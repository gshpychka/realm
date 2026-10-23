package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"

	"github.com/gshpychka/realm/packages/bay/internal/api"
	"github.com/gshpychka/realm/packages/bay/internal/text"
)

func (c *cli) start(ctx context.Context, args []string) error {
	args, command := splitCommand(args)
	fs := newFlags()
	var repos []string
	fs.Func("repo", "", func(repo string) error {
		if _, err := api.ParseRepo(repo); err != nil {
			return errors.New("want OWNER/NAME or OWNER/NAME@REF")
		}
		repos = append(repos, repo)
		return nil
	})
	positional, err := parse(fs, args, 1, 2)
	if err != nil {
		return err
	}
	name := positional[0]
	spec := api.Start{Command: command, Repos: repos}
	if len(positional) > 1 {
		spec.Program = positional[1]
	}
	if spec.Program != "" && len(command) > 0 {
		return usageError("give a program or a command, not both")
	}
	if len(command) > 0 && command[0] == "" {
		return usageError("the command is empty")
	}
	fmt.Fprintf(c.stderr, "starting %s...\n", text.OneLine(name))
	s, err := c.client.Start(ctx, name, spec)
	if err != nil {
		return err
	}
	fmt.Fprintf(c.stdout, "%s %s\n", s.Name, s.State)
	return nil
}

func (c *cli) attach(ctx context.Context, args []string) error {
	positional, err := parse(newFlags(), args, 1, 1)
	if err != nil {
		return err
	}
	if !c.terminal {
		return errors.New("attach needs a terminal, and stdin is not one")
	}
	attach, err := c.client.Attach(ctx, positional[0])
	if err != nil {
		return err
	}
	if len(attach.Command) == 0 {
		return errors.New("the server returned no command to attach with")
	}
	path, err := exec.LookPath(attach.Command[0])
	if err != nil {
		return err
	}
	if err := c.execve(path, attach.Command, os.Environ()); err != nil {
		return fmt.Errorf("run %s: %w", path, err)
	}
	return nil
}

func (c *cli) list(ctx context.Context, args []string) error {
	fs := newFlags()
	asJSON := fs.Bool("json", false, "")
	if _, err := parse(fs, args, 0, 0); err != nil {
		return err
	}
	sessions, err := c.client.List(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return c.printJSON(sessions)
	}
	w := c.table()
	fmt.Fprintln(w, "NAME\tSTATE\tPROGRAM\tREPOS\tCREATED")
	for _, s := range sessions {
		var repos []string
		for _, r := range s.Repos {
			repos = append(repos, fmt.Sprintf("%s/%s@%.7s", r.Owner, r.Name, r.Commit))
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", s.Name, s.State, program(s), dash(strings.Join(repos, ", ")), stamp(s.Created))
	}
	return w.Flush()
}

func (c *cli) show(ctx context.Context, args []string) error {
	fs := newFlags()
	asJSON := fs.Bool("json", false, "")
	positional, err := parse(fs, args, 1, 1)
	if err != nil {
		return err
	}
	s, err := c.client.Get(ctx, positional[0])
	if err != nil {
		return err
	}
	if *asJSON {
		return c.printJSON(s)
	}
	var repos []string
	for _, r := range s.Repos {
		repo := fmt.Sprintf("%s/%s@%s", r.Owner, r.Name, r.Commit)
		if r.Branch != "" {
			repo += " (" + r.Branch + ")"
		}
		repos = append(repos, repo)
	}
	w := c.table()
	fmt.Fprintf(w, "Name:\t%s\n", s.Name)
	fmt.Fprintf(w, "State:\t%s\n", s.State)
	fmt.Fprintf(w, "Program:\t%s\n", program(s))
	fmt.Fprintf(w, "Created:\t%s\n", stamp(s.Created))
	fmt.Fprintf(w, "Repos:\t%s\n", dash(strings.Join(repos, "\n\t")))
	fmt.Fprintf(w, "Snapshots:\t%s\n", dash(strings.Join(s.Snapshots, ", ")))
	return w.Flush()
}

func (c *cli) suspend(ctx context.Context, args []string) error {
	positional, err := parse(newFlags(), args, 1, 1)
	if err != nil {
		return err
	}
	name := positional[0]
	if err := c.client.Suspend(ctx, name); err != nil {
		return err
	}
	fmt.Fprintf(c.stdout, "%s suspended\n", name)
	return nil
}

func (c *cli) resume(ctx context.Context, args []string) error {
	fs := newFlags()
	snapshot := fs.String("snapshot", "", "")
	yes := fs.Bool("yes", false, "")
	positional, err := parse(fs, args, 1, 1)
	if err != nil {
		return err
	}
	name := positional[0]
	resume := api.Resume{Snapshot: *snapshot}
	if *snapshot != "" {
		s, err := c.client.Get(ctx, name)
		if err != nil {
			return err
		}
		if i := slices.Index(s.Snapshots, *snapshot); i >= 0 {
			resume.Discard = s.Snapshots[i+1:]
		}
		if len(resume.Discard) > 0 && !*yes {
			question := fmt.Sprintf("Rolling %s back to %s deletes the snapshots after it: %s.",
				name, *snapshot, strings.Join(resume.Discard, ", "))
			if err := c.confirm(question); err != nil {
				return err
			}
		}
	}
	if err := c.client.Resume(ctx, name, resume); err != nil {
		return err
	}
	if *snapshot != "" {
		fmt.Fprintf(c.stdout, "%s rolled back to %s\n", name, *snapshot)
		return nil
	}
	fmt.Fprintf(c.stdout, "%s resumed\n", name)
	return nil
}

func (c *cli) snap(ctx context.Context, args []string) error {
	positional, err := parse(newFlags(), args, 1, 2)
	if err != nil {
		return err
	}
	var snap api.Snap
	if len(positional) > 1 {
		snap.Snapshot = positional[1]
	}
	snapped, err := c.client.Snap(ctx, positional[0], snap)
	if err != nil {
		return err
	}
	fmt.Fprintln(c.stdout, snapped.Snapshot)
	return nil
}

func (c *cli) end(ctx context.Context, args []string) error {
	fs := newFlags()
	yes := fs.Bool("yes", false, "")
	positional, err := parse(fs, args, 1, 1)
	if err != nil {
		return err
	}
	name := positional[0]
	s, err := c.client.Get(ctx, name)
	if err != nil {
		return err
	}
	if len(s.Snapshots) > 0 && !*yes {
		question := fmt.Sprintf("Ending %s deletes its snapshots: %s.", name, strings.Join(s.Snapshots, ", "))
		if err := c.confirm(question); err != nil {
			return err
		}
	}
	if err := c.client.End(ctx, name, api.End{Snapshots: s.Snapshots}); err != nil {
		return err
	}
	fmt.Fprintf(c.stdout, "%s ended\n", name)
	return nil
}

func (c *cli) rm(ctx context.Context, args []string) error {
	fs := newFlags()
	yes := fs.Bool("yes", false, "")
	positional, err := parse(fs, args, 1, 1)
	if err != nil {
		return err
	}
	name := positional[0]
	if !*yes {
		if err := c.confirm(fmt.Sprintf("Removing %s deletes its record and history.", name)); err != nil {
			return err
		}
	}
	if err := c.client.Remove(ctx, name); err != nil {
		return err
	}
	fmt.Fprintf(c.stdout, "%s removed\n", name)
	return nil
}

func program(s api.Session) string {
	switch {
	case s.Program != "":
		return text.OneLine(s.Program)
	case len(s.Command) > 0:
		return text.OneLine(strings.Join(s.Command, " "))
	}
	return "(login shell)"
}
