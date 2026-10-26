# Secrets the Hermes agent decrypts itself: sops in its commands, with an age
# key of its own generated on this host.
#
# Imperative, once per key, after the gateway's first start generates it: add
# its public half as a key of .sops.yaml with a secrets/hermes/ rule like
# secrets/openclaw/'s, then create or re-encrypt the files there from a
# checkout, with the YubiKey or the op age key:
#   sudo grep '^# public key' /var/lib/hermes/age-key.txt
#   find secrets/hermes -type f -exec sops updatekeys -y {} \;
{
  config,
  lib,
  pkgs,
  ...
}:
let
  service = config.services.hermes-agent;
  keyFile = "${service.stateDir}/age-key.txt";

  generateKey = pkgs.writeShellScript "hermes-agent-generate-age-key" ''
    # whether nothing exists (`! -e`) at the key's path
    if ! [ -e ${keyFile} ]; then
      # a new key pair, written to that path (-o)
      ${lib.getExe' pkgs.age "age-keygen"} -o ${keyFile}
    fi
  '';
in
{
  config = lib.mkIf service.enable {
    services.hermes-agent = {
      environment.SOPS_AGE_KEY_FILE = keyFile;
      extraPackages = [ pkgs.sops ];
    };

    systemd.services.hermes-agent.serviceConfig.ExecStartPre = [ "${generateKey}" ];

    my.hermes-agent.skills.sops = {
      description = "Read and write sops secrets encrypted to your own age key, in a checkout of this host's NixOS config.";
      text = ''
        `sops` decrypts with your own age key, with no setup. In a checkout of
        this host's NixOS config, `.sops.yaml` encrypts files under
        `secrets/hermes/` to you and to the owner:

        - `printf '{}\n' | sops encrypt --filename-override secrets/hermes/<file>.yaml > secrets/hermes/<file>.yaml`
          creates an empty one;
        - `sops decrypt --extract '["<key>"]' secrets/hermes/<file>` reads
          one value;
        - `sops set secrets/hermes/<file> '["<key>"]' '"<value>"'` adds or
          changes a value.

        A decrypted value enters your context and goes to the model
        provider: decrypt only what the task needs, and never repeat a
        secret value in a reply.
      '';
    };
  };
}
