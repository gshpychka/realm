// Command flare notifies the operator and sends and reads messages from inside a session.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
)

const requestTimeout = 30 * time.Second

const usageText = `usage: flare [-json] COMMAND [ARGUMENT...]

commands:
  whoami                                    print this session's name
  notify EVENT                              alert the operator; EVENT is one of %s
  send [-thread N] [-subject S] TO [MESSAGE...]
                                            send MESSAGE, or standard input, to a session or to operator
  inbox                                     list threads with unread messages
  read THREAD                               print a thread's messages
  mcp                                       serve the gateway's tools as an MCP server on standard input and output

-json prints a command's output as JSON.
`

type app struct {
	stdin          io.Reader
	stdout, stderr io.Writer
	gateway        gateway
	asJSON         bool
}

func main() {
	a := &app{
		stdin:   os.Stdin,
		stdout:  os.Stdout,
		stderr:  os.Stderr,
		gateway: gateway{dial: dialGateway, timeout: requestTimeout},
	}
	os.Exit(a.run(context.Background(), os.Args[1:]))
}

// run executes a flare command line and returns its exit code: 2 for a usage error, 1 for any other failure.
func (a *app) run(ctx context.Context, args []string) int {
	err := a.dispatch(ctx, args)
	switch {
	case err == nil:
		return 0
	case errors.Is(err, flag.ErrHelp):
		a.usage(a.stdout)
		return 0
	case errors.Is(err, fault.Invalid):
		fmt.Fprintf(a.stderr, "flare: %v\n\n", err)
		a.usage(a.stderr)
		return 2
	default:
		fmt.Fprintf(a.stderr, "flare: %v\n", err)
		return 1
	}
}

func (a *app) dispatch(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("flare", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.BoolVar(&a.asJSON, "json", false, "")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("%w: %w", fault.Invalid, err)
	}
	rest := flags.Args()
	if len(rest) == 0 {
		return fmt.Errorf("%w: no command", fault.Invalid)
	}
	command, args := rest[0], rest[1:]
	switch command {
	case "whoami":
		return a.whoami(ctx, args)
	case "notify":
		return a.notify(ctx, args)
	case "send":
		return a.send(ctx, args)
	case "inbox":
		return a.inbox(ctx, args)
	case "read":
		return a.read(ctx, args)
	case "mcp":
		return a.mcp(ctx, args)
	}
	return fmt.Errorf("%w: unknown command %q", fault.Invalid, command)
}

func (a *app) usage(w io.Writer) {
	fmt.Fprintf(w, usageText, eventNames())
}

func eventNames() string {
	names := make([]string, len(sessionapi.Events))
	for i, e := range sessionapi.Events {
		names[i] = string(e)
	}
	return strings.Join(names, ", ")
}
