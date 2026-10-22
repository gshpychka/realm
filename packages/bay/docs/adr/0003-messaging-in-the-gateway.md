# Messaging lives in the session gateway; Agent Mail was set aside

The session gateway stores threads and inboxes itself and serves them to sessions over MCP and `flare`. The gateway already identifies every caller by its VM's vsock address, holds the session names and feeds the operator's view through the Bay server, which leaves a messaging service only a store to provide.

## Considered Options

- **MCP Agent Mail (Rust) behind the gateway**: its identity is advisory (one server-wide bearer token, and inbox reads and contact-policy changes take a bare agent name), it accepts only adjective-noun names from its own word lists, and it brings a pinned nightly Rust toolchain, 45 git-sourced crates and a licence rider withholding rights from OpenAI and Anthropic.
