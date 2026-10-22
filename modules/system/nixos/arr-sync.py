"""arr-sync — idempotently converge Servarr configuration over the REST API.

Reads one JSON spec per target app and converges the declared resources:
- root folders (matched by path, only ever added);
- providers: download clients, notifications, import lists, metadata
  consumers and (Prowlarr) applications, matched by their stable id when the
  declared id still holds the same implementation, otherwise by name; missing
  ones are created from the app's own /schema, so the payload always matches
  the running version;
- an import list's quality profile and tags, declared by profile name and tag
  label and resolved to this install's ids; a missing tag is created (tags are
  only ever added: Seerr makes one per user and owns those);
- custom filters (the saved filters of the UI's lists, kept server-side),
  matched by id while it holds the same list type, otherwise by type + label;
- settings singletons such as config/naming, config/host or delayprofile/1;
- quality definitions, matched by quality name;
- fields of existing quality profiles, matched by name (never created here:
  Recyclarr owns the profiles and their custom formats).
Only declared keys are compared and written; every other key and every
undeclared resource is left exactly as it is, and nothing is ever deleted.

Every run first plans with reads only. A plan with a problem (unknown field,
implementation clash, a privacy field without a secret file, ...) writes
nothing. A write happens only for a resource whose declared keys differ, so a
converged app sees zero writes. Before the first write a before-image of
everything read is saved privately, and after the writes a second read-only
plan must come out empty.

Secrets are file paths read at runtime, never part of the spec or the logs;
output names resources and field names only. Servarr masks privacy fields as
"********" in its API and keeps the stored value when that mask is sent back.
A masked value is compared with the app's own database, opened read-only. The
adoption rule never rotates a credential: an empty live value is filled, an
equal one is left alone, and a differing one is kept and reported as a
mismatch, which fails the run so the SOPS value gets fixed.

A consequence of that rule: when a SOPS value is changed on purpose (say a
rotated API key), the app keeps the old one and the run fails until the field
is updated or blanked in the UI; arr-sync then fills or adopts it.

Servarr tests a provider (for a notification: sends a real message; for an
import list: fetches it) on create whenever it is enabled, forceSave or not,
and on a changed update of an enabled provider unless forceSave=true. A
notification is "enabled" when any of its event flags is on. So it is created
with every event off (no test) and then given its events by an update with
forceSave=true. Nothing here runs a command: no search, list sync, refresh or
test is ever requested.

Import lists are stricter: saving an enabled list makes the app sync it at
once (see IMPORT_LIST_ENABLE), which may add and search media. So no write
ever leaves a list enabled: a list is created switched off, and a change to a
list that is (to be) enabled is held, not written, and reported like a
mismatch, so the run fails until it is made in the UI. Lists that stay
disabled are converged as usual.

Before-images and output never hold a secret: values read from secret files,
the API key and credential keys of config/host are replaced by "<redacted>".
Credential keys of config/host can't be declared at all (see
CREDENTIAL_SETTINGS).

The login (user name and salted password hash) can't be set over the API
without re-hashing it, so it is restored from its secret file into the app's
database while the app is stopped, only when the app has none (see
restore_login); every run compares it with the secret and never writes it.

usage:
  arr-sync apply <spec.json> [backup dir]
  arr-sync preview <spec.json> [--expect-no-changes]
  arr-sync restore-login <database> <login secret file>

preview plans against the live app with GET requests only and exits non-zero
on a problem, a secret mismatch or an unverifiable secret, and with
--expect-no-changes also when any write would happen.
"""

import base64
import binascii
import copy
import datetime
import email.utils
import http.client
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# How long to wait for a target's API to answer before giving up.
READY_TIMEOUT = 180
# Per-request timeout, and how often a failed request is retried.
REQUEST_TIMEOUT = 60
RETRIES = 5
# Upper bound for one wait between retries, whatever Retry-After asks for.
MAX_BACKOFF = 60
MASK = "********"

# Provider kinds: API collection -> database table holding their settings.
PROVIDER_TABLES = {
    "downloadclient": "DownloadClients",
    "notification": "Notifications",
    "importlist": "ImportLists",
    "metadata": "Metadata",
    "applications": "Applications",
}
# Kinds whose create/update must not run Servarr's test (a message, a fetch).
FORCE_SAVE_KINDS = {"notification", "importlist"}
# An import list's switches: Radarr's enabled/enableAuto, Sonarr's
# enableAutomaticAdd. All are off when a list is created.
IMPORT_LIST_SWITCHES = {"enabled", "enableAuto", "enableAutomaticAdd"}
# The one that makes it "enabled" (ImportListDefinition.Enable): Radarr syncs
# an enabled list as soon as it is added or changed, Sonarr when it's changed
# (ImportListUpdatedHandler); the sync fetches the list, stamps its last sync
# and, with auto-add, adds and searches movies/series. A disabled list skips it.
IMPORT_LIST_ENABLE = {"enabled", "enableAutomaticAdd"}
# config/host keys holding credentials. GET returns the API key and the
# login's user name and salted password hash in clear (passwordConfirmation
# always empty). None can be declared there: the API key is pinned through the
# app's environment (see auth.nix), and the login is restored whole from its
# secret file (see restore_login), because config/host can't take a hash:
# UserService.Upsert treats any password differing from the stored hash as
# plaintext and hashes it again, so a PUT of another hash makes the hash
# string itself the password. A PUT echoes the live hash back, which keeps the
# login (Upsert leaves an equal hash alone); check_login_unchanged re-reads it
# just before the PUT, in case it was changed in the UI after planning.
CREDENTIAL_SETTINGS = {"apiKey", "username", "password", "passwordConfirmation"}
# The login as Servarr stores it (table Users, one row): the user name
# (lowercased by the app), base64 PBKDF2-HMAC-SHA512 hash (32 bytes), its
# base64 salt (16 bytes), the iteration count, and the Guid the login cookie
# names. Secret file keys -> Users columns.
LOGIN_COLUMNS = {
    "identifier": "Identifier",
    "username": "Username",
    "password": "Password",
    "salt": "Salt",
    "iterations": "Iterations",
}
# Credential slots that may only be declared empty ("none set"); a set value
# would have to come from a secret file, which settings don't take.
EMPTY_ONLY_SETTINGS = {"proxyUsername", "proxyPassword", "sslCertPassword"}
REDACTED = "<redacted>"
# Radarr's tag label rule (Sonarr has none; lowercase is what both store)
TAG_LABEL = re.compile(r"[a-z0-9-]+")


def log(message):
    print(f"arr-sync: {message}", flush=True)


def read_secret(path):
    with open(path) as handle:
        return handle.read().strip()


class ApiError(Exception):
    def __init__(self, method, path, status, detail):
        super().__init__(f"{method} {path} -> HTTP {status}: {detail}")
        self.status = status


class Uncertain(Exception):
    """A request whose outcome is unknown: it may or may not have been applied."""


def error_detail(raw):
    """A response body's error text, without any attempted values (they may be secrets)."""
    try:
        body = json.loads(raw)
    except ValueError:
        return raw.decode("utf-8", "replace")[:300]
    if isinstance(body, list):
        return "; ".join(
            f"{item.get('propertyName', '?')}: {item.get('errorMessage', '?')}"
            for item in body
            if isinstance(item, dict)
        )[:300]
    if isinstance(body, dict):
        return str(body.get("message") or body.get("error") or "")[:300]
    return ""


def retry_delay(attempt, retry_after=None):
    seconds = None
    if retry_after:
        try:
            seconds = float(retry_after)
        except ValueError:
            try:
                parsed = email.utils.parsedate_to_datetime(retry_after)
                seconds = (
                    parsed - datetime.datetime.now(parsed.tzinfo)
                ).total_seconds()
            except (TypeError, ValueError):
                # an unparsable Retry-After counts as absent
                seconds = None
    if seconds is None:
        seconds = 2**attempt
    return min(max(seconds, 0), MAX_BACKOFF)


class Api:
    def __init__(self, url, version, api_key):
        self.base = f"{url.rstrip('/')}/api/{version}"
        self.api_key = api_key

    def sleep(self, seconds):
        time.sleep(seconds)

    def _send(self, method, path, body, query):
        data = json.dumps(body).encode() if body is not None else None
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("X-Api-Key", self.api_key)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read()
        try:
            return json.loads(raw) if raw else None
        except ValueError as err:
            # a cut-off or garbled body: as unknown as a dropped connection
            raise http.client.HTTPException(f"unreadable response: {err}") from err

    def request(self, method, path, body=None, query=None):
        """One request, retried on 429, 5xx and connection failures.

        A POST is not idempotent: when its outcome is unknown (a dropped
        connection, a timeout, a 5xx) it raises Uncertain instead of retrying,
        so the caller can look the resource up before trying again."""
        attempt = 0
        while True:
            try:
                return self._send(method, path, body, query)
            except urllib.error.HTTPError as err:
                with err:
                    detail = error_detail(err.read())
                if err.code == 429 and attempt < RETRIES:
                    delay = retry_delay(attempt, err.headers.get("Retry-After"))
                    log(f"{method} {path} rate limited, retrying in {delay:.0f}s")
                elif err.code >= 500 and method == "POST":
                    raise Uncertain(f"{method} {path} -> HTTP {err.code}") from err
                elif err.code >= 500 and attempt < RETRIES:
                    delay = retry_delay(attempt)
                    log(f"{method} {path} -> HTTP {err.code}, retrying in {delay:.0f}s")
                else:
                    raise ApiError(method, path, err.code, detail) from err
            except (
                urllib.error.URLError,
                http.client.HTTPException,
                TimeoutError,
                ConnectionError,
            ) as err:
                if method == "POST":
                    raise Uncertain(f"{method} {path}: {err}") from err
                if attempt >= RETRIES:
                    raise
                delay = retry_delay(attempt)
                log(f"{method} {path} failed ({err}), retrying in {delay:.0f}s")
            attempt += 1
            self.sleep(delay)

    def get(self, path):
        return self.request("GET", path)


class ReadOnlyApi(Api):
    """The API for preview and planning: anything but GET is refused."""

    def request(self, method, path, body=None, query=None):
        if method != "GET":
            raise RuntimeError(f"refusing {method} {path} in a read-only run")
        return super().request(method, path, body, query)


def wait_ready(name, url, version, api_key):
    api = Api(url, version, api_key)
    deadline = time.monotonic() + READY_TIMEOUT
    while True:
        try:
            api._send("GET", "/system/status", None, None)
            return
        except urllib.error.HTTPError as err:
            err.close()
            # starting up answers 5xx; a 4xx (a wrong API key) won't change
            if err.code < 500:
                raise SystemExit(f"{name} at {url}: HTTP {err.code}") from err
            if time.monotonic() > deadline:
                raise SystemExit(
                    f"timed out waiting for {name} at {url}: {err}"
                ) from err
            time.sleep(3)
        except (
            urllib.error.URLError,
            http.client.HTTPException,
            TimeoutError,
            ConnectionError,
        ) as err:
            if time.monotonic() > deadline:
                raise SystemExit(
                    f"timed out waiting for {name} at {url}: {err}"
                ) from err
            time.sleep(3)


class StoredSecrets:
    """Provider settings as stored in the app's database, opened read-only.

    The API masks privacy fields, so this is the only way to tell whether a
    masked live value equals the declared one."""

    def __init__(self, path):
        self.path = path
        self.cache = {}

    def get(self, kind, resource_id, field):
        if not self.path or kind not in PROVIDER_TABLES:
            return None
        if kind not in self.cache:
            # mode=ro: never writes; the app's -wal/-shm let it read current data
            uri = f"file:{urllib.parse.quote(self.path)}?mode=ro"
            try:
                con = sqlite3.connect(uri, uri=True, timeout=30)
                try:
                    rows = con.execute(
                        f"SELECT Id, Settings FROM {PROVIDER_TABLES[kind]}"
                    ).fetchall()
                finally:
                    con.close()
            except sqlite3.Error as err:
                log(f"cannot read {kind} settings from the database: {err}")
                rows = None
            self.cache[kind] = (
                None
                if rows is None
                else {row_id: json.loads(settings) for row_id, settings in rows}
            )
        table = self.cache[kind]
        if table is None or resource_id not in table:
            return None
        return table[resource_id].get(field)


def read_login(path):
    """The login from its secret file (a JSON object with LOGIN_COLUMNS' keys).

    Checked against the shape Servarr writes, so a value it would never accept
    (or a plaintext password in the hash's place) is refused before anything
    is compared or written. Errors name the key, never a value."""

    def b64(key, size):
        try:
            if len(base64.b64decode(login[key], validate=True)) == size:
                return
        except (binascii.Error, TypeError, ValueError):
            pass
        raise ValueError(f"login secret: '{key}' is not {size} bytes of base64")

    with open(path) as handle:
        try:
            login = json.loads(handle.read())
        except ValueError:
            raise ValueError("login secret: not a JSON object") from None
    if not isinstance(login, dict) or set(login) != set(LOGIN_COLUMNS):
        raise ValueError(f"login secret: keys must be {sorted(LOGIN_COLUMNS)}")
    try:
        canonical = str(uuid.UUID(login["identifier"])) == login["identifier"]
    except (AttributeError, TypeError, ValueError):
        canonical = False
    if not canonical:
        raise ValueError("login secret: 'identifier' is not a lowercase Guid")
    user = login["username"]
    if not isinstance(user, str) or not user.strip() or user != user.strip().lower():
        # the app lowercases the name on every save and login
        raise ValueError("login secret: 'username' must be non-empty lowercase")
    b64("password", 32)
    b64("salt", 16)
    iterations = login["iterations"]
    if type(iterations) is not int or iterations < 1:
        raise ValueError("login secret: 'iterations' is not a positive integer")
    return login


def login_rows(con):
    columns = ", ".join(LOGIN_COLUMNS.values())
    rows = con.execute(f"SELECT {columns} FROM Users").fetchall()
    return [dict(zip(LOGIN_COLUMNS, row, strict=True)) for row in rows]


def restore_login(database, secret_path):
    """Restore the login into an app that has none yet, while it's stopped.

    Neither the API nor config.xml can take a hash (see CREDENTIAL_SETTINGS),
    so the one row is inserted into the app's own database: only into an empty
    Users table, in one transaction, under an exclusive lock that fails at once
    while anything (the running app) has the database open. No other table is
    read or written, apart from the counter SQLite keeps for Users' ids
    (sqlite_sequence). A login equal to the secret is left alone; any other
    login is never touched, and the run fails naming the differing keys.
    Before the app's first start there is no database (or no Users table)
    yet: nothing is done, and the login is restored at its next start."""
    login = read_login(secret_path)
    if not os.path.exists(database):
        log(
            "no database yet; the app creates it at this start, the login is restored at its next"
        )
        return
    # Compare read-only first: the app may leave its -wal behind when stopped,
    # and the last read-write connection to close checkpoints it into the
    # database (same data, other bytes), so the usual runs (a login equal or
    # differing) never open one; only an empty Users table, or a database the
    # read-only connection can't read, gets the locked read-write path.
    uri = f"file:{urllib.parse.quote(database)}?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True, timeout=30)
        try:
            if not con.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Users'"
            ).fetchall():
                log(
                    "the database has no Users table yet; the login is restored at the app's next start"
                )
                return
            rows = login_rows(con)
        finally:
            con.close()
    except sqlite3.OperationalError:
        # e.g. an old Users without Salt/Iterations: the locked path below
        # checks again and decides
        rows = []
    if rows == [login]:
        log("login matches its secret; nothing written")
        return
    if rows:
        differ = sorted(
            {key for row in rows for key in LOGIN_COLUMNS if row[key] != login[key]}
        )
        raise SystemExit(
            f"the app has {len(rows)} login(s) differing from the secret "
            f"({', '.join(differ)}); left as is, nothing written"
        )
    uri = f"file:{urllib.parse.quote(database)}?mode=rw"
    # isolation_level=None: the transaction is exactly the BEGIN/COMMIT below
    con = sqlite3.connect(uri, uri=True, timeout=0, isolation_level=None)
    committed = False
    try:
        # an exclusive lock, held to the end: fails while another connection
        # has the database open (WAL mode keeps a shared lock per connection)
        con.execute("PRAGMA locking_mode=EXCLUSIVE")
        try:
            con.execute("BEGIN EXCLUSIVE")
        except sqlite3.OperationalError as err:
            raise SystemExit(
                f"database in use ({err}); is the app running? Nothing written"
            ) from err
        try:
            tables = con.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Users'"
            ).fetchall()
            if not tables:
                log(
                    "the database has no Users table yet; the login is restored at the app's next start"
                )
                return
            columns = {row[1] for row in con.execute("PRAGMA table_info(Users)")}
            missing = sorted(set(LOGIN_COLUMNS.values()) - columns)
            if missing:
                raise SystemExit(f"Users has no column(s) {missing}; nothing written")
            rows = login_rows(con)
            if rows == [login]:
                log("login matches its secret; nothing written")
                return
            if rows:
                differ = sorted(
                    {
                        key
                        for row in rows
                        for key in LOGIN_COLUMNS
                        if row[key] != login[key]
                    }
                )
                raise SystemExit(
                    f"the app has {len(rows)} login(s) differing from the secret "
                    f"({', '.join(differ)}); left as is, nothing written"
                )
            con.execute(
                f"INSERT INTO Users ({', '.join(LOGIN_COLUMNS.values())}) "
                "VALUES (?, ?, ?, ?, ?)",
                [login[key] for key in LOGIN_COLUMNS],
            )
            if login_rows(con) != [login]:
                raise SystemExit("login not stored as read back; nothing written")
            con.execute("COMMIT")
            committed = True
        finally:
            if con.in_transaction:
                con.execute("ROLLBACK")
    finally:
        try:
            con.close()
        except sqlite3.Error as err:
            # closing checkpoints the -wal: past the COMMIT the login is stored
            if committed:
                raise SystemExit(
                    f"login restored, but closing the database failed: {err}"
                ) from err
            raise
    if committed:
        log(f"login '{login['username']}' restored from its secret")


def plan_login(plan, spec):
    """Compare the app's login with its secret file; never written here.

    Equal is a note; a differing one is a mismatch (the run fails, the live
    login is kept); none at all is a problem, so nothing is written until the
    app's next start has restored it (config/host can't even be saved without
    a password then)."""
    try:
        login = read_login(spec["login"])
    except (OSError, ValueError) as err:
        plan.problems.append(
            str(err) if isinstance(err, ValueError) else f"login secret: {err.strerror}"
        )
        return
    plan.secret_values.update(login[key] for key in ("identifier", "password", "salt"))
    if not spec.get("database"):
        plan.problems.append("login: declared without the app's database")
        return
    uri = f"file:{urllib.parse.quote(spec['database'])}?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True, timeout=30)
        try:
            rows = login_rows(con)
        finally:
            con.close()
    except sqlite3.Error as err:
        log(f"cannot read the login from the database: {err}")
        plan.unverifiable.append("login")
        return
    if not rows:
        plan.problems.append(
            "login: the app has none yet; it's restored from its secret before "
            "the app's next start (restart it)"
        )
    elif len(rows) > 1:
        plan.problems.append(f"login: the app has {len(rows)} logins, expected one")
    else:
        differ = [key for key in LOGIN_COLUMNS if rows[0][key] != login[key]]
        if differ:
            plan.mismatches.append(f"login ({', '.join(differ)})")
        else:
            plan.notes.append("login matches its secret")


class Plan:
    def __init__(self):
        self.writes = []
        self.problems = []
        self.mismatches = []
        self.unverifiable = []
        # changes not written because writing them would start a list sync
        self.held = []
        self.notes = []
        # everything read while planning: the before-image of a write
        self.reads = {}
        # values read from secret files, redacted from the before-image
        self.secret_values = set()
        # tag labels this plan creates
        self.new_tags = set()
        # root folder paths present or created by this plan
        self.root_folders = set()
        # names of fields declared as secrets: redacted wherever they appear
        self.secret_fields = set()

    def write(
        self,
        method,
        path,
        body,
        summary,
        query=None,
        match=None,
        then=None,
        tag_labels=None,
    ):
        self.writes.append(
            {
                "method": method,
                "path": path,
                "body": body,
                "summary": summary,
                "query": query,
                "match": match,
                # a body to PUT on the created resource once its id is known
                "then": then,
                # tags created by this run: their ids are filled in when writing
                "tagLabels": tag_labels,
            }
        )


def read(api, plan, path):
    value = api.get(path)
    plan.reads[path] = value
    return value


def read_once(api, plan, path):
    return plan.reads[path] if path in plan.reads else read(api, plan, path)


def is_event(key):
    """A notification event flag: onGrab, onUpgrade, ... (not supportsOn*)."""
    return key.startswith("on") and key[2:3].isupper()


def is_switch(kind, key):
    """A key that makes a provider of this kind "enabled" (and so tested)."""
    if kind == "notification":
        return is_event(key)
    return kind == "importlist" and key in IMPORT_LIST_SWITCHES


def plan_tag_creates(plan, labels):
    """Create missing tags, once per run, just before the write that needs them;
    their ids are filled in when writing (with_tag_ids)."""
    for tag in labels:
        if tag not in plan.new_tags:
            plan.new_tags.add(tag)
            plan.write(
                "POST",
                "/tag",
                {"label": tag},
                f"create tag '{tag}'",
                match={"kind": "tag", "label": tag},
            )


def resolve_refs(api, plan, label, spec, desired, changed):
    """Set the references declared by logical identity (profile name, tag labels).

    Returns the tag labels that don't exist yet (created only if the resource
    is written), or None when the resource has to be skipped. Everything the
    app would reject is a problem here, before anything is written."""
    root = spec.get("properties", {}).get("rootFolderPath")
    if root is not None and root.rstrip("/") not in plan.root_folders:
        plan.problems.append(f"{label}: root folder {root} is not declared or present")
        return None
    profile = spec.get("qualityProfile")
    if profile is not None:
        ids = {p["name"]: p["id"] for p in read_once(api, plan, "/qualityprofile")}
        if profile not in ids:
            # Recyclarr creates the profile; a later run creates this resource
            plan.notes.append(
                f"{label}: quality profile '{profile}' does not exist yet; skipped"
            )
            return None
        if "qualityProfileId" not in desired:
            plan.problems.append(f"{label}: has no quality profile")
            return None
        if desired["qualityProfileId"] != ids[profile]:
            desired["qualityProfileId"] = ids[profile]
            changed.append("qualityProfile")
    labels = spec.get("tagLabels")
    if labels is None:
        return []
    # Servarr lowercases labels, and Radarr accepts only these characters
    bad = [tag for tag in labels if not TAG_LABEL.fullmatch(tag)]
    if bad:
        plan.problems.append(f"{label}: tag labels must match [a-z0-9-]+: {bad}")
        return None
    live = {tag["label"]: tag["id"] for tag in read_once(api, plan, "/tag")}
    ids = [live[tag] for tag in labels if tag in live]
    missing = [tag for tag in labels if tag not in live]
    # a set in Servarr: order doesn't matter
    if missing or sorted(desired.get("tags", [])) != sorted(ids):
        desired["tags"] = ids
        changed.append("tags")
    return missing


def provider_label(kind, spec):
    return f"{kind} '{spec['name']}'"


def find_provider(existing, spec):
    """The live resource a declared provider stands for, or None.

    The declared id wins while it still holds the same implementation and its
    name isn't taken by another resource, so a rename in the UI is undone
    instead of creating a duplicate; otherwise (a fresh install, where ids
    differ) the name decides."""
    by_name = {item["name"]: item for item in existing}
    wanted = spec.get("id")
    if wanted is not None:
        for item in existing:
            if (
                item["id"] == wanted
                and item.get("implementation") == spec["implementation"]
                and (
                    item["name"] == spec["name"]
                    or by_name.get(spec["name"], item) is item
                )
            ):
                return item
    return by_name.get(spec["name"])


def plan_secret(plan, secrets, kind, label, resource, field, desired):
    """Whether a declared secret has to be written, by the adoption rule."""
    live = field.get("value")
    if resource is None:
        return True
    if live == MASK:
        live = secrets.get(kind, resource["id"], field["name"])
        if live is None:
            plan.unverifiable.append(f"{label} field {field['name']}")
            return False
    if live in ("", None):
        return True
    if live != desired:
        plan.mismatches.append(f"{label} field {field['name']}")
    return False


def plan_provider(api, plan, secrets, kind, spec, schemas, existing):
    label = provider_label(kind, spec)
    impl = spec["implementation"]
    resource = find_provider(existing, spec)
    if resource is not None and resource.get("implementation") != impl:
        plan.problems.append(
            f"{label} exists with implementation {resource.get('implementation')} (want {impl})"
        )
        return
    if resource is None and impl not in schemas:
        plan.problems.append(f"{label}: no schema for implementation '{impl}'")
        return
    desired = copy.deepcopy(resource if resource is not None else schemas[impl])
    changed = []

    def assign(container, key, value, what):
        if container.get(key) != value:
            container[key] = value
            changed.append(what)

    pending_tags = resolve_refs(api, plan, label, spec, desired, changed)
    if pending_tags is None:
        return
    assign(desired, "name", spec["name"], "name")
    for prop, value in spec.get("properties", {}).items():
        if prop not in desired:
            plan.problems.append(f"{label}: unknown property '{prop}'")
            continue
        supported = desired.get("supports" + prop[0].upper() + prop[1:])
        if value is True and supported is False:
            plan.problems.append(f"{label}: {impl} does not support '{prop}'")
            continue
        assign(desired, prop, value, prop)

    fields = {field["name"]: field for field in desired.get("fields", [])}
    for key, value in spec.get("fields", {}).items():
        field = fields.get(key)
        if field is None:
            valid = ", ".join(sorted(fields)) or "<none>"
            plan.problems.append(
                f"{label}: unknown field '{key}'; valid fields: {valid}"
            )
            continue
        if field.get("privacy", "normal") != "normal" and value not in ("", None):
            plan.problems.append(
                f"{label}: field '{key}' is private; declare it as a secret field"
            )
            continue
        # a blank declared over a masked (set) value clears it
        assign(field, "value", value, key)
    for key, path in spec.get("secretFields", {}).items():
        field = fields.get(key)
        if field is None:
            plan.problems.append(f"{label}: unknown secret field '{key}'")
            continue
        try:
            value = read_secret(path)
        except OSError as err:
            plan.problems.append(
                f"{label}: cannot read secret for '{key}': {err.strerror}"
            )
            continue
        plan.secret_fields.add(key)
        if value:
            plan.secret_values.add(value)
        if plan_secret(plan, secrets, kind, label, resource, field, value):
            field["value"] = value
            changed.append(key)

    query = {"forceSave": "true"} if kind in FORCE_SAVE_KINDS else None
    # saving an enabled import list starts a list sync: never written
    syncs = kind == "importlist" and any(desired.get(k) for k in IMPORT_LIST_ENABLE)
    if resource is not None and changed and syncs:
        plan.held.append(
            f"{label} (id {resource['id']}): {', '.join(changed)} not written, "
            "saving an enabled list makes the app sync it at once; change it in the UI"
        )
        return
    if resource is None:
        desired.pop("id", None)
        create = desired
        then = None
        if kind in FORCE_SAVE_KINDS:
            # created with its switches off (no test); a notification gets its
            # events by the forceSave update after it, an import list doesn't
            create = copy.deepcopy(desired)
            for key in create:
                if is_switch(kind, key):
                    create[key] = False
            # a list stays off: no second write when it's disabled, held otherwise
            then = desired if create != desired and not syncs else None
            if syncs:
                plan.held.append(
                    f"{label}: created switched off; switch it on in the UI "
                    "(the app then syncs it at once)"
                )
        plan_tag_creates(plan, pending_tags)
        plan.write(
            "POST",
            "/" + kind,
            create,
            f"create {label}",
            query=query,
            match={"kind": kind, "name": spec["name"], "implementation": impl},
            then=then,
            tag_labels=spec.get("tagLabels") if pending_tags else None,
        )
    elif changed:
        plan_tag_creates(plan, pending_tags)
        plan.write(
            "PUT",
            f"/{kind}/{resource['id']}",
            desired,
            f"update {label} (id {resource['id']}): {', '.join(changed)}",
            query=query,
            tag_labels=spec.get("tagLabels") if pending_tags else None,
        )


def plan_providers(api, plan, secrets, kind, desired):
    names = [spec["name"] for spec in desired]
    if len(set(names)) != len(names):
        plan.problems.append(f"{kind}: declared names are not unique")
        return
    schemas = {
        item["implementation"]: item for item in read(api, plan, f"/{kind}/schema")
    }
    existing = read(api, plan, "/" + kind)
    claimed = {}
    for spec in desired:
        resource = find_provider(existing, spec)
        if resource is not None and resource["id"] in claimed:
            plan.problems.append(
                f"{kind} id {resource['id']} is matched by both "
                f"'{claimed[resource['id']]}' and '{spec['name']}'"
            )
            continue
        if resource is not None:
            claimed[resource["id"]] = spec["name"]
        plan_provider(api, plan, secrets, kind, spec, schemas, existing)


def plan_root_folders(api, plan, paths, needs_profiles):
    existing = {rf["path"].rstrip("/") for rf in read(api, plan, "/rootfolder")}
    extra = {}
    if needs_profiles:
        # Lidarr requires default quality/metadata profiles on every root folder.
        quality = read(api, plan, "/qualityprofile")
        metadata = read(api, plan, "/metadataprofile")
        if not quality or not metadata:
            plan.problems.append(
                "root folder needs an existing quality and metadata profile"
            )
            return
        extra = {
            "defaultQualityProfileId": quality[0]["id"],
            "defaultMetadataProfileId": metadata[0]["id"],
            "defaultMonitorOption": "all",
            "defaultNewItemMonitorOption": "all",
            "defaultTags": [],
        }
    for path in paths:
        if path.rstrip("/") in existing:
            continue
        body = {"path": path}
        if needs_profiles:
            body["name"] = os.path.basename(path.rstrip("/"))
            body.update(extra)
        plan.write(
            "POST",
            "/rootfolder",
            body,
            f"create root folder {path}",
            match={"kind": "rootfolder", "path": path},
        )


def plan_settings(api, plan, settings):
    for path, values in settings.items():
        try:
            current = read(api, plan, "/" + path)
        except ApiError as err:
            plan.problems.append(f"settings {path}: {err}")
            continue
        if not isinstance(current, dict) or "id" not in current:
            plan.problems.append(f"settings {path}: not a settings object")
            continue
        desired = copy.deepcopy(current)
        changed = []
        for key, value in values.items():
            if key not in current:
                plan.problems.append(f"settings {path}: unknown setting '{key}'")
            elif key in CREDENTIAL_SETTINGS:
                plan.problems.append(
                    f"settings {path}: '{key}' is a credential; it can't be declared"
                )
            elif key in EMPTY_ONLY_SETTINGS and value != "":
                plan.problems.append(
                    f"settings {path}: '{key}' is a credential; only empty can be declared"
                )
            elif current[key] != value:
                desired[key] = value
                changed.append(key)
        if changed:
            # config/naming is written to config/naming/<id>; delayprofile/1 to itself
            last = path.rsplit("/", 1)[-1]
            target = path if last == str(current["id"]) else f"{path}/{current['id']}"
            plan.write(
                "PUT", "/" + target, desired, f"update {path}: {', '.join(changed)}"
            )


def plan_quality_definitions(api, plan, definitions):
    live = {d["quality"]["name"]: d for d in read(api, plan, "/qualitydefinition")}
    for name, values in definitions.items():
        current = live.get(name)
        if current is None:
            plan.problems.append(f"quality definition '{name}' does not exist")
            continue
        desired = copy.deepcopy(current)
        changed = []
        for key, value in values.items():
            if key not in current and value is not None:
                plan.problems.append(
                    f"quality definition '{name}': unknown key '{key}'"
                )
            # an absent key and null both mean "no limit"
            elif current.get(key) != value:
                desired[key] = value
                changed.append(key)
        if changed:
            plan.write(
                "PUT",
                f"/qualitydefinition/{current['id']}",
                desired,
                f"update quality definition '{name}': {', '.join(changed)}",
            )
    for name in sorted(set(live) - set(definitions)):
        plan.notes.append(f"quality definition '{name}' is not declared; left as is")


def plan_quality_profiles(api, plan, profiles):
    live = {p["name"]: p for p in read(api, plan, "/qualityprofile")}
    for name, values in profiles.items():
        current = live.get(name)
        if current is None:
            # Recyclarr creates the profile; the next run sets these fields
            plan.notes.append(f"quality profile '{name}' does not exist yet; skipped")
            continue
        desired = copy.deepcopy(current)
        changed = []
        for key, value in values.items():
            if key not in current:
                plan.problems.append(f"quality profile '{name}': unknown key '{key}'")
            elif current[key] != value:
                desired[key] = value
                changed.append(key)
        if changed:
            plan.write(
                "PUT",
                f"/qualityprofile/{current['id']}",
                desired,
                f"update quality profile '{name}' (id {current['id']}): {', '.join(changed)}",
            )


def find_custom_filter(existing, spec):
    """The live custom filter a declared one stands for, or None.

    Like find_provider: the declared id wins while it holds the same list type
    and its label isn't taken there by another filter; otherwise type + label."""
    same_type = [item for item in existing if item["type"] == spec["type"]]
    by_label = {item["label"]: item for item in same_type}
    wanted = spec.get("id")
    if wanted is not None:
        for item in same_type:
            if item["id"] == wanted and by_label.get(spec["label"], item) is item:
                return item
    return by_label.get(spec["label"])


def plan_custom_filters(api, plan, desired):
    keys = [(spec["type"], spec["label"]) for spec in desired]
    if len(set(keys)) != len(keys):
        plan.problems.append("customfilter: declared type + label are not unique")
        return
    existing = read(api, plan, "/customfilter")
    claimed = {}
    for spec in desired:
        label = f"custom filter '{spec['label']}' ({spec['type']})"
        resource = find_custom_filter(existing, spec)
        body = {key: spec[key] for key in ("type", "label", "filters")}
        if resource is None:
            plan.write(
                "POST",
                "/customfilter",
                body,
                f"create {label}",
                match={
                    "kind": "customfilter",
                    "type": spec["type"],
                    "label": spec["label"],
                },
            )
            continue
        if resource["id"] in claimed:
            plan.problems.append(
                f"customfilter id {resource['id']} is matched by both "
                f"'{claimed[resource['id']]}' and '{spec['label']}'"
            )
            continue
        claimed[resource["id"]] = spec["label"]
        changed = [key for key, value in body.items() if resource.get(key) != value]
        if changed:
            plan.write(
                "PUT",
                f"/customfilter/{resource['id']}",
                dict(resource, **body),
                f"update {label} (id {resource['id']}): {', '.join(changed)}",
            )


def make_plan(api, spec, secrets):
    plan = Plan()
    if spec.get("login"):
        plan_login(plan, spec)
    try:
        if spec.get("rootFolders"):
            plan_root_folders(
                api,
                plan,
                spec["rootFolders"],
                spec.get("rootFolderNeedsProfiles", False),
            )
        if spec.get("importLists"):
            live = read_once(api, plan, "/rootfolder")
            plan.root_folders = {rf["path"].rstrip("/") for rf in live} | {
                path.rstrip("/") for path in spec.get("rootFolders", [])
            }
        # import lists after root folders: they point at one
        for kind, key in (
            ("downloadclient", "downloadClients"),
            ("notification", "notifications"),
            ("importlist", "importLists"),
            ("metadata", "metadata"),
            ("applications", "applications"),
        ):
            if spec.get(key):
                plan_providers(api, plan, secrets, kind, spec[key])
        if spec.get("customFilters"):
            plan_custom_filters(api, plan, spec["customFilters"])
        if spec.get("settings"):
            plan_settings(api, plan, spec["settings"])
        if spec.get("qualityDefinitions"):
            plan_quality_definitions(api, plan, spec["qualityDefinitions"])
        if spec.get("qualityProfiles"):
            plan_quality_profiles(api, plan, spec["qualityProfiles"])
    except ApiError as err:
        plan.problems.append(str(err))
    return plan


def report(name, plan):
    for note in plan.notes:
        log(f"{name}: {note}")
    for write in plan.writes:
        log(f"{name}: would {write['summary']}")
    for item in plan.problems:
        log(f"{name}: PROBLEM {item}")
    for item in plan.mismatches:
        log(f"{name}: {item} differs from its secret file; live value kept")
    for item in plan.unverifiable:
        log(f"{name}: {item} can't be checked against the database; left as is")
    for item in plan.held:
        log(f"{name}: HELD {item}")
    log(
        f"{name}: {len(plan.writes)} write(s), {len(plan.problems)} problem(s), "
        f"{len(plan.mismatches)} mismatch(es), {len(plan.unverifiable)} unverifiable, "
        f"{len(plan.held)} held"
    )


def find_created(api, match):
    """After an uncertain create: the resource it may have created, if any."""
    if match["kind"] == "rootfolder":
        wanted = match["path"].rstrip("/")
        return next(
            (rf for rf in api.get("/rootfolder") if rf["path"].rstrip("/") == wanted),
            None,
        )
    if match["kind"] == "tag":
        return next(
            (tag for tag in api.get("/tag") if tag["label"] == match["label"]), None
        )
    if match["kind"] == "customfilter":
        return next(
            (
                item
                for item in api.get("/customfilter")
                if item["type"] == match["type"] and item["label"] == match["label"]
            ),
            None,
        )
    return next(
        (
            item
            for item in api.get("/" + match["kind"])
            if item["name"] == match["name"]
            and item.get("implementation") == match["implementation"]
        ),
        None,
    )


def create(api, write):
    """POST a resource; returns what was created."""
    for attempt in range(RETRIES + 1):
        try:
            return api.request("POST", write["path"], write["body"], write["query"])
        except Uncertain as err:
            # look before retrying, so a create that did land isn't duplicated
            found = find_created(api, write["match"])
            if found is not None:
                log(f"{err}; the resource exists, so the create landed")
                return found
            if attempt == RETRIES:
                raise Uncertain(
                    f"{err}; not created after {attempt + 1} attempts"
                ) from err
            # A create still running server-side when the timeout hit is missed
            # here; the retry then fails Servarr's unique-name check (a 400),
            # and the next run converges with the resource that did land.
            delay = retry_delay(attempt)
            log(f"{err}; not created, retrying in {delay:.0f}s")
            api.sleep(delay)


def with_tag_ids(api, write):
    """The write with the ids of tags created earlier in this run filled in."""
    if not write["tagLabels"]:
        return write
    live = {tag["label"]: tag["id"] for tag in api.get("/tag")}
    missing = [tag for tag in write["tagLabels"] if tag not in live]
    if missing:
        raise ApiError("GET", "/tag", 404, f"tags not created: {missing}")
    ids = [live[tag] for tag in write["tagLabels"]]
    write = dict(write, body=dict(write["body"], tags=ids))
    if write["then"] is not None:
        write["then"] = dict(write["then"], tags=ids)
    return write


def check_login_unchanged(api, write):
    """Before a config/host PUT: the login it echoes must still be the live one.

    The body carries the hash read while planning; had the password been
    changed in the UI since, the app would take that old hash for a new
    plaintext password (see CREDENTIAL_SETTINGS). Read again just before the
    PUT, which leaves only the moment between this GET and the PUT."""
    if not write["path"].startswith("/config/host/"):
        return
    live = api.get("/config/host")
    if any(live.get(key) != write["body"].get(key) for key in ("username", "password")):
        raise ApiError(
            "PUT", write["path"], 409, "the login changed since planning; not written"
        )


def execute(api, write):
    write = with_tag_ids(api, write)
    check_login_unchanged(api, write)
    if write["method"] != "POST":
        api.request(write["method"], write["path"], write["body"], write["query"])
        return
    created = create(api, write)
    if write["then"] is not None:
        body = dict(write["then"], id=created["id"])
        api.request("PUT", f"{write['path']}/{created['id']}", body, write["query"])


def scrub(text, secrets):
    """Text (an error message) with every secret value replaced by REDACTED."""
    for secret in sorted(secrets, key=len, reverse=True):
        text = text.replace(secret, REDACTED)
    return text


def redacted(value, secrets, secret_fields=frozenset()):
    """A copy of an API response with every secret replaced by REDACTED.

    Covers values from secret files (the import list's Plex token is a plain
    field in the API), the value of any field named like a declared secret
    field (also a live value that differs from SOPS), the API key, config/host
    credential keys and privacy fields the API didn't mask."""
    if isinstance(value, list):
        return [redacted(item, secrets, secret_fields) for item in value]
    if isinstance(value, str):
        # a long secret also inside a longer string (a URL); a short one (a
        # user name) only as the whole value
        hit = any(s == value or (len(s) >= 8 and s in value) for s in secrets)
        return REDACTED if hit else value
    if not isinstance(value, dict):
        return value
    private_field = (
        value.get("privacy", "normal") != "normal" or value.get("name") in secret_fields
    )
    out = {}
    for key, item in value.items():
        secret_key = key in CREDENTIAL_SETTINGS or key in EMPTY_ONLY_SETTINGS
        if (secret_key or (private_field and key == "value")) and item not in (
            "",
            None,
        ):
            out[key] = REDACTED
        else:
            out[key] = redacted(item, secrets, secret_fields)
    return out


def save_backup(backup_dir, name, plan):
    stamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%S.%fZ")
    for n in range(100):
        path = os.path.join(
            backup_dir, f"{name}-before-{stamp}{f'-{n}' if n else ''}.json"
        )
        try:
            # O_EXCL: never overwrites an earlier before-image
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            continue
    else:
        raise SystemExit(f"{name}: no free before-image name in {backup_dir}")
    with os.fdopen(fd, "w") as handle:
        json.dump(
            redacted(plan.reads, plan.secret_values, plan.secret_fields),
            handle,
            indent=1,
            sort_keys=True,
        )
    log(f"{name}: before-image saved to {path}")


def load_spec(path):
    with open(path) as handle:
        return json.load(handle)


def wait_all(spec, api_key):
    wait_ready(spec["name"], spec["url"], spec["apiVersion"], api_key)
    for dep in spec.get("waitFor", []):
        wait_ready(
            dep["name"], dep["url"], dep["apiVersion"], read_secret(dep["apiKeyFile"])
        )


def apply(spec, backup_dir):
    name = spec["name"]
    api_key = read_secret(spec["apiKeyFile"])
    wait_all(spec, api_key)
    secrets = StoredSecrets(spec.get("database"))
    plan = make_plan(
        ReadOnlyApi(spec["url"], spec["apiVersion"], api_key), spec, secrets
    )
    report(name, plan)
    if plan.problems:
        raise SystemExit(f"{name}: nothing written, the plan has problems")
    if plan.writes:
        plan.secret_values.add(api_key)
        if backup_dir:
            save_backup(backup_dir, name, plan)
        api = Api(spec["url"], spec["apiVersion"], api_key)
        for done, write in enumerate(plan.writes):
            try:
                execute(api, write)
            except (ApiError, Uncertain, OSError, http.client.HTTPException) as err:
                pending = [w["summary"] for w in plan.writes[done:]]
                raise SystemExit(
                    f"{name}: {write['summary']} failed: {scrub(str(err), plan.secret_values)}; "
                    f"{done} write(s) done, not done: {'; '.join(pending)}"
                ) from err
            log(f"{name}: {write['summary']}")
        check = make_plan(
            ReadOnlyApi(spec["url"], spec["apiVersion"], api_key),
            spec,
            StoredSecrets(spec.get("database")),
        )
        if check.writes or check.problems:
            report(name, check)
            raise SystemExit(f"{name}: not converged after writing")
    if plan.mismatches or plan.unverifiable:
        raise SystemExit(
            f"{name}: secrets differ from or can't be checked against SOPS"
        )
    if plan.held:
        raise SystemExit(f"{name}: import list changes held, make them in the UI")
    print(f"{name}: converged, {len(plan.writes)} write(s)", flush=True)


def preview(spec, expect_no_changes):
    name = spec["name"]
    api_key = read_secret(spec["apiKeyFile"])
    secrets = StoredSecrets(spec.get("database"))
    plan = make_plan(
        ReadOnlyApi(spec["url"], spec["apiVersion"], api_key), spec, secrets
    )
    report(name, plan)
    failed = plan.problems or plan.mismatches or plan.unverifiable or plan.held
    return 1 if failed or (expect_no_changes and plan.writes) else 0


def main(argv):
    if len(argv) >= 3 and argv[1] == "apply":
        apply(load_spec(argv[2]), argv[3] if len(argv) > 3 else None)
        return 0
    if len(argv) >= 3 and argv[1] == "preview":
        return preview(load_spec(argv[2]), "--expect-no-changes" in argv[3:])
    if len(argv) == 4 and argv[1] == "restore-login":
        try:
            restore_login(argv[2], argv[3])
        except (OSError, ValueError, sqlite3.Error) as err:
            # the message names the key or file, never a value
            raise SystemExit(f"nothing written: {err}") from None
        return 0
    raise SystemExit(__doc__.split("usage:")[1])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
