package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

func isTerminal(r io.Reader) bool {
	f, ok := r.(*os.File)
	if !ok {
		return false
	}
	_, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	return err == nil
}

// confirm returns nil when the operator, told consequence, answers yes; any other answer, or the lack of a terminal
// to ask on, is an error.
func (c *cli) confirm(consequence string) error {
	if !c.terminal {
		return fmt.Errorf("%s Pass --yes to go ahead without a terminal.", consequence)
	}
	fmt.Fprintf(c.stderr, "%s Continue? [y/N] ", consequence)
	answer, _ := bufio.NewReader(c.stdin).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "y", "yes":
		return nil
	}
	return errors.New("aborted")
}
