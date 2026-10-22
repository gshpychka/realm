package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"slices"
)

// usageError is a mistake in the command line itself.
type usageError string

func (e usageError) Error() string { return string(e) }

func newFlags() *flag.FlagSet {
	fs := flag.NewFlagSet("", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func parseFlags(fs *flag.FlagSet, args []string) error {
	err := fs.Parse(args)
	if err != nil && !errors.Is(err, flag.ErrHelp) {
		return usageError(err.Error())
	}
	return err
}

// parse parses args into fs and returns the positional arguments, which must number between lo and hi. Flags and
// positional arguments may be mixed in any order.
func parse(fs *flag.FlagSet, args []string, lo, hi int) ([]string, error) {
	var positional []string
	for {
		if err := parseFlags(fs, args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			break
		}
		positional = append(positional, fs.Arg(0))
		args = fs.Args()[1:]
	}
	switch {
	case len(positional) < lo:
		return nil, usageError("missing argument")
	case len(positional) > hi:
		return nil, usageError(fmt.Sprintf("unexpected argument %q", positional[hi]))
	}
	return positional, nil
}

func splitCommand(args []string) (before, command []string) {
	if i := slices.Index(args, "--"); i >= 0 {
		return args[:i], args[i+1:]
	}
	return args, nil
}
