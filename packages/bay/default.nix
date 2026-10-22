{
  lib,
  buildGoModule,
  git,
}:
let
  common = {
    version = "0.1.0";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [
        ./go.mod
        ./go.sum
        ./cmd
        ./internal
      ];
    };
    vendorHash = "sha256-xOlIj/36J5wg+NKKZOanc2atHldgz8ZLw9mwxyhB8zM=";
    env.CGO_ENABLED = 0;
    meta.platforms = lib.platforms.linux;
    ldflags = [
      "-s"
      "-w"
    ];
  };
in
buildGoModule (
  common
  // {
    pname = "bay";
    meta = common.meta // {
      description = "Disposable, isolated VM sessions for terminal programs";
      mainProgram = "bay";
    };
    # the repo mirror tests drive real git repositories
    nativeCheckInputs = [ git ];
    # flare runs inside sessions
    postInstall = "rm $out/bin/flare";
    passthru.flare = buildGoModule (
      common
      // {
        pname = "flare";
        subPackages = [ "cmd/flare" ];
        # the bay derivation runs every package's tests
        doCheck = false;
        meta = common.meta // {
          description = "Session notifications and messaging for Bay";
          mainProgram = "flare";
        };
      }
    );
  }
)
