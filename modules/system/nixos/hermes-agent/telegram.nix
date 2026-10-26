# The Telegram channel (https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram):
# the owner's DMs with the agent's bot.
#
# Imperative, one-time: create the bot with @BotFather, then store its token
# and the owner's numeric user id (from @userinfobot):
#   sops set <sopsFile> '["telegram-bot-token"]' '"<token>"'
#   sops set <sops.defaultSopsFile> '["telegram-owner-id"]' '"<numeric id>"'
{ config, lib, ... }:
let
  cfg = config.my.hermes-agent;
  service = config.services.hermes-agent;
in
{
  options.my.hermes-agent.telegram.enable = lib.mkEnableOption ''
    the Telegram channel: the bot whose token is sopsFile's
    telegram-bot-token, in DMs with the user whose numeric id is the host's
    telegram-owner-id secret'';

  config = lib.mkIf (service.enable && cfg.telegram.enable) {
    my.hermes-agent = {
      secrets.TELEGRAM_BOT_TOKEN = "telegram-bot-token";
      hostSecrets.TELEGRAM_ALLOWED_USERS = "telegram-owner-id";
    };

    services.hermes-agent.settings.platforms.telegram = {
      enabled = true;
      # DMs from anyone else go unanswered, with no pairing offer
      unauthorized_dm_behavior = "ignore";
      # no sender in a group
      group_allow_from = [ ];
    };
  };
}
