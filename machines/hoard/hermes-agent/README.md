# Hermes on hoard

## Credentials

The main model uses a ChatGPT subscription. Once the service user exists,
authenticate as Hermes:

```sh
ssh -t hoard sudo -iu hermes hermes auth add openai-codex
```

Set `openrouter-api-key` in `secrets/hoard/hermes.yaml` for speech, other
models and Jev.

```sh
sops edit secrets/hoard/hermes.yaml
```

Set `telegram-bot-token` in the same SOPS file.

For GitHub access, [register calcifer-hermes](https://github.com/settings/apps/new?name=calcifer-hermes&url=https%3A%2F%2Fgithub.com%2Fgshpychka%2Frealm&public=false&webhook_active=false&actions=write&actions_variables=write&administration=read&checks=write&contents=write&copilot_agent_settings=write&deployments=write&environments=write&git_signing_ssh_public_keys=read&gpg_keys=read&issues=write&keys=read&merge_queues=write&metadata=read&packages=write&pull_requests=write&repository_creation=write&repository_custom_properties=write&repository_hooks=write&repository_projects=write&secrets=write&statuses=write&user_issue_fields=write&user_issue_types=write&workflows=write) and install it on the
repositories it needs. Store its private key as
`github-app-private-key` in Hermes's SOPS file. Declare the App's IDs and
SOPS file under `my.githubApps.<slug>` and set `my.hermes-agent.github`
to its slug.

Set `home-assistant-token`, `home-assistant-admin-mcp-path` and
`telegram-owner-id` in Hermes's SOPS file.

TPM SSH key provisioning is documented in `machines/hoard/hermes-ssh-key.nix`.

## Activation

```sh
nix flake check --all-systems --no-build
nix build .#nixosConfigurations.hoard.config.system.build.toplevel
nixos-rebuild switch --flake .#hoard --target-host hoard --sudo
ssh hoard 'systemctl is-active hermes-agent hermes-backend'
```

Start a private chat with the Telegram bot and check that Hermes replies.
Check its Home Assistant tools and run `gh api /installation/repositories`
as the service user to verify GitHub access.

Open `https://hermes.hoard.glib.sh` and sign in as the owner. The password is
the `dashboard-password` entry in Hermes's SOPS file.

The gateway creates its age key at `/var/lib/hermes/age-key.txt`. Follow the
instructions in `modules/system/nixos/hermes-agent/age-key.nix` to enrol its
public key in `.sops.yaml` before encrypting files for Hermes to decrypt.
