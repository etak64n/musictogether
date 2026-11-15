package main

import (
	"math"
	"math/rand/v2"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Limits that keep a room small enough to send whole on every change.
const (
	maxQueueItems = 200
	// A room keeps this many songs that played, which members fetch to save
	// them as a playlist, and sends the latest maxHistoryShown with the room.
	maxHistoryItems = 500
	maxHistoryShown = 50
	maxTextRunes    = 200
	maxNameRunes    = 30
	maxDuration     = 24 * 60 * 60
)

// A member's player may report the end of a song this many seconds before
// the room's timeline reaches it, because players drift a little.
const endedMargin = 5

var videoIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// Artwork may only come from the hosts YouTube Music serves it from, so that
// one member cannot make the others' panels load images from any server.
var thumbnailHostSuffixes = []string{".googleusercontent.com", ".ggpht.com", ".ytimg.com"}

// Track is a song as the extension found it in YouTube Music.
type Track struct {
	VideoID   string  `json:"videoId"`
	Title     string  `json:"title"`
	Artists   string  `json:"artists"`
	Album     string  `json:"album"`
	Duration  float64 `json:"duration"`
	Thumbnail string  `json:"thumbnail"`
}

// Item is a track placed in a room. Its ID is unique within the room, so the
// same song can be queued twice and still be removed one at a time.
type Item struct {
	ID string `json:"id"`
	Track
	AddedBy   string `json:"addedBy"`
	AddedByID string `json:"addedById"`
}

// Playback is the room's shared timeline: where the current song was at
// UpdatedAt, and whether it has been moving forward since then.
type Playback struct {
	Playing   bool    `json:"playing"`
	Position  float64 `json:"position"`
	UpdatedAt int64   `json:"updatedAt"` // Unix time in milliseconds on the server clock
}

// State is the part of a room that is saved to disk.
// Current is nil exactly when nothing is playing, and the queue is then empty.
type State struct {
	ID           string `json:"id"`
	CreatedAt    int64  `json:"createdAt"`
	LastActiveAt int64  `json:"lastActiveAt"`
	Version      int64  `json:"version"`
	NextItemID   int64  `json:"nextItemId"`
	// HostID is the member ID of the browser that created the room.
	HostID string `json:"hostId"`
	// ParticipantControl lets members other than the host seek, skip and
	// reorder the queue. A new room starts with it on, and only the host can
	// change it.
	ParticipantControl bool   `json:"participantControl"`
	Current            *Item  `json:"current"`
	Queue              []Item `json:"queue"`
	// Standby is the songs that play once the queue is empty, in their order:
	// songs that may wait while the requests go first.
	Standby []Item `json:"standby"`
	// History is the songs that played, oldest first, up to maxHistoryItems.
	History  []Item   `json:"history"`
	Playback Playback `json:"playback"`
}

// Command is one change that a member asks for.
type Command struct {
	Type   string  `json:"type"`
	Track  *Track  `json:"track,omitempty"`
	Tracks []Track `json:"tracks,omitempty"`
	// List names the list that add, addTracks, and move put songs in:
	// "queue", which add and addTracks take without a name, or "standby".
	List     string   `json:"list,omitempty"`
	ItemID   string   `json:"itemId,omitempty"`
	Position *float64 `json:"position,omitempty"`
	Index    *int     `json:"index,omitempty"`
	Value    *bool    `json:"value,omitempty"`
}

// Apply changes the state by one command from a member.
// It reports whether anything changed, so that only real changes are saved and sent.
//
// Anyone in the room can add songs, remove the songs they added, and report
// that the current song has ended. Seeking, skipping and reordering the
// queue need the host, or the host's permission. Removing another member's
// song and changing that permission need the host. Pausing is not a command:
// each member pauses their own player, and the hub plays the room while
// anyone is listening.
func (s *State) Apply(c Command, by member, now int64) (bool, error) {
	isHost := by.ID == s.HostID
	switch c.Type {
	case "seek", "next", "move":
		if !isHost && !s.ParticipantControl {
			return false, errHostOnly
		}
	}

	switch c.Type {
	case "add":
		list, ok := s.list(c.List)
		if !ok || c.Track == nil || (c.Index != nil && *c.Index < 0) {
			return false, errBadRequest
		}
		track, ok := normalizeTrack(*c.Track)
		if !ok {
			return false, errBadRequest
		}
		if len(*list) >= maxQueueItems {
			return false, errQueueFull
		}
		s.addItem(track, list, c.Index, by, now)
	case "remove":
		list, i := s.find(c.ItemID)
		if i < 0 {
			return false, nil
		}
		if !isHost && (*list)[i].AddedByID != by.ID {
			return false, errHostOnly
		}
		*list = slices.Delete(*list, i, i+1)
	case "move":
		// The song is taken out of its list and put at Index in the list that
		// the command names, or back in its own list without a name. 0 puts it
		// first, and an index past the end puts it last.
		if c.Index == nil || *c.Index < 0 {
			return false, errBadRequest
		}
		from, i := s.find(c.ItemID)
		if i < 0 {
			return false, nil
		}
		to := from
		if c.List != "" {
			var ok bool
			if to, ok = s.list(c.List); !ok {
				return false, errBadRequest
			}
		}
		item := (*from)[i]
		if to == from {
			at := min(*c.Index, len(*from)-1)
			if at == i {
				return false, nil
			}
			*from = slices.Insert(slices.Delete(*from, i, i+1), at, item)
		} else {
			if len(*to) >= maxQueueItems {
				return false, errQueueFull
			}
			*from = slices.Delete(*from, i, i+1)
			*to = slices.Insert(*to, min(*c.Index, len(*to)), item)
		}
	case "seek":
		pos, ok := s.clampPosition(c.Position)
		if !ok {
			return false, errBadRequest
		}
		if s.Current == nil {
			return false, nil
		}
		s.Playback = Playback{Playing: s.Playback.Playing, Position: pos, UpdatedAt: now}
	case "next", "ended":
		// Members name the song they want to move past, so that several members
		// reaching the end of the same song together move the room on only once.
		if s.Current == nil || s.Current.ID != c.ItemID {
			return false, nil
		}
		// "ended" needs no permission, so it only counts near the end of the
		// song; a player that ran ahead asks again until the timeline gets there.
		if c.Type == "ended" && s.Current.Duration > 0 && s.PositionAt(now) < s.Current.Duration-endedMargin {
			return false, nil
		}
		s.advance(now)
	case "participantControl":
		if !isHost {
			return false, errHostOnly
		}
		if c.Value == nil {
			return false, errBadRequest
		}
		if s.ParticipantControl == *c.Value {
			return false, nil
		}
		s.ParticipantControl = *c.Value
	default:
		return false, errBadRequest
	}
	s.Version++
	s.LastActiveAt = now
	return true, nil
}

// AddTracks adds the songs of an album or a playlist to the list that
// listName names, as many as the list has room for, and reports how many it
// added. With at, the songs go there in their order; without it, they go to
// the end of the queue, or to random places in the standby queue. Anyone in
// the room can add songs. The songs are all checked first, so that one bad
// song adds none of them. In a room where nothing plays, the first song starts
// at once.
func (s *State) AddTracks(tracks []Track, listName string, at *int, by member, now int64) (int, error) {
	list, ok := s.list(listName)
	if !ok || len(tracks) == 0 || len(tracks) > maxQueueItems || (at != nil && *at < 0) {
		return 0, errBadRequest
	}
	checked := make([]Track, 0, len(tracks))
	for _, t := range tracks {
		track, ok := normalizeTrack(t)
		if !ok {
			return 0, errBadRequest
		}
		checked = append(checked, track)
	}
	added, placed := 0, 0
	for _, track := range checked {
		if len(*list) >= maxQueueItems {
			break
		}
		// The songs keep their order from the given place on. A song that
		// starts playing in an idle room takes no place in the list.
		var place *int
		if at != nil {
			next := *at + placed
			place = &next
		}
		if s.Current != nil {
			placed++
		}
		s.addItem(track, list, place, by, now)
		added++
	}
	if added == 0 {
		return 0, errQueueFull
	}
	s.Version++
	s.LastActiveAt = now
	return added, nil
}

// standbyPlace picks the place of a song added to the standby queue, among
// the n+1 places of a list of n songs. Songs take random places, so that a
// whole album or playlist that one member adds mixes with the others' songs.
var standbyPlace = func(n int) int { return rand.IntN(n + 1) }

// addItem puts a song at the place that at names, as when a member drops it
// there, or else at the end of the queue, or at a random place in the standby
// queue. A place past the end is the end. An idle room starts playing it.
func (s *State) addItem(track Track, list *[]Item, at *int, by member, now int64) {
	s.NextItemID++
	item := Item{ID: strconv.FormatInt(s.NextItemID, 10), Track: track, AddedBy: by.Name, AddedByID: by.ID}
	switch {
	case s.Current == nil:
		s.Current = &item
		s.Playback = Playback{Playing: true, UpdatedAt: now}
	case at != nil:
		*list = slices.Insert(*list, min(*at, len(*list)), item)
	case list == &s.Standby:
		*list = slices.Insert(*list, standbyPlace(len(*list)), item)
	default:
		*list = append(*list, item)
	}
}

// list returns the list that a command names: the queue without a name.
func (s *State) list(name string) (*[]Item, bool) {
	switch name {
	case "", "queue":
		return &s.Queue, true
	case "standby":
		return &s.Standby, true
	}
	return nil, false
}

// find returns the list that holds an item, and the item's place in it, or -1.
func (s *State) find(itemID string) (*[]Item, int) {
	for _, list := range []*[]Item{&s.Queue, &s.Standby} {
		if i := slices.IndexFunc(*list, func(it Item) bool { return it.ID == itemID }); i >= 0 {
			return list, i
		}
	}
	return nil, -1
}

// PositionAt returns where the shared timeline is at the given time.
func (s *State) PositionAt(now int64) float64 {
	pos := s.Playback.Position
	if s.Playback.Playing {
		pos += float64(now-s.Playback.UpdatedAt) / 1000
	}
	if s.Current != nil && s.Current.Duration > 0 && pos > s.Current.Duration {
		pos = s.Current.Duration
	}
	return pos
}

// PauseAt stops the timeline where it is. The hub uses it when nobody is
// listening any more, so that the room does not run on without anyone.
func (s *State) PauseAt(now int64) bool {
	if s.Current == nil || !s.Playback.Playing {
		return false
	}
	s.Playback = Playback{Playing: false, Position: s.PositionAt(now), UpdatedAt: now}
	s.Version++
	return true
}

// ResumeAt starts the timeline again from where it stopped. The hub uses it
// when someone listens again.
func (s *State) ResumeAt(now int64) bool {
	if s.Current == nil || s.Playback.Playing {
		return false
	}
	s.Playback = Playback{Playing: true, Position: s.Playback.Position, UpdatedAt: now}
	s.Version++
	return true
}

// advance moves past the current song, which goes to the end of the history,
// to the first song of the queue, or leaves the room idle when the queue is empty.
func (s *State) advance(now int64) {
	if s.Current != nil {
		s.History = append(s.History, *s.Current)
		if len(s.History) > maxHistoryItems {
			s.History = slices.Delete(s.History, 0, len(s.History)-maxHistoryItems)
		}
	}
	// The queue goes first; the standby queue plays once the queue is empty.
	list := &s.Queue
	if len(*list) == 0 {
		list = &s.Standby
	}
	if len(*list) == 0 {
		s.Current = nil
		s.Playback = Playback{UpdatedAt: now}
		return
	}
	next := (*list)[0]
	*list = slices.Delete(*list, 0, 1)
	s.Current = &next
	s.Playback = Playback{Playing: true, UpdatedAt: now}
}

func (s *State) clampPosition(p *float64) (float64, bool) {
	if p == nil || math.IsNaN(*p) || math.IsInf(*p, 0) || *p < 0 {
		return 0, false
	}
	pos := *p
	if s.Current != nil && s.Current.Duration > 0 && pos > s.Current.Duration {
		pos = s.Current.Duration
	}
	return pos, true
}

func normalizeTrack(t Track) (Track, bool) {
	if !videoIDPattern.MatchString(t.VideoID) {
		return Track{}, false
	}
	t.Title = cleanText(t.Title, maxTextRunes)
	if t.Title == "" {
		return Track{}, false
	}
	t.Artists = cleanText(t.Artists, maxTextRunes)
	t.Album = cleanText(t.Album, maxTextRunes)
	if math.IsNaN(t.Duration) || math.IsInf(t.Duration, 0) || t.Duration < 0 || t.Duration > maxDuration {
		t.Duration = 0
	}
	if !allowedThumbnail(t.Thumbnail) {
		t.Thumbnail = ""
	}
	return t, true
}

// cleanName returns a member's display name, or false if nothing usable is left.
func cleanName(name string) (string, bool) {
	name = cleanText(name, maxNameRunes)
	return name, name != ""
}

// cleanText removes control characters and surrounding spaces and cuts the
// text to at most limit characters.
func cleanText(s string, limit int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > limit {
		s = strings.TrimSpace(string([]rune(s)[:limit]))
	}
	return s
}

func allowedThumbnail(raw string) bool {
	if raw == "" || len(raw) > 1000 {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, suffix := range thumbnailHostSuffixes {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}
