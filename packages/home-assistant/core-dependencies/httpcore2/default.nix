{ httpcore2 }:
# Keep every cancellation assertion, but start the timeout once the simulated
# blocked I/O is reached. A 10ms deadline can cancel HTTP/2 setup under ARM QEMU.
httpcore2.overridePythonAttrs (old: {
  patches = (old.patches or [ ]) ++ [ ./cancellation-phase.patch ];
})
