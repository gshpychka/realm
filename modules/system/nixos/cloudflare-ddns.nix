{ config, lib, ... }:

let
  cfg = config.my.cloudflare-ddns;
in
with lib;
{
  options.my.cloudflare-ddns = {
    enable = mkEnableOption "Cloudflare dynamic DNS updater";
    subdomains = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "wan" ];
      description = "Subdomains to update with Cloudflare.";
    };
  };

  config = mkIf cfg.enable {
    # Set up SOPS secret for API token
    sops.secrets.cloudflare-dns-api-token = {
      sopsFile = ../../../secrets/common/cloudflare.yaml;
    };
    sops.templates."cloudflare-ddns.env" = {
      content = "CLOUDFLARE_API_TOKEN=${config.sops.placeholder.cloudflare-dns-api-token}";
      restartUnits = [ "cloudflare-ddns.service" ];
    };

    services.cloudflare-ddns = {
      enable = true;
      credentialsFile = config.sops.templates."cloudflare-ddns.env".path;
      domains = map (subdomain: "${subdomain}.${config.my.domain}") cfg.subdomains;
      provider.ipv6 = "none";
      updateCron = "@every 30s";
      # Cloudflare's minimum for unproxied records outside Enterprise plans.
      # The client applies it only to records it creates and keeps an existing record's TTL on
      # update; an existing record's TTL is set with:
      #   curl -X PATCH -H "Authorization: Bearer $TOKEN" --json '{"ttl":60}' \
      #     https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID
      ttl = 60;
    };
  };
}
