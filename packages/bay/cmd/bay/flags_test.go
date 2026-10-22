package main

import (
	"slices"
	"testing"
)

func TestSplitCommand(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		before  []string
		command []string
	}{
		{"no separator", []string{"foo", "claude"}, []string{"foo", "claude"}, nil},
		{"command after the separator", []string{"foo", "--", "sh", "-c", "ls"}, []string{"foo"}, []string{"sh", "-c", "ls"}},
		{"separator first", []string{"--", "sh"}, nil, []string{"sh"}},
		{"separator last", []string{"foo", "--"}, []string{"foo"}, nil},
		{"only the first separator splits", []string{"foo", "--", "sh", "--", "x"},
			[]string{"foo"}, []string{"sh", "--", "x"}},
		{"no arguments", nil, nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before, command := splitCommand(tt.args)
			if !slices.Equal(before, tt.before) || !slices.Equal(command, tt.command) {
				t.Errorf("splitCommand(%q) = %q, %q; want %q, %q", tt.args, before, command, tt.before, tt.command)
			}
		})
	}
}
