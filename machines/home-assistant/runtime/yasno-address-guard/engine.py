"""Address checks and recoverable updates through the HA API adapter."""

import asyncio
import contextlib
import fcntl
import importlib.util
import json
import os
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote, urlencode

HERE = Path(__file__).parent
OFFICIAL = "https://app.yasno.ua/api/blackout-service/public/shutdowns/"

# Failed checks retry after 15 minutes, doubling up to this cap so a lasting
# provider fault or fail-closed address mismatch cannot repeat every trigger.
RETRY_CAP_MINUTES = 360

# Quote and apostrophe styles fold to one character each. Nothing is removed,
# so a missing quote, word or building suffix still fails the comparison.
QUOTES = str.maketrans(
    {"«": '"', "»": '"', "“": '"', "”": '"', "„": '"', "’": "'", "ʼ": "'", "‘": "'"}
)

# The same DSO was renamed from ПРАТ to ТОВ (2026-11). Only one of these leading
# legal-form words is ignored in provider names; the remainder must match.
LEGAL_FORMS = ("прат", "тов")

# Leading street-type spellings that name the same street type. "пр." is absent
# because it abbreviates проспект, провулок and проїзд alike.
STREET_TYPES = {
    "вул.": "вулиця",
    "вулиця": "вулиця",
    "просп.": "проспект",
    "пр-т": "проспект",
    "проспект": "проспект",
    "пров.": "провулок",
    "провулок": "провулок",
    "бульв.": "бульвар",
    "б-р": "бульвар",
    "бульвар": "бульвар",
    "пл.": "площа",
    "площа": "площа",
    "наб.": "набережна",
    "набережна": "набережна",
    "узв.": "узвіз",
    "узвіз": "узвіз",
    "шос.": "шосе",
    "шосе": "шосе",
}


def load_module(name):
    spec = importlib.util.spec_from_file_location(
        "yasno_guard_" + name, HERE / (name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validation = load_module("validation")
flow_contract = load_module("flow_contract")


def live_preference(field):
    """Current form value; HA's voluptuous_serialize nests the suggested value
    under description.suggested_value, older/other serializers put it at top
    level. Falsy values (False, 0) are real preferences. Returns None if absent;
    raises if the form is ambiguous or not in a known shape."""
    description = field.get("description")
    if description is not None and not isinstance(description, dict):
        raise RuntimeError("Unknown preferences form schema; refusing overwrite")
    found = [
        source["suggested_value"]
        for source in (field, description or {})
        if "suggested_value" in source
    ]
    if found:
        if any(
            value != found[0] or type(value) is not type(found[0]) for value in found
        ):
            raise RuntimeError("Conflicting live preferences; refusing overwrite")
        return found[0]
    return field.get("default")


def words(value):
    """Case-, Unicode-form-, quote-style- and whitespace-insensitive tokens."""
    if type(value) is not str:
        raise ValueError("Malformed address name")
    result = unicodedata.normalize("NFKC", value).translate(QUOTES).casefold().split()
    if not result:
        raise ValueError("Empty address name")
    return result


def provider_key(value):
    result = words(value)
    return result[1:] if result[0] in LEGAL_FORMS and len(result) > 1 else result


def street_key(value):
    result = words(value)
    return [STREET_TYPES.get(result[0], result[0]), *result[1:]]


def only(items, matches):
    """The single official item naming the anchor; none or several fail closed."""
    found = [item for item in items if matches(item)]
    if len(found) != 1:
        raise RuntimeError("Address anchor not matched exactly once")
    return found[0]


def official_items(value, name):
    if not isinstance(value, list) or not all(
        isinstance(item, dict)
        and type(item.get("id")) is int
        and item["id"] > 0
        and type(item.get(name)) is str
        for item in value
    ):
        raise ValueError("Malformed official address response")
    return value


class Guard:
    def __init__(self, api, config, journal, save, now=None):
        self.api, self.config, self.journal, self.save = api, config, journal, save
        self.now = now or datetime.now(timezone.utc)
        # Official region/provider names for the reconfigure target, and whether
        # the entry's stored names differ from them. Set by candidate().
        self.target = None
        self.rename = False

    def persist(self):
        self.save(self.journal)

    def retry_later(self):
        failures = self.journal.get("failures", 0) + 1
        delay = min(15 * 2 ** (failures - 1), RETRY_CAP_MINUTES)
        self.journal.update(
            failures=failures,
            next_check=(self.now + timedelta(minutes=delay)).isoformat(),
        )
        return delay

    async def notify(self, message):
        try:
            await self.api.notification(message)
        except Exception:
            # Status/journal remain truthful when the API itself is unavailable.
            self.journal["notification_failed"] = True
        else:
            self.journal["notification_failed"] = False
        self.persist()

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

    async def official(self, path, **params):
        query = "?" + urlencode(params, quote_via=quote) if params else ""
        return await self.api.http("GET", OFFICIAL + path + query, external=True)

    async def entry(self):
        entries = await self.api.http("GET", "/api/config/config_entries/entry")
        for entry in entries:
            if entry["entry_id"] == self.config["entry_id"]:
                return entry
        raise RuntimeError("Yasno config entry missing")

    def anchor(self):
        # The human-verified address is the identity. Official numeric IDs are
        # re-resolved from it on every check: Yasno rotates them, and a cached
        # ID cannot be tied to the anchor without journaling the address.
        value = self.config.get("address")
        if (
            not isinstance(value, dict)
            or set(value) != {"region", "provider", "street", "building"}
            or not all(type(v) is str and v.strip() for v in value.values())
        ):
            raise ValueError("Address anchor missing or malformed")
        return value

    async def candidate(self):
        want = self.anchor()
        region = only(
            official_items(await self.official("addresses/v2/regions"), "value"),
            lambda r: words(r["value"]) == words(want["region"]),
        )
        dso = only(
            official_items(region.get("dsos"), "name"),
            lambda d: provider_key(d["name"]) == provider_key(want["provider"]),
        )
        ids = {"regionId": region["id"], "dsoId": dso["id"]}
        # Search by the street name alone; results are then compared in full.
        street_words = unicodedata.normalize("NFKC", want["street"]).split()
        if words(want["street"])[0] in STREET_TYPES and len(street_words) > 1:
            street_words = street_words[1:]
        street = only(
            official_items(
                await self.official(
                    "addresses/v2/streets", **ids, query=" ".join(street_words)
                ),
                "value",
            ),
            lambda s: street_key(s["value"]) == street_key(want["street"]),
        )
        house = only(
            official_items(
                await self.official(
                    "addresses/v2/houses",
                    **ids,
                    streetId=street["id"],
                    query=" ".join(want["building"].split()),
                ),
                "value",
            ),
            lambda h: words(h["value"]) == words(want["building"]),
        )
        address = await self.official(
            "addresses/v2/group", **ids, streetId=street["id"], houseId=house["id"]
        )
        if (
            not isinstance(address, dict)
            or type(address.get("group")) is not int
            or type(address.get("subgroup")) is not int
            or address["group"] <= 0
            or address["subgroup"] <= 0
        ):
            raise ValueError("Invalid official address response")
        group = str(address["group"]) + "." + str(address["subgroup"])
        planned = await self.official(
            "regions/"
            + str(region["id"])
            + "/dsos/"
            + str(dso["id"])
            + "/planned-outages"
        )
        probable = await self.official("probable-outages", **ids)
        api = SimpleNamespace(
            group=group, region_id=region["id"], provider_id=dso["id"]
        )
        validation.validate_planned(api, planned, self.now, require_available=True)
        validation.validate_probable(api, probable)
        # The integration resolves its stored names exactly at setup, so a renamed
        # provider needs a reconfigure even when the group is unchanged.
        self.target = {"region": region["value"], "provider": dso["name"]}
        entry = await self.entry()
        self.rename = any(entry.get(k) != v for k, v in self.target.items())
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
            # Without a resolved target (legacy rollback), keep the entry's names.
            if self.target is None:
                entry = await self.entry()
                self.target = {k: entry[k] for k in ("region", "provider")}
            settings.update(self.target)
            for _ in range(10):
                flow_id = response.get("flow_id", flow_id)
                # Preserve the user's current preferences from the live form.
                if response.get("step_id") == "preferences":
                    for field in response.get("data_schema", []):
                        key = field.get("name")
                        if key in (
                            "scan_interval",
                            "filter_probable",
                            "status_all_day_events",
                        ):
                            value = live_preference(field)
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
                and all(entry.get(k) == v for k, v in (self.target or {}).items())
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
        # Renames propagate asynchronously to live entities. Verify registry
        # membership, live neutral references and copied options together.
        for _ in range(30):
            current = {r["entity_id"]: r for r in await self.registry()}
            states = {
                s["entity_id"]: s["state"]
                for s in await self.api.http("GET", "/api/states")
            }
            # The integration reports electricity "unknown" whenever no timed
            # slot covers now and the day is not "no_outages" (coordinator
            # current_state). Under official EmergencyShutdowns that is the
            # correct value, so accept it only when this entry's own neutral
            # status_today entity for the same group says emergency_shutdowns.
            status_target = c["bindings"].get("status_today")
            status_row = current.get(status_target, {}) if status_target else {}
            emergency = (
                status_row.get("unique_id") == prefix + "status_today"
                and status_row.get("config_entry_id") == c["entry_id"]
                and states.get(status_target) == "emergency_shutdowns"
            )
            valid = True
            for key, target in c["bindings"].items():
                row = current.get(target, {})
                if row.get("unique_id") != prefix + key or states.get(target) in (
                    None,
                    "unavailable",
                ):
                    valid = False
                    break
                if key == "electricity" and not (
                    states[target] in ("normal", "outage")
                    or (emergency and states[target] == "unknown")
                ):
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
        # A renamed provider's old name no longer resolves; restore the previous
        # group under the official names recorded for the transaction.
        if "provider" in tx:
            self.target = {"region": tx["region"], "provider": tx["provider"]}
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
            # Each rollback drives the integration's own official lookups, so
            # retries after a failed rollback back off; crash recovery does not.
            if (
                not force_check
                and j.get("failures")
                and self.now < datetime.fromisoformat(j["next_check"])
            ):
                return {
                    "status": "repair_required",
                    "next_check": j["next_check"],
                    "notification_failed": j.get("notification_failed", False),
                }
            try:
                await self.rollback()
            except Exception:
                self.retry_later()
                await self.notify(
                    "Yasno correction recovery could not complete. Existing references may be temporarily unavailable; manual repair is required. No unknown schedule is treated as an outage."
                )
                return {
                    "status": "repair_required",
                    "notification_failed": j["notification_failed"],
                }
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
                "notification_failed": j.get("notification_failed", False),
            }
        previous_group = None
        try:
            previous_group = await self.group()
            group = await self.candidate()
            change = group != previous_group or self.rename
            if dry_run:
                return {
                    "status": "validated_change" if change else "validated_unchanged",
                    "group": group,
                    "current_group": previous_group,
                    "checked_at": self.now.isoformat(),
                    "writes": 0,
                }
            if change:
                before = {r["entity_id"]: r for r in await self.registry()}
                metadata = {
                    key: before[target]
                    for key, target in self.config["bindings"].items()
                }
                j["pending"] = {
                    "previous_group": previous_group,
                    "new_group": group,
                    "metadata": metadata,
                    **(self.target or {}),
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
                notification_failed=False,
            )
            j.pop("failures", None)
            self.persist()
            return {
                "status": "verified",
                "last_valid_group": group,
                "last_success": j["last_success"],
                "next_check": j["next_check"],
                "notification_failed": j["notification_failed"],
            }
        except Exception:
            recovered = False
            if j.get("pending"):
                try:
                    await self.rollback()
                    recovered = True
                except Exception:
                    pass
            delay = self.retry_later()
            j["error"] = "official_lookup_validation_or_correction_failed"
            if not dry_run:
                self.persist()
                await self.notify(
                    "Yasno address verification/correction failed. "
                    + (
                        "Previous group and references were verified restored."
                        if recovered
                        else "Last valid group retained in journal; check integration state before relying on schedules."
                    )
                    + f" Retry in {delay} minutes; unknown schedule is not an outage."
                )
            return {
                "status": "rolled_back"
                if recovered
                else "repair_required"
                if j.get("pending")
                else "check_failed",
                "last_valid_group": j.get("last_valid_group"),
                "next_check": j["next_check"],
                "notification_failed": j.get("notification_failed", False),
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
