# Embed JSON as a Jinja string, then decode it with HA's own filter. Two
# serializations keep quotes, newlines, booleans/null and template delimiters
# inside data rather than treating them as Jinja source.
value: "(${builtins.toJSON (builtins.toJSON value)} | from_json)"
