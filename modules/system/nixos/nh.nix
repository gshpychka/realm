{ pkgs, ... }:
{
  # `nh os switch --target-host` diffs the new system with dix on the target
  environment.systemPackages = [ pkgs.dix ];
}
