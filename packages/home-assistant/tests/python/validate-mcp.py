"""Validate native MCP imports, constraints and gate resources offline.

Use synthetic settings in an isolated build directory. No server is started,
acknowledgement key requested, or HA action performed.
"""

import json
import socket
from importlib.metadata import requires, version

from packaging.requirements import Requirement


def denied(*_args, **_kwargs):
    raise RuntimeError("network is forbidden in MCP packaging QA")


socket.create_connection = denied
socket.socket.connect = denied
socket.socket.connect_ex = denied
socket.socket.sendto = denied
socket.getaddrinfo = denied


def main():
    assert version("ha-mcp") == "8.7.0"
    checked = 0
    for text in requires("ha-mcp"):
        requirement = Requirement(text)
        if requirement.marker and not requirement.marker.evaluate():
            continue
        assert version(requirement.name) in requirement.specifier, requirement.name
        checked += 1
    from ha_mcp.__main__ import main_web
    from ha_mcp.server import HomeAssistantSmartMCPServer
    from ha_mcp.settings_ui import register_settings_routes
    from ha_mcp.strict_bps import strict_bps_effective
    from ha_mcp.utils.skill_loader import best_practices_skill, get_skills_dir

    assert all(
        callable(entry)
        for entry in [main_web, HomeAssistantSmartMCPServer, register_settings_routes]
    )
    assert best_practices_skill(get_skills_dir()) is not None
    assert strict_bps_effective()
    print(
        json.dumps(
            {
                "mcp_version": version("ha-mcp"),
                "dependency_constraints_checked": checked,
                "http_imports": "passed",
                "mandatory_best_practices_gate": "effective",
                "network_connections_allowed": False,
            }
        )
    )


if __name__ == "__main__":
    main()
