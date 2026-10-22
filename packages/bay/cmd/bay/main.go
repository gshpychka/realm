// Command bay is the operator's terminal client of the Bay server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"syscall"

	"github.com/gshpychka/realm/packages/bay/internal/api"
	"github.com/gshpychka/realm/packages/bay/internal/text"
)

const (
	exitFailure = 1
	exitUsage   = 2
)

const defaultSocket = "/run/bay/bay.sock"

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// run executes the bay command line args and returns the exit status: 0 on success, 1 when the command fails and 2
// when the command line is wrong.
func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	return newCLI(stdin, stdout, stderr).run(args)
}

type cli struct {
	client   *api.Client
	stdin    io.Reader
	stdout   io.Writer
	stderr   io.Writer
	terminal bool
	execve   func(path string, argv, env []string) error
}

func newCLI(stdin io.Reader, stdout, stderr io.Writer) *cli {
	return &cli{
		client:   api.NewClient(socketPath()),
		stdin:    stdin,
		stdout:   stdout,
		stderr:   stderr,
		terminal: isTerminal(stdin),
		execve:   syscall.Exec,
	}
}

func socketPath() string {
	if path := os.Getenv("BAY_SOCKET"); path != "" {
		return path
	}
	return defaultSocket
}

func (c *cli) run(args []string) int {
	if len(args) == 0 {
		usage(c.stderr)
		return exitUsage
	}
	switch args[0] {
	case "help", "-h", "--help":
		usage(c.stdout)
		return 0
	}
	i := slices.IndexFunc(commands, func(cmd subcommand) bool { return cmd.name == args[0] })
	if i < 0 {
		fmt.Fprintf(c.stderr, "bay: unknown command %q; bay help lists the commands\n", args[0])
		return exitUsage
	}
	cmd := commands[i]
	err := cmd.run(c, context.Background(), args[1:])
	var mistake usageError
	switch {
	case err == nil:
		return 0
	case errors.Is(err, flag.ErrHelp):
		fmt.Fprintf(c.stdout, "usage: bay %s\n%s\n", cmd.synopsis(), cmd.summary)
		return 0
	case errors.As(err, &mistake):
		fmt.Fprintf(c.stderr, "bay %s: %s\nusage: bay %s\n", cmd.name, mistake, cmd.synopsis())
		return exitUsage
	default:
		fmt.Fprintf(c.stderr, "bay: %s\n", text.Printable(err.Error()))
		return exitFailure
	}
}
