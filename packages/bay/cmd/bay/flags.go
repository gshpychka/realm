package main

import (
	"errors"
	"flag"
	"io"
	"slices"

	"github.com/gshpychka/realm/packages/bay/internal/arguments"
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
	positional, err := arguments.Parse(fs, args, lo, hi)
	if err != nil && !errors.Is(err, flag.ErrHelp) {
		return nil, usageError(err.Error())
	}
	return positional, err
}

func splitCommand(args []string) (before, command []string) {
	if i := slices.Index(args, "--"); i >= 0 {
		return args[:i], args[i+1:]
	}
	return args, nil
}
