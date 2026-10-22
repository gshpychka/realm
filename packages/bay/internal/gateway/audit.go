package gateway

import (
	"log/slog"
	"unicode/utf8"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

// maxValue is the most bytes of any one value an audit record carries; sessions choose the names they pass.
const maxValue = 256

// audit logs who called what and how it ended; message bodies stay out of the log.
func audit(log *slog.Logger, caller, tool string, err error, attrs ...any) {
	attrs = append([]any{"caller", caller, "tool", tool}, attrs...)
	switch {
	case err == nil:
		log.Info("call", clip(attrs)...)
	case fault.Kind(err) != nil:
		log.Info("call refused", clip(append(attrs, "err", err.Error()))...)
	default:
		log.Error("call failed", clip(append(attrs, "err", err.Error()))...)
	}
}

// clip cuts every string value in attrs to maxValue bytes, on a rune boundary.
func clip(attrs []any) []any {
	for i, v := range attrs {
		s, ok := v.(string)
		if !ok || len(s) <= maxValue {
			continue
		}
		cut := maxValue
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		attrs[i] = s[:cut] + "…"
	}
	return attrs
}
