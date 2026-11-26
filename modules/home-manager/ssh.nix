{
  config,
  lib,
  osConfig,
  ...
}:
let
  cfg = config.my.ssh;
  domain = osConfig.my.domain;
in
{
  options.my.ssh = {
    enable = lib.mkEnableOption "SSH client configuration";
    hostSettings = lib.mkOption {
      type = lib.types.attrsOf lib.types.attrs;
      default = { };
      description = "Extra ssh_config keys for fleet hosts on this machine, by host name";
    };
  };

  config = lib.mkIf cfg.enable {
    programs = {
      ssh = {
        enable = true;
        extraConfig = ''
          CanonicalizeHostname yes
          CanonicalDomains ${domain}

          # only canonicalize hosts with no dots
          CanonicalizeMaxDots 0
        '';
        enableDefaultConfig = false;

        settings =
          let
            # Tailscale MagicDNS names take the form <host>.<tailnet>.ts.net
            tailnetSuffix = "ts.net";
            hostBlock =
              name: h: extra:
              lib.hm.dag.entryBefore [ "local" "remote" ] (
                {
                  User = if h.sshUser != null then h.sshUser else osConfig.my.user;
                  ForwardAgent = true;
                }
                // extra
                // h.sshSettings
                // cfg.hostSettings.${name} or { }
              );
            fleetBlocks = lib.mapAttrs (
              name: h:
              hostBlock name h {
                header = "Match final host ${name},${name}.${domain},${name}.*.${tailnetSuffix}";
              }
            ) osConfig.my.hosts;

            # HostName carries the tailnet address, so <name>-ts works with any
            # resolver.
            tailnetBlocks = lib.mapAttrs' (
              name: h:
              lib.nameValuePair "${name}-ts" (
                hostBlock name h {
                  header = "Match final host ${name}-ts,${name}-ts.${domain}";
                  HostName = h.tailscaleIp;
                }
              )
            ) (lib.filterAttrs (_: h: h.tailscaleIp != null) osConfig.my.hosts);
          in
          # order matters for SSH, since the first value wins (no overrides later)
          # The order of the attrs specified here has no effect on the resulting file
          # because HM orders these as a DAG, so we need to specify the dependencies ourselves
          # Short attr names are used (rather than literal `Match ...` keys) so the DAG
          # references stay stable and readable.
          fleetBlocks
          // tailnetBlocks
          // {

            local = {
              header = "Match final host *.${domain}";
              User = osConfig.my.user;
              ForwardAgent = true;
            };

            remote = {
              # do not match before canonicalization, if any
              # we can't just use `host` because it would match on the first pass
              # (i.e. before canonicalization)
              # N.B. we need to use `final` as opposed to `canonical`,
              # since the latter will not match if no canonicalization happens
              header = "Match final host !*.${domain}";
              ForwardAgent = false;
              SetEnv = {
                # avoid compatibility issues with Ghostty
                TERM = "xterm-256color";
              };
            };
            "*" = {
              AddKeysToAgent = "no";
              Compression = true;
              EscapeChar = "none";
              # detect dead connections in ~45s and keep NAT mappings alive
              ServerAliveInterval = 15;
              ServerAliveCountMax = 3;
              # keystroke-timing chaff costs ~20ms per keypress and extra packets
              ObscureKeystrokeTiming = false;
              HashKnownHosts = false;
              UserKnownHostsFile = "~/.ssh/known_hosts";
              # share one connection per destination; new sessions skip the
              # TCP + key exchange + auth round trips
              ControlMaster = "auto";
              ControlPath = "~/.ssh/master-%C"; # %C = hash of user/host/port
              ControlPersist = "10m";
            };
          };
      };
    };
  };
}
