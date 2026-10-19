"""Address checks and recoverable updates through the HA API adapter."""

import asyncio
import contextlib
import fcntl
import importlib.util
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).parent


def load_module(name):
    spec = importlib.util.spec_from_file_location(
        "yasno_guard_" + name, HERE / (name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validation = load_module("validation")
flow_contract = load_module("flow_contract")


class Guard:
    def __init__(self, api, config, journal, save, now=None):
        self.api, self.config, self.journal, self.save = api, config, journal, save
        self.now = now or datetime.now(timezone.utc)

    def persist(self):
        self.save(self.journal)

    async def notify(self, message):
        try:
            await self.api.notification(message)
        except Exception:
            # Status/journal remain truthful when the API itself is unavailable.
            self.journal["notification_failed"] = True

    async def registry(self):
        return await self.api.ws("config/entity_registry/list")

    async def group(self):
        rows = await self.registry()
        groups = set()
        matched = set()
        for row in rows:
            if (
                row.get("config_entry_id") == self.config["entry_id"]
                and row["entity_id"] in self.config["bindings"].values()
            ):
                match = re.fullmatch(
                    re.escape(self.config["entry_id"]) + r"-([1-9]\d*\.[1-9]\d*)-(.+)",
                    row["unique_id"],
                )
                if match:
                    key = match.group(2)
                    if (
                        row.get("platform") != "yasno_outages"
                        or self.config["bindings"].get(key) != row["entity_id"]
                    ):
                        raise RuntimeError("Neutral binding ownership mismatch")
                    matched.add(key)
                    groups.add(match.group(1))
        if len(groups) != 1 or matched != set(self.config["bindings"]):
            raise RuntimeError(
                "Ambiguous current group; no automatic configuration write"
            )
        return groups.pop()

    async def candidate(self):
        c = self.config
        root = "https://app.yasno.ua/api/blackout-service/public/shutdowns/"
        address = await self.api.http(
            "GET",
            root
            + "addresses/v2/group?regionId="
            + str(c["region_id"])
            + "&dsoId="
            + str(c["provider_id"])
            + "&streetId="
            + str(c["street_id"])
            + "&houseId="
            + str(c["house_id"]),
            external=True,
        )
        if (
            type(address.get("group")) is not int
            or type(address.get("subgroup")) is not int
            or address["group"] <= 0
            or address["subgroup"] <= 0
        ):
            raise ValueError("Invalid official address response")
        group = str(address["group"]) + "." + str(address["subgroup"])
        planned = await self.api.http(
            "GET",
            root
            + "regions/"
            + str(c["region_id"])
            + "/dsos/"
            + str(c["provider_id"])
            + "/planned-outages",
            external=True,
        )
        probable = await self.api.http(
            "GET",
            root
            + "probable-outages?regionId="
            + str(c["region_id"])
            + "&dsoId="
            + str(c["provider_id"]),
            external=True,
        )
        api = SimpleNamespace(
            group=group, region_id=c["region_id"], provider_id=c["provider_id"]
        )
        validation.validate_planned(api, planned, self.now, require_available=True)
        validation.validate_probable(api, probable)
        return group

    async def reconfigure(self, group):
        c = self.config
        flow_id = None
        try:
            response = await self.api.http(
                "POST",
                "/api/config/config_entries/flow",
                {"handler": "yasno_outages", "entry_id": c["entry_id"]},
            )
            settings = dict(c["settings"])
            for _ in range(10):
                flow_id = response.get("flow_id", flow_id)
                # Preserve live preferences, rather than overriding later user changes.
                if response.get("step_id") == "preferences":
                    for field in response.get("data_schema", []):
                        key = field.get("name")
                        if key in (
                            "scan_interval",
                            "filter_probable",
                            "status_all_day_events",
                        ):
                            value = field.get("suggested_value", field.get("default"))
                            if value is None:
                                raise RuntimeError(
                                    "Live preferences unavailable; refusing overwrite"
                                )
                            settings[key] = value
                payload = flow_contract.next_input(response, settings, group)
                if payload is None:
                    return
                if not flow_id:
                    raise RuntimeError("Missing flow identifier")
                response = await self.api.http(
                    "POST", "/api/config/config_entries/flow/" + flow_id, payload
                )
            raise RuntimeError("Reconfigure flow exceeded bounded step count")
        finally:
            if flow_id:
                with contextlib.suppress(Exception):
                    await self.api.http(
                        "DELETE", "/api/config/config_entries/flow/" + flow_id
                    )

    async def loaded(self, group):
        # Bounded wait for integration-only reload and all nine new entities.
        for _ in range(30):
            entries = await self.api.http("GET", "/api/config/config_entries/entry")
            entry = next(
                (e for e in entries if e["entry_id"] == self.config["entry_id"]), None
            )
            rows = await self.registry()
            expected = {
                self.config["entry_id"] + "-" + group + "-" + key
                for key in self.config["bindings"]
            }
            matched = [
                r
                for r in rows
                if r.get("config_entry_id") == self.config["entry_id"]
                and r["unique_id"] in expected
            ]
            states = {
                s["entity_id"]: s["state"]
                for s in await self.api.http("GET", "/api/states")
            }
            if (
                entry
                and entry.get("state") == "loaded"
                and len(matched) == 9
                and all(
                    states.get(r["entity_id"]) not in (None, "unavailable")
                    for r in matched
                )
            ):
                return
            await asyncio.sleep(2)
        raise RuntimeError("Integration reload did not verify nine available entities")

    async def handover(self, group):
        rows = await self.registry()
        c = self.config
        moves = []
        by_id = {r["entity_id"]: r for r in rows}
        prefix = c["entry_id"] + "-" + group + "-"
        for key, target in c["bindings"].items():
            sources = [
                r
                for r in rows
                if r.get("config_entry_id") == c["entry_id"]
                and r["unique_id"] == prefix + key
            ]
            if len(sources) != 1:
                raise RuntimeError(
                    "Missing/duplicate semantic entity; handover refused"
                )
            source = sources[0]
            if source["entity_id"].split(".")[0] != target.split(".")[0]:
                raise RuntimeError("Entity domain mismatch")
            if source["entity_id"] == target:
                continue
            occupant = by_id.get(target)
            if occupant:
                if (
                    occupant.get("config_entry_id") != c["entry_id"]
                    or occupant.get("translation_key") != key
                ):
                    raise RuntimeError("Neutral entity ID occupied by unrelated entity")
                archive = target + "_archived_" + occupant["id"][:12]
                if archive in by_id:
                    raise RuntimeError("Archive entity ID collision")
                moves.append((occupant["id"], archive))
            moves.append((source["id"], target))
        # All mappings preflighted. Registry IDs survive interrupted entity renames.
        for registry_id, target in moves:
            rows = await self.registry()
            row = next(r for r in rows if r["id"] == registry_id)
            await self.api.ws(
                "config/entity_registry/update",
                entity_id=row["entity_id"],
                new_entity_id=target,
            )
        metadata = self.journal.get("pending", {}).get("metadata", {})
        for key, target in c["bindings"].items():
            before = metadata.get(key)
            if before:
                values = {
                    k: before[k]
                    for k in ("area_id", "labels", "name", "icon", "hidden_by")
                    if k in before
                }
                await self.api.ws(
                    "config/entity_registry/update", entity_id=target, **values
                )
                for domain, options in before.get("options", {}).items():
                    await self.api.ws(
                        "config/entity_registry/update",
                        entity_id=target,
                        options_domain=domain,
                        options=options,
                    )
        # Renames propagate asynchronously to live entities. Verify the actual
        # neutral references and copied options, not only registry membership.
        for _ in range(30):
            current = {r["entity_id"]: r for r in await self.registry()}
            states = {
                s["entity_id"]: s["state"]
                for s in await self.api.http("GET", "/api/states")
            }
            valid = True
            for key, target in c["bindings"].items():
                row = current.get(target, {})
                if row.get("unique_id") != prefix + key or states.get(target) in (
                    None,
                    "unavailable",
                ):
                    valid = False
                    break
                if key == "electricity" and states[target] not in ("normal", "outage"):
                    valid = False
                    break
                if key == "status_today" and states[target] not in (
                    "no_outages",
                    "schedule_applies",
                    "emergency_shutdowns",
                ):
                    valid = False
                    break
                before = metadata.get(key, {})
                for field in ("area_id", "labels", "name", "icon", "hidden_by"):
                    if field in before and row.get(field) != before[field]:
                        valid = False
                for domain, options in before.get("options", {}).items():
                    if row.get("options", {}).get(domain) != options:
                        valid = False
            if valid:
                return
            await asyncio.sleep(2)
        raise RuntimeError("Neutral live references or metadata/options did not verify")

    async def rollback(self):
        tx = self.journal["pending"]
        await self.reconfigure(tx["previous_group"])
        await self.loaded(tx["previous_group"])
        await self.handover(tx["previous_group"])
        self.journal["last_valid_group"] = tx["previous_group"]
        self.journal.pop("pending")
        self.persist()

    async def check(self, dry_run=False, force_check=False):
        j = self.journal
        if j.get("pending"):
            if dry_run:
                return {"status": "repair_pending", "writes": 0}
            try:
                await self.rollback()
            except Exception:
                await self.notify(
                    "Yasno correction recovery could not complete. Existing references may be temporarily unavailable; manual repair is required. No unknown schedule is treated as an outage."
                )
                return {"status": "repair_required"}
        if (
            not dry_run
            and not force_check
            and j.get("next_check")
            and self.now < datetime.fromisoformat(j["next_check"])
        ):
            return {
                "status": "not_due",
                "last_valid_group": j.get("last_valid_group"),
                "last_success": j.get("last_success"),
                "next_check": j.get("next_check"),
            }
        previous_group = None
        try:
            previous_group = await self.group()
            group = await self.candidate()
            if dry_run:
                return {
                    "status": "validated_unchanged"
                    if group == previous_group
                    else "validated_change",
                    "group": group,
                    "current_group": previous_group,
                    "checked_at": self.now.isoformat(),
                    "writes": 0,
                }
            if group != previous_group:
                before = {r["entity_id"]: r for r in await self.registry()}
                metadata = {
                    key: before[target]
                    for key, target in self.config["bindings"].items()
                }
                j["pending"] = {
                    "previous_group": previous_group,
                    "new_group": group,
                    "metadata": metadata,
                }
                self.persist()
                await self.reconfigure(group)
                await self.loaded(group)
                await self.handover(group)
                j.pop("pending")
            j.update(
                last_valid_group=group,
                last_success=self.now.isoformat(),
                next_check=(self.now + timedelta(days=1)).isoformat(),
                error=None,
            )
            self.persist()
            return {
                "status": "verified",
                "last_valid_group": group,
                "last_success": j["last_success"],
                "next_check": j["next_check"],
            }
        except Exception:
            recovered = False
            if j.get("pending"):
                try:
                    await self.rollback()
                    recovered = True
                except Exception:
                    pass
            j.update(
                error="official_lookup_validation_or_correction_failed",
                next_check=(self.now + timedelta(minutes=15)).isoformat(),
            )
            if not dry_run:
                self.persist()
                await self.notify(
                    "Yasno address verification/correction failed. "
                    + (
                        "Previous group and references were verified restored."
                        if recovered
                        else "Last valid group retained in journal; check integration state before relying on schedules."
                    )
                    + " Retry in 15 minutes; unknown schedule is not an outage."
                )
            return {
                "status": "rolled_back"
                if recovered
                else "repair_required"
                if j.get("pending")
                else "check_failed",
                "last_valid_group": j.get("last_valid_group"),
                "next_check": j["next_check"],
            }


async def run(config, dry_run=False, force_check=False, hass=None):
    import aiohttp

    path = Path(config["journal_path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path) + ".lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "already_running"}
        journal = json.loads(path.read_text()) if path.exists() else {}

        def save(data):
            temporary = str(path) + ".tmp"
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump(data, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)

        if hass is None:
            raise RuntimeError("Documented Pyscript hass context required")
        adapter = load_module("inprocess")
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=60)
        ) as session:
            return await Guard(
                adapter.InProcessAPI(hass, session, config), config, journal, save
            ).check(dry_run=dry_run, force_check=force_check)
