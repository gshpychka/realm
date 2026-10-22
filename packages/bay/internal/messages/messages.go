// Package messages is session messaging: its threads and messages, and the operator's service over them.
package messages

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/wire"
)

// Operator is the operator's name in messaging, reserved from sessions.
const Operator = "operator"

// MaxBody is the most bytes a message body holds.
const MaxBody = 64 << 10

// MaxConversation is the most body bytes one Conversation carries.
const MaxConversation = 256 << 10

// ReadBody reads a message from stdin without buffering input beyond the message limit.
func ReadBody(r io.Reader) (string, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxBody+1))
	if err != nil {
		return "", fmt.Errorf("read the message: %w", err)
	}
	if len(data) > MaxBody {
		return "", fmt.Errorf("%w: a message body is at most %d bytes", fault.Invalid, MaxBody)
	}
	return string(data), nil
}

// Thread is a conversation between participants, seen by one viewer.
type Thread struct {
	ID           int64     `json:"id"`
	Subject      string    `json:"subject"`
	Participants []string  `json:"participants"`
	Messages     int       `json:"messages"`
	Unread       int       `json:"unread"`
	Updated      time.Time `json:"updated"`
}

// Message is one message in a thread, from one participant to another.
type Message struct {
	ID             int64     `json:"id"`
	Thread         int64     `json:"thread"`
	From           string    `json:"from"`
	To             string    `json:"to"`
	Body           string    `json:"body"`
	Sent           time.Time `json:"sent"`
	FromID         string    `json:"fromId"`
	ToID           string    `json:"toId"`
	FromGeneration uint64    `json:"fromGeneration"`
}

// Feed is a bounded, non-marking forward page. Next is opaque and belongs to one message database.
type Feed struct {
	Messages []Message `json:"messages"`
	Next     string    `json:"next"`
	More     bool      `json:"more"`
}

// Conversation is a thread with its messages, oldest first.
type Conversation struct {
	Thread Thread `json:"thread"`
	// Messages are the thread's latest messages, oldest first, within MaxConversation.
	Messages []Message `json:"messages"`
	// Earlier counts the thread's older messages that Messages leaves out.
	Earlier int `json:"earlier,omitempty"`
}

// Send is a message to send; Thread 0 starts a new thread titled Subject, or the first line of Body when Subject is
// empty.
type Send struct {
	To       string `json:"to"`
	ToID     string `json:"toId,omitempty"`
	ClientID string `json:"clientId,omitempty"`
	Thread   int64  `json:"thread,omitempty"`
	Subject  string `json:"subject,omitempty"`
	// Body holds at most MaxBody bytes.
	Body string `json:"body"`
}

// Relay is an operator-authorized send by the named session's exact current execution. The gateway derives its
// sender from the session record; clients cannot supply a different sender name or identity.
type Relay struct {
	ID         string  `json:"id"`
	Generation *uint64 `json:"generation"`
	Send
}

// Service is messaging as the operator sees it: every thread, and sending as the operator.
type Service interface {
	// Threads returns every thread, most recently updated first.
	Threads(ctx context.Context) ([]Thread, error)
	// Conversation returns the latest page, or messages before the given message ID
	// when before is positive, and marks only the returned messages read.
	Conversation(ctx context.Context, thread, before int64) (Conversation, error)
	Send(ctx context.Context, s Send) (Message, error)
	Feed(ctx context.Context, after string) (Feed, error)
	Relay(ctx context.Context, name string, r Relay) (Message, error)
}

// Handler serves svc.
func Handler(svc Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /feed", func(w http.ResponseWriter, r *http.Request) {
		page, err := svc.Feed(r.Context(), r.URL.Query().Get("after"))
		respond(w, page, err)
	})
	mux.HandleFunc("POST /sessions/{name}/messages", func(w http.ResponseWriter, r *http.Request) {
		var relay Relay
		if err := wire.Read(r, &relay); err != nil {
			wire.Fail(w, err)
			return
		}
		m, err := svc.Relay(r.Context(), r.PathValue("name"), relay)
		respond(w, m, err)
	})
	mux.HandleFunc("GET /threads", func(w http.ResponseWriter, r *http.Request) {
		threads, err := svc.Threads(r.Context())
		respond(w, threads, err)
	})
	mux.HandleFunc("GET /threads/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || id <= 0 {
			wire.Fail(w, fmt.Errorf("%w: thread %q", fault.Invalid, r.PathValue("id")))
			return
		}
		var before int64
		if cursor := r.URL.Query().Get("before"); cursor != "" {
			before, err = strconv.ParseInt(cursor, 10, 64)
			if err != nil || before <= 0 {
				wire.Fail(w, fmt.Errorf("%w: before must be a positive message ID", fault.Invalid))
				return
			}
		}
		c, err := svc.Conversation(r.Context(), id, before)
		respond(w, c, err)
	})
	mux.HandleFunc("POST /messages", func(w http.ResponseWriter, r *http.Request) {
		var s Send
		if err := wire.Read(r, &s); err != nil {
			wire.Fail(w, err)
			return
		}
		m, err := svc.Send(r.Context(), s)
		respond(w, m, err)
	})
	return mux
}

func respond(w http.ResponseWriter, v any, err error) {
	if err != nil {
		wire.Fail(w, err)
		return
	}
	wire.Write(w, http.StatusOK, v)
}

// Client uses a Service served by Handler.
type Client struct {
	c wire.Client
}

// NewClient returns a client of the Handler reached through httpClient at base.
func NewClient(httpClient *http.Client, base string) *Client {
	return &Client{c: wire.Client{HTTP: httpClient, Base: base}}
}

func (c *Client) Threads(ctx context.Context) ([]Thread, error) {
	var threads []Thread
	err := c.c.Do(ctx, http.MethodGet, "/threads", nil, &threads)
	return threads, err
}

func (c *Client) Conversation(ctx context.Context, thread, before int64) (Conversation, error) {
	var conv Conversation
	path := "/threads/" + strconv.FormatInt(thread, 10)
	if before != 0 {
		path += "?before=" + strconv.FormatInt(before, 10)
	}
	err := c.c.Do(ctx, http.MethodGet, path, nil, &conv)
	return conv, err
}

func (c *Client) Send(ctx context.Context, s Send) (Message, error) {
	var m Message
	err := c.c.Do(ctx, http.MethodPost, "/messages", s, &m)
	return m, err
}

func (c *Client) Feed(ctx context.Context, after string) (Feed, error) {
	var page Feed
	path := "/feed"
	if after != "" {
		path += "?after=" + url.QueryEscape(after)
	}
	err := c.c.Do(ctx, http.MethodGet, path, nil, &page)
	return page, err
}

func (c *Client) Relay(ctx context.Context, name string, r Relay) (Message, error) {
	var m Message
	err := c.c.Do(ctx, http.MethodPost, "/sessions/"+url.PathEscape(name)+"/messages", r, &m)
	return m, err
}
