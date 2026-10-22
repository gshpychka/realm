package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode"

	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/text"
)

func (c *cli) threads(ctx context.Context, args []string) error {
	fs := newFlags()
	asJSON := fs.Bool("json", false, "")
	if _, err := parse(fs, args, 0, 0); err != nil {
		return err
	}
	threads, err := c.client.Messages().Threads(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return c.printJSON(threads)
	}
	w := c.table()
	fmt.Fprintln(w, "ID\tSUBJECT\tPARTICIPANTS\tMESSAGES\tUNREAD\tUPDATED")
	for _, t := range threads {
		fmt.Fprintf(w, "%d\t%s\t%s\t%d\t%d\t%s\n", t.ID, dash(text.OneLine(t.Subject)),
			dash(strings.Join(t.Participants, ", ")), t.Messages, t.Unread, stamp(t.Updated))
	}
	return w.Flush()
}

func (c *cli) read(ctx context.Context, args []string) error {
	fs := newFlags()
	asJSON := fs.Bool("json", false, "")
	positional, err := parse(fs, args, 1, 1)
	if err != nil {
		return err
	}
	id, err := strconv.ParseInt(positional[0], 10, 64)
	if err != nil {
		return usageError(fmt.Sprintf("invalid thread %q", positional[0]))
	}
	conversation, err := c.client.Messages().Conversation(ctx, id)
	if err != nil {
		return err
	}
	if *asJSON {
		return c.printJSON(conversation)
	}
	t := conversation.Thread
	w := c.table()
	fmt.Fprintf(w, "Thread:\t%d\n", t.ID)
	fmt.Fprintf(w, "Subject:\t%s\n", dash(text.OneLine(t.Subject)))
	fmt.Fprintf(w, "Participants:\t%s\n", dash(strings.Join(t.Participants, ", ")))
	if err := w.Flush(); err != nil {
		return err
	}
	if conversation.Earlier > 0 {
		fmt.Fprintf(c.stdout, "\n(%d earlier messages)\n", conversation.Earlier)
	}
	for _, m := range conversation.Messages {
		body := indent(strings.TrimRight(text.Printable(m.Body), "\n"))
		fmt.Fprintf(c.stdout, "\n%s  %s -> %s\n%s\n", stamp(m.Sent), m.From, m.To, body)
	}
	return nil
}

func (c *cli) send(ctx context.Context, args []string) error {
	fs := newFlags()
	thread := fs.Int64("thread", 0, "")
	subject := fs.String("subject", "", "")
	asJSON := fs.Bool("json", false, "")
	// Flags end at TO: every word after it belongs to the message.
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		return usageError("missing argument")
	}
	to := fs.Arg(0)
	body, err := c.body(fs.Args()[1:])
	if err != nil {
		return err
	}
	if body == "" {
		return usageError("empty message")
	}
	sent, err := c.client.Messages().Send(ctx, messages.Send{To: to, Thread: *thread, Subject: *subject, Body: body})
	if err != nil {
		return err
	}
	if *asJSON {
		return c.printJSON(sent)
	}
	fmt.Fprintf(c.stdout, "sent to %s in thread %d\n", to, sent.Thread)
	return nil
}

// body is the message given as words, or the one read from stdin when there are no words or the only word is "-".
func (c *cli) body(words []string) (string, error) {
	message := strings.Join(words, " ")
	if len(words) == 0 || message == "-" {
		if c.terminal {
			fmt.Fprintln(c.stderr, "Type the message, then press Ctrl-D.")
		}
		data, err := io.ReadAll(c.stdin)
		if err != nil {
			return "", err
		}
		message = string(data)
	}
	return strings.TrimRightFunc(message, unicode.IsSpace), nil
}
