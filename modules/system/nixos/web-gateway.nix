# Authenticated entry point for a machine's web services.
#
# nginx is the only network path to a declared service: each one gets a TLS
# vhost <name>.<fqdn> backed by the machine's wildcard ACME certificate. With
# `sso.enable`, Authelia (portal at auth.<fqdn>, single sign-on across the
# vhosts) authorizes every request to services with `auth = "gateway"` through
# nginx's auth_request and passes the signed-in identity in Remote-* headers;
# the service's own login is expected to be off.
# Services with `auth = "native"` authenticate every request themselves and
# are proxied untouched. With the SSO layer off, every vhost is a plain TLS
# proxy and nothing else of the gateway exists on the machine.
#
# Programmatic access model: declared apiBypassPrefixes skip the portal and
# answer to the service's own API-key check, and a loopback firewall gate
# limits direct connections to gateway-auth ports to declared static clients
# and the host's systemd DynamicUser class, or to a service's own client list,
# so delegating a service's login to the gateway does not open that service to
# arbitrary local processes.
#
# nginx wiring follows https://www.authelia.com/integration/proxies/nginx/.
{ config, lib, ... }:
let
  cfg = config.my.webGateway;
  inherit (config.networking) fqdn;

  instanceName = "main";
  # the upstream module names the unit, user, group, and StateDirectory
  # "authelia-<instance>"
  autheliaName = "authelia-${instanceName}";
  autheliaService = config.systemd.services.${autheliaName};
  autheliaUser = config.services.authelia.instances.${instanceName}.user;
  autheliaPort = 9091;
  autheliaAddr = "127.0.0.1:${toString autheliaPort}";
  autheliaStateDir = "/var/lib/${autheliaName}";
  authDomain = "auth.${fqdn}";
  authzPath = "/internal/authelia/authz";

  serviceDomain = name: "${name}.${fqdn}";
  ssoOn = cfg.enable && cfg.sso.enable;
  gateOn = ssoOn && cfg.loopbackGate.enable;
  iptablesFirewall =
    config.networking.firewall.enable && config.networking.firewall.backend == "iptables";
  gatewayAuthServices = lib.filterAttrs (_: s: s.auth == "gateway") cfg.services;

  # Contract with the SOPS file: one flat key per secret.
  machineSecretKeys = [
    "jwt-secret"
    "session-secret"
    "storage-encryption-key"
  ];
  userHashKey = user: "password-hash-${user}";
  secretName = key: "authelia/${key}";
  usersFileTemplate = "authelia-users.yaml";

  mkSecret = key: {
    inherit (cfg.sso) sopsFile;
    inherit key;
    owner = autheliaUser;
    restartUnits = [ autheliaService.name ];
  };

  delegatesAuth = svc: ssoOn && svc.auth == "gateway";

  # Identity Authelia's authz endpoint returns for a signed-in request
  # (https://www.authelia.com/integration/proxies/nginx/), keyed by header.
  identityHeaders = {
    ${cfg.sso.identityHeader} = "$authelia_user";
    Remote-Groups = "$authelia_groups";
    Remote-Email = "$authelia_email";
    Remote-Name = "$authelia_name";
  };

  mkServiceVhost = name: svc: {
    serverName = serviceDomain name;
    useACMEHost = fqdn;
    onlySSL = true;
    locations = {
      "/" = {
        proxyPass = "http://127.0.0.1:${toString svc.port}";
        proxyWebsockets = svc.websockets;
      }
      // lib.optionalAttrs (delegatesAuth svc) {
        # On 401 the authz endpoint's Location header points at the portal
        # with the original URL as the post-login redirect. On 200 it names the
        # signed-in user; proxy_set_header replaces any client-sent copy of
        # those headers, and an empty value (bypassed paths) drops them.
        extraConfig = ''
          auth_request ${authzPath};
          auth_request_set $redirection_url $upstream_http_location;
          error_page 401 =302 $redirection_url;
          ${lib.concatStrings (
            lib.mapAttrsToList (header: variable: ''
              auth_request_set ${variable} $upstream_http_${
                lib.toLower (lib.replaceStrings [ "-" ] [ "_" ] header)
              };
              proxy_set_header ${header} ${variable};
            '') identityHeaders
          )}
        '';
      };
    }
    // lib.optionalAttrs (delegatesAuth svc) {
      "= ${authzPath}" = {
        extraConfig = ''
          internal;
          proxy_pass http://${autheliaAddr}/api/authz/auth-request;
          proxy_set_header X-Original-Method $request_method;
          proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
          proxy_set_header X-Forwarded-For $remote_addr;
          proxy_set_header Content-Length "";
          proxy_set_header Connection "";
          proxy_pass_request_body off;
        '';
      };
    };
  };

  # unknown vhosts get 404
  catchAllLabel = "_";
  catchAllVhost = {
    serverName = catchAllLabel;
    default = true;
    useACMEHost = fqdn;
    onlySSL = true;
    locations."/".return = 404;
  };

  # Loopback gate: only connection-opening packets are checked, because reply
  # packets on lo carry the server process's uid.
  gateChain = "web-gateway";
  gatedPorts = lib.unique (
    lib.sort lib.lessThan (lib.mapAttrsToList (_: s: s.port) gatewayAuthServices)
  );
  # systemd allocates DynamicUser uids from this fixed range (systemd.exec(5)).
  # This deliberately trusts every DynamicUser service configured by root on
  # the machine, not only the clients listed below.
  dynamicUserUidRange = "61184-65519";
  allowedUsers = lib.unique (
    [
      "root"
      config.services.nginx.user
    ]
    ++ cfg.loopbackGate.clients
  );
  # multiport matches at most 15 ports per rule
  multiportLimit = 15;
  chunksOf = n: xs: if xs == [ ] then [ ] else [ (lib.take n xs) ] ++ chunksOf n (lib.drop n xs);
  gatedPortChunks = chunksOf multiportLimit gatedPorts;
  gateJump = "OUTPUT -o lo -p tcp -m conntrack --ctstate NEW -j ${gateChain}";

  # The target chain is the stable identity of every rule this module has
  # installed in OUTPUT. Delete all references to it by rule number,
  # independently for IPv4 and IPv6; matching only gateJump would strand the
  # older port-specific form when migrating to the fixed jump.
  deleteGateJumps = ''
    for iptables_cmd in iptables ip6tables; do
      while :; do
        jump_number=
        while read -r rule_number target _; do
          if [[ "$target" == "${gateChain}" ]]; then
            jump_number="$rule_number"
            break
          fi
        done < <("$iptables_cmd" -w -n -L OUTPUT --line-numbers 2>/dev/null || true)

        [[ -n "$jump_number" ]] || break
        "$iptables_cmd" -w -D OUTPUT "$jump_number" 2>/dev/null || break
      done
    done
  '';
  gateTeardown = ''
    ${deleteGateJumps}
    for iptables_cmd in iptables ip6tables; do
      "$iptables_cmd" -w -F ${gateChain} 2>/dev/null || true
      "$iptables_cmd" -w -X ${gateChain} 2>/dev/null || true
    done
  '';
  # Services naming their own loopback clients get port-specific rules ahead of
  # the machine-wide allow-list, so that list never reaches their ports.
  exclusiveGateServices = lib.filterAttrs (_: s: s.loopbackClients != null) gatewayAuthServices;
  exclusiveGateRules = lib.concatStrings (
    lib.mapAttrsToList (
      _: svc:
      lib.concatMapStrings
        (user: ''
          ip46tables -A ${gateChain} -p tcp --dport ${toString svc.port} -m owner --uid-owner ${user} -j RETURN
        '')
        (
          lib.unique (
            [
              "root"
              config.services.nginx.user
            ]
            ++ svc.loopbackClients
          )
        )
      + ''
        ip46tables -A ${gateChain} -p tcp --dport ${toString svc.port} -j REJECT --reject-with tcp-reset
      ''
    ) exclusiveGateServices
  );

  # Keep the global OUTPUT hook fixed and put the mutable port policy inside
  # the module-owned chain, mirroring NixOS's own INPUT -> nixos-fw shape.
  # Start from the same configuration-independent teardown used on disable,
  # then install exactly the currently declared rules.
  gateInstall = ''
    ${gateTeardown}
    ip46tables -N ${gateChain}
    ${exclusiveGateRules}
    ${lib.concatMapStrings (user: ''
      ip46tables -A ${gateChain} -m owner --uid-owner ${user} -j RETURN
    '') allowedUsers}
    ip46tables -A ${gateChain} -m owner --uid-owner ${dynamicUserUidRange} -j RETURN
    ${lib.concatMapStrings (ports: ''
      ip46tables -A ${gateChain} -p tcp -m multiport \
        --dports ${lib.concatMapStringsSep "," toString ports} -j REJECT --reject-with tcp-reset
    '') gatedPortChunks}
    ip46tables -A ${gateJump}
  '';
in
{
  options.my.webGateway = {
    enable = lib.mkEnableOption "authenticated web entry point (nginx + Authelia + loopback gate)";

    services = lib.mkOption {
      default = { };
      description = "Web services exposed through the gateway, keyed by vhost subdomain.";
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            port = lib.mkOption {
              type = lib.types.port;
              description = "Loopback port the service listens on.";
            };
            auth = lib.mkOption {
              type = lib.types.enum [
                "gateway"
                "native"
              ];
              default = "gateway";
              description = ''
                Who authenticates interactive access: the gateway (Authelia in
                front, the service's own login off) or the service itself
                (multi-user identity lives in the app).
              '';
            };
            loopbackClients = lib.mkOption {
              type = lib.types.nullOr (lib.types.listOf lib.types.str);
              default = null;
              description = ''
                Users whose processes may open direct loopback connections to
                this gateway-auth service's port, replacing loopbackGate.clients
                and the DynamicUser class for it; root and nginx are always
                admitted. Null applies the machine-wide allow-list.
              '';
            };
            websockets = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Forward WebSocket upgrades to the service.";
            };
            apiBypassPrefixes = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              example = [ "/api" ];
              description = ''
                URL path prefixes that skip gateway auth; the service enforces
                its own API key on them, which is how LAN programmatic clients
                authenticate.
              '';
            };
          };
        }
      );
    };

    loopbackGate = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Restrict direct loopback connections to gateway-auth service ports
          to the users in `clients`. Disabled, those ports answer to every
          local process, including ones a service's delegated login no longer
          challenges. The gate accompanies the SSO layer: without
          `sso.enable` it is torn down.
        '';
      };
      clients = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = ''
          Static service users whose processes may open direct loopback
          connections to gateway-auth service ports. systemd DynamicUser
          services are admitted as a class; every other local process is
          rejected.
        '';
      };
    };

    sso = {
      identityHeader = lib.mkOption {
        type = lib.types.str;
        readOnly = true;
        default = "Remote-User";
        description = ''
          Request header carrying the signed-in user's name to gateway-auth
          services; the gateway sets it on every proxied request.
        '';
      };
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          The interactive-auth layer: the Authelia portal, per-vhost
          enforcement, and the loopback gate. Disabled, every vhost proxies
          without an auth check and none of the layer's services, secrets, or
          firewall rules exist on the machine.
        '';
      };
      sopsFile = lib.mkOption {
        type = lib.types.path;
        description = ''
          SOPS file holding flat keys jwt-secret, session-secret,
          storage-encryption-key, and password-hash-<name> (an argon2id
          digest) for every declared user.
        '';
      };
      users = lib.mkOption {
        default = { };
        description = "Accounts that can sign in at the portal.";
        type = lib.types.attrsOf (
          lib.types.submodule {
            options = {
              displayName = lib.mkOption {
                type = lib.types.str;
                description = "Name shown in the portal.";
              };
              email = lib.mkOption {
                type = lib.types.str;
                description = "Recipient of identity-validation notifications (delivered to the filesystem notifier).";
              };
            };
          }
        );
      };
    };
  };

  config = lib.mkMerge [
    # Keep the teardown in the disabled gateway configuration while the
    # iptables firewall remains active. Firewall reloads use the new
    # generation's hooks, so placing this behind cfg.enable would strand rules
    # when the whole gateway is switched off.
    (lib.mkIf iptablesFirewall {
      networking.firewall = {
        extraCommands = if gateOn then gateInstall else gateTeardown;
        extraStopCommands = gateTeardown;
      };
    })
    (lib.mkIf cfg.enable {
      networking.hosts."127.0.0.1" =
        map serviceDomain (lib.attrNames cfg.services) ++ lib.optional ssoOn authDomain;

      assertions = [
        {
          assertion = config.security.acme.certs ? ${fqdn};
          message = "my.webGateway serves vhosts from the ${fqdn} wildcard certificate; enable my.acme.";
        }
        {
          assertion = !(cfg.services ? auth);
          message = "my.webGateway.services: the vhost label 'auth' is reserved for the Authelia portal.";
        }
        {
          assertion = !(cfg.services ? ${catchAllLabel});
          message = "my.webGateway.services: the vhost label '${catchAllLabel}' is reserved for the catch-all 404 sink.";
        }
        {
          assertion = !ssoOn || gatewayAuthServices != { };
          message = "my.webGateway.sso: no service delegates auth to the gateway; drop the SSO layer instead.";
        }
        {
          assertion = !ssoOn || cfg.sso.users != { };
          message = "my.webGateway.sso.users: at least one portal account is required.";
        }
        {
          assertion = lib.all (s: s.auth == "gateway" || s.apiBypassPrefixes == [ ]) (
            lib.attrValues cfg.services
          );
          message = "my.webGateway.services: apiBypassPrefixes only applies to auth = \"gateway\" services.";
        }
        {
          assertion = lib.all (u: config.users.users ? ${u}) cfg.loopbackGate.clients;
          message = "my.webGateway.loopbackGate.clients must name existing users.users entries.";
        }
        {
          assertion = lib.all (s: s.loopbackClients == null || s.auth == "gateway") (
            lib.attrValues cfg.services
          );
          message = "my.webGateway.services: loopbackClients only applies to auth = \"gateway\" services.";
        }
        {
          assertion = lib.all (u: config.users.users ? ${u}) (
            lib.concatMap (s: lib.optionals (s.loopbackClients != null) s.loopbackClients) (
              lib.attrValues cfg.services
            )
          );
          message = "my.webGateway.services.*.loopbackClients must name existing users.users entries.";
        }
        {
          assertion = !gateOn || iptablesFirewall;
          message = "my.webGateway.loopbackGate requires the NixOS iptables firewall.";
        }
      ];

      sops.secrets = lib.mkIf ssoOn (
        lib.listToAttrs (
          map (key: lib.nameValuePair (secretName key) (mkSecret key)) (
            machineSecretKeys ++ map userHashKey (lib.attrNames cfg.sso.users)
          )
        )
      );

      # JSON is a YAML subset, so the users database renders via toJSON.
      sops.templates.${usersFileTemplate} = lib.mkIf ssoOn {
        owner = autheliaUser;
        restartUnits = [ autheliaService.name ];
        content = builtins.toJSON {
          users = lib.mapAttrs (name: user: {
            displayname = user.displayName;
            inherit (user) email;
            password = config.sops.placeholder.${secretName (userHashKey name)};
          }) cfg.sso.users;
        };
      };

      services.authelia.instances.${instanceName} = lib.mkIf ssoOn {
        enable = true;
        secrets = {
          jwtSecretFile = config.sops.secrets.${secretName "jwt-secret"}.path;
          sessionSecretFile = config.sops.secrets.${secretName "session-secret"}.path;
          storageEncryptionKeyFile = config.sops.secrets.${secretName "storage-encryption-key"}.path;
        };
        settings = {
          theme = "auto";
          log = {
            level = "info";
            format = "text";
          };
          server = {
            address = "tcp://${autheliaAddr}/";
            endpoints.authz.auth-request.implementation = "AuthRequest";
          };
          authentication_backend.file.path = config.sops.templates.${usersFileTemplate}.path;
          access_control = {
            default_policy = "deny";
            # First match wins: API-key paths bypass the portal, everything else
            # on a gateway-auth domain requires a signed-in user.
            rules = lib.concatLists (
              lib.mapAttrsToList (
                name: svc:
                lib.optional (svc.apiBypassPrefixes != [ ]) {
                  domain = serviceDomain name;
                  policy = "bypass";
                  resources = map (prefix: "^${lib.escapeRegex prefix}([/?].*)?$") svc.apiBypassPrefixes;
                }
                ++ [
                  {
                    domain = serviceDomain name;
                    policy = "one_factor";
                  }
                ]
              ) gatewayAuthServices
            );
          };
          session.cookies = [
            {
              domain = fqdn;
              authelia_url = "https://${authDomain}";
              inactivity = "2h";
              expiration = "12h";
              remember_me = "1M";
            }
          ];
          storage.local.path = "${autheliaStateDir}/db.sqlite3";
          notifier.filesystem.filename = "${autheliaStateDir}/notification.txt";
        };
      };

      services.nginx = {
        enable = true;
        recommendedProxySettings = true;
        recommendedTlsSettings = true;
        virtualHosts = {
          ${catchAllLabel} = catchAllVhost;
        }
        // lib.optionalAttrs ssoOn {
          auth = {
            serverName = authDomain;
            useACMEHost = fqdn;
            onlySSL = true;
            locations."/".proxyPass = "http://${autheliaAddr}";
          };
        }
        // lib.mapAttrs mkServiceVhost cfg.services;
      };

      networking.firewall.allowedTCPPorts = [ config.services.nginx.defaultSSLListenPort ];
    })
  ];
}
