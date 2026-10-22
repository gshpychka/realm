{ glances }:
# Network metadata can be unavailable (including SIOCETHTOOL under QEMU ARM).
# Forked filesystem probes can also crash; never block waiting for their queue.
# Keep the pinned OS package and all its tests, with bounded failure handling.
# Tests wait for server readiness under emulation and allow unknown CPU topology,
# as documented by psutil.cpu_count(logical=False); endpoint assertions remain.
glances.overridePythonAttrs (old: {
  patches = (old.patches or [ ]) ++ [
    ./ip-probe.patch
    ./test-portability.patch
  ];
  postPatch = (old.postPatch or "") + ''
    cp ${./test_ip_probe.py} tests/test_ip_probe.py
  '';
})
