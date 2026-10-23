// Package sessionapi is what a session can ask of the gateway: MCP tools over HTTP on vsock.
package sessionapi

import "github.com/gshpychka/realm/packages/bay/internal/messages"

// Port is the gateway's vsock port on the host. It sits below 1024, outside the range Incus draws its own host
// vsock port from.
const Port = 800

// Path is the gateway's MCP endpoint: streamable HTTP, stateless, with JSON responses.
const Path = "/mcp"

// Tool names.
const (
	Whoami = "whoami"
	Send   = "send_message"
	Inbox  = "inbox"
	Read   = "read_thread"
	Notify = "notify"
)

type WhoamiOutput struct {
	Name       string `json:"name"`
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
}

type SendInput struct {
	To      string `json:"to" jsonschema:"the session to message, by name, or operator"`
	Body    string `json:"body"`
	Thread  int64  `json:"thread,omitempty" jsonschema:"the thread to reply in; omit it to start a thread"`
	Subject string `json:"subject,omitempty" jsonschema:"the subject of a new thread"`
}

type SendOutput struct {
	Thread  int64 `json:"thread"`
	Message int64 `json:"message"`
}

type InboxOutput struct {
	// Threads are the caller's threads holding messages to it that it has not read.
	Threads []messages.Thread `json:"threads"`
}

type ReadInput struct {
	Thread int64 `json:"thread"`
	Before int64 `json:"before,omitempty" jsonschema:"read messages before this message ID; omit it for the latest page"`
}

type ReadOutput = messages.Conversation

// Event is what an alert tells the operator about a session.
type Event string

const (
	Done    Event = "done"
	Blocked Event = "blocked"
	Idle    Event = "idle"
)

// Events lists every Event.
var Events = []Event{Done, Blocked, Idle}

type NotifyInput struct {
	Event Event `json:"event" jsonschema:"done when the work is finished, blocked when it needs the operator, idle when it is waiting"`
}

type NotifyOutput struct{}
