// Package arguments parses flags mixed with positional arguments for Bay's CLIs.
package arguments

import (
	"flag"
	"fmt"
	"strings"
)

// Parse accepts between lo and hi positional arguments. A -- ends flag parsing;
// flags otherwise follow flag.FlagSet's value and boolean rules.
func Parse(fs *flag.FlagSet, args []string, lo, hi int) ([]string, error) {
	var positional []string
	for len(args) > 0 {
		if args[0] == "--" {
			positional = append(positional, args[1:]...)
			break
		}
		if args[0] == "-" || !strings.HasPrefix(args[0], "-") {
			positional = append(positional, args[0])
			args = args[1:]
			continue
		}
		// Parse one flag at a time so FlagSet cannot consume a -- boundary
		// before subsequent positional arguments have been collected.
		n := 1
		name, _, inline := strings.Cut(strings.TrimPrefix(strings.TrimPrefix(args[0], "-"), "-"), "=")
		if f := fs.Lookup(name); f != nil && !inline {
			boolean, ok := f.Value.(interface{ IsBoolFlag() bool })
			if (!ok || !boolean.IsBoolFlag()) && len(args) > 1 {
				n = 2
			}
		}
		if err := fs.Parse(args[:n]); err != nil {
			return nil, err
		}
		args = args[n:]
	}
	switch {
	case len(positional) < lo:
		return nil, fmt.Errorf("missing argument")
	case len(positional) > hi:
		return nil, fmt.Errorf("unexpected argument %q", positional[hi])
	}
	return positional, nil
}
