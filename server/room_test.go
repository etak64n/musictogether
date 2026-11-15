package main

import (
	"errors"
	"math"
	"testing"
)

var (
	host  = member{ID: "host-member", Name: "ねこ"}
	guest = member{ID: "guest-member", Name: "いぬ"}
)

func newState() State {
	return State{ID: "ABCDE", HostID: host.ID, Queue: []Item{}}
}

func testTrack(videoID string) *Track {
	return &Track{
		VideoID:   videoID,
		Title:     "Song " + videoID,
		Artists:   "Artist",
		Album:     "Album",
		Duration:  200,
		Thumbnail: "https://lh3.googleusercontent.com/art=w120-h120-l90-rj",
	}
}

func pos(v float64) *float64 { return &v }
func flag(v bool) *bool      { return &v }
func at(v int) *int          { return &v }

func mustApply(t *testing.T, s *State, c Command, by member, now int64) {
	t.Helper()
	changed, err := s.Apply(c, by, now)
	if err != nil || !changed {
		t.Fatalf("Apply(%+v) by %s = %v, %v; want a change", c, by.Name, changed, err)
	}
}

func add(t *testing.T, s *State, videoID string, by member, now int64) {
	t.Helper()
	mustApply(t, s, Command{Type: "add", Track: testTrack(videoID)}, by, now)
}

func TestAddToIdleRoomStartsPlaying(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", guest, 1000)

	if s.Current == nil || s.Current.VideoID != "aaaaaaaaaaa" || s.Current.AddedBy != "いぬ" || s.Current.AddedByID != guest.ID {
		t.Fatalf("Current = %+v; want the song, added by いぬ", s.Current)
	}
	if want := (Playback{Playing: true, Position: 0, UpdatedAt: 1000}); s.Playback != want {
		t.Errorf("Playback = %+v; want %+v", s.Playback, want)
	}
	if len(s.Queue) != 0 {
		t.Errorf("Queue = %+v; want empty", s.Queue)
	}
}

func TestAddWhilePlayingQueuesInOrder(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", host, 1000)
	add(t, &s, "bbbbbbbbbbb", guest, 2000)
	add(t, &s, "aaaaaaaaaaa", guest, 3000)

	if len(s.Queue) != 2 || s.Queue[0].VideoID != "bbbbbbbbbbb" || s.Queue[1].VideoID != "aaaaaaaaaaa" {
		t.Fatalf("Queue = %+v; want b then a", s.Queue)
	}
	if s.Queue[1].ID == s.Current.ID {
		t.Errorf("the same song queued twice shares item ID %q", s.Current.ID)
	}
	if want := (Playback{Playing: true, UpdatedAt: 1000}); s.Playback != want {
		t.Errorf("adding to the queue changed Playback to %+v", s.Playback)
	}
}

func TestNextMovesOnOnceForTheSameSong(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", host, 1000)
	add(t, &s, "bbbbbbbbbbb", host, 1000)
	add(t, &s, "ccccccccccc", host, 1000)
	first := s.Current.ID

	mustApply(t, &s, Command{Type: "next", ItemID: first}, host, 5000)
	changed, err := s.Apply(Command{Type: "next", ItemID: first}, host, 5100)
	if err != nil || changed {
		t.Fatalf("second next for the same song = %v, %v; want no change", changed, err)
	}
	if s.Current.VideoID != "bbbbbbbbbbb" || len(s.Queue) != 1 {
		t.Fatalf("Current = %+v, Queue = %+v; want b playing and c queued", s.Current, s.Queue)
	}
	if want := (Playback{Playing: true, UpdatedAt: 5000}); s.Playback != want {
		t.Errorf("Playback = %+v; want %+v", s.Playback, want)
	}
}

func TestEndedCountsOnlyNearTheEnd(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", host, 0)
	add(t, &s, "bbbbbbbbbbb", host, 0)
	first := s.Current.ID

	if changed, err := s.Apply(Command{Type: "ended", ItemID: first}, guest, 10_000); changed || err != nil {
		t.Fatalf("ended 10 seconds into a 200-second song = %v, %v; want no change", changed, err)
	}
	mustApply(t, &s, Command{Type: "ended", ItemID: first}, guest, 197_000)
	if s.Current.VideoID != "bbbbbbbbbbb" {
		t.Errorf("Current = %+v; want b", s.Current)
	}
	if changed, _ := s.Apply(Command{Type: "ended", ItemID: first}, host, 197_100); changed {
		t.Errorf("a second ended for the same song moved the room again")
	}
}

func TestNextAfterTheLastSongLeavesTheRoomIdle(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", host, 1000)
	mustApply(t, &s, Command{Type: "next", ItemID: s.Current.ID}, host, 2000)

	if s.Current != nil {
		t.Fatalf("Current = %+v; want nil", s.Current)
	}
	if s.Playback.Playing {
		t.Errorf("an idle room is still playing")
	}
	add(t, &s, "bbbbbbbbbbb", guest, 3000)
	if s.Current == nil || s.Current.VideoID != "bbbbbbbbbbb" || !s.Playback.Playing {
		t.Errorf("adding to the idle room did not start the song: %+v %+v", s.Current, s.Playback)
	}
}

func TestResumeAtStartsWherePauseAtStopped(t *testing.T) {
	s := newState()
	if s.ResumeAt(1000) {
		t.Errorf("ResumeAt changed an idle room")
	}
	add(t, &s, "aaaaaaaaaaa", host, 1000)
	if s.ResumeAt(2000) {
		t.Errorf("ResumeAt changed a playing room")
	}
	s.PauseAt(43_500)
	if s.PauseAt(50_000) {
		t.Errorf("PauseAt changed a paused room")
	}
	if got := s.PositionAt(100_000); got != 42.5 {
		t.Errorf("a paused room moved to %v", got)
	}
	if !s.ResumeAt(60_000) {
		t.Fatalf("ResumeAt did not start a paused room")
	}
	if want := (Playback{Playing: true, Position: 42.5, UpdatedAt: 60_000}); s.Playback != want {
		t.Fatalf("after ResumeAt Playback = %+v; want %+v", s.Playback, want)
	}
	if got := s.PositionAt(62_000); got != 44.5 {
		t.Errorf("PositionAt two seconds later = %v; want 44.5", got)
	}
}

func TestParticipantsNeedTheHostsPermissionToSeekAndSkip(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", guest, 0)
	add(t, &s, "bbbbbbbbbbb", guest, 0)
	controls := []Command{
		{Type: "seek", Position: pos(1)},
		{Type: "next", ItemID: s.Current.ID},
	}
	for _, c := range controls {
		if _, err := s.Apply(c, guest, 1000); !errors.Is(err, errHostOnly) {
			t.Errorf("%s by a participant: err = %v; want host_only", c.Type, err)
		}
	}
	if _, err := s.Apply(Command{Type: "participantControl", Value: flag(true)}, guest, 1000); !errors.Is(err, errHostOnly) {
		t.Errorf("a participant changed the permission: err = %v", err)
	}

	mustApply(t, &s, Command{Type: "participantControl", Value: flag(true)}, host, 1000)
	for _, c := range controls {
		mustApply(t, &s, c, guest, 2000)
	}
	mustApply(t, &s, Command{Type: "participantControl", Value: flag(false)}, host, 3000)
	if _, err := s.Apply(Command{Type: "seek", Position: pos(2)}, guest, 3000); !errors.Is(err, errHostOnly) {
		t.Errorf("seek after the permission was taken back: err = %v; want host_only", err)
	}
	if _, err := s.Apply(Command{Type: "participantControl"}, host, 3000); !errors.Is(err, errBadRequest) {
		t.Errorf("participantControl without a value: err = %v; want bad_request", err)
	}
}

func TestParticipantsRemoveOnlyTheirOwnSongs(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", host, 0)
	add(t, &s, "bbbbbbbbbbb", host, 0)
	add(t, &s, "ccccccccccc", guest, 0)
	hostsSong, guestsSong := s.Queue[0].ID, s.Queue[1].ID

	if _, err := s.Apply(Command{Type: "remove", ItemID: hostsSong}, guest, 1000); !errors.Is(err, errHostOnly) {
		t.Errorf("a participant removed the host's song: err = %v", err)
	}
	// The permission to control playback does not cover other members' songs.
	mustApply(t, &s, Command{Type: "participantControl", Value: flag(true)}, host, 1000)
	if _, err := s.Apply(Command{Type: "remove", ItemID: hostsSong}, guest, 1000); !errors.Is(err, errHostOnly) {
		t.Errorf("a participant with control removed the host's song: err = %v", err)
	}
	mustApply(t, &s, Command{Type: "remove", ItemID: guestsSong}, guest, 1000)
	mustApply(t, &s, Command{Type: "remove", ItemID: hostsSong}, host, 1000)
	if len(s.Queue) != 0 {
		t.Errorf("Queue = %+v; want empty", s.Queue)
	}
	if changed, _ := s.Apply(Command{Type: "remove", ItemID: s.Current.ID}, host, 2000); changed {
		t.Errorf("remove took the song that is playing")
	}
}

// queued returns the first letter of each queued song's video ID, in order.
func queued(s *State) string {
	letters := ""
	for _, it := range s.Queue {
		letters += it.VideoID[:1]
	}
	return letters
}

func TestMovePutsTheSongAtTheIndex(t *testing.T) {
	s := newState()
	for _, id := range []string{"aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"} {
		add(t, &s, id, host, 0)
	}
	b, d := s.Queue[0].ID, s.Queue[2].ID

	mustApply(t, &s, Command{Type: "move", ItemID: d, Index: at(0)}, host, 1000)
	if got := queued(&s); got != "dbc" {
		t.Fatalf("after moving d to 0, queue = %s; want dbc", got)
	}
	mustApply(t, &s, Command{Type: "move", ItemID: d, Index: at(99)}, host, 1000)
	if got := queued(&s); got != "bcd" {
		t.Fatalf("after moving d past the end, queue = %s; want bcd", got)
	}
	mustApply(t, &s, Command{Type: "move", ItemID: b, Index: at(1)}, host, 1000)
	if got := queued(&s); got != "cbd" {
		t.Fatalf("after moving b to 1, queue = %s; want cbd", got)
	}
	if s.Current.VideoID != "aaaaaaaaaaa" {
		t.Errorf("moving songs in the queue changed the playing song to %+v", s.Current)
	}

	noChange := map[string]Command{
		"a song to where it is":   {Type: "move", ItemID: b, Index: at(1)},
		"the playing song":        {Type: "move", ItemID: s.Current.ID, Index: at(0)},
		"a song not in the queue": {Type: "move", ItemID: "999", Index: at(0)},
	}
	for name, c := range noChange {
		if changed, err := s.Apply(c, host, 2000); changed || err != nil {
			t.Errorf("moving %s = %v, %v; want no change", name, changed, err)
		}
	}
	if _, err := s.Apply(Command{Type: "move", ItemID: b}, host, 2000); !errors.Is(err, errBadRequest) {
		t.Errorf("move without an index: err = %v; want bad_request", err)
	}
	if _, err := s.Apply(Command{Type: "move", ItemID: b, Index: at(-1)}, host, 2000); !errors.Is(err, errBadRequest) {
		t.Errorf("move to -1: err = %v; want bad_request", err)
	}
}

func TestParticipantsNeedTheHostsPermissionToMoveSongs(t *testing.T) {
	s := newState()
	for _, id := range []string{"aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"} {
		add(t, &s, id, guest, 0)
	}
	move := Command{Type: "move", ItemID: s.Queue[1].ID, Index: at(0)}

	if _, err := s.Apply(move, guest, 1000); !errors.Is(err, errHostOnly) {
		t.Errorf("a participant moved a song without permission: err = %v", err)
	}
	mustApply(t, &s, Command{Type: "participantControl", Value: flag(true)}, host, 1000)
	mustApply(t, &s, move, guest, 2000)
	if got := queued(&s); got != "cb" {
		t.Errorf("queue = %s; want cb", got)
	}
}

func TestSeekIsClampedToTheSong(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", host, 1000)
	mustApply(t, &s, Command{Type: "seek", Position: pos(500)}, host, 2000)
	if s.Playback.Position != 200 || !s.Playback.Playing {
		t.Errorf("Playback = %+v; want playing at the song's end, 200", s.Playback)
	}
}

func TestBadPositionsAreRejected(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", host, 1000)
	for _, p := range []*float64{nil, pos(-1), pos(math.NaN()), pos(math.Inf(1))} {
		if _, err := s.Apply(Command{Type: "seek", Position: p}, host, 2000); !errors.Is(err, errBadRequest) {
			t.Errorf("seek with position %v: err = %v; want bad_request", p, err)
		}
	}
}

func TestQueueHasALimit(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", host, 1000)
	for range maxQueueItems {
		add(t, &s, "bbbbbbbbbbb", host, 1000)
	}
	if _, err := s.Apply(Command{Type: "add", Track: testTrack("ccccccccccc")}, host, 1000); !errors.Is(err, errQueueFull) {
		t.Errorf("err = %v; want queue_full", err)
	}
}

func TestTracksAreChecked(t *testing.T) {
	bad := []Track{
		{VideoID: "short", Title: "Song"},
		{VideoID: "aaaaaaaaaa/", Title: "Song"},
		{VideoID: "aaaaaaaaaaa", Title: " \t "},
	}
	for _, tr := range bad {
		s := newState()
		if _, err := s.Apply(Command{Type: "add", Track: &tr}, host, 1000); !errors.Is(err, errBadRequest) {
			t.Errorf("add %+v: err = %v; want bad_request", tr, err)
		}
	}

	s := newState()
	tr := Track{VideoID: "aaaaaaaaaaa", Title: "  Song\x07  ", Duration: math.NaN(), Thumbnail: "https://example.com/art.png"}
	mustApply(t, &s, Command{Type: "add", Track: &tr}, host, 1000)
	if s.Current.Title != "Song" || s.Current.Duration != 0 || s.Current.Thumbnail != "" {
		t.Errorf("Current = %+v; want the title cleaned, no duration and no thumbnail from a foreign host", s.Current)
	}
}

func TestThumbnailHosts(t *testing.T) {
	tests := map[string]bool{
		"https://lh3.googleusercontent.com/art=w120-h120":  true,
		"https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg": true,
		"https://yt3.ggpht.com/art":                        true,
		"http://lh3.googleusercontent.com/art":             false,
		"https://googleusercontent.com.example.org/art":    false,
		"https://user@lh3.googleusercontent.com/art":       false,
		"javascript:alert(1)":                              false,
		"":                                                 false,
	}
	for raw, want := range tests {
		if got := allowedThumbnail(raw); got != want {
			t.Errorf("allowedThumbnail(%q) = %v; want %v", raw, got, want)
		}
	}
}

func TestPositionAtStopsAtTheEndOfTheSong(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", host, 0)
	if got := s.PositionAt(500_000); got != 200 {
		t.Errorf("PositionAt long after the song = %v; want 200", got)
	}
}

func TestPauseAtFreezesTheTimeline(t *testing.T) {
	s := newState()
	if s.PauseAt(1000) {
		t.Errorf("PauseAt changed an idle room")
	}
	add(t, &s, "aaaaaaaaaaa", host, 0)
	if !s.PauseAt(30_000) {
		t.Fatalf("PauseAt did not pause a playing room")
	}
	if want := (Playback{Playing: false, Position: 30, UpdatedAt: 30_000}); s.Playback != want {
		t.Errorf("Playback = %+v; want %+v", s.Playback, want)
	}
}

func TestUnknownCommandsAreRejected(t *testing.T) {
	s := newState()
	add(t, &s, "aaaaaaaaaaa", host, 0)
	// Pausing and playing are each member's own, not changes to the room.
	for _, typ := range []string{"shuffle", "pause", "play"} {
		if _, err := s.Apply(Command{Type: typ, Position: pos(1)}, host, 1000); !errors.Is(err, errBadRequest) {
			t.Errorf("%s: err = %v; want bad_request", typ, err)
		}
	}
}

func TestNamesAreCleaned(t *testing.T) {
	if _, ok := cleanName(" \n "); ok {
		t.Errorf("an empty name was accepted")
	}
	long := "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも"
	if got, _ := cleanName(long); got != long[:len("あ")*maxNameRunes] {
		t.Errorf("cleanName cut %q to %q", long, got)
	}
}
