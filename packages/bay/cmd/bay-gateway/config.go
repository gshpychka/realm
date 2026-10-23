package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// config is the gateway's JSON configuration file.
type config struct {
	// IdentitySocket is the unix socket the identity API is served on.
	IdentitySocket string `json:"identitySocket"`
	// Database is the path of the message store's SQLite file.
	Database string `json:"database"`
	// Ntfy enables alerts through an ntfy topic; without it alerts are logged only.
	Ntfy *ntfyConfig `json:"ntfy,omitempty"`
}

type ntfyConfig struct {
	URL   string `json:"url"`
	Topic string `json:"topic"`
}

// tokenCredential is the systemd credential holding the ntfy access token.
const tokenCredential = "ntfy-token"

func loadConfig(path string) (config, error) {
	f, err := os.Open(path)
	if err != nil {
		return config{}, err
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	dec.DisallowUnknownFields()
	var c config
	if err := dec.Decode(&c); err != nil {
		return config{}, fmt.Errorf("config %s: %w", path, err)
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
		return config{}, fmt.Errorf("config %s: expected one JSON object", path)
	}
	switch {
	case c.IdentitySocket == "":
		return config{}, errors.New("config: identitySocket is required")
	case c.Database == "":
		return config{}, errors.New("config: database is required")
	case c.Ntfy != nil && (c.Ntfy.URL == "" || c.Ntfy.Topic == ""):
		return config{}, errors.New("config: ntfy needs a url and a topic")
	}
	return c, nil
}

// readToken returns the ntfy access token from the service's credentials directory.
func readToken() (string, error) {
	dir := os.Getenv("CREDENTIALS_DIRECTORY")
	if dir == "" {
		return "", errors.New("CREDENTIALS_DIRECTORY is not set")
	}
	data, err := os.ReadFile(filepath.Join(dir, tokenCredential))
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", fmt.Errorf("credential %s is empty", tokenCredential)
	}
	return token, nil
}
