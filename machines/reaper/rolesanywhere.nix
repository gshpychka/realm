# AWS credentials for my user through IAM Roles Anywhere: infra/aws trusts this CA, and its certificates assume
# the deploy role. Every process running as my user, coding agents included, can get them.
#
# Registering a new CA, whenever `journalctl -u rolesanywhere-ca` says it is not registered with AWS. The CA's
# certificates open no session until then, so the apply runs on the SSO profile:
#   cp /var/lib/rolesanywhere/current/ca.pem machines/reaper/rolesanywhere-ca.pem
#   in the infra shell: cd infra/aws && AWS_PROFILE=<SSO profile> tg apply
#   deploy reaper
{ config, ... }:
{
  services.rolesanywhere = {
    enable = true;
    clients = [ config.my.user ];
  };
}
