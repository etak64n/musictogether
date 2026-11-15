package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
)

// The room server can tell every member when a newer release of Music
// Together is out, so that their extensions show it at once, in place of
// finding it on their own once a day. It asks the GitHub API for the latest
// release when RELEASES_URL is set, and never otherwise.
const (
	releaseInterval = 10 * time.Minute
	releaseTimeout  = 15 * time.Second
	maxReleaseBytes = 1 << 20
)

var releaseVersionPattern = regexp.MustCompile(`^\d+(\.\d+)*$`)

// release is the latest release that the server has found: its version, such
// as 0.3.6, and the address of its page.
type release struct {
	Version string `json:"version"`
	URL     string `json:"url"`
}

// WatchReleases asks url for the latest release at once and then every
// releaseInterval, until ctx ends.
func (h *Hub) WatchReleases(ctx context.Context, url string) {
	client := &http.Client{Timeout: releaseTimeout}
	h.checkRelease(ctx, client, url)
	ticker := time.NewTicker(releaseInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.checkRelease(ctx, client, url)
		}
	}
}

// checkRelease asks for the latest release once, and tells every member when
// it differs from the one the server knew.
func (h *Hub) checkRelease(ctx context.Context, client *http.Client, url string) {
	found, err := fetchRelease(ctx, client, url)
	if err != nil {
		h.log.Warn("Release check failed", "errorType", fmt.Sprintf("%T", err), "errorMessage", err.Error())
		return
	}
	if known := h.release.Load(); known != nil && *known == *found {
		return
	}
	h.release.Store(found)
	h.log.Info("Release found", "releaseVersion", found.Version)
	h.broadcastRelease(found)
}

func fetchRelease(ctx context.Context, client *http.Client, url string) (*release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "musictogether-server/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the release answered with the status %d", resp.StatusCode)
	}
	var body struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxReleaseBytes)).Decode(&body); err != nil {
		return nil, err
	}
	v := strings.TrimPrefix(body.TagName, "v")
	if !releaseVersionPattern.MatchString(v) {
		return nil, errors.New("the release has no version in its tag")
	}
	return &release{Version: v, URL: body.HTMLURL}, nil
}

// releaseFrame is the event that tells of the latest release, or false while
// the server knows none.
func (h *Hub) releaseFrame() ([]byte, bool) {
	known := h.release.Load()
	if known == nil {
		return nil, false
	}
	return h.frame("release", known)
}

// broadcastRelease sends the latest release to every session of every room.
func (h *Hub) broadcastRelease(found *release) {
	data, ok := h.frame("release", found)
	if !ok {
		return
	}
	h.mu.Lock()
	rooms := slices.Collect(maps.Values(h.rooms))
	h.mu.Unlock()
	for _, room := range rooms {
		room.mu.Lock()
		for s := range room.sessions {
			select {
			case s.out <- data:
			default:
				s.close()
			}
		}
		room.mu.Unlock()
	}
}
