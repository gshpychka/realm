package main

import (
	"io"
	"os"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestIsTerminalRefusesWhatIsNotOne(t *testing.T) {
	devNull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer devNull.Close()
	pipe, pipeWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer pipe.Close()
	defer pipeWriter.Close()
	tests := map[string]io.Reader{
		"string reader": strings.NewReader(""),
		"pipe":          pipe,
		"/dev/null":     devNull,
	}
	for name, r := range tests {
		if isTerminal(r) {
			t.Errorf("%s is reported as a terminal", name)
		}
	}
}

func TestIsTerminalAcceptsAPseudoTerminal(t *testing.T) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		t.Skipf("no pseudo-terminals: %v", err)
	}
	defer master.Close()
	fd := int(master.Fd())
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
		t.Skipf("cannot unlock the pseudo-terminal: %v", err)
	}
	n, err := unix.IoctlGetInt(fd, unix.TIOCGPTN)
	if err != nil {
		t.Skipf("cannot name the pseudo-terminal: %v", err)
	}
	slave, err := os.OpenFile("/dev/pts/"+strconv.Itoa(n), os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		t.Skipf("cannot open the pseudo-terminal: %v", err)
	}
	defer slave.Close()
	if !isTerminal(slave) {
		t.Error("a pseudo-terminal is not reported as a terminal")
	}
}
