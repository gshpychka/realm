// Package messages is session messaging: its threads and messages, and the operator's service over them.
package messages

import (
	"context"
	"fmt"
	"net/http"
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
	ID     int64     `json:"id"`
	Thread int64     `json:"thread"`
	From   string    `json:"from"`
	To     string    `json:"to"`
	Body   string    `json:"body"`
	Sent   time.Time `json:"sent"`
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
	To      string `json:"to"`
	Thread  int64  `json:"thread,omitempty"`
	Subject string `json:"subject,omitempty"`
	// Body holds at most MaxBody bytes.
	Body string `json:"body"`
}

// Service is messaging as the operator sees it: every thread, and sending as the operator.
type Service interface {
	// Threads returns every thread, most recently updated first.
	Threads(ctx context.Context) ([]Thread, error)
	// Conversation returns a thread with its messages and marks the messages sent to the operator read.
	Conversation(ctx context.Context, thread int64) (Conversation, error)
	Send(ctx context.Context, s Send) (Message, error)
}

// Handler serves svc.
func Handler(svc Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /threads", func(w http.ResponseWriter, r *http.Request) {
		threads, err := svc.Threads(r.Context())
		respond(w, threads, err)
	})
	mux.HandleFunc("GET /threads/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			wire.Fail(w, fmt.Errorf("%w: thread %q", fault.Invalid, r.PathValue("id")))
			return
		}
		c, err := svc.Conversation(r.Context(), id)
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

func (c *Client) Conversation(ctx context.Context, thread int64) (Conversation, error) {
	var conv Conversation
	err := c.c.Do(ctx, http.MethodGet, "/threads/"+strconv.FormatInt(thread, 10), nil, &conv)
	return conv, err
}

func (c *Client) Send(ctx context.Context, s Send) (Message, error) {
	var m Message
	err := c.c.Do(ctx, http.MethodPost, "/messages", s, &m)
	return m, err
}
