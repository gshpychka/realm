# Evaluate an agent's NixOS execution environment and its independent host role.
{
  name,
  pkgs,
  incus ? pkgs.incus,
  bay ? pkgs.callPackage ../bay { },
  modules ? [ ],
}:
let
  inherit (pkgs) lib;
  guest = import ../bay/image.nix {
    inherit pkgs incus bay;
    modules = [
      ./agent-module.nix
      { environment.systemPackages = [ pkgs.ripgrep ]; }
    ]
    ++ modules;
  };
  role = guest.system.config.pituitary.agent;
  command = [ "${pkgs.bashInteractive}/bin/bash" ];
  manifest = {
    schemaVersion = 1;
    inherit name;
    inherit (role)
      description
      instructions
      model
      tools
      delegatesTo
      credentials
      limits
      ;
  };
in
assert lib.assertMsg (builtins.match "[a-zA-Z][a-zA-Z0-9_-]*" name != null)
  "Pituitary agent names must start with a letter and contain only letters, digits, underscores, and hyphens";
{
  inherit (guest) system;
  image = { inherit (guest) metadata disk; };
  inherit manifest;
  inherit (role) verification;
  manifestFile = (pkgs.formats.json { }).generate "pituitary-agent-${name}.json" manifest;
  # Pi Durable runs on the host. Bay provides files, commands and an operator shell.
  # Role metadata stays outside the image, so prompt edits require no OS rebuild.
  program = {
    inherit command;
    resume = command;
    history = [ ];
    monitor = false;
  };
}
