# The session image in the form Incus imports: a metadata tarball and a disk.
{
  pkgs,
  incus,
  bay ? pkgs.callPackage ./. { },
  modules ? [ ],
}:
let
  system = pkgs.nixos {
    _module.args = { inherit bay; };
    imports = [ ./guest.nix ] ++ modules;
    # the guest agent loader comes from the same Incus as the host
    virtualisation.incus.package = incus;
  };
  name = system.config.image.baseName;
in
{
  inherit system;
  metadata = "${system.metadata}/tarball/${name}.tar.xz";
  disk = "${system.repartImage}/${name}.qcow2";
}
