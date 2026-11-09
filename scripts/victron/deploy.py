#!/usr/bin/env nix-shell
#!nix-shell -I nixpkgs=flake:nixpkgs -i python3 -p "python3.withPackages (p: [p.websocket-client])"
"""Deploy the Cerbo charging policy and its Home Assistant controls."""

import argparse
import base64
import hashlib
import io
import json
import os
import re
import shlex
import socket
import ssl
import subprocess
import tarfile
import time
from contextlib import closing, contextmanager
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

import websocket

SOURCE = Path(__file__).with_name("flow.nix")
FRONTEND_KEY = "victron-energy-card"


def frontend_resource(bundle):
    assets = bundle["homeAssistant"]["frontendAssets"]
    if not {FRONTEND_KEY + ".js", "LICENSE", "NOTICE"} <= assets.keys() or any(
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name)
        or not isinstance(source, str)
        for name, source in assets.items()
    ):
        raise RuntimeError("Invalid dashboard frontend assets")
    digest = hashlib.sha256(json.dumps(assets, sort_keys=True).encode()).hexdigest()
    return {
        "url": f"/local/victron-energy/{digest}/{FRONTEND_KEY}.js#{FRONTEND_KEY}",
        "type": "module",
    }


def upload_frontend(bundle):
    resource = frontend_resource(bundle)
    destination = "/config/www/" + urlsplit(resource["url"]).path.removeprefix(
        "/local/"
    )
    destination = str(Path(destination).parent)
    assets = bundle["homeAssistant"]["frontendAssets"]
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as output:
        for name, source in sorted(assets.items()):
            data = source.encode()
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            output.addfile(member, io.BytesIO(data))
    ssh = shlex.split(
        os.environ.get(
            "HOME_ASSISTANT_SSH_COMMAND",
            "ssh -o BatchMode=yes root@homeassistant.glib.sh",
        )
    )
    remote = (
        f"set -eu; mkdir -p {shlex.quote(destination)}; "
        f"tar -xf - -C {shlex.quote(destination)}; cd {shlex.quote(destination)}; "
        "sha256sum " + " ".join(shlex.quote(name) for name in sorted(assets))
    )
    result = subprocess.run(
        ssh + [remote],
        input=archive.getvalue(),
        capture_output=True,
        timeout=60,
    )
    if result.returncode:
        raise RuntimeError(
            "Frontend upload failed: " + result.stderr.decode(errors="replace").strip()
        )
    actual = {
        name: digest
        for line in result.stdout.decode().splitlines()
        for digest, name in [line.split(maxsplit=1)]
    }
    expected = {
        name: hashlib.sha256(source.encode()).hexdigest()
        for name, source in assets.items()
    }
    if actual != expected:
        raise RuntimeError("Deployed frontend asset checksums differ")
    return resource


def frontend_snapshot(command, rest, bundle):
    return {
        "scope": "victron-frontend",
        "dashboard": command(
            "lovelace/config", url_path=bundle["homeAssistant"]["dashboard"]
        ),
        "scripts": read_scripts(rest, bundle["homeAssistant"]),
        "resource": owned_resource(command, bundle),
        "frontend_resource": owned_resource(command, bundle, FRONTEND_KEY),
    }


def restore_frontend(command, rest, bundle, snapshot):
    if (
        not isinstance(snapshot, dict)
        or snapshot.get("scope") != "victron-frontend"
        or not {"dashboard", "scripts", "resource", "frontend_resource"}
        <= snapshot.keys()
        or not isinstance(snapshot["scripts"], dict)
        or set(snapshot["scripts"]) != set(bundle["homeAssistant"]["scripts"])
        or not isinstance(snapshot["dashboard"], dict)
        or not isinstance(snapshot["dashboard"].get("views"), list)
    ):
        raise RuntimeError("Incompatible frontend rollback snapshot")
    for field, key in [
        ("resource", bundle["homeAssistant"]["cardResource"]["key"]),
        ("frontend_resource", FRONTEND_KEY),
    ]:
        resource = snapshot[field]
        if resource is not None and (
            not isinstance(resource, dict)
            or resource.get("type") != "module"
            or not isinstance(resource.get("url"), str)
            or not resource["url"].endswith("#" + key)
        ):
            raise RuntimeError("Incompatible frontend resource snapshot")
    configure_resource(command, bundle, snapshot["frontend_resource"], FRONTEND_KEY)
    update_controls(
        command,
        rest,
        bundle,
        snapshot["dashboard"],
        snapshot["scripts"],
        snapshot["resource"],
    )


def deploy_frontend(command, rest, bundle, directory):
    require_resources(command, bundle)
    previous = frontend_snapshot(command, rest, bundle)
    backup = save_snapshot(directory, previous)
    desired = deepcopy(previous["dashboard"])
    view = bundle["homeAssistant"]["view"]
    matches = [
        i for i, item in enumerate(desired["views"]) if item.get("path") == view["path"]
    ]
    if len(matches) != 1:
        raise RuntimeError("Expected exactly one owned Victron overview")
    desired["views"][matches[0]] = view
    resource = upload_frontend(bundle)
    try:
        configure_resource(command, bundle, resource, FRONTEND_KEY)
        update_controls(
            command,
            rest,
            bundle,
            desired,
            bundle["homeAssistant"]["scripts"],
            declared_resource(bundle),
        )
    except Exception:
        restore_frontend(command, rest, bundle, previous)
        raise
    return backup


class NodeRed:
    def __init__(self, host, password, fingerprint):
        discovery = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        discovery.check_hostname = False
        discovery.verify_mode = ssl.CERT_NONE
        with (
            socket.create_connection((host, 1881), timeout=8) as raw,
            discovery.wrap_socket(raw, server_hostname=host) as tls,
        ):
            certificate = tls.getpeercert(binary_form=True)
        if hashlib.sha256(certificate).hexdigest() != fingerprint:
            raise RuntimeError("GX TLS certificate differs from the repository pin")
        self.tls = ssl.create_default_context(
            cadata=ssl.DER_cert_to_PEM_cert(certificate)
        )
        # The pinned GX certificate names venus.local and has no IP subject alternative name.
        self.tls.check_hostname = False
        self.tls.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
        self.base = f"https://{host}:1881"
        self.token = None
        login = self.request(
            "/auth/token",
            {
                "client_id": "node-red-admin",
                "grant_type": "password",
                "scope": "*",
                "username": "admin",
                "password": password,
            },
            form=True,
        )
        self.token = login["access_token"]

    def request(self, path, data=None, *, form=False, deployment=None):
        headers = {"Accept": "application/json", "Node-RED-API-Version": "v2"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if deployment:
            headers["Node-RED-Deployment-Type"] = deployment
        body = None
        if data is not None:
            headers["Content-Type"] = (
                "application/x-www-form-urlencoded" if form else "application/json"
            )
            body = urlencode(data).encode() if form else json.dumps(data).encode()
        with urlopen(
            Request(self.base + path, data=body, headers=headers),
            context=self.tls,
            timeout=20,
        ) as response:
            content = response.read()
            if not content:
                return None
            if "application/json" in response.headers.get("Content-Type", ""):
                return json.loads(content)
            return content.decode()

    def close(self):
        try:
            self.request("/auth/revoke", {"token": self.token}, form=True)
            try:
                self.request("/flows")
            except HTTPError as error:
                if error.code == 401:
                    return
                raise
            raise RuntimeError("Temporary Node-RED token remains active")
        finally:
            self.token = None


@contextmanager
def home_assistant(url):
    token = os.environ.get("HOME_ASSISTANT_TOKEN")
    if not token:
        raise RuntimeError(
            "HOME_ASSISTANT_TOKEN is required for deployment and rollback"
        )
    address = urlsplit(url)
    ws_url = (
        ("wss" if address.scheme == "https" else "ws")
        + "://"
        + address.netloc
        + "/api/websocket"
    )
    with closing(websocket.create_connection(ws_url, timeout=20)) as connection:
        if json.loads(connection.recv())["type"] != "auth_required":
            raise RuntimeError("Unexpected Home Assistant authentication handshake")
        connection.send(json.dumps({"type": "auth", "access_token": token}))
        if json.loads(connection.recv())["type"] != "auth_ok":
            raise RuntimeError("Home Assistant authentication failed")
        sequence = 0

        def command(kind, **fields):
            nonlocal sequence
            sequence += 1
            connection.send(json.dumps({"id": sequence, "type": kind, **fields}))
            while True:
                response = json.loads(connection.recv())
                if response.get("id") == sequence:
                    if not response.get("success"):
                        raise RuntimeError("Home Assistant command failed: " + kind)
                    return response.get("result")

        def rest(path, data=None, method=None):
            headers = {
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
            }
            body = None if data is None else json.dumps(data).encode()
            with urlopen(
                Request(
                    url.rstrip("/") + path, data=body, headers=headers, method=method
                ),
                timeout=20,
            ) as response:
                content = response.read()
                return json.loads(content) if content else None

        yield command, rest


def owned(node, bundle):
    return node["id"] == bundle["tabId"] or node.get("z") == bundle["tabId"]


def apply_flow(client, bundle, desired, credentials=None):
    current = client.request("/flows")
    existing = [node for node in current["flows"] if owned(node, bundle)]
    if credentials is None and sorted(existing, key=lambda node: node["id"]) == sorted(
        desired, key=lambda node: node["id"]
    ):
        return
    others = [node for node in current["flows"] if not owned(node, bundle)]
    deployment = deepcopy(desired)
    for node in deployment:
        if credentials is not None and node["id"] in credentials:
            node["credentials"] = credentials[node["id"]]
    configuration = {"rev": current["rev"], "flows": others + deployment}
    client.request("/flows", configuration, deployment="nodes")
    actual = client.request("/flows")["flows"]
    if [node for node in actual if not owned(node, bundle)] != others:
        raise RuntimeError("Unrelated Node-RED configuration changed")
    if sorted(
        (node for node in actual if owned(node, bundle)), key=lambda node: node["id"]
    ) != sorted(desired, key=lambda node: node["id"]):
        raise RuntimeError("Deployed charging flow differs from the repository")


def state(client, bundle):
    return client.request(f"/context/flow/{bundle['tabId']}/state")


def current_limit(client, bundle):
    return client.request("/victron/cache")[bundle["limitService"]][bundle["limitPath"]]


def full_charging(client, bundle):
    client.request("/inject/" + bundle["overrideId"], {})
    for _ in range(30):
        if current_limit(client, bundle) == -1:
            return
        time.sleep(0.5)
    raise RuntimeError("Full charging did not restore the normal DVCC user limit")


def throttle_charging(client, bundle):
    client.request("/inject/" + bundle["throttleId"], {})
    for _ in range(30):
        controller = json.loads(state(client, bundle)["msg"])
        if (
            controller["mode"] == "ramping"
            and current_limit(client, bundle) == controller["requestedLimit"]
        ):
            return
        time.sleep(0.5)
    raise RuntimeError("Charging ramp did not become active")


def save_snapshot(directory, snapshot):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    filename = directory / (datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ") + ".json")
    with os.fdopen(
        os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
    ) as output:
        json.dump(snapshot, output, indent=2)
    return filename


def configure_control(command, rest, bundle, disabled_by):
    entity_id = bundle["homeAssistant"]["controlEntity"]
    entity = command("config/entity_registry/get", entity_id=entity_id)
    if entity["disabled_by"] != disabled_by:
        command(
            "config/entity_registry/update",
            entity_id=entity_id,
            disabled_by=disabled_by,
        )
        rest(
            "/api/services/homeassistant/reload_config_entry",
            {"entry_id": entity["config_entry_id"]},
            method="POST",
        )
    if (
        command("config/entity_registry/get", entity_id=entity_id)["disabled_by"]
        != disabled_by
    ):
        raise RuntimeError("Victron charge-control registry readback differs")
    if disabled_by is None:
        for _ in range(60):
            try:
                control = rest("/api/states/" + entity_id)
                if control["state"] not in ("unknown", "unavailable"):
                    if control["attributes"]["min"] > -1:
                        raise RuntimeError(
                            "Victron charge control does not support the unrestricted limit"
                        )
                    return
            except HTTPError as error:
                if error.code != 404:
                    raise
            time.sleep(0.5)
        raise RuntimeError("Victron charge control did not become available")


def read_scripts(rest, controls):
    result = {}
    for script_id in controls["scripts"]:
        try:
            result[script_id] = rest("/api/config/script/config/" + script_id)
        except HTTPError as error:
            if error.code != 404:
                raise
            result[script_id] = None
    return result


def owned_resource(command, bundle, key=None):
    suffix = "#" + (key or bundle["homeAssistant"]["cardResource"]["key"])
    matches = [
        resource
        for resource in command("lovelace/resources")
        if resource["url"].endswith(suffix)
    ]
    if len(matches) > 1:
        raise RuntimeError("Multiple frontend resources have the same ownership key")
    return matches[0] if matches else None


def declared_resource(bundle):
    declaration = bundle["homeAssistant"]["cardResource"]
    encoded = base64.b64encode(declaration["source"].encode()).decode()
    return {
        "url": "data:text/javascript;charset=utf-8;base64,"
        + encoded
        + "#"
        + declaration["key"],
        "type": "module",
    }


def configure_resource(command, bundle, desired, key=None):
    current = owned_resource(command, bundle, key)
    if desired is None:
        if current:
            command("lovelace/resources/delete", resource_id=current["id"])
    elif current is None:
        command(
            "lovelace/resources/create", url=desired["url"], res_type=desired["type"]
        )
    elif any(current[key] != desired[key] for key in ("url", "type")):
        command(
            "lovelace/resources/update",
            resource_id=current["id"],
            url=desired["url"],
            res_type=desired["type"],
        )
    actual = owned_resource(command, bundle, key)
    if (desired is None and actual is not None) or (
        desired is not None
        and (
            actual is None
            or any(actual[key] != desired[key] for key in ("url", "type"))
        )
    ):
        raise RuntimeError("Frontend resource readback differs")


def require_resources(command, bundle):
    controls = bundle["homeAssistant"]
    resources = command("lovelace/resources")
    missing = [
        name
        for name in controls["resourceFiles"]
        if not any(
            urlsplit(item["url"]).path.endswith("/" + name) for item in resources
        )
    ]
    if missing:
        raise RuntimeError("Missing Home Assistant resources: " + ", ".join(missing))


def update_controls(command, rest, bundle, dashboard, scripts, resource):
    controls = bundle["homeAssistant"]
    if set(scripts) != set(controls["scripts"]):
        raise RuntimeError("Script definitions exceed the owned control scope")
    current_scripts = read_scripts(rest, controls)
    for script_id, script in scripts.items():
        path = "/api/config/script/config/" + script_id
        if script is None:
            if current_scripts[script_id] is not None:
                rest(path, method="DELETE")
        elif current_scripts[script_id] is None or any(
            current_scripts[script_id].get(key) != value
            for key, value in script.items()
        ):
            rest(path, script, method="POST")
    actual_scripts = read_scripts(rest, controls)
    for script_id, expected in scripts.items():
        actual = actual_scripts[script_id]
        if (expected is None and actual is not None) or (
            expected is not None
            and (
                actual is None
                or any(actual.get(key) != value for key, value in expected.items())
            )
        ):
            raise RuntimeError("Home Assistant script readback differs: " + script_id)
    configure_resource(command, bundle, resource)
    command("lovelace/config/save", url_path=controls["dashboard"], config=dashboard)
    if command("lovelace/config", url_path=controls["dashboard"]) != dashboard:
        raise RuntimeError("Home Assistant dashboard readback differs")


def wait_for_telemetry(rest, bundle):
    for _ in range(60):
        try:
            readings = [
                rest("/api/states/" + sensor["entityId"])
                for sensor in bundle["telemetry"]["sensors"]
            ]
            if all(
                reading["state"] not in ("unknown", "unavailable")
                for reading in readings
            ):
                return
        except HTTPError as error:
            if error.code != 404:
                raise
        time.sleep(1)
    raise RuntimeError("Charging telemetry did not become available in Home Assistant")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=(
            "deploy",
            "frontend",
            "frontend-rollback",
            "status",
            "full",
            "throttle",
            "rollback",
        ),
    )
    parser.add_argument("--ha-url", default="http://homeassistant.glib.sh:8123")
    parser.add_argument("--backup", type=Path)
    parser.add_argument(
        "--state-dir", type=Path, default=Path.home() / ".local/state/victron-node-red"
    )
    args = parser.parse_args()
    result = subprocess.run(
        ["nix", "eval", "--json", "--file", str(SOURCE)],
        check=True,
        capture_output=True,
        text=True,
    )
    bundle = json.loads(result.stdout)
    if args.action in ("frontend", "frontend-rollback"):
        with home_assistant(args.ha_url) as (command, rest):
            if args.action == "frontend":
                backup = deploy_frontend(command, rest, bundle, args.state_dir)
                print(json.dumps({"frontend_deployed": True, "backup": str(backup)}))
            else:
                if args.backup is None:
                    raise RuntimeError("Frontend rollback requires --backup")
                try:
                    snapshot = json.loads(args.backup.read_text())
                except json.JSONDecodeError:
                    raise RuntimeError(
                        "Incompatible frontend rollback snapshot"
                    ) from None
                restore_frontend(command, rest, bundle, snapshot)
                print(json.dumps({"frontend_rolled_back": True}))
        return
    if args.action == "rollback":
        if args.backup is None:
            raise RuntimeError("Rollback requires --backup")
        try:
            snapshot = json.loads(args.backup.read_text())
        except json.JSONDecodeError:
            raise RuntimeError("Incompatible rollback snapshot") from None
        if (
            not isinstance(snapshot, dict)
            or not {
                "flows",
                "dashboard",
                "scripts",
                "resource",
                "frontend_resource",
                "control_disabled_by",
            }
            <= snapshot.keys()
            or not isinstance(snapshot["scripts"], dict)
            or set(snapshot["scripts"]) != set(bundle["homeAssistant"]["scripts"])
        ):
            raise RuntimeError("Incompatible rollback snapshot")
    mqtt_credentials = None
    if args.action == "deploy":
        mqtt_user = os.environ.get("MQTT_USERNAME")
        mqtt_password = os.environ.get("MQTT_PASSWORD")
        if bool(mqtt_user) != bool(mqtt_password):
            raise RuntimeError("Supply MQTT_USERNAME and MQTT_PASSWORD together")
        if mqtt_user:
            mqtt_credentials = {
                bundle["telemetry"]["brokerId"]: {
                    "user": mqtt_user,
                    "password": mqtt_password,
                }
            }
    password = os.environ.get("VICTRON_PASSWORD")
    if not password:
        raise RuntimeError("VICTRON_PASSWORD is required")
    client = NodeRed(bundle["host"], password, bundle["certificateSha256"])
    password = None
    try:
        if args.action == "status":
            print(
                json.dumps(
                    {
                        "controller": state(client, bundle),
                        "dvcc_limit_A": current_limit(client, bundle),
                    }
                )
            )
        elif args.action in ("full", "throttle"):
            if args.action == "full":
                full_charging(client, bundle)
            else:
                throttle_charging(client, bundle)
            print(
                json.dumps(
                    {
                        "controller": state(client, bundle),
                        "dvcc_limit_A": current_limit(client, bundle),
                    }
                )
            )
        else:
            controls = bundle["homeAssistant"]
            with home_assistant(args.ha_url) as (command, rest):
                if args.action == "deploy":
                    require_resources(command, bundle)
                dashboard = command("lovelace/config", url_path=controls["dashboard"])
                control = command(
                    "config/entity_registry/get", entity_id=controls["controlEntity"]
                )
                scripts = read_scripts(rest, controls)
                resource = owned_resource(command, bundle)
                energy_resource = owned_resource(command, bundle, FRONTEND_KEY)
                current = client.request("/flows")
                if args.action == "deploy":
                    if mqtt_credentials is None and not any(
                        node["id"] == bundle["telemetry"]["brokerId"]
                        for node in current["flows"]
                    ):
                        raise RuntimeError(
                            "Initial telemetry deployment requires MQTT_USERNAME and MQTT_PASSWORD"
                        )
                    limit = current_limit(client, bundle)
                    if (
                        not any(owned(node, bundle) for node in current["flows"])
                        and limit != -1
                    ):
                        raise RuntimeError(
                            "Initial deployment requires the agreed unrestricted DVCC user limit"
                        )
                    backup = save_snapshot(
                        args.state_dir,
                        {
                            "flows": current["flows"],
                            "limit": limit,
                            "dashboard": dashboard,
                            "scripts": scripts,
                            "resource": resource,
                            "frontend_resource": energy_resource,
                            "control_disabled_by": control["disabled_by"],
                        },
                    )
                    desired_dashboard = deepcopy(dashboard)
                    desired_dashboard["views"] = [controls["view"]]
                    configure_resource(
                        command, bundle, upload_frontend(bundle), FRONTEND_KEY
                    )
                    configure_control(command, rest, bundle, None)
                    apply_flow(client, bundle, bundle["flows"], mqtt_credentials)
                    wait_for_telemetry(rest, bundle)
                    update_controls(
                        command,
                        rest,
                        bundle,
                        desired_dashboard,
                        controls["scripts"],
                        declared_resource(bundle),
                    )

                    print(
                        json.dumps(
                            {
                                "deployed": True,
                                "backup": str(backup),
                                "dashboard": controls["dashboard"]
                                + "/"
                                + controls["view"]["path"],
                            }
                        )
                    )
                else:
                    full_charging(client, bundle)
                    configure_resource(
                        command, bundle, snapshot["frontend_resource"], FRONTEND_KEY
                    )
                    update_controls(
                        command,
                        rest,
                        bundle,
                        snapshot["dashboard"],
                        snapshot["scripts"],
                        snapshot["resource"],
                    )
                    apply_flow(
                        client,
                        bundle,
                        [node for node in snapshot["flows"] if owned(node, bundle)],
                    )
                    if not any(
                        node["id"] == bundle["telemetry"]["brokerId"]
                        for node in snapshot["flows"]
                    ):
                        topics = [
                            sensor["topic"] for sensor in bundle["telemetry"]["sensors"]
                        ]
                        topics += [
                            bundle["telemetry"]["availabilityTopic"],
                            bundle["telemetry"]["stateTopic"],
                        ]
                        for topic in topics:
                            rest(
                                "/api/services/mqtt/publish",
                                {
                                    "topic": topic,
                                    "payload": "",
                                    "retain": True,
                                    "qos": 1,
                                },
                                method="POST",
                            )
                    configure_control(
                        command, rest, bundle, snapshot["control_disabled_by"]
                    )
                    print(
                        json.dumps(
                            {
                                "rolled_back": True,
                                "dvcc_limit_A": current_limit(client, bundle),
                            }
                        )
                    )
    finally:
        if mqtt_credentials is not None:
            mqtt_credentials.clear()
        client.close()


if __name__ == "__main__":
    main()
