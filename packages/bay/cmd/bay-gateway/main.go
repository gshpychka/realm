// Command bay-gateway runs the session gateway. systemd passes it two sockets: sessions, an AF_VSOCK socket on
// sessionapi.Port that sessions call, and operator, a unix socket for the operator's messaging.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	stdlog "log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/activation"
	"github.com/gshpychka/realm/packages/bay/internal/gateway"
	"github.com/gshpychka/realm/packages/bay/internal/gateway/store"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/ntfy"
	"github.com/mdlayher/vsock"
)

const (
	headerTimeout   = 10 * time.Second
	readTimeout     = 10 * time.Second
	writeTimeout    = 30 * time.Second
	idleTimeout     = time.Minute
	shutdownTimeout = 10 * time.Second
)

// maxPeerConns is the most connections a VM holds open to the sessions' socket at once; each one can hold a request in
// memory.
const maxPeerConns = 16

func main() {
	configPath := flag.String("config", "", "path of the JSON configuration file")
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, log, *configPath)
	stop()
	if err != nil {
		log.Error("bay-gateway stopped", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, log *slog.Logger, configPath string) error {
	if configPath == "" {
		return errors.New("-config is required")
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}

	sockets, err := activation.Passed()
	if err != nil {
		return err
	}
	sessions, err := vsockListener(sockets, "sessions")
	if err != nil {
		return err
	}
	operator, err := sockets.Listener("operator")
	if err != nil {
		return err
	}

	st, err := store.Open(cfg.Database)
	if err != nil {
		return err
	}
	defer st.Close()

	var alerter gateway.Alerter
	if cfg.Ntfy != nil {
		token, err := readToken()
		if err != nil {
			return fmt.Errorf("ntfy token: %w", err)
		}
		alerter = gateway.NtfyAlerter(&ntfy.Client{URL: cfg.Ntfy.URL, Topic: cfg.Ntfy.Topic, Token: token})
	} else {
		log.Warn("ntfy is not configured, so alerts are only logged")
	}

	gw := gateway.New(gateway.Config{Resolver: identity.NewClient(cfg.IdentitySocket), Store: st, Alerter: alerter, Log: log})
	return serve(ctx, log, gw, sessions, operator)
}

// vsockListener returns the AF_VSOCK socket systemd passed under name.
func vsockListener(s activation.Sockets, name string) (net.Listener, error) {
	f, err := s.File(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	l, err := vsock.FileListener(f)
	if err != nil {
		return nil, fmt.Errorf("socket %q: %w", name, err)
	}
	return l, nil
}

// peer returns the vsock context ID of the VM that c comes from.
func peer(c net.Conn) (uint32, bool) {
	addr, ok := c.RemoteAddr().(*vsock.Addr)
	if !ok {
		return 0, false
	}
	return addr.ContextID, true
}

// peerContext marks ctx with the vsock context ID of the VM that c comes from.
func peerContext(ctx context.Context, c net.Conn) context.Context {
	if cid, ok := peer(c); ok {
		return gateway.WithPeer(ctx, cid)
	}
	return ctx
}

// peerConns counts the connections each VM holds open to a server, and closes each new one past maxPeerConns.
type peerConns struct {
	mu   sync.Mutex
	open map[uint32]int
}

// track is an http.Server ConnState hook.
func (p *peerConns) track(c net.Conn, state http.ConnState) {
	cid, ok := peer(c)
	if !ok {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	switch state {
	case http.StateNew:
		if p.open[cid]++; p.open[cid] > maxPeerConns {
			c.Close()
		}
	case http.StateClosed, http.StateHijacked:
		if p.open[cid]--; p.open[cid] == 0 {
			delete(p.open, cid)
		}
	}
}

// newSessionsServer returns the server for the sessions' socket.
func newSessionsServer(gw *gateway.Gateway, errorLog *stdlog.Logger) *http.Server {
	conns := &peerConns{open: map[uint32]int{}}
	return &http.Server{
		Handler:           gw.SessionHandler(),
		ConnContext:       peerContext,
		ConnState:         conns.track,
		ReadHeaderTimeout: headerTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		ErrorLog:          errorLog,
	}
}

// serve serves sessions on one listener and the operator on the other until ctx ends or either fails, and then shuts
// both down.
func serve(ctx context.Context, log *slog.Logger, gw *gateway.Gateway, sessions, operator net.Listener) error {
	errorLog := slog.NewLogLogger(log.Handler(), slog.LevelError)
	sessionsServer := newSessionsServer(gw, errorLog)
	operatorServer := &http.Server{
		Handler:           messages.Handler(gw.OperatorService()),
		ReadHeaderTimeout: headerTimeout,
		ErrorLog:          errorLog,
	}

	failed := make(chan error, 2)
	start := func(name string, srv *http.Server, l net.Listener) {
		log.Info("serving", "socket", name)
		failed <- fmt.Errorf("%s: %w", name, srv.Serve(l))
	}
	go start("sessions", sessionsServer, sessions)
	go start("operator", operatorServer, operator)

	var failure error
	select {
	case <-ctx.Done():
	case failure = <-failed:
	}
	log.Info("shutting down")
	shutdown, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	for _, srv := range []*http.Server{sessionsServer, operatorServer} {
		if err := srv.Shutdown(shutdown); err != nil {
			log.Warn("shut down server", "err", err)
		}
	}
	return failure
}
