# The agent's access to the owner's OneDrive, synced both ways on this host.
{ config, lib, ... }:
let
  cfg = config.my.hermes-agent;
  service = config.services.hermes-agent;
  onedrive = config.my.onedrive;
in
{
  options.my.hermes-agent.onedrive.enable = lib.mkEnableOption ''
    the owner's OneDrive for the agent: read and write access to the synced
    tree'';

  config = lib.mkIf (service.enable && cfg.onedrive.enable) {
    assertions = [
      {
        assertion = onedrive.enable;
        message = "my.hermes-agent.onedrive.enable needs my.onedrive, whose synced tree it gives the agent.";
      }
    ];

    users.users.${service.user}.extraGroups = [ onedrive.group ];

    # writable through the units' read-only file system (ProtectSystem=strict)
    systemd.services = lib.genAttrs cfg.units (_: {
      serviceConfig.ReadWritePaths = [ onedrive.syncDir ];
    });

    my.hermes-agent.skills.onedrive = {
      description = "Read, write and organise the owner's OneDrive files, synced both ways at ${onedrive.syncDir}.";
      text = ''
        `${onedrive.syncDir}` is the owner's whole OneDrive, kept in sync both
        ways: what you create, change, move or delete there changes on
        OneDrive within seconds, and changes made elsewhere arrive within
        ${toString (onedrive.pollInterval / 60)} minutes. Use the normal file
        tools. Bring a file in from elsewhere with
        `install -m 660 -g ${onedrive.group} <file> <dir>/`: a copied or
        moved file keeps permissions the sync cannot read.

        OneDrive's recycle bin keeps what you delete for 30 days. Deleting a
        folder that holds ${toString onedrive.bigDeleteThreshold} or more
        items, itself included, stops the sync until the owner confirms.
      '';
    };
  };
}
