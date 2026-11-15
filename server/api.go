package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"
)

// The extension calls the server from its content script on YouTube Music,
// so requests carry YouTube Music's origin.
const allowedOrigin = "https://music.youtube.com"

// The largest body is the command addTracks with the songs of a long playlist:
// up to 200 songs of about 1 KiB each, and far less in practice.
const maxBodyBytes = 512 << 10

// apiError is an error that the client is told about, with its HTTP status and
// a machine-readable reason.
type apiError struct {
	status int
	reason string
}

func (e *apiError) Error() string { return e.reason }

var (
	errBadRequest   = &apiError{http.StatusBadRequest, "bad_request"}
	errUnauthorized = &apiError{http.StatusUnauthorized, "unauthorized"}
	errNotMember    = &apiError{http.StatusForbidden, "not_member"}
	errHostOnly     = &apiError{http.StatusForbidden, "host_only"}
	errRoomNotFound = &apiError{http.StatusNotFound, "room_not_found"}
	errQueueFull    = &apiError{http.StatusConflict, "queue_full"}
	errRateLimited  = &apiError{http.StatusTooManyRequests, "rate_limited"}
	errTooManyRooms = &apiError{http.StatusServiceUnavailable, "too_many_rooms"}
	errRoomFull     = &apiError{http.StatusServiceUnavailable, "room_full"}
	errServerFull   = &apiError{http.StatusServiceUnavailable, "server_full"}
)

// Handler routes the HTTP API. Every API call needs the server's token; the
// index page and the CORS preflight requests, which browsers send without it,
// do not.
func (h *Hub) Handler(token string) http.Handler {
	auth := authorized(token)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", h.handleIndex)
	mux.HandleFunc("GET /api/time", auth(h.handleTime))
	mux.HandleFunc("POST /api/rooms", auth(h.handleCreate))
	mux.HandleFunc("POST /api/rooms/{id}/stream", auth(h.handleStream))
	mux.HandleFunc("POST /api/rooms/{id}/commands", auth(h.handleCommand))
	mux.HandleFunc("OPTIONS /api/", h.handlePreflight)
	return h.withCommon(mux)
}

// authorized lets a request through only when it carries the token as a
// bearer token. Both sides are hashed first, so that the comparison takes the
// same time whatever was sent, and tells nothing about the token's length.
func authorized(token string) func(http.HandlerFunc) http.HandlerFunc {
	want := sha256.Sum256([]byte("Bearer " + token))
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			got := sha256.Sum256([]byte(r.Header.Get("Authorization")))
			if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
				w.Header().Set("WWW-Authenticate", "Bearer")
				writeError(w, r, errUnauthorized)
				return
			}
			next(w, r)
		}
	}
}

func (h *Hub) handleIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, "Music Together server "+version+"\n")
}

// handleTime returns the server clock, which clients use to place the room's timeline on their own clocks.
func (h *Hub) handleTime(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]int64{"now": h.now().UnixMilli()})
}

func (h *Hub) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientID string `json:"clientId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, errBadRequest)
		return
	}
	id, err := h.CreateRoom(clientAddr(r), req.ClientID, loggerFrom(r.Context()))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"roomId": id})
}

// handleStream keeps a server-sent event stream open for as long as the member
// is in the room. Closing the stream is how a member leaves.
func (h *Hub) handleStream(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientID string `json:"clientId"`
		Name     string `json:"name"`
		// Listening is false when a member who has paused their own player
		// joins again, as after a lost connection. Joining means listening.
		Listening *bool `json:"listening"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, errBadRequest)
		return
	}
	log := loggerFrom(r.Context())
	listening := req.Listening == nil || *req.Listening
	room, sess, err := h.Join(r.PathValue("id"), req.ClientID, req.Name, listening, log)
	if err != nil {
		writeError(w, r, err)
		return
	}
	defer h.Leave(room, sess, log)

	rc := http.NewResponseController(w)
	rc.SetReadDeadline(time.Time{})
	rc.SetWriteDeadline(time.Time{})
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-store, no-transform")
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if rc.Flush() != nil {
		return
	}
	heartbeat := time.NewTicker(heartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case data := <-sess.out:
			if _, err := w.Write(data); err != nil {
				return
			}
		case <-heartbeat.C:
			// Proxies close connections that stay silent; a comment line keeps this one open.
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
		case <-sess.done:
			// Deliver what was sent before the session ended, such as the news
			// that the host closed the room.
			for {
				select {
				case data := <-sess.out:
					if _, err := w.Write(data); err != nil {
						return
					}
				default:
					rc.Flush()
					return
				}
			}
		case <-r.Context().Done():
			return
		}
		if rc.Flush() != nil {
			return
		}
	}
}

func (h *Hub) handleCommand(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"sessionId"`
		Command
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, errBadRequest)
		return
	}
	// The answer to addTracks also tells how many songs the queue took.
	answer := map[string]any{"ok": true}
	var err error
	switch req.Type {
	case "close":
		err = h.CloseRoom(r.PathValue("id"), req.SessionID, loggerFrom(r.Context()))
	case "addTracks":
		var added int
		added, err = h.AddTracks(r.PathValue("id"), req.SessionID, req.Tracks)
		answer["added"] = added
	default:
		err = h.Command(r.PathValue("id"), req.SessionID, req.Command)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, answer)
}

// handlePreflight answers CORS preflight requests. The extension sends JSON
// and the token, which makes the browser ask first.
func (h *Hub) handlePreflight(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") == allowedOrigin {
		header := w.Header()
		header.Set("Access-Control-Allow-Methods", "GET, POST")
		header.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		header.Set("Access-Control-Max-Age", "86400")
	}
	w.WriteHeader(http.StatusNoContent)
}

// withCommon gives every request a request ID and a logger, lets YouTube
// Music's pages read the response, limits the body size and logs the result.
func (h *Hub) withCommon(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// Behind Cloudflare, the Ray ID ties this log line to Cloudflare's own logs.
		requestID := r.Header.Get("Cf-Ray")
		if requestID == "" {
			requestID = strings.ToLower(rand.Text()[:16])
		}
		log := h.log.With("requestId", requestID)
		if r.Header.Get("Origin") == allowedOrigin {
			w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			w.Header().Add("Vary", "Origin")
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		req := r.WithContext(context.WithValue(r.Context(), loggerKey{}, log))
		next.ServeHTTP(sw, req)

		// Every client checks the clock regularly; those lines only matter when debugging.
		level := slog.LevelInfo
		if req.Pattern == "GET /api/time" {
			level = slog.LevelDebug
		}
		log.Log(r.Context(), level, "Request completed",
			"method", r.Method, "path", routeOf(req), "status", sw.status, "durationMs", time.Since(start).Milliseconds())
	})
}

// routeOf names the route instead of the raw path, so that room IDs, which
// let anyone join a room, stay out of the logs.
func routeOf(r *http.Request) string {
	if r.Pattern == "" {
		return "-"
	}
	if _, route, ok := strings.Cut(r.Pattern, " "); ok {
		return route
	}
	return r.Pattern
}

type loggerKey struct{}

func loggerFrom(ctx context.Context) *slog.Logger {
	if log, ok := ctx.Value(loggerKey{}).(*slog.Logger); ok {
		return log
	}
	return slog.Default()
}

// statusWriter remembers the status code for the log. Unwrap lets
// http.ResponseController reach the underlying writer to flush streams.
type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wroteHeader {
		w.status = code
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	w.wroteHeader = true
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		writeJSON(w, ae.status, map[string]string{"error": ae.reason})
		return
	}
	loggerFrom(r.Context()).Error("Request failed", "errorType", fmt.Sprintf("%T", err), "errorMessage", err.Error())
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
}

// clientAddr is the address that room creation is counted against. Behind
// Cloudflare, it is the visitor's address from CF-Connecting-IP.
func clientAddr(r *http.Request) string {
	if ip := r.Header.Get("Cf-Connecting-Ip"); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
