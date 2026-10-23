package main

import (
	"context"
	"fmt"
	"io"
	"strings"
)

type subcommand struct {
	name    string
	args    string
	summary string
	run     func(c *cli, ctx context.Context, args []string) error
}

func (cmd subcommand) synopsis() string {
	return strings.TrimSpace(cmd.name + " " + cmd.args)
}

var commands = []subcommand{
	{
		name:    "start",
		args:    "NAME [PROGRAM] [--repo OWNER/NAME[@REF]]... [-- COMMAND...]",
		summary: "start a session running PROGRAM, COMMAND or a login shell; with only NAME, start an ended session again or a new login shell",
		run:     (*cli).start,
	},
	{
		name:    "attach",
		args:    "NAME",
		summary: "attach this terminal to a running session",
		run:     (*cli).attach,
	},
	{
		name:    "list",
		args:    "[--json]",
		summary: "list every session",
		run:     (*cli).list,
	},
	{
		name:    "show",
		args:    "NAME [--json]",
		summary: "show a session with its repos and snapshots",
		run:     (*cli).show,
	},
	{
		name:    "suspend",
		args:    "NAME",
		summary: "suspend a running session, keeping its memory",
		run:     (*cli).suspend,
	},
	{
		name:    "resume",
		args:    "NAME [--snapshot SNAPSHOT] [--yes]",
		summary: "resume a suspended session, start a running session's stopped program again, or roll a session back to SNAPSHOT, deleting the snapshots after it",
		run:     (*cli).resume,
	},
	{
		name:    "snap",
		args:    "NAME [SNAPSHOT]",
		summary: "snapshot a running session and print the snapshot's name",
		run:     (*cli).snap,
	},
	{
		name:    "end",
		args:    "NAME [--yes]",
		summary: "end a session, deleting its snapshots; its record stays",
		run:     (*cli).end,
	},
	{
		name:    "rm",
		args:    "NAME [--yes]",
		summary: "remove a session with its record and history",
		run:     (*cli).rm,
	},
	{
		name:    "threads",
		args:    "[--json]",
		summary: "list every message thread",
		run:     (*cli).threads,
	},
	{
		name:    "read",
		args:    "THREAD [--before MESSAGE] [--json]",
		summary: "print a thread's latest messages, or the page before MESSAGE",
		run:     (*cli).read,
	},
	{
		name:    "send",
		args:    "[--thread N] [--subject S] [--client-id KEY] [--to-id ID] [--json] TO [MESSAGE...]",
		summary: "send a message as the operator; MESSAGE comes from stdin when omitted or -",
		run:     (*cli).send,
	},
}

func usage(w io.Writer) {
	fmt.Fprint(w, "usage: bay COMMAND [ARGUMENTS]\n\n")
	for _, cmd := range commands {
		fmt.Fprintf(w, "  %s\n      %s\n", cmd.synopsis(), cmd.summary)
	}
	fmt.Fprint(w, "  help [COMMAND]\n      show this list or a command's usage\n\n")
	fmt.Fprint(w, "rm asks before deleting a session, and end and resume --snapshot before deleting snapshots; --yes skips the question.\n")
	fmt.Fprint(w, "--json prints the server's answer as JSON.\n")
	fmt.Fprintf(w, "bay reaches the Bay server on the unix socket $BAY_SOCKET, %s when unset.\n", defaultSocket)
}
