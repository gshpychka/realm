# Rootless Docker fails a container start when its dynamic host port is taken
# on the host: https://github.com/moby/moby/issues/53153
_final: prev:
let
  moby = prev.docker.moby.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./docker-rootless-port-retry.patch ];
  });
in
{
  docker = prev.docker.overrideAttrs (old: {
    # installPhase links the daemon by its moby store path, which overriding the
    # `moby` attribute doesn't reach
    installPhase = builtins.replaceStrings [ "${prev.docker.moby}" ] [ "${moby}" ] old.installPhase;
  });
}
