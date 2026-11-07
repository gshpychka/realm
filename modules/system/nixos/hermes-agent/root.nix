# Root on this host for the Hermes agent: sudo for any command, authenticated
# by a key that an SSH agent holds for the service user.
{ config, lib, ... }:
let
  cfg = config.my.hermes-agent;
  service = config.services.hermes-agent;
  host = config.networking.hostName;
in
{
  options.my.hermes-agent.root = lib.mkOption {
    default = null;
    description = "The key the agent's sudo authenticates with; null leaves the agent without sudo.";
    type = lib.types.nullOr (
      lib.types.submodule {
        options = {
          publicKey = lib.mkOption {
            type = lib.types.singleLineStr;
            description = "The key's public half.";
          };
          agentSocket = lib.mkOption {
            type = lib.types.str;
            description = "Socket of the SSH agent holding the key's private half.";
          };
        };
      }
    );
  };

  config = lib.mkIf (service.enable && cfg.root != null) {
    services.hermes-agent.environment.SSH_AUTH_SOCK = cfg.root.agentSocket;

    security = {
      pam.sshAgentAuth.enable = true;
      sudo.extraRules = [
        {
          users = [ service.user ];
          commands = [ "ALL" ];
        }
      ];
    };
    # the keys sudo's pam_ssh_agent_auth accepts for the service user
    users.users.${service.user}.openssh.authorizedKeys.keys = [ cfg.root.publicKey ];

    # setuid sudo, and root's writes anywhere on the file system, which the upstream units' hardening forbids
    systemd.services = lib.genAttrs cfg.units (_: {
      serviceConfig = {
        NoNewPrivileges = lib.mkForce false;
        ProtectSystem = lib.mkForce false;
      };
    });

    my.hermes-agent.skills.nixos-switch = lib.mkIf config.my.nixosSwitch.enable {
      description = "Rebuild and switch this host (${host}) to a commit of its NixOS config.";
      text = ''
        `nixos-switch` builds this host's config at a commit on main of its
        canonical repository, and switches to it:

            nixos-switch build <full commit sha>
            sudo nixos-switch switch <full commit sha>

        A commit that is not on main is refused: push first. A switch may
        restart this agent mid-turn, ending the command; the activation runs
        on in its own unit, and returns to the previous generation when it
        fails. Its journal shows how the last one ended:

            sudo journalctl -u nixos-switch -I
      '';
    };
  };
}
