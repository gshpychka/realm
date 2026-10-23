// Package ntfy publishes notifications to an ntfy server.
package ntfy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Priorities ntfy distinguishes.
const (
	PriorityMin = 1 + iota
	PriorityLow
	PriorityDefault
	PriorityHigh
	PriorityMax
)

// Client publishes to one topic on one ntfy server.
type Client struct {
	URL   string
	Topic string
	// Token is the publisher's access token; empty publishes anonymously.
	Token string
	// HTTP carries the requests; nil means http.DefaultClient.
	HTTP *http.Client
}

// Notification is one message for the topic's subscribers.
type Notification struct {
	Title   string
	Message string
	Tags    []string
	// Priority is one of the Priority constants; 0 leaves the server's default.
	Priority int
}

// Error is a refusal by the server.
type Error struct {
	Status int
	// Message is the server's explanation, or the status text when it gave none.
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("ntfy: %d %s", e.Status, e.Message) }

// Publish sends n to the topic.
func (c *Client) Publish(ctx context.Context, n Notification) error {
	endpoint := strings.TrimSuffix(c.URL, "/") + "/" + url.PathEscape(c.Topic)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(n.Message))
	if err != nil {
		return err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if n.Title != "" {
		req.Header.Set("X-Title", encode(n.Title))
	}
	if len(n.Tags) > 0 {
		req.Header.Set("X-Tags", encode(strings.Join(n.Tags, ",")))
	}
	if n.Priority != 0 {
		// ntfy reads X-Priority ahead of Priority, an RFC 9218 header that intermediaries can add or replace.
		req.Header.Set("X-Priority", strconv.Itoa(n.Priority))
	}

	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return refusal(resp)
	}
	return nil
}

// encode makes s safe for a header value; ntfy decodes the encoded form.
func encode(s string) string {
	return mime.QEncoding.Encode("utf-8", s)
}

func refusal(resp *http.Response) error {
	var body struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body)
	if body.Error == "" {
		body.Error = http.StatusText(resp.StatusCode)
	}
	return &Error{Status: resp.StatusCode, Message: body.Error}
}
