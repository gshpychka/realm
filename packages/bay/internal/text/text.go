// Package text prepares untrusted text for printing to a terminal.
package text

import (
	"strings"
	"unicode"
)

// Printable returns s with CR LF folded into a line break and every other control character, except a line break or
// tab, shown as U+FFFD, since terminals act on control characters.
func Printable(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return unicode.ReplacementChar
		}
		return r
	}, strings.ReplaceAll(s, "\r\n", "\n"))
}

// OneLine returns the words of Printable(s) joined by single spaces.
func OneLine(s string) string {
	return strings.Join(strings.Fields(Printable(s)), " ")
}
