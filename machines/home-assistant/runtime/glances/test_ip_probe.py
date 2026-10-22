"""Unavailable NIC metadata must not stop unrelated system monitoring."""

import errno
import queue
import socket
from types import SimpleNamespace

import glances.globals as globals_module
import pytest


@pytest.mark.parametrize("ipv6", [False, True])
@pytest.mark.parametrize("error", [errno.ENOTTY, errno.EOPNOTSUPP])
def test_unavailable_interface_metadata(monkeypatch, ipv6, error):
    def unavailable():
        raise OSError(error, "interface metadata unsupported")

    monkeypatch.setattr(globals_module.psutil, "net_if_stats", unavailable)
    assert globals_module.get_ip_address(ipv6=ipv6) == (None, None)


@pytest.mark.parametrize("ipv6", [False, True])
def test_available_interface_metadata(monkeypatch, ipv6):
    family = socket.AF_INET6 if ipv6 else socket.AF_INET
    address = "fd00::123" if ipv6 else "192.0.2.123"
    netmask = "ffff:ffff:ffff:ffff::" if ipv6 else "255.255.255.0"
    monkeypatch.setattr(
        globals_module.psutil,
        "net_if_stats",
        lambda: {"end0": SimpleNamespace(isup=True)},
    )
    monkeypatch.setattr(
        globals_module.psutil,
        "net_if_addrs",
        lambda: {
            "end0": [SimpleNamespace(family=family, address=address, netmask=netmask)]
        },
    )
    assert globals_module.get_ip_address(ipv6=ipv6) == (address, netmask)


@pytest.mark.parametrize("exitcode", [1, -6])
def test_crashed_probe_does_not_wait_for_result(monkeypatch, exitcode):
    def must_not_read(**_kwargs):
        pytest.fail("a crashed worker has no result to wait for")

    worker = SimpleNamespace(
        start=lambda: None,
        join=lambda **_kwargs: None,
        is_alive=lambda: False,
        exitcode=exitcode,
    )
    context = SimpleNamespace(
        Queue=lambda: SimpleNamespace(get=must_not_read),
        Process=lambda **_kwargs: worker,
    )
    monkeypatch.setattr(globals_module, "LINUX", True)
    monkeypatch.setattr(globals_module, "ctx_mp_fork", context)
    wrapped = globals_module.exit_after(2, default="unavailable")(lambda: "unused")
    assert wrapped() == "unavailable"


@pytest.mark.parametrize("has_result", [False, True])
def test_exited_probe_has_bounded_result_handoff(monkeypatch, has_result):
    def result(*, timeout):
        assert 0 < timeout <= 1
        if not has_result:
            raise queue.Empty
        return "measured"

    worker = SimpleNamespace(
        start=lambda: None,
        join=lambda **_kwargs: None,
        is_alive=lambda: False,
        exitcode=0,
    )
    context = SimpleNamespace(
        Queue=lambda: SimpleNamespace(get=result),
        Process=lambda **_kwargs: worker,
    )
    monkeypatch.setattr(globals_module, "LINUX", True)
    monkeypatch.setattr(globals_module, "ctx_mp_fork", context)
    wrapped = globals_module.exit_after(2, default="unavailable")(lambda: "unused")
    assert wrapped() == ("measured" if has_result else "unavailable")
