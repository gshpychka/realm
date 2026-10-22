package text_test

import (
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/text"
)

func TestPrintable(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"text", "just text", "just text"},
		{"line breaks and tabs", "a\n\tb", "a\n\tb"},
		{"carriage return and line feed", "a\r\nb", "a\nb"},
		{"lone carriage return", "a\rb", "a�b"},
		{"carriage return before a line feed pair", "a\r\r\nb", "a�\nb"},
		{"escape sequence", "a\x1b[31mb", "a�[31mb"},
		{"operating system command", "a\x1b]0;title\x07b", "a�]0;title�b"},
		{"bell", "a\x07b", "a�b"},
		{"backspace", "a\x08b", "a�b"},
		{"delete", "a\x7fb", "a�b"},
		{"next line", "a\u0085b", "a�b"},
		{"null", "a\x00b", "a�b"},
		{"unicode text", "héllo wörld", "héllo wörld"},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := text.Printable(tt.in); got != tt.want {
				t.Errorf("Printable(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestOneLine(t *testing.T) {
	tests := []struct{ in, want string }{
		{"plan", "plan"},
		{"  plan \t for\nthe   week\n", "plan for the week"},
		{"x\n99  fake  row", "x 99 fake row"},
		{"a\x1b[2Jb", "a�[2Jb"},
		{"a\rb", "a�b"},
		{" \n ", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := text.OneLine(tt.in); got != tt.want {
			t.Errorf("OneLine(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
