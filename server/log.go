package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync"
)

const serviceName = "musictogether"

// logHandler writes one log line per record, in one of two formats: one JSON
// object per line, or tab-separated columns of timestamp, requestId, level,
// message and the other keys as one JSON object. Timestamps are in UTC.
type logHandler struct {
	mu    *sync.Mutex
	w     io.Writer
	json  bool
	level slog.Level
	attrs []slog.Attr
}

func newLogHandler(w io.Writer, format string, level slog.Level) *logHandler {
	return &logHandler{mu: &sync.Mutex{}, w: w, json: format == "json", level: level}
}

func (h *logHandler) Enabled(_ context.Context, level slog.Level) bool { return level >= h.level }

func (h *logHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	c := *h
	c.attrs = append(slices.Clip(h.attrs), attrs...)
	return &c
}

// WithGroup is not used by this program, so groups are not kept.
func (h *logHandler) WithGroup(string) slog.Handler { return h }

func (h *logHandler) Handle(_ context.Context, r slog.Record) error {
	requestID := "-"
	var extra []slog.Attr
	add := func(a slog.Attr) bool {
		if a.Key == "requestId" {
			requestID = a.Value.String()
		} else {
			extra = append(extra, a)
		}
		return true
	}
	for _, a := range h.attrs {
		add(a)
	}
	r.Attrs(add)

	timestamp := r.Time.UTC().Format("2006-01-02T15:04:05.000Z")
	level := levelName(r.Level)
	var buf bytes.Buffer
	if h.json {
		buf.WriteByte('{')
		writeField(&buf, "timestamp", timestamp, true)
		writeField(&buf, "level", level, false)
		writeField(&buf, "message", r.Message, false)
		writeField(&buf, "requestId", requestID, false)
		writeField(&buf, "service", serviceName, false)
		for _, a := range extra {
			writeField(&buf, a.Key, a.Value.Resolve().Any(), false)
		}
		buf.WriteString("}\n")
	} else {
		buf.WriteString(timestamp + "\t" + requestID + "\t" + level + "\t" + r.Message + "\t")
		if len(extra) == 0 {
			buf.WriteByte('-')
		} else {
			buf.WriteByte('{')
			for i, a := range extra {
				writeField(&buf, a.Key, a.Value.Resolve().Any(), i == 0)
			}
			buf.WriteByte('}')
		}
		buf.WriteByte('\n')
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := h.w.Write(buf.Bytes())
	return err
}

func writeField(buf *bytes.Buffer, key string, value any, first bool) {
	if !first {
		buf.WriteByte(',')
	}
	k, _ := json.Marshal(key)
	v, err := json.Marshal(value)
	if err != nil {
		v, _ = json.Marshal(fmt.Sprint(value))
	}
	buf.Write(k)
	buf.WriteByte(':')
	buf.Write(v)
}

func levelName(level slog.Level) string {
	switch {
	case level >= slog.LevelError:
		return "ERROR"
	case level >= slog.LevelWarn:
		return "WARN"
	case level >= slog.LevelInfo:
		return "INFO"
	default:
		return "DEBUG"
	}
}
