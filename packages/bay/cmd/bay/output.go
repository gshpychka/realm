package main

import (
	"encoding/json"
	"strings"
	"text/tabwriter"
	"time"
)

const timeLayout = "2006-01-02 15:04"

func (c *cli) table() *tabwriter.Writer {
	return tabwriter.NewWriter(c.stdout, 0, 0, 2, ' ', 0)
}

func stamp(t time.Time) string {
	return t.Local().Format(timeLayout)
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func indent(s string) string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		if line != "" {
			lines[i] = "    " + line
		}
	}
	return strings.Join(lines, "\n")
}

func (c *cli) printJSON(v any) error {
	enc := json.NewEncoder(c.stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
