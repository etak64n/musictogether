package main

import (
	"strings"
	"testing"
)

func TestConfigNeedsEverySetting(t *testing.T) {
	for _, name := range []string{"ADDR", "DATA_DIR", "LOG_FORMAT", "TOKEN"} {
		t.Setenv(name, "")
	}
	_, err := loadConfig()
	if err == nil {
		t.Fatal("loadConfig succeeded without any setting")
	}
	// Every missing setting is reported at once, each with what to do.
	lines := strings.Split(err.Error(), "\n")
	if len(lines) != 4 {
		t.Fatalf("error = %q; want one line for each of the 4 settings", err)
	}
	for i, name := range []string{"ADDR", "DATA_DIR", "LOG_FORMAT", "TOKEN"} {
		if !strings.HasPrefix(lines[i], "Please set "+name+" ") {
			t.Errorf("line %d = %q; want it to start with %q", i+1, lines[i], "Please set "+name)
		}
	}
}

func TestConfigNeedsATokenThatTheExtensionCanSend(t *testing.T) {
	t.Setenv("ADDR", "127.0.0.1:8080")
	t.Setenv("DATA_DIR", t.TempDir())
	t.Setenv("LOG_FORMAT", "json")
	for _, tc := range []struct {
		token string
		ok    bool
	}{
		{"", false},
		{"short", false},       // fewer than 8 characters
		{"with space1", false}, // a space
		{"トークンはひみつです", false},  // not ASCII
		{"tab\tinside", false}, // a control character
		{"listen-2gether!", true},
		{"12345678", true},
	} {
		t.Setenv("TOKEN", tc.token)
		cfg, err := loadConfig()
		if tc.ok && (err != nil || cfg.token != tc.token) {
			t.Errorf("TOKEN %q: got %+v, %v; want it accepted", tc.token, cfg, err)
		}
		if !tc.ok && (err == nil || !strings.Contains(err.Error(), "TOKEN")) {
			t.Errorf("TOKEN %q: error %v; want it refused", tc.token, err)
		}
	}
}

func TestConfigNeedsAHostAndPortToListenOn(t *testing.T) {
	t.Setenv("DATA_DIR", t.TempDir())
	t.Setenv("LOG_FORMAT", "json")
	t.Setenv("TOKEN", "listen-2gether!")
	for _, tc := range []struct {
		addr string
		ok   bool
	}{
		{"0.0.0.0:8080", true},
		{"127.0.0.1:8080", true},
		{"[::1]:8080", true},
		{"8080", false},      // a port without a host
		{"localhost", false}, // a host without a port
	} {
		t.Setenv("ADDR", tc.addr)
		_, err := loadConfig()
		if tc.ok && err != nil {
			t.Errorf("ADDR %q: %v; want it accepted", tc.addr, err)
		}
		if !tc.ok && (err == nil || !strings.HasPrefix(err.Error(), "Please set ADDR ")) {
			t.Errorf("ADDR %q: error %v; want it refused", tc.addr, err)
		}
	}
}
