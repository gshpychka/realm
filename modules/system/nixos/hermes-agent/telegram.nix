# The Telegram channel (https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram):
# the owner's DMs with the agent's bot.
#
# Imperative, one-time: create the bot with @BotFather, then store its token
# and the owner's numeric user id (from @userinfobot):
#   sops set <sopsFile> '["hermes-telegram-bot-token"]' '"<token>"'
#   sops set <sopsFile> '["telegram-owner-id"]' '"<numeric id>"'
{ config, lib, ... }:
let
  cfg = config.my.hermes-agent;
  service = config.services.hermes-agent;
in
{
  options.my.hermes-agent.telegram.enable = lib.mkEnableOption ''
    the Telegram channel: the bot whose token is sopsFile's
    hermes-telegram-bot-token, in DMs with the user whose numeric id is
    sopsFile's telegram-owner-id'';

  config = lib.mkIf (service.enable && cfg.telegram.enable) {
    my.hermes-agent.secrets = {
      TELEGRAM_BOT_TOKEN = "hermes-telegram-bot-token";
      TELEGRAM_ALLOWED_USERS = "telegram-owner-id";
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
