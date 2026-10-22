# Evaluate one agent as a real Bay NixOS guest and a separately delivered role manifest.
{
  name,
  pkgs,
  workerPackage,
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
      { environment.systemPackages = [ workerPackage ]; }
    ]
    ++ modules;
  };
  role = guest.system.config.pituitary.agent;
  state = "/home/dev/.local/state/pituitary";
  socket = "${state}/worker.sock";
  worker = lib.getExe workerPackage;
  command = [
    worker
    "--role-required"
    "--socket"
    socket
    "--state"
    state
    "--cwd"
    "/work"
  ];
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
  manifestFile = (pkgs.formats.json { }).generate "pituitary-agent-${name}.json" manifest;
  # The same connector and image serve different roles. The manifest is delivered
  # separately by the orchestration runtime; embedding it here would rebuild the OS for prompt edits.
  program = {
    inherit command;
    resume = command;
    connect = [
      worker
      "connect"
      "--socket"
      socket
    ];
    # Process ownership and sockets belong to an instance, never restored history.
    history = map (path: ".local/state/pituitary/${path}") [
      "worker.json"
      "role.json"
      "assignment.json"
      "commands.json"
      "domain.json"
      "sessions"
      "agent"
    ];
    monitor = false;
    maxConnections = 8;
  };
}
