# link-sanitizer

Telegram bot that replies to messages whose links carry tracking parameters or
tracking redirects with the cleaned links. The rules come from
[url-sanitize](https://github.com/antonio-orionus/url-sanitize)'s merged
ClearURLs, AdGuard, Brave and Firefox catalog. An
[Alchemy](https://alchemy.run) stack on AWS: Telegram posts updates to the
`Receiver` Lambda's function URL, which queues each reply on SQS for the
`Sender` Lambda to deliver through the Bot API.

## Deploy

From this directory, in the infra shell:

```sh
# once: the bot token, an AWS profile and the account's Alchemy assets bucket
sops ../../secrets/infra/link-sanitizer.env  # TELEGRAM_BOT_TOKEN=<token from @BotFather>
bun alchemy profile edit --add AWS
bun alchemy provider aws bootstrap --aws-profile "$(aws configure list-profiles)"

bun install --frozen-lockfile
bun run deploy
```

A bot has a single webhook, so the scripts deploy one stage, `prod`. They read
the token through `sops exec-env`.

`bun run dev` serves the stack from Alchemy's local AWS emulator in Docker
while the bot's webhook stays on `prod`.

`bun install` regenerates `bun.nix`, the Nix form of `bun.lock` that the flake
check installs from.

`patches/` carries
[alchemy-run/distilled#650](https://github.com/alchemy-run/distilled/pull/650),
which resolves SSO sessions from `AWS_CONFIG_FILE`, where the infra shell keeps
the AWS profiles.
