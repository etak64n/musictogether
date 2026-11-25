package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testToken is the token of the servers that the tests start.
const testToken = "test-token-1"

func newTestServer(t *testing.T) (*httptest.Server, *Hub) {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHub(store, slog.New(newLogHandler(io.Discard, "json", slog.LevelInfo)), nil)
	srv := httptest.NewServer(hub.Handler(testToken))
	t.Cleanup(func() {
		hub.CloseAll()
		srv.Close()
	})
	return srv, hub
}

func post(t *testing.T, url string, body any) (*http.Response, map[string]any) {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", allowedOrigin)
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

func createRoom(t *testing.T, srv *httptest.Server, clientID string) string {
	t.Helper()
	resp, body := post(t, srv.URL+"/api/rooms", map[string]string{"clientId": clientID})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create room: status %d, body %v", resp.StatusCode, body)
	}
	id, _ := body["roomId"].(string)
	if !roomIDPattern.MatchString(id) {
		t.Fatalf("room ID %q does not match %s", id, roomIDPattern)
	}
	return id
}

type event struct {
	name string
	data map[string]any
}

// openStream joins a room as a listener and returns the events it receives.
func openStream(t *testing.T, srv *httptest.Server, roomID, clientID, name string) <-chan event {
	t.Helper()
	return stream(t, srv, roomID, map[string]any{"clientId": clientID, "name": name})
}

// stream joins a room with the given request body and returns the events it receives.
func stream(t *testing.T, srv *httptest.Server, roomID string, body map[string]any) <-chan event {
	t.Helper()
	data, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/rooms/"+roomID+"/stream", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("stream: status %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Errorf("stream Content-Type = %q", got)
	}
	events := make(chan event, 64)
	go func() {
		defer resp.Body.Close()
		defer close(events)
		scanner := bufio.NewScanner(resp.Body)
		var name string
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				var payload map[string]any
				json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload)
				events <- event{name: name, data: payload}
			}
		}
	}()
	return events
}

func next(t *testing.T, events <-chan event) event {
	t.Helper()
	select {
	case ev, ok := <-events:
		if !ok {
			t.Fatal("the stream ended")
		}
		return ev
	case <-time.After(5 * time.Second):
		t.Fatal("no event within 5 seconds")
	}
	return event{}
}

func members(ev event) []string {
	var names []string
	list, _ := ev.data["members"].([]any)
	for _, m := range list {
		names = append(names, m.(map[string]any)["name"].(string))
	}
	return names
}

// listeners tells, for each member's name, whether the member listens.
func listeners(ev event) map[string]bool {
	out := map[string]bool{}
	list, _ := ev.data["members"].([]any)
	for _, m := range list {
		fields := m.(map[string]any)
		out[fields["name"].(string)] = fields["listening"] == true
	}
	return out
}

func TestJoinSendsHelloThenTheRoom(t *testing.T) {
	srv, _ := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")

	events := openStream(t, srv, roomID, "client-neko", "ねこ")
	hello := next(t, events)
	if hello.name != "hello" || hello.data["sessionId"] == "" || hello.data["memberId"] == "" {
		t.Fatalf("first event = %+v; want hello with sessionId and memberId", hello)
	}
	room := next(t, events)
	if room.name != "room" || room.data["id"] != roomID || room.data["current"] != nil {
		t.Fatalf("second event = %+v; want the empty room", room)
	}
	if got := members(room); len(got) != 1 || got[0] != "ねこ" {
		t.Errorf("members = %v; want [ねこ]", got)
	}
}

func TestJoinUnknownRoom(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, body := post(t, srv.URL+"/api/rooms/ABCDE/stream", map[string]string{"clientId": "client-neko", "name": "ねこ"})
	if resp.StatusCode != http.StatusNotFound || body["error"] != "room_not_found" {
		t.Errorf("status %d, body %v; want 404 room_not_found", resp.StatusCode, body)
	}
}

func TestJoinNeedsANameAndClientID(t *testing.T) {
	srv, _ := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	for _, body := range []map[string]string{
		{"clientId": "client-neko", "name": "  "},
		{"clientId": "bad id!", "name": "ねこ"},
	} {
		resp, out := post(t, srv.URL+"/api/rooms/"+roomID+"/stream", body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("join with %v: status %d, body %v; want 400", body, resp.StatusCode, out)
		}
	}
}

func TestCommandsReachEveryMember(t *testing.T) {
	srv, _ := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	neko := openStream(t, srv, roomID, "client-neko", "ねこ")
	sessionID := next(t, neko).data["sessionId"].(string)
	next(t, neko)
	inu := openStream(t, srv, roomID, "client-inu", "いぬ")
	next(t, inu)
	if got := members(next(t, inu)); len(got) != 2 || got[0] != "ねこ" || got[1] != "いぬ" {
		t.Errorf("members = %v; want [ねこ いぬ]", got)
	}
	next(t, neko) // いぬ joined

	resp, body := post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{
		"sessionId": sessionID,
		"type":      "add",
		"track":     testTrack("aaaaaaaaaaa"),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("add: status %d, body %v", resp.StatusCode, body)
	}
	for _, events := range []<-chan event{neko, inu} {
		room := next(t, events)
		current, _ := room.data["current"].(map[string]any)
		if current["videoId"] != "aaaaaaaaaaa" || current["addedBy"] != "ねこ" {
			t.Errorf("current = %v; want the song added by ねこ", current)
		}
		if playback, _ := room.data["playback"].(map[string]any); playback["playing"] != true {
			t.Errorf("playback = %v; want playing", playback)
		}
	}
}

func TestShuffleReachesEveryMember(t *testing.T) {
	srv, _ := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	neko := openStream(t, srv, roomID, "client-neko", "ねこ")
	nekoSession := next(t, neko).data["sessionId"].(string)
	next(t, neko)
	inu := openStream(t, srv, roomID, "client-inu", "いぬ")
	inuSession := next(t, inu).data["sessionId"].(string)
	next(t, inu)
	next(t, neko) // いぬ joined

	resp, body := post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{
		"sessionId": nekoSession,
		"type":      "addTracks",
		"tracks":    []*Track{testTrack("aaaaaaaaaaa"), testTrack("bbbbbbbbbbb"), testTrack("ccccccccccc")},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("addTracks: status %d, body %v", resp.StatusCode, body)
	}
	next(t, neko)
	next(t, inu)

	resp, body = post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{
		"sessionId": nekoSession,
		"type":      "shuffle",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("shuffle: status %d, body %v", resp.StatusCode, body)
	}
	for _, events := range []<-chan event{neko, inu} {
		room := next(t, events)
		queue, _ := room.data["queue"].([]any)
		if len(queue) != 2 || queue[0].(map[string]any)["videoId"] != "ccccccccccc" || queue[1].(map[string]any)["videoId"] != "bbbbbbbbbbb" {
			t.Errorf("queue = %v; want [c, b]", queue)
		}
	}

	// Without participantControl, a participant cannot shuffle.
	resp, body = post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{
		"sessionId": nekoSession,
		"type":      "participantControl",
		"value":     false,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("participantControl: status %d, body %v", resp.StatusCode, body)
	}
	resp, body = post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{
		"sessionId": inuSession,
		"type":      "shuffle",
	})
	if resp.StatusCode != http.StatusForbidden || body["error"] != "host_only" {
		t.Errorf("shuffle by participant: status %d, body %v; want 403 host_only", resp.StatusCode, body)
	}
}

func TestAddTracksTellsHowManyWereAdded(t *testing.T) {
	srv, _ := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	neko := openStream(t, srv, roomID, "client-neko", "ねこ")
	sessionID := next(t, neko).data["sessionId"].(string)
	next(t, neko)

	resp, body := post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{
		"sessionId": sessionID,
		"type":      "addTracks",
		"tracks":    []*Track{testTrack("aaaaaaaaaaa"), testTrack("bbbbbbbbbbb"), testTrack("ccccccccccc")},
	})
	if resp.StatusCode != http.StatusOK || body["added"] != 3.0 {
		t.Fatalf("addTracks: status %d, body %v; want 200 with 3 added", resp.StatusCode, body)
	}
	room := next(t, neko)
	current, _ := room.data["current"].(map[string]any)
	queue, _ := room.data["queue"].([]any)
	if current["videoId"] != "aaaaaaaaaaa" || len(queue) != 2 || queue[1].(map[string]any)["videoId"] != "ccccccccccc" {
		t.Errorf("current = %v, queue = %v; want the 3 songs in their order", current, queue)
	}
}

func TestTheRoomSendsTheLatestSongsThatPlayed(t *testing.T) {
	srv, hub := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	room := hub.room(roomID)
	room.mu.Lock()
	for i := range maxHistoryShown + 10 {
		room.state.History = append(room.state.History, Item{ID: fmt.Sprint(i), Track: *testTrack(fmt.Sprintf("song%07d", i))})
	}
	room.mu.Unlock()

	neko := openStream(t, srv, roomID, "client-neko", "ねこ")
	sessionID := next(t, neko).data["sessionId"].(string)
	sent, _ := next(t, neko).data["history"].([]any)
	if len(sent) != maxHistoryShown || sent[len(sent)-1].(map[string]any)["id"] != fmt.Sprint(maxHistoryShown+9) {
		t.Errorf("the room sent %d songs that played; want the latest %d", len(sent), maxHistoryShown)
	}

	resp, body := post(t, srv.URL+"/api/rooms/"+roomID+"/history", map[string]any{"sessionId": sessionID})
	all, _ := body["history"].([]any)
	if resp.StatusCode != http.StatusOK || len(all) != maxHistoryShown+10 {
		t.Errorf("history: status %d, %d songs; want 200 with all %d", resp.StatusCode, len(all), maxHistoryShown+10)
	}
	if resp, body := post(t, srv.URL+"/api/rooms/"+roomID+"/history", map[string]any{"sessionId": "not-a-session"}); resp.StatusCode != http.StatusForbidden {
		t.Errorf("history without a session: status %d, body %v; want 403", resp.StatusCode, body)
	}
}

func TestMembersHearOfTheLatestRelease(t *testing.T) {
	const page = "https://github.com/etak64n/musictogether/releases/tag/v9.8.7"
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"tag_name":"v9.8.7","html_url":%q}`, page)
	}))
	t.Cleanup(feed.Close)
	srv, hub := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	neko := openStream(t, srv, roomID, "client-neko", "ねこ")
	next(t, neko)
	next(t, neko)

	// A member in a room hears of the release as soon as the server finds it.
	hub.checkRelease(context.Background(), feed.Client(), feed.URL)
	if ev := next(t, neko); ev.name != "release" || ev.data["version"] != "9.8.7" || ev.data["url"] != page {
		t.Errorf("event %s %v; want the release 9.8.7", ev.name, ev.data)
	}
	// A member who joins later hears of it right after hello.
	inu := openStream(t, srv, roomID, "client-inu", "いぬ")
	next(t, inu)
	if ev := next(t, inu); ev.name != "release" || ev.data["version"] != "9.8.7" {
		t.Errorf("event %s %v; want the release after hello", ev.name, ev.data)
	}
	next(t, neko) // いぬ joined
	// The same release is told once.
	hub.checkRelease(context.Background(), feed.Client(), feed.URL)
	select {
	case ev := <-neko:
		t.Errorf("event %s %v after the same release; want none", ev.name, ev.data)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestTheCreatorIsTheHost(t *testing.T) {
	srv, _ := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	neko := openStream(t, srv, roomID, "client-neko", "ねこ")
	nekoID := next(t, neko).data["memberId"]
	if room := next(t, neko); room.data["hostId"] != nekoID || room.data["participantControl"] != true {
		t.Errorf("hostId = %v, participantControl = %v; want ねこ's member ID, and true in a new room", room.data["hostId"], room.data["participantControl"])
	}

	inu := openStream(t, srv, roomID, "client-inu", "いぬ")
	inuSession := next(t, inu).data["sessionId"].(string)
	resp, body := post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{"sessionId": inuSession, "type": "participantControl", "value": false})
	if resp.StatusCode != http.StatusForbidden || body["error"] != "host_only" {
		t.Errorf("participantControl by a participant: status %d, body %v; want 403 host_only", resp.StatusCode, body)
	}
}

func TestHostClosesTheRoom(t *testing.T) {
	srv, _ := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	neko := openStream(t, srv, roomID, "client-neko", "ねこ")
	nekoSession := next(t, neko).data["sessionId"].(string)
	next(t, neko)
	inu := openStream(t, srv, roomID, "client-inu", "いぬ")
	inuSession := next(t, inu).data["sessionId"].(string)
	next(t, inu)
	next(t, neko) // いぬ joined

	resp, body := post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{"sessionId": inuSession, "type": "close"})
	if resp.StatusCode != http.StatusForbidden || body["error"] != "host_only" {
		t.Fatalf("close by a participant: status %d, body %v; want 403 host_only", resp.StatusCode, body)
	}
	resp, body = post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{"sessionId": nekoSession, "type": "close"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("close by the host: status %d, body %v", resp.StatusCode, body)
	}
	for _, events := range []<-chan event{neko, inu} {
		if ev := next(t, events); ev.name != "closed" {
			t.Errorf("event = %+v; want closed", ev)
		}
		select {
		case _, open := <-events:
			if open {
				t.Errorf("the stream went on after the room was closed")
			}
		case <-time.After(5 * time.Second):
			t.Errorf("the stream did not end after the room was closed")
		}
	}
	resp, body = post(t, srv.URL+"/api/rooms/"+roomID+"/stream", map[string]string{"clientId": "client-inu", "name": "いぬ"})
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("joining a closed room: status %d, body %v; want 404", resp.StatusCode, body)
	}
}

func TestCommandsNeedAnOpenSession(t *testing.T) {
	srv, _ := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	resp, body := post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{"sessionId": "guess", "type": "seek", "position": 1})
	if resp.StatusCode != http.StatusForbidden || body["error"] != "not_member" {
		t.Errorf("status %d, body %v; want 403 not_member", resp.StatusCode, body)
	}
}

func TestOnlyYouTubeMusicMayReadResponses(t *testing.T) {
	srv, _ := newTestServer(t)

	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/api/rooms", nil)
	req.Header.Set("Origin", allowedOrigin)
	req.Header.Set("Access-Control-Request-Method", "POST")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent ||
		resp.Header.Get("Access-Control-Allow-Origin") != allowedOrigin ||
		resp.Header.Get("Access-Control-Allow-Headers") != "Content-Type, Authorization" {
		t.Errorf("preflight: status %d, headers %v", resp.StatusCode, resp.Header)
	}

	req, _ = http.NewRequest(http.MethodGet, srv.URL+"/api/time", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("another origin was allowed: %q", got)
	}
}

func TestTheAPINeedsTheToken(t *testing.T) {
	srv, _ := newTestServer(t)
	get := func(path, authorization string) (*http.Response, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		req.Header.Set("Origin", allowedOrigin)
		if authorization != "" {
			req.Header.Set("Authorization", authorization)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		json.NewDecoder(resp.Body).Decode(&out)
		return resp, out
	}

	for _, authorization := range []string{"", "Bearer wrong-token-1", testToken, "Bearer " + testToken + "x"} {
		resp, body := get("/api/time", authorization)
		if resp.StatusCode != http.StatusUnauthorized || body["error"] != "unauthorized" {
			t.Errorf("Authorization %q: status %d, body %v; want 401 unauthorized", authorization, resp.StatusCode, body)
		}
		if resp.Header.Get("WWW-Authenticate") != "Bearer" {
			t.Errorf("Authorization %q: WWW-Authenticate = %q; want Bearer", authorization, resp.Header.Get("WWW-Authenticate"))
		}
		// The extension reads the reason to tell the member that the token is wrong.
		if resp.Header.Get("Access-Control-Allow-Origin") != allowedOrigin {
			t.Errorf("Authorization %q: YouTube Music cannot read the error", authorization)
		}
	}

	if resp, _ := get("/api/time", "Bearer "+testToken); resp.StatusCode != http.StatusOK {
		t.Errorf("with the token: status %d; want 200", resp.StatusCode)
	}

	data, _ := json.Marshal(map[string]string{"clientId": "client-neko"})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/rooms", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("creating a room without the token: status %d; want 401", resp.StatusCode)
	}

	// The index page answers health checks, which carry no token.
	if resp, _ := get("/", ""); resp.StatusCode != http.StatusOK {
		t.Errorf("index without the token: status %d; want 200", resp.StatusCode)
	}
}

func TestRoomCreationIsLimitedPerAddress(t *testing.T) {
	srv, _ := newTestServer(t)
	for range roomCreationsPerHour {
		createRoom(t, srv, "client-neko")
	}
	resp, body := post(t, srv.URL+"/api/rooms", map[string]string{"clientId": "client-neko"})
	if resp.StatusCode != http.StatusTooManyRequests || body["error"] != "rate_limited" {
		t.Errorf("status %d, body %v; want 429 rate_limited", resp.StatusCode, body)
	}
}

func TestTheRoomPlaysWhileAnyoneListens(t *testing.T) {
	srv, _ := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	neko := openStream(t, srv, roomID, "client-neko", "ねこ")
	nekoSession := next(t, neko).data["sessionId"].(string)
	next(t, neko)
	inu := openStream(t, srv, roomID, "client-inu", "いぬ")
	inuSession := next(t, inu).data["sessionId"].(string)
	next(t, inu)
	next(t, neko) // いぬ joined
	command := func(session string, body map[string]any) {
		t.Helper()
		body["sessionId"] = session
		if resp, out := post(t, srv.URL+"/api/rooms/"+roomID+"/commands", body); resp.StatusCode != http.StatusOK {
			t.Fatalf("%v: status %d, body %v", body, resp.StatusCode, out)
		}
	}
	playing := func(events <-chan event) bool {
		t.Helper()
		playback, _ := next(t, events).data["playback"].(map[string]any)
		return playback["playing"] == true
	}

	command(nekoSession, map[string]any{"type": "add", "track": testTrack("aaaaaaaaaaa")})
	if !playing(neko) || !playing(inu) {
		t.Fatalf("the room did not start the song")
	}
	// One member pausing their own player leaves the room playing for the
	// other, and everyone sees who stopped.
	command(nekoSession, map[string]any{"type": "listening", "value": false})
	for _, events := range []<-chan event{neko, inu} {
		ev := next(t, events)
		if playback, _ := ev.data["playback"].(map[string]any); playback["playing"] != true {
			t.Fatalf("the room stopped while いぬ was listening")
		}
		if got := listeners(ev); got["ねこ"] || !got["いぬ"] {
			t.Errorf("listening = %v; want いぬ only", got)
		}
	}
	// With nobody listening, the room stops where it is.
	command(inuSession, map[string]any{"type": "listening", "value": false})
	if playing(neko) || playing(inu) {
		t.Fatalf("the room played on with nobody listening")
	}
	// Listening again starts it from there.
	command(nekoSession, map[string]any{"type": "listening", "value": true})
	if !playing(neko) || !playing(inu) {
		t.Fatalf("the room did not play again for a listener")
	}

	resp, body := post(t, srv.URL+"/api/rooms/"+roomID+"/commands", map[string]any{"sessionId": nekoSession, "type": "listening"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("listening without a value: status %d, body %v; want 400", resp.StatusCode, body)
	}
}

func TestJoiningToListenStartsAPausedRoom(t *testing.T) {
	srv, hub := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	room := hub.room(roomID)
	room.mu.Lock()
	room.state.Apply(Command{Type: "add", Track: testTrack("aaaaaaaaaaa")}, host, 0)
	room.state.PauseAt(5_000)
	room.mu.Unlock()

	// A member who has paused their own player comes back without starting the room.
	neko := stream(t, srv, roomID, map[string]any{"clientId": "client-neko", "name": "ねこ", "listening": false})
	next(t, neko)
	if playback, _ := next(t, neko).data["playback"].(map[string]any); playback["playing"] != false {
		t.Fatalf("playback = %v; want paused", playback)
	}
	inu := openStream(t, srv, roomID, "client-inu", "いぬ")
	next(t, inu)
	if playback, _ := next(t, inu).data["playback"].(map[string]any); playback["playing"] != true || playback["position"] != 5.0 {
		t.Errorf("playback = %v; want playing from 5 seconds", playback)
	}
}

func TestTheRoomWaitsForAListenerWhoLostTheConnection(t *testing.T) {
	srv, hub := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	log := slog.New(newLogHandler(io.Discard, "json", slog.LevelInfo))
	room, sess, err := hub.Join(roomID, "client-neko", "ねこ", true, log)
	if err != nil {
		t.Fatal(err)
	}
	if err := hub.Command(roomID, sess.ID, Command{Type: "add", Track: testTrack("aaaaaaaaaaa")}); err != nil {
		t.Fatal(err)
	}
	hub.Leave(room, sess, log)
	room.mu.Lock()
	waiting, playing := room.graceTimer != nil, room.state.Playback.Playing
	room.stopGraceLocked()
	room.mu.Unlock()
	if !waiting || !playing {
		t.Errorf("after the listener left: waiting = %v, playing = %v; want the room playing while it waits", waiting, playing)
	}
}

func TestARoomNobodyListensToIsPausedWhereItWas(t *testing.T) {
	srv, hub := newTestServer(t)
	roomID := createRoom(t, srv, "client-neko")
	room := hub.room(roomID)
	room.mu.Lock()
	room.state.Apply(Command{Type: "add", Track: testTrack("aaaaaaaaaaa")}, host, 0)
	room.mu.Unlock()

	hub.now = func() time.Time { return time.UnixMilli(12_000) }
	hub.pauseIfNobodyListens(room)

	if want := (Playback{Playing: false, Position: 12, UpdatedAt: 12_000}); room.state.Playback != want {
		t.Errorf("Playback = %+v; want %+v", room.state.Playback, want)
	}
}

func TestRoomsSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st := State{ID: "ABCDE", CreatedAt: 1, LastActiveAt: 2, Version: 3, NextItemID: 1, Queue: []Item{}}
	st.Apply(Command{Type: "add", Track: testTrack("aaaaaaaaaaa")}, host, 10)
	if err := store.Save(st); err != nil {
		t.Fatal(err)
	}
	leftover := filepath.Join(dir, "rooms", "ABCDE.123.tmp")
	if err := os.WriteFile(leftover, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}

	states, err := store.LoadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 1 || states[0].Current == nil || states[0].Current.VideoID != "aaaaaaaaaaa" || states[0].Version != st.Version {
		t.Errorf("LoadAll = %+v; want the saved room", states)
	}
	if _, err := os.Stat(leftover); !os.IsNotExist(err) {
		t.Errorf("the leftover temporary file was not removed")
	}
}

func TestLogLineFormats(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(newLogHandler(&buf, "json", slog.LevelInfo)).With("requestId", "abc")
	log.Info("Room created", "count", 3)
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("JSON line %q: %v", buf.String(), err)
	}
	for key, want := range map[string]any{"level": "INFO", "message": "Room created", "requestId": "abc", "service": serviceName, "count": 3.0} {
		if line[key] != want {
			t.Errorf("%s = %v; want %v", key, line[key], want)
		}
	}
	if ts, _ := line["timestamp"].(string); len(ts) != len("2026-09-22T12:30:45.123Z") || !strings.HasSuffix(ts, "Z") {
		t.Errorf("timestamp = %q; want UTC with milliseconds", ts)
	}

	buf.Reset()
	text := slog.New(newLogHandler(&buf, "text", slog.LevelInfo))
	text.Info("Server stopped")
	fields := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\t")
	if len(fields) != 5 || fields[1] != "-" || fields[2] != "INFO" || fields[3] != "Server stopped" || fields[4] != "-" {
		t.Errorf("text line = %q; want timestamp, -, INFO, message, -", buf.String())
	}
}
