{
  config,
  ...
}:
{
  services = {
    nginx = {
      enable = true;
      recommendedProxySettings = true;
      recommendedTlsSettings = true;
      virtualHosts = {
        adguard = {
          serverName = "adguard.${config.networking.fqdn}";
          useACMEHost = config.networking.fqdn;
          onlySSL = true;
          extraConfig = ''
            proxy_buffering off;
          '';
          locations."/" = {
            proxyPass = "http://${config.services.adguardhome.settings.http.address}";
          };
        };
        "block-root-domain" = {
          serverName = config.networking.fqdn; # Explicitly block the base domain
          useACMEHost = config.networking.fqdn;
          onlySSL = true;
          default = true;
          locations."/" = {
            return = "444";
          };
        };
      };
    };
  };
  networking.firewall.allowedTCPPorts = [
    config.services.nginx.defaultSSLListenPort
  ];
}
