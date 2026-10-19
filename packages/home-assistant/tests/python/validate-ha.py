"""Validate using HA's real schemas and dependency metadata, without setup.

No HA service or integration setup runs. Native script tests register only local
service stubs. Socket connections are blocked even if an import attempts one.
"""

import asyncio
import compileall
import importlib
import importlib.util
import json
import socket
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path
from types import SimpleNamespace

import yaml
from packaging.requirements import Requirement


def denied(*_args, **_kwargs):
    raise RuntimeError("network is forbidden in offline QA")


socket.create_connection = denied
socket.socket.connect = denied
socket.socket.connect_ex = denied
socket.socket.sendto = denied
socket.getaddrinfo = denied


async def validate(hass, configuration, components, component_path, template_fixtures):
    failures = []
    from homeassistant.components.automation.config import PLATFORM_SCHEMA
    from homeassistant.components.homeassistant.scene import (
        PLATFORM_SCHEMA as SCENE_SCHEMA,
    )
    from homeassistant.components.script.config import SCRIPT_ENTITY_SCHEMA
    from homeassistant.const import Platform
    from homeassistant.core_config import CORE_CONFIG_SCHEMA
    from homeassistant.helpers import config_validation as cv
    from homeassistant.helpers.template import Template
    from probatio import Invalid

    # CORE_CONFIG_SCHEMA checks directory existence. Validate the same media
    # mapping with temporary directories; the native service creates the real
    # state directory before HA starts.
    core_config = dict(configuration["homeassistant"])
    with tempfile.TemporaryDirectory() as media_root:
        core_config["media_dirs"] = dict.fromkeys(core_config["media_dirs"], media_root)
        await cv.async_validate(hass, CORE_CONFIG_SCHEMA, core_config)

    for item in configuration["automation"]:
        try:
            await cv.async_validate(hass, PLATFORM_SCHEMA, item)
        except Exception as error:
            failures.append(
                ["automation", item["alias"], type(error).__name__, str(error)]
            )
    for name, item in configuration["script"].items():
        try:
            await cv.async_validate(hass, SCRIPT_ENTITY_SCHEMA, item)
        except Exception as error:
            failures.append(["script", name, type(error).__name__, str(error)])
    try:
        await cv.async_validate(
            hass,
            SCENE_SCHEMA,
            {"platform": "homeassistant", "states": configuration["scene"]},
        )
    except Exception as error:
        failures.append(["scene", type(error).__name__, str(error)])
    for domain in [
        "timer",
        "input_boolean",
        "input_button",
        "rest_command",
        "command_line",
        "shell_command",
        "frontend",
        "http",
    ]:
        module = importlib.import_module("homeassistant.components." + domain)
        try:
            await cv.async_validate(
                hass, module.CONFIG_SCHEMA, {domain: configuration.get(domain, {})}
            )
        except Exception as error:
            failures.append([domain, type(error).__name__, str(error)])
    for domain in ["binary_sensor", "media_player"]:
        for item in configuration.get(domain, []):
            platform = item["platform"]
            try:
                prefix = (
                    "custom_components"
                    if platform in components
                    else "homeassistant.components"
                )
                module = await hass.async_add_import_executor_job(
                    importlib.import_module, f"{prefix}.{platform}.{domain}"
                )
                await cv.async_validate(hass, module.PLATFORM_SCHEMA, item)
            except Exception as error:
                failures.append([domain, platform, type(error).__name__, str(error)])

    # Mutation fixtures must fail the real HA validators, not only our Nix
    # shape checks. These schemas do not set up integrations or run actions.
    timer = importlib.import_module("homeassistant.components.timer")
    for schema, invalid in [
        (
            PLATFORM_SCHEMA,
            {
                "alias": "Invalid",
                "triggers": [{"trigger": "homeassistant", "event": "start"}],
                "actions": [{"action": "invalid service"}],
            },
        ),
        (SCRIPT_ENTITY_SCHEMA, {"sequence": [{"unexpected_action": "invalid"}]}),
        (
            cv.CONDITION_SCHEMA,
            {
                "condition": "state",
                "entity_id": "sensor.fixture",
                "state": "on",
                "unexpected": True,
            },
        ),
        (timer.CONFIG_SCHEMA, {"timer": {"fixture": {"duration": "invalid duration"}}}),
    ]:
        try:
            await cv.async_validate(hass, schema, invalid)
        except Invalid:
            pass
        else:
            failures.append(["negative schema fixture accepted", invalid])
    for item in configuration.get("command_line", []):
        sensor = item.get("sensor", {})
        if sensor.get("unique_id") == "argon_one_fan_speed":
            assert (
                Template(sensor["value_template"], hass).async_render(
                    {"value": "25 60.0"}, parse_result=False
                )
                == "25"
            )
    checked_requirements = 0
    checked_modules = 0
    platform_modules = {platform.value for platform in Platform} | {
        "config_flow",
        "diagnostics",
        "repairs",
    }
    for domain, manifest in components.items():
        installed_manifest = json.loads(
            (
                component_path / "custom_components" / domain / "manifest.json"
            ).read_text()
        )
        for text in manifest.get("requirements", []):
            requirement = Requirement(text)
            try:
                actual = version(requirement.name)
                if requirement.specifier and actual not in requirement.specifier:
                    failures.append([domain, "requirement", text, actual])
                checked_requirements += 1
            except Exception as error:
                failures.append(
                    [domain, "requirement", requirement.name, type(error).__name__]
                )
        module_names = ["custom_components." + domain]
        module_names.extend(
            "custom_components." + domain + "." + name
            for name in sorted(platform_modules)
            if (
                component_path / "custom_components" / domain / (name + ".py")
            ).is_file()
        )
        for module_name in module_names:
            try:
                if installed_manifest.get("import_executor", True):
                    await hass.async_add_import_executor_job(
                        importlib.import_module, module_name
                    )
                else:
                    importlib.import_module(module_name)
                checked_modules += 1
            except Exception as error:
                failures.append(
                    [module_name, "import", type(error).__name__, str(error)]
                )
    if not compileall.compile_dir(component_path / "custom_components", quiet=2):
        failures.append(["component", "compile"])
    if not failures:
        spec = importlib.util.spec_from_file_location(
            "template_check", Path(__file__).with_name("template-check.py")
        )
        template_check = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(template_check)
        await template_check.validate_templates(
            hass, configuration, **template_fixtures
        )
        from behavior import validate_behavior

        await validate_behavior(hass, configuration)
        from layout import validate_field_order
        from service_contracts import validate_service_contracts

        validate_field_order(Path(sys.argv[4]), configuration)
        await validate_service_contracts(hass, configuration)
        # Check the API port with an inert device value; no device method runs.
        from custom_components.dyson_local.vacuum import DYSON_STATES, DysonVacuumEntity
        from homeassistant.components.vacuum import VacuumActivity

        entity = object.__new__(DysonVacuumEntity)
        for vendor_state, activity in DYSON_STATES.items():
            entity._device = SimpleNamespace(
                state=vendor_state, battery_level=61, position="fixture"
            )
            assert isinstance(activity, VacuumActivity)
            assert entity.activity == activity and entity.state == activity.value
            assert entity.extra_state_attributes["battery_level"] == 61
    if failures:
        # Only the public declarations and public package code are loaded.
        # No private state or real credential values are present in this check.
        print(json.dumps({"failures": failures}, indent=2))
        return 1
    print(
        json.dumps(
            {
                "ha_version": version("homeassistant"),
                "jinja_version": version("Jinja2"),
                "automations": len(configuration["automation"]),
                "scripts": len(configuration["script"]),
                "scenes": len(configuration["scene"]),
                "custom_component_imports": len(components),
                "custom_modules_imported": checked_modules,
                "requirements_checked": checked_requirements,
                "network_connections_allowed": False,
            }
        )
    )
    return 0


async def main():
    from homeassistant.core import CoreState, HomeAssistant

    configuration = yaml.safe_load(Path(sys.argv[1]).read_text())
    component_path = Path(sys.argv[2])
    template_fixtures = json.loads(Path(sys.argv[3]).read_text())
    components = {
        path.parent.name: json.loads(path.read_text())
        for path in (component_path / "custom_components").glob("*/manifest.json")
    }
    sys.path.insert(0, str(component_path))
    # Register HA's schema context without starting HA or setting up anything.
    hass = HomeAssistant(str(component_path))
    try:
        result = await validate(
            hass, configuration, components, component_path, template_fixtures
        )
        assert hass.state is CoreState.not_running
        return result
    finally:
        hass.import_executor.shutdown(wait=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
