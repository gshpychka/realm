{
  stdenv,
  pyrate-limiter,
  redisTestHook,
}:
# PlayStation Network's limiter tests use an ephemeral Valkey server. Its ARM
# copy-on-write kernel probe fails under our QEMU user emulation before the
# socket opens. Disable persistence before suppressing that probe, only here:
# no background save can use copy-on-write in this disposable test database.
if !stdenv.hostPlatform.isAarch64 then
  pyrate-limiter
else
  pyrate-limiter.override {
    redisTestHook = redisTestHook.overrideAttrs (old: {
      buildCommand = old.buildCommand + ''
        substituteInPlace "$out/nix-support/setup-hook" \
          --replace-fail 'enable-module-command yes' 'enable-module-command yes
        save ""
        appendonly no
        ignore-warnings ARM64-COW-BUG' \
          --replace-fail '> /dev/null 2>&1 &' '> "$NIX_BUILD_TOP/run/redis.log" 2>&1 &' \
          --replace-fail '    sleep 1' '    if ! kill -0 "$REDIS_PID" 2>/dev/null; then
            cat "$NIX_BUILD_TOP/run/redis.log" >&2
            wait "$REDIS_PID" || true
            return 1
          fi
          sleep 1'
      '';
    });
  }
