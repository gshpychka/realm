# Hermes-owned encrypted files

Hermes generates its own age key at `/var/lib/hermes/age-key.txt` on first
start. The initial creation rule in `.sops.yaml` includes hoard and the owner;
it deliberately contains no invented agent recipient.

Read the public recipient locally with:

```sh
sudo grep '^# public key:' /var/lib/hermes/age-key.txt
```

Add that public recipient as a `hermes` anchor and to the `secrets/hermes/.*`
creation rule. With an existing owner decryption key available, run
`sops updatekeys -y` on each encrypted file here. Do not run it on this README.
Only then can the service decrypt those files itself. Existing
`secrets/openclaw/` recipients and the OpenClaw private key stay separate.

Credentials consumed through sops-nix need only hoard's existing host key;
they do not require this agent-owned age key. The deployment initially
reuses named values from `secrets/hoard/openclaw.yaml`. A dedicated
`secrets/hoard/hermes.yaml` can replace that source after copying values
securely with SOPS. Never commit a plaintext placeholder as a SOPS document.
