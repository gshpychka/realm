package main

import (
	"slices"
	"strings"
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

func TestParsePreservesFlagBoundaries(t *testing.T) {
	for _, tt := range []struct {
		args  []string
		want  []string
		value string
		json  bool
	}{
		{[]string{"name", "--json", "--value", "x", "tail"}, []string{"name", "tail"}, "x", true},
		{[]string{"--", "name", "--json"}, []string{"name", "--json"}, "", false},
		{[]string{"name", "--", "--json", "tail"}, []string{"name", "--json", "tail"}, "", false},
		{[]string{"name", "--value", "--", "--json=false"}, []string{"name"}, "--", false},
		{[]string{"--value=-h", "name", "-"}, []string{"name", "-"}, "-h", false},
	} {
		t.Run(strings.Join(tt.args, " "), func(t *testing.T) {
			fs := newFlags()
			value := fs.String("value", "", "")
			asJSON := fs.Bool("json", false, "")
			got, err := parse(fs, tt.args, 0, 4)
			if err != nil || !slices.Equal(got, tt.want) || *value != tt.value || *asJSON != tt.json {
				t.Fatalf("parse = %q, value %q, json %v, err %v", got, *value, *asJSON, err)
			}
		})
	}
}
