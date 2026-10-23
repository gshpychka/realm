// Command bay-server is the Bay server: it owns sessions and their records, and serves the operator's API and the
// gateway's identity lookups.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/activation"
	"github.com/gshpychka/realm/packages/bay/internal/api"
	"github.com/gshpychka/realm/packages/bay/internal/guest"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/incus"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/records"
	"github.com/gshpychka/realm/packages/bay/internal/repos"
	"github.com/gshpychka/realm/packages/bay/internal/sessions"
	"github.com/gshpychka/realm/packages/bay/internal/wire"
)

// Config is the server's configuration file.
type Config struct {
	IncusSocket string `json:"incusSocket"`
	Project     string `json:"project"`
	// Base names the warm base instance every session's instance is cloned from.
	Base          string             `json:"base"`
	Records       string             `json:"records"`
	Mirrors       string             `json:"mirrors"`
	MirrorRefresh duration           `json:"mirrorRefresh"`
	GatewaySocket string             `json:"gatewaySocket"`
	MaxRunning    int                `json:"maxRunning"`
	Programs      map[string]Program `json:"programs"`
}

// Program is a program definition as configured.
type Program struct {
	Command []string `json:"command"`
	Resume  []string `json:"resume"`
	History []string `json:"history"`
	Monitor bool     `json:"monitor"`
}

type duration struct{ time.Duration }

func (d *duration) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	parsed, err := time.ParseDuration(s)
	d.Duration = parsed
	return err
}

// remoteBase is where the repos sessions work on live.
const remoteBase = "https://github.com/"

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(log)
	if err := run(os.Args[1:], log); err != nil {
		log.Error("bay-server failed", "err", err)
		os.Exit(1)
	}
}

func run(args []string, log *slog.Logger) error {
	if len(args) > 0 && args[0] == "base" {
		return base(args[1:], log)
	}
	flags := flag.NewFlagSet("bay-server", flag.ContinueOnError)
	configPath := flags.String("config", "", "configuration file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	config, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if err := validateServeConfig(config); err != nil {
		return fmt.Errorf("config %s: %w", *configPath, err)
	}
	return serve(config, log)
}

func loadConfig(file string) (Config, error) {
	if file == "" {
		return Config{}, errors.New("-config is required")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return Config{}, err
	}
	var config Config
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&config); err != nil {
		return Config{}, fmt.Errorf("config %s: %w", file, err)
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
		return Config{}, fmt.Errorf("config %s: expected one JSON object", file)
	}
	for _, field := range []struct{ name, value string }{
		{"incusSocket", config.IncusSocket}, {"project", config.Project}, {"base", config.Base},
	} {
		if field.value == "" {
			return Config{}, fmt.Errorf("config %s: %s is required", file, field.name)
		}
	}
	return config, nil
}

func validateServeConfig(config Config) error {
	for _, field := range []struct{ name, value string }{
		{"records", config.Records}, {"mirrors", config.Mirrors}, {"gatewaySocket", config.GatewaySocket},
	} {
		if field.value == "" {
			return fmt.Errorf("%s is required", field.name)
		}
	}
	if config.MaxRunning < 1 || config.MirrorRefresh.Duration < 0 {
		return errors.New("maxRunning must be positive and mirrorRefresh must not be negative")
	}
	return nil
}

func serve(config Config, log *slog.Logger) error {
	store, err := records.Open(config.Records)
	if err != nil {
		return err
	}
	driver, err := incus.Connect(config.IncusSocket, config.Project, config.Base)
	if err != nil {
		return err
	}
	mirrors, err := repos.New(config.Mirrors, remoteBase)
	if err != nil {
		return err
	}
	programs := map[string]sessions.Program{}
	for name, p := range config.Programs {
		programs[name] = sessions.Program{Command: p.Command, Resume: p.Resume, History: p.History, Monitor: p.Monitor}
	}
	svc, err := sessions.New(store, driver, mirrors, sessions.Config{
		Programs:   programs,
		MaxRunning: config.MaxRunning,
		Reserved:   append(driver.Reserved(), messages.Operator),
	}, log)
	if err != nil {
		return err
	}

	sockets, err := activation.Passed()
	if err != nil {
		return err
	}
	apiListener, err := sockets.Listener("api")
	if err != nil {
		return err
	}
	identityListener, err := sockets.Listener("identity")
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go refreshMirrors(ctx, mirrors, config.MirrorRefresh.Duration, log)

	servers := []*http.Server{
		{Handler: api.Handler(operatorAPI{svc}, messagesProxy(config.GatewaySocket))},
		{Handler: identity.Handler(resolver{svc})},
	}
	errs := make(chan error, len(servers))
	for i, l := range []net.Listener{apiListener, identityListener} {
		go func() { errs <- servers[i].Serve(l) }()
	}
	log.Info("bay-server serving", "project", config.Project)
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	return shutdown(servers)
}

// shutdown stops each server from accepting connections and returns once every request in flight has finished, however
// long it runs.
func shutdown(servers []*http.Server) error {
	var errs []error
	for _, server := range servers {
		errs = append(errs, server.Shutdown(context.Background()))
	}
	return errors.Join(errs...)
}

// messagesProxy forwards the operator's messaging to the gateway's operator socket.
func messagesProxy(socket string) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(&url.URL{Scheme: "http", Host: "gateway"})
		},
		Transport: wire.UnixTransport(socket),
	}
}

func refreshMirrors(ctx context.Context, mirrors *repos.Mirrors, every time.Duration, log *slog.Logger) {
	if every <= 0 {
		return
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			round, cancel := context.WithTimeout(ctx, every)
			if err := mirrors.RefreshAll(round); err != nil {
				log.Warn("refresh mirrors", "err", err)
			}
			cancel()
		}
	}
}

// base makes the warm base the given guest image booted once.
func base(args []string, log *slog.Logger) error {
	flags := flag.NewFlagSet("bay-server base", flag.ContinueOnError)
	configPath := flags.String("config", "", "configuration file")
	metadata := flags.String("metadata", "", "image metadata tarball")
	disk := flags.String("disk", "", "image disk")
	if err := flags.Parse(args); err != nil {
		return err
	}
	config, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	driver, err := incus.Connect(config.IncusSocket, config.Project, config.Base)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ready := func(ctx context.Context, exec guest.Exec) error { return guest.New(exec).Ready(ctx) }
	if err := driver.UpdateBase(ctx, *metadata, *disk, ready); err != nil {
		return err
	}
	log.Info("warm base ready")
	return nil
}
