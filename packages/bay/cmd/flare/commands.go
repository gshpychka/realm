package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
	"unicode"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
	"github.com/gshpychka/realm/packages/bay/internal/text"
)

// show prints out as JSON under -json, and through render otherwise; a nil render prints nothing.
func (a *app) show(out any, render func(w io.Writer)) error {
	if a.asJSON {
		enc := json.NewEncoder(a.stdout)
		enc.SetEscapeHTML(false)
		return enc.Encode(out)
	}
	if render != nil {
		render(a.stdout)
	}
	return nil
}

func (a *app) whoami(ctx context.Context, args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("%w: whoami takes no arguments", fault.Invalid)
	}
	out, err := call[sessionapi.WhoamiOutput](ctx, a.gateway, sessionapi.Whoami, nil)
	if err != nil {
		return err
	}
	return a.show(out, func(w io.Writer) { fmt.Fprintln(w, out.Name) })
}

func (a *app) notify(ctx context.Context, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("%w: notify takes one event, one of %s", fault.Invalid, eventNames())
	}
	event := sessionapi.Event(args[0])
	if !slices.Contains(sessionapi.Events, event) {
		return fmt.Errorf("%w: unknown event %q, want one of %s", fault.Invalid, args[0], eventNames())
	}
	out, err := call[sessionapi.NotifyOutput](ctx, a.gateway, sessionapi.Notify, sessionapi.NotifyInput{Event: event})
	if err != nil {
		return err
	}
	return a.show(out, nil)
}

func (a *app) send(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("send", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	thread := flags.Int64("thread", 0, "")
	subject := flags.String("subject", "", "")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("%w: %w", fault.Invalid, err)
	}
	rest := flags.Args()
	if len(rest) == 0 {
		return fmt.Errorf("%w: send needs a recipient", fault.Invalid)
	}
	to, words := rest[0], rest[1:]

	body := strings.Join(words, " ")
	if len(words) == 0 || (len(words) == 1 && words[0] == "-") {
		data, err := io.ReadAll(a.stdin)
		if err != nil {
			return fmt.Errorf("read the message: %w", err)
		}
		body = string(data)
	}
	body = strings.TrimRightFunc(body, unicode.IsSpace)
	if body == "" {
		return fmt.Errorf("%w: the message is empty", fault.Invalid)
	}

	in := sessionapi.SendInput{To: to, Body: body, Thread: *thread, Subject: *subject}
	out, err := call[sessionapi.SendOutput](ctx, a.gateway, sessionapi.Send, in)
	if err != nil {
		return err
	}
	return a.show(out, func(w io.Writer) { fmt.Fprintf(w, "thread %d message %d\n", out.Thread, out.Message) })
}

func (a *app) inbox(ctx context.Context, args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("%w: inbox takes no arguments", fault.Invalid)
	}
	out, err := call[sessionapi.InboxOutput](ctx, a.gateway, sessionapi.Inbox, nil)
	if err != nil {
		return err
	}
	return a.show(out, func(w io.Writer) {
		if len(out.Threads) == 0 {
			fmt.Fprintln(w, "no unread messages")
			return
		}
		table := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
		fmt.Fprintln(table, "ID\tSUBJECT\tPARTICIPANTS\tUNREAD\tUPDATED")
		for _, t := range out.Threads {
			fmt.Fprintf(table, "%d\t%s\t%s\t%d\t%s\n",
				t.ID, text.OneLine(t.Subject), strings.Join(t.Participants, ", "), t.Unread, stamp(t.Updated))
		}
		table.Flush()
	})
}

func (a *app) read(ctx context.Context, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("%w: read takes one thread", fault.Invalid)
	}
	thread, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		return fmt.Errorf("%w: thread %q is not a number", fault.Invalid, args[0])
	}
	out, err := call[sessionapi.ReadOutput](ctx, a.gateway, sessionapi.Read, sessionapi.ReadInput{Thread: thread})
	if err != nil {
		return err
	}
	return a.show(out, func(w io.Writer) {
		head := fmt.Sprintf("thread %d", out.Thread.ID)
		if subject := text.OneLine(out.Thread.Subject); subject != "" {
			head += ": " + subject
		}
		fmt.Fprintln(w, head)
		if out.Earlier > 0 {
			fmt.Fprintf(w, "\n(%d earlier messages)\n", out.Earlier)
		}
		for _, m := range out.Messages {
			fmt.Fprintf(w, "\n%s -> %s  %s\n", m.From, m.To, stamp(m.Sent))
			// Header lines alone start at the margin; every body line is indented.
			for _, line := range strings.Split(text.Printable(m.Body), "\n") {
				if line != "" {
					line = "  " + line
				}
				fmt.Fprintln(w, line)
			}
		}
	})
}

func stamp(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}
