package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"regexp"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// Room IDs leave out 0, 1, I and O, which are easy to misread when shared by hand.
	roomIDAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	roomIDLength   = 5

	maxRooms             = 1000
	maxSessionsPerRoom   = 50
	maxSessions          = 500
	roomCreationsPerHour = 20 // per client address

	// A room keeps playing this long after its last listener disconnects, so
	// that a listener who is only reconnecting does not stop the music.
	listenerGrace = 30 * time.Second
	// A room that nobody is in, and that nobody has joined or changed for
	// this long, is deleted. The rooms are checked this often.
	roomLifetime    = time.Hour
	cleanupInterval = time.Minute

	// A client that falls this many messages behind is dropped; it then
	// reconnects and starts again from a fresh snapshot.
	sessionBuffer     = 32
	heartbeatInterval = 15 * time.Second
)

var (
	roomIDPattern   = regexp.MustCompile(fmt.Sprintf("^[%s]{%d}$", roomIDAlphabet, roomIDLength))
	clientIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)
)

// Hub holds every room and the sessions connected to them.
type Hub struct {
	store *Store
	log   *slog.Logger
	now   func() time.Time

	sessions atomic.Int64

	mu        sync.Mutex // guards rooms and creations; never taken while a room is locked
	rooms     map[string]*Room
	creations map[string][]time.Time
}

// Room is one room's state and the sessions connected to it.
type Room struct {
	mu         sync.Mutex
	state      State
	sessions   map[*Session]struct{}
	graceTimer *time.Timer
	deleted    bool
}

// Session is one open event stream. Its ID is a secret that authorizes the
// member's commands. MemberID is public and the same for every session that
// one browser opens in the room. Listening is false while the member has
// paused their own player.
type Session struct {
	ID        string
	MemberID  string
	Name      string
	Listening bool
	joinedAt  time.Time
	out       chan []byte
	done      chan struct{}
	once      sync.Once
}

func (s *Session) close() { s.once.Do(func() { close(s.done) }) }

type helloEvent struct {
	SessionID string `json:"sessionId"`
	MemberID  string `json:"memberId"`
}

// member is a person in the room. Listening is true while the member's own
// player plays; the others see it next to the name.
type member struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Listening bool   `json:"listening"`
}

// roomView is what members receive: the room's state, the server's clock, and who is in the room.
type roomView struct {
	ID                 string   `json:"id"`
	Version            int64    `json:"version"`
	ServerTime         int64    `json:"serverTime"`
	HostID             string   `json:"hostId"`
	ParticipantControl bool     `json:"participantControl"`
	Current            *Item    `json:"current"`
	Queue              []Item   `json:"queue"`
	Standby            []Item   `json:"standby"`
	History            []Item   `json:"history"`
	Playback           Playback `json:"playback"`
	Members            []member `json:"members"`
}

// NewHub returns a hub holding the rooms that were saved before.
func NewHub(store *Store, log *slog.Logger, states []State) *Hub {
	h := &Hub{
		store:     store,
		log:       log,
		now:       time.Now,
		rooms:     make(map[string]*Room, len(states)),
		creations: make(map[string][]time.Time),
	}
	for _, st := range states {
		if st.Queue == nil {
			st.Queue = []Item{}
		}
		// Rooms saved before the history or the standby queue was kept have none.
		if st.History == nil {
			st.History = []Item{}
		}
		if st.Standby == nil {
			st.Standby = []Item{}
		}
		room := &Room{state: st, sessions: make(map[*Session]struct{})}
		// Nobody is connected yet: give listeners the usual grace to reconnect
		// before a room that was playing is paused.
		room.graceTimer = time.AfterFunc(listenerGrace, func() { h.pauseIfNobodyListens(room) })
		h.rooms[st.ID] = room
	}
	return h
}

// CreateRoom makes an empty room and returns its ID. The browser that creates
// it, known by its client ID, is the room's host.
func (h *Hub) CreateRoom(addr, clientID string, log *slog.Logger) (string, error) {
	if !clientIDPattern.MatchString(clientID) {
		return "", errBadRequest
	}
	now := h.now()
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.allowCreation(addr, now) {
		return "", errRateLimited
	}
	if len(h.rooms) >= maxRooms {
		return "", errTooManyRooms
	}
	id := newRoomID()
	for h.rooms[id] != nil {
		id = newRoomID()
	}
	ms := now.UnixMilli()
	// A new room lets participants seek, skip and reorder; the host can turn it off.
	st := State{ID: id, CreatedAt: ms, LastActiveAt: ms, HostID: memberID(id, clientID), ParticipantControl: true, Queue: []Item{}, Standby: []Item{}, History: []Item{}}
	if err := h.store.Save(st); err != nil {
		return "", fmt.Errorf("save new room: %w", err)
	}
	h.rooms[id] = &Room{state: st, sessions: make(map[*Session]struct{})}
	log.Info("Room created", "count", len(h.rooms))
	return id, nil
}

// Join opens a session in a room. The session's first message says who the
// member is; every message after that is a snapshot of the room. A member
// who joins listening starts a room that nobody was listening to.
func (h *Hub) Join(roomID, clientID, name string, listening bool, log *slog.Logger) (*Room, *Session, error) {
	name, ok := cleanName(name)
	if !ok || !clientIDPattern.MatchString(clientID) {
		return nil, nil, errBadRequest
	}
	room := h.room(roomID)
	if room == nil {
		return nil, nil, errRoomNotFound
	}
	if h.sessions.Load() >= maxSessions {
		return nil, nil, errServerFull
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	if room.deleted {
		return nil, nil, errRoomNotFound
	}
	if len(room.sessions) >= maxSessionsPerRoom {
		return nil, nil, errRoomFull
	}
	now := h.now()
	sess := &Session{
		ID:        rand.Text(),
		MemberID:  memberID(roomID, clientID),
		Name:      name,
		Listening: listening,
		joinedAt:  now,
		out:       make(chan []byte, sessionBuffer),
		done:      make(chan struct{}),
	}
	h.sessions.Add(1)
	room.sessions[sess] = struct{}{}
	room.state.LastActiveAt = now.UnixMilli()
	if h.followListenersLocked(room, now) {
		h.saveLocked(room)
	}
	if hello, ok := h.frame("hello", helloEvent{SessionID: sess.ID, MemberID: sess.MemberID}); ok {
		sess.out <- hello
	}
	h.broadcastLocked(room, now)
	log.Info("Member joined", "count", len(room.sessions))
	return room, sess, nil
}

// Leave closes a session. When the last listener leaves, the room is paused
// after a grace period unless someone listens again.
func (h *Hub) Leave(room *Room, sess *Session, log *slog.Logger) {
	sess.close()
	room.mu.Lock()
	defer room.mu.Unlock()
	if _, ok := room.sessions[sess]; !ok {
		return
	}
	delete(room.sessions, sess)
	h.sessions.Add(-1)
	log.Info("Member left", "count", len(room.sessions))
	if room.deleted {
		// The room was closed; its members have been told already.
		return
	}
	now := h.now()
	room.state.LastActiveAt = now.UnixMilli()
	if sess.Listening && !room.listeningLocked() && room.graceTimer == nil {
		room.graceTimer = time.AfterFunc(listenerGrace, func() { h.pauseIfNobodyListens(room) })
	}
	h.broadcastLocked(room, now)
}

// Command applies one member's command and sends the new state to everyone
// in the room. The command "listening" says whether the member's own player
// is playing, and the room plays while anyone's is.
func (h *Hub) Command(roomID, sessionID string, c Command) error {
	room := h.room(roomID)
	if room == nil {
		return errRoomNotFound
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	sess := room.sessionLocked(sessionID)
	if sess == nil {
		return errNotMember
	}
	now := h.now()
	changed := false
	// The others see who listens, so a member who pauses or plays again is
	// sent to everyone even when the room itself does not change.
	membersChanged := false
	if c.Type == "listening" {
		if c.Value == nil {
			return errBadRequest
		}
		membersChanged = sess.Listening != *c.Value
		sess.Listening = *c.Value
	} else {
		var err error
		changed, err = room.state.Apply(c, member{ID: sess.MemberID, Name: sess.Name}, now.UnixMilli())
		if err != nil {
			return err
		}
	}
	// A song added to an idle room, for one, starts only if someone listens.
	if h.followListenersLocked(room, now) {
		changed = true
	}
	if changed {
		h.saveLocked(room)
	}
	if changed || membersChanged {
		h.broadcastLocked(room, now)
	}
	return nil
}

// AddTracks adds the songs of an album or a playlist for one member to the
// list that listName names, as many as it has room for, and sends the new
// state to everyone in the room. It reports how many songs it added.
func (h *Hub) AddTracks(roomID, sessionID string, tracks []Track, listName string, at *int) (int, error) {
	room := h.room(roomID)
	if room == nil {
		return 0, errRoomNotFound
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	sess := room.sessionLocked(sessionID)
	if sess == nil {
		return 0, errNotMember
	}
	now := h.now()
	added, err := room.state.AddTracks(tracks, listName, at, member{ID: sess.MemberID, Name: sess.Name}, now.UnixMilli())
	if err != nil {
		return 0, err
	}
	// The first song added to an idle room starts only if someone listens.
	h.followListenersLocked(room, now)
	h.saveLocked(room)
	h.broadcastLocked(room, now)
	return added, nil
}

// CloseRoom deletes the room at its host's request. Every member is told
// that the room was closed, and their streams end.
func (h *Hub) CloseRoom(roomID, sessionID string, log *slog.Logger) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[roomID]
	if room == nil {
		return errRoomNotFound
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	sess := room.sessionLocked(sessionID)
	if sess == nil {
		return errNotMember
	}
	if sess.MemberID != room.state.HostID {
		return errHostOnly
	}
	room.deleted = true
	room.stopGraceLocked()
	delete(h.rooms, roomID)
	if err := h.store.Delete(roomID); err != nil {
		log.Error("Room file delete failed", "errorType", fmt.Sprintf("%T", err), "errorMessage", err.Error())
	}
	closed, _ := h.frame("closed", struct{}{})
	for s := range room.sessions {
		if closed != nil {
			select {
			case s.out <- closed:
			default:
			}
		}
		s.close()
	}
	log.Info("Room closed", "count", len(h.rooms))
	return nil
}

// CloseAll ends every stream, for shutting down.
func (h *Hub) CloseAll() {
	h.mu.Lock()
	rooms := slices.Collect(maps.Values(h.rooms))
	h.mu.Unlock()
	for _, room := range rooms {
		room.mu.Lock()
		for s := range room.sessions {
			s.close()
		}
		room.mu.Unlock()
	}
}

// RunCleanup deletes unused rooms until the context ends.
func (h *Hub) RunCleanup(ctx context.Context) {
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.cleanup()
		}
	}
}

func (h *Hub) cleanup() {
	now := h.now()
	cutoff := now.Add(-roomLifetime).UnixMilli()
	deleted := 0
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, room := range h.rooms {
		room.mu.Lock()
		expired := len(room.sessions) == 0 && room.state.LastActiveAt < cutoff
		if expired {
			room.deleted = true
			room.stopGraceLocked()
		}
		room.mu.Unlock()
		if !expired {
			continue
		}
		delete(h.rooms, id)
		deleted++
		if err := h.store.Delete(id); err != nil {
			h.log.Error("Room file delete failed", "errorType", fmt.Sprintf("%T", err), "errorMessage", err.Error())
		}
	}
	hourAgo := now.Add(-time.Hour)
	for addr, times := range h.creations {
		if len(times) == 0 || times[len(times)-1].Before(hourAgo) {
			delete(h.creations, addr)
		}
	}
	if deleted > 0 {
		h.log.Info("Unused rooms deleted", "count", deleted)
	}
}

func (h *Hub) room(id string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.rooms[id]
}

// sessionLocked finds the session with the given secret ID. The caller holds room.mu.
func (r *Room) sessionLocked(id string) *Session {
	for s := range r.sessions {
		if s.ID == id {
			return s
		}
	}
	return nil
}

// allowCreation limits how many rooms one address can create in an hour. The caller holds h.mu.
func (h *Hub) allowCreation(addr string, now time.Time) bool {
	hourAgo := now.Add(-time.Hour)
	recent := slices.DeleteFunc(h.creations[addr], func(t time.Time) bool { return t.Before(hourAgo) })
	if len(recent) >= roomCreationsPerHour {
		h.creations[addr] = recent
		return false
	}
	h.creations[addr] = append(recent, now)
	return true
}

// listeningLocked reports whether anyone in the room is listening. The caller holds room.mu.
func (r *Room) listeningLocked() bool {
	for s := range r.sessions {
		if s.Listening {
			return true
		}
	}
	return false
}

// stopGraceLocked cancels the pause that waits for a lost listener. The caller holds room.mu.
func (r *Room) stopGraceLocked() {
	if r.graceTimer != nil {
		r.graceTimer.Stop()
		r.graceTimer = nil
	}
}

// followListenersLocked plays the room while anyone is listening and stops it
// where it is once nobody is, except during the grace after a listener lost
// the connection. It reports whether the room changed. The caller holds room.mu.
func (h *Hub) followListenersLocked(room *Room, now time.Time) bool {
	if room.listeningLocked() {
		room.stopGraceLocked()
		return room.state.ResumeAt(now.UnixMilli())
	}
	if room.graceTimer != nil {
		return false
	}
	return room.state.PauseAt(now.UnixMilli())
}

// pauseIfNobodyListens runs when the grace after the last listener's
// disconnection is over.
func (h *Hub) pauseIfNobodyListens(room *Room) {
	room.mu.Lock()
	defer room.mu.Unlock()
	room.graceTimer = nil
	if room.deleted || room.listeningLocked() {
		return
	}
	now := h.now()
	if room.state.PauseAt(now.UnixMilli()) {
		h.saveLocked(room)
		h.broadcastLocked(room, now)
	}
}

func (h *Hub) saveLocked(room *Room) {
	if err := h.store.Save(room.state); err != nil {
		h.log.Error("Room save failed", "errorType", fmt.Sprintf("%T", err), "errorMessage", err.Error())
	}
}

// broadcastLocked sends the room's snapshot to every session. The caller holds room.mu.
func (h *Hub) broadcastLocked(room *Room, now time.Time) {
	data, ok := h.frame("room", roomView{
		ID:                 room.state.ID,
		Version:            room.state.Version,
		ServerTime:         now.UnixMilli(),
		HostID:             room.state.HostID,
		ParticipantControl: room.state.ParticipantControl,
		Current:            room.state.Current,
		Queue:              room.state.Queue,
		Standby:            room.state.Standby,
		History:            latest(room.state.History, maxHistoryShown),
		Playback:           room.state.Playback,
		Members:            membersOf(room.sessions),
	})
	if !ok {
		return
	}
	for s := range room.sessions {
		select {
		case s.out <- data:
		default:
			s.close()
		}
	}
}

// frame encodes one server-sent event.
func (h *Hub) frame(event string, v any) ([]byte, bool) {
	data, err := json.Marshal(v)
	if err != nil {
		h.log.Error("Event encoding failed", "errorType", fmt.Sprintf("%T", err), "errorMessage", err.Error())
		return nil, false
	}
	return []byte("event: " + event + "\ndata: " + string(data) + "\n\n"), true
}

// latest returns the last n items of a list, or the whole list when it is shorter.
func latest(items []Item, n int) []Item {
	return items[max(0, len(items)-n):]
}

// History returns every song that played in the room that the member is in,
// oldest first, up to maxHistoryItems.
func (h *Hub) History(roomID, sessionID string) ([]Item, error) {
	room := h.room(roomID)
	if room == nil {
		return nil, errRoomNotFound
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	if room.sessionLocked(sessionID) == nil {
		return nil, errNotMember
	}
	return slices.Clone(room.state.History), nil
}

// membersOf lists the room's members in the order they joined. A browser with
// two sessions open counts once, under the name it joined with most recently,
// and listens while either session listens.
func membersOf(sessions map[*Session]struct{}) []member {
	list := slices.SortedFunc(maps.Keys(sessions), func(a, b *Session) int { return a.joinedAt.Compare(b.joinedAt) })
	members := []member{}
	index := map[string]int{}
	for _, s := range list {
		if i, ok := index[s.MemberID]; ok {
			members[i].Name = s.Name
			members[i].Listening = members[i].Listening || s.Listening
			continue
		}
		index[s.MemberID] = len(members)
		members = append(members, member{ID: s.MemberID, Name: s.Name, Listening: s.Listening})
	}
	return members
}

func memberID(roomID, clientID string) string {
	sum := sha256.Sum256([]byte(roomID + "\x00" + clientID))
	return hex.EncodeToString(sum[:6])
}

func newRoomID() string {
	b := make([]byte, roomIDLength)
	rand.Read(b) // crypto/rand.Read never fails since Go 1.24
	for i := range b {
		// 256 is a multiple of the alphabet's 32 letters, so every letter is equally likely.
		b[i] = roomIDAlphabet[int(b[i])%len(roomIDAlphabet)]
	}
	return string(b)
}
