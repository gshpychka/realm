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
        ./bay-session.sh
        ./cmd
        ./internal
      ];
    };
    vendorHash = "sha256-VvyjLzqTaKN7kWO0O3mjHYFMoc1zmWcLX0W546azp7U=";
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
    postInstall = "rm $out/bin/flare $out/bin/bay-guest";
    passthru.guestTools = buildGoModule (
      common
      // {
        pname = "bay-guest";
        subPackages = [ "cmd/bay-guest" ];
        # The host Bay derivation runs all package tests.
        doCheck = false;
        meta = common.meta // {
          description = "Unprivileged execution environments and bounded operator transfers for Bay";
          mainProgram = "bay-guest";
        };
      }
    );
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
