{ config, lib, ... }:
let
  team = import ../../agents;
in
{
  networking.hostId = "91e0f444";
  boot.zfs.forceImportRoot = false;

  services.bay = {
    network.address = "10.80.0.1/24";
    storage.size = "96GiB";
    sessions = {
      cpus = 4;
      memory = 16;
      disk = 24;
      maxRunning = 4;
      maxMemory = 64;
    };
  };

  services.dura = {
    enable = true;
    operator = config.my.user;
    model = "openai/gpt-6.1-sol";
    authFile = "/home/${config.my.user}/.pi/agent/auth.json";
    credentialProfiles.primary.provider = "openai";
    limits.deadlineMs = 4 * 60 * 60 * 1000;
    agents = team // {
      builder = {
        imports = [ team.builder ];
        # Realm's flake checks include nested-VM tests; verification runs CI's evaluation and lint jobs.
        dura.agent.verification.checks = {
          flake = {
            command = lib.mkForce [
              "nix"
              "flake"
              "check"
              "--all-systems"
              "--no-build"
            ];
            timeoutMs = 1200000;
          };
          lint = {
            command = [
              "nix"
              "build"
              "--no-link"
              ".#checks.x86_64-linux.statix"
              ".#checks.x86_64-linux.deadnix"
              ".#checks.x86_64-linux.treefmt"
              ".#checks.x86_64-linux.biome"
              ".#checks.x86_64-linux.ruff"
              ".#checks.x86_64-linux.bay-shellcheck"
            ];
            timeoutMs = 1200000;
          };
        };
      };
    };
  };
}
