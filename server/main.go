// Command musictogether is the room server of Music Together. It keeps each
// room's queue and shared timeline and streams every change to the members.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const version = "0.3.0"

// minTokenLength keeps the token from being one that is quick to guess.
const minTokenLength = 8

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "musictogether:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	// Lines that belong to no request carry an ID of this run of the process.
	log := slog.New(newLogHandler(os.Stderr, cfg.logFormat, slog.LevelInfo)).
		With("requestId", strings.ToLower(rand.Text()[:16]))

	store, err := OpenStore(cfg.dataDir)
	if err != nil {
		return err
	}
	states, err := store.LoadAll()
	if err != nil {
		return err
	}
	hub := NewHub(store, log, states)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go hub.RunCleanup(ctx)

	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           hub.Handler(cfg.token),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	log.Info("Server started", "addr", cfg.addr, "version", version, "count", len(states))

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	// Streams never end on their own, so they are closed before the server waits for requests to finish.
	hub.CloseAll()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	log.Info("Server stopped")
	return nil
}

type config struct {
	addr      string
	dataDir   string
	logFormat string
	token     string
}

// loadConfig reads the settings from environment variables. Every one of them
// is required, so the server never runs on a value that nobody wrote down. It
// reports every setting that is missing or wrong at once.
func loadConfig() (config, error) {
	cfg := config{
		addr:      os.Getenv("ADDR"),
		dataDir:   os.Getenv("DATA_DIR"),
		logFormat: os.Getenv("LOG_FORMAT"),
		token:     os.Getenv("TOKEN"),
	}
	var problems []error
	if cfg.addr == "" {
		problems = append(problems, errors.New("Please set ADDR to the address to listen on, such as :8080."))
	}
	if cfg.dataDir == "" {
		problems = append(problems, errors.New("Please set DATA_DIR to the directory to keep the rooms in, such as /data."))
	}
	if cfg.logFormat != "json" && cfg.logFormat != "text" {
		problems = append(problems, errors.New("Please set LOG_FORMAT to json or text."))
	}
	if !validToken(cfg.token) {
		problems = append(problems, fmt.Errorf("Please set TOKEN to the token that members enter in the extension: at least %d ASCII letters, digits or symbols, without spaces.", minTokenLength))
	}
	return cfg, errors.Join(problems...)
}

// validToken tells whether the token can travel in an HTTP header as the
// extension sends it, and is long enough.
func validToken(token string) bool {
	if len(token) < minTokenLength {
		return false
	}
	for _, c := range token {
		if c < '!' || c > '~' {
			return false
		}
	}
	return true
}
