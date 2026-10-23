// bay-guest is invoked only through the operator's Incus connection, not through the guest messaging gateway.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/environment"
	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/operations"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) == 2 && os.Args[1] == "environment-files" {
		if os.Geteuid() == 0 {
			return fmt.Errorf("environment must run unprivileged")
		}
		return environment.ServeFiles(os.Stdin, os.Stdout)
	}

	flags := flag.NewFlagSet("bay-guest", flag.ContinueOnError)
	root := flags.String("root", "/var/lib/bay", "operator storage")
	work := flags.String("work", "/work", "workspace directory")
	user := flags.String("user", "dev", "session user")
	home := flags.String("home", "/home/dev", "session home")
	record := flags.String("record", "", "session record ID")
	generation := flags.Uint64("generation", 0, "execution generation")
	if err := flags.Parse(os.Args[1:]); err != nil {
		return err
	}
	args := flags.Args()
	if len(args) != 2 {
		return fmt.Errorf("usage: bay-guest [OPTIONS] put-blob|capture|capture-info|read-capture|start-job|job|run-job|environment ID")
	}
	g := operations.Guest{Root: *root, Work: *work, User: *user, Home: *home, RecordID: *record, Generation: *generation}
	g.Launch = func(id string) error {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		unit := "bay-job-" + operations.Digest([]any{*record, *generation, id})[:40]
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, "systemd-run", "--quiet", "--collect", "--no-block", "--unit="+unit,
			"--property=KillMode=control-group", "--property=NoNewPrivileges=yes", "--property=TimeoutStopSec=5s", executable,
			"--root", *root, "--work", *work, "--user", *user, "--home", *home, "--record", *record, "--generation", fmt.Sprint(*generation), "run-job", id)
		output, err := command.CombinedOutput()
		if err != nil {
			return fmt.Errorf("start detached runner: %w: %.4096s", err, output)
		}
		return nil
	}
	var result any
	var err error
	switch args[0] {
	case "environment":
		if err := nonRootUser(*user); err != nil {
			return err
		}
		return environmentBridge(*user, *home, *work)
	case "environment-supervisor":
		return superviseEnvironment(*user, *home, *work)

	case "put-blob":
		result, err = g.PutBlob(args[1], os.Stdin)
	case "capture":
		var request operations.Capture
		if err = decode(&request); err == nil {
			result, err = g.Capture(args[1], request)
		}
	case "capture-info":
		result, err = g.CaptureInfo(args[1])
	case "read-capture":
		return g.ReadCapture(args[1], os.Stdout)
	case "start-job":
		var request operations.Command
		if err = decode(&request); err == nil {
			result, err = g.StartJob(args[1], request)
		}
	case "job":
		result, err = g.Job(args[1])
	case "run-job":
		return g.RunJob(args[1])
	default:
		return fmt.Errorf("unknown operator operation %q", args[0])
	}
	if err != nil {
		kind := ""
		if k := fault.Kind(err); k != nil {
			kind = k.Error()
		}
		return json.NewEncoder(os.Stdout).Encode(struct {
			Error string `json:"error"`
			Kind  string `json:"kind"`
		}{err.Error(), kind})
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func decode(value any) error {
	decoder := json.NewDecoder(os.Stdin)
	decoder.DisallowUnknownFields()
	return decoder.Decode(value)
}
