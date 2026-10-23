{ config, pkgs, ... }:
{
  networking.hostId = "91e0f444";
  boot.zfs.forceImportRoot = false;

  services.bay = {
    network.address = "10.80.0.1/24";
    storage.size = "96GiB";
    sessions = {
      cpus = 4;
      memory = 4;
      disk = 24;
      maxRunning = 4;
      maxMemory = 16;
    };
  };

  services.dura = {
    enable = true;
    operator = config.my.user;
    model = "openai-codex/gpt-6.1-sol";
    authFile = "/home/${config.my.user}/.pi/agent/auth.json";
    credentialProfiles.primary.provider = "openai-codex";
    agents = (import ../../agents) // {
      builder = {
        imports = [ (import ../../agents).builder ];
        dura.agent.verification.checks.unit.command = pkgs.lib.mkForce [
          "bash"
          "-c"
          "bun install --frozen-lockfile && bun test packages/dura"
        ];
      };
    };
  };
}
