# AWS credentials for my user through IAM Roles Anywhere: infra/aws trusts this CA, and its certificates assume
# the deploy role. Every process running as my user, coding agents included, can get them.
#
# A new CA certificate, whenever the issuer refuses with "this TPM2's CA key is not the registered CA certificate's"
# (a Secure Boot change or a TPM clear). The deploy role is out of reach until then, so the apply runs on the SSO
# profile:
#   sudo "$(nix build --no-link --print-out-paths .#rolesanywhere)/bin/rolesanywhere" ca-certificate > machines/reaper/rolesanywhere-ca.pem
#   in the infra shell: cd infra/aws && AWS_PROFILE=<SSO profile> tg apply
#   deploy reaper
{ config, ... }:
{
  services.rolesanywhere = {
    enable = true;
    clients = [ config.my.user ];
    caCertificate = ./rolesanywhere-ca.pem;
  };
}
