# The Telegram channel: the owner's DMs with the agent's bot.
#
# Imperative, one-time: create the bot with @BotFather, then store its token
# and the owner's numeric user id (from @userinfobot):
#   sops set <sopsFile> '["telegram-bot-token"]' '"<token>"'
#   sops set <sops.defaultSopsFile> '["telegram-owner-id"]' '"<numeric id>"'
{ config, lib, ... }:
let
  cfg = config.my.openclaw;
  ownerId = cfg.secretVars.TELEGRAM_OWNER_ID;
in
{
  options.my.openclaw.telegram.enable = lib.mkEnableOption ''
    the Telegram channel: the bot whose token is sopsFile's
    telegram-bot-token, in DMs with the user whose numeric id is the host's
    telegram-owner-id secret, who is the command owner and runs
    `! <command>` on this host'';

  config = lib.mkIf (cfg.enable && cfg.telegram.enable) {
    my.openclaw = {
      secrets.TELEGRAM_BOT_TOKEN = "telegram-bot-token";
      hostSecrets.TELEGRAM_OWNER_ID = "telegram-owner-id";
    };

    services.openclaw-gateway.config = {
      channels.telegram = {
        enabled = true;
        botToken = cfg.secretRefs.TELEGRAM_BOT_TOKEN;
        dmPolicy = "allowlist";
        allowFrom = [ ownerId ];
        groupPolicy = "disabled";
      };
      commands.ownerAllowFrom = [ "telegram:${ownerId}" ];
      # senders allowed elevated tools, which `! <command>` requires
      tools.elevated.allowFrom.telegram = [ ownerId ];
    };
  };
}
