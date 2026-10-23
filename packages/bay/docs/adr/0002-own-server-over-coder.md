# Bay has its own server; Coder was set aside

The Bay server is written for this project. Coder offers an API-first server with a CLI, a web UI and Incus templates, but suspend with memory, starting from a session record, and agents running under the operator's own subscription sit outside its Terraform-driven lifecycle. Its workspace agent also dials the control plane over the network, which puts the service that drives Incus within reach of untrusted sessions.

## Considered Options

- **Coder with the Incus NixOS VM template**: as of October 2026 its agent features were in flux (Coder Tasks leaves new releases from v2.37, AgentAPI is deprecated), and prebuilt workspaces, its equivalent of the warm base, need a Premium licence.
