"""Private two-way YAML reconciliation workbook, without choosing a winner.

Uses the pinned Core/annotatedyaml include semantics, but retains !secret names
instead of reading secrets. Unsupported/ambiguous input always makes the audit
incomplete. Normalized documents may contain plaintext values: all outputs are
private, while the workbook/delta contain identities and field paths only.
"""

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

import yaml

IDENTITY = re.compile(r"[A-Za-z0-9_.-]{1,200}\Z")
SPECIAL = {"automation", "script", "scene"}
ACKNOWLEDGEABLE = {"unreferenced-yaml-needs-review", "ui-storage-code-needs-review"}
SKIP_DIRS = {
    ".storage",
    "custom_components",
    "deps",
    "www",
    "tts",
    "backups",
    "blueprints",
    "pyscript",
    "__pycache__",
    ".git",
}


def canonical(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class InvalidInput(Exception):
    """Only fixed diagnostics reach the terminal."""


class Unresolved(Exception):
    pass


class CaptureYaml:
    def __init__(self, root):
        self.root = root
        self.stack = []
        self.files = {}
        self.findings = []

    def issue(self, code, source="configuration.yaml"):
        self.findings.append({"code": code, "source": source, "confidence": "low"})

    def checked_path(self, path):
        try:
            resolved = path.resolve(strict=True)
            resolved.relative_to(self.root)
        except (OSError, ValueError, RuntimeError):
            raise Unresolved("include-outside-snapshot-or-missing") from None
        return resolved

    def load(self, path):
        try:
            path = self.checked_path(path)
            if not path.is_file():
                raise Unresolved("include-is-not-file")
            if path in self.stack:
                raise Unresolved("include-cycle")
            if len(self.stack) >= 64 or len(self.files) >= 10000:
                raise Unresolved("include-limit")
            content = path.read_bytes()
            self.files[str(path.relative_to(self.root))] = hashlib.sha256(
                content
            ).hexdigest()
            self.stack.append(path)
            owner = self

            class Loader(yaml.SafeLoader):
                pass

            def mapping(loader, node):
                loader.flatten_mapping(node)
                result = {}
                for key_node, value_node in node.value:
                    key = loader.construct_object(key_node, deep=True)
                    if not isinstance(key, (str, int, bool)):
                        raise Unresolved("unsupported-yaml-key")
                    key = str(key)
                    if key in result:
                        raise Unresolved("duplicate-yaml-key")
                    result[key] = loader.construct_object(value_node, deep=True)
                return result

            def secret(loader, node):
                if not isinstance(node, yaml.ScalarNode) or not re.fullmatch(
                    r"[A-Za-z0-9_.-]+", node.value
                ):
                    raise Unresolved("invalid-secret-reference")
                return {"$ha_secret": node.value}

            def unknown(_loader, _node):
                owner.issue("unsupported-yaml-tag", str(path.relative_to(owner.root)))
                return {"$unresolved": "unsupported-yaml-tag"}

            def include(loader, node):
                if not isinstance(node, yaml.ScalarNode) or not node.value:
                    raise Unresolved("invalid-include")
                included = owner.checked_path(path.parent / node.value)
                if node.tag == "!include":
                    value = owner.load(included)
                    return {} if value is None else value
                if not included.is_dir():
                    raise Unresolved("include-directory-is-not-directory")
                candidates = []
                for directory, dirs, files in os.walk(included, followlinks=False):
                    dirs[:] = sorted(d for d in dirs if not d.startswith("."))
                    for name in sorted(files):
                        if (
                            not name.startswith(".")
                            and name.endswith(".yaml")
                            and name != "secrets.yaml"
                        ):
                            candidate = Path(directory) / name
                            owner.checked_path(candidate)
                            candidates.append(candidate)
                if node.tag in ("!include_dir_list", "!include_dir_merge_list"):
                    result = []
                    for candidate in candidates:
                        value = owner.load(candidate)
                        if node.tag == "!include_dir_list":
                            if value is not None:
                                result.append(value)
                        elif isinstance(value, list):
                            result.extend(value)
                        elif value is not None:
                            owner.issue(
                                "include-merge-list-has-non-list",
                                str(candidate.relative_to(owner.root)),
                            )
                    return result
                result = {}
                for candidate in candidates:
                    value = owner.load(candidate)
                    if node.tag == "!include_dir_named":
                        additions = {candidate.stem: {} if value is None else value}
                    elif isinstance(value, dict):
                        additions = value
                    else:
                        if value is not None:
                            owner.issue(
                                "include-merge-named-has-non-mapping",
                                str(candidate.relative_to(owner.root)),
                            )
                        continue
                    if result.keys() & additions.keys():
                        owner.issue(
                            "duplicate-include-key",
                            str(candidate.relative_to(owner.root)),
                        )
                    result.update(additions)
                return result

            Loader.add_constructor(
                yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping
            )
            Loader.add_constructor("!secret", secret)
            Loader.add_constructor(None, unknown)
            for tag in (
                "!include",
                "!include_dir_list",
                "!include_dir_merge_list",
                "!include_dir_named",
                "!include_dir_merge_named",
            ):
                Loader.add_constructor(tag, include)
            try:
                return yaml.load(content, Loader=Loader)
            finally:
                self.stack.pop()
        except (
            Unresolved,
            yaml.YAMLError,
            UnicodeError,
            OSError,
            RecursionError,
        ) as error:
            code = str(error) if isinstance(error, Unresolved) else "yaml-unreadable"
            self.issue(code)
            return {"$unresolved": code}


def normalize(value, findings, declared=False, context="", active=None):
    active = set() if active is None else active
    if isinstance(value, (dict, list)):
        if id(value) in active:
            findings.append(
                {
                    "code": "yaml-alias-cycle",
                    "source": "configuration.yaml",
                    "confidence": "low",
                }
            )
            return {"$unresolved": "yaml-alias-cycle"}
        active = active | {id(value)}
    if isinstance(value, list):
        return [normalize(item, findings, declared, context, active) for item in value]
    if isinstance(value, dict):
        result = {
            str(key): normalize(item, findings, declared, "", active)
            for key, item in value.items()
            if not (declared and item is None)
        }
        aliases = {
            "automation": (
                ("trigger", "triggers"),
                ("condition", "conditions"),
                ("action", "actions"),
            ),
            "action": (("service", "action"),),
            "trigger": (("platform", "trigger"),),
        }
        for old, new in aliases.get(context, ()):
            if old in result and new in result:
                findings.append(
                    {
                        "code": "conflicting-schema-aliases",
                        "source": context,
                        "confidence": "low",
                    }
                )
            elif old in result:
                result[new] = result.pop(old)
        if context == "automation":
            for field, child_context in (
                ("triggers", "trigger"),
                ("conditions", "condition"),
                ("actions", "action"),
            ):
                if field in result:
                    items = (
                        result[field]
                        if isinstance(result[field], list)
                        else [result[field]]
                    )
                    result[field] = [
                        normalize(item, findings, False, child_context)
                        for item in items
                    ]
        if context in ("action", "script"):
            for field in ("sequence", "then", "else", "default", "parallel"):
                if field in result:
                    items = (
                        result[field]
                        if isinstance(result[field], list)
                        else [result[field]]
                    )
                    result[field] = [
                        normalize(item, findings, False, "action") for item in items
                    ]
            if isinstance(result.get("repeat"), dict):
                result["repeat"] = normalize(
                    result["repeat"], findings, False, "action"
                )
            if isinstance(result.get("choose"), list):
                result["choose"] = [
                    normalize(choice, findings, False, "action")
                    for choice in result["choose"]
                ]
        if "use_blueprint" in result:
            findings.append(
                {
                    "code": "blueprint-expansion-needs-review",
                    "source": context or "configuration.yaml",
                    "confidence": "low",
                }
            )
        if context in ("automation", "scene") and "id" in result:
            result["id"] = str(result["id"])
        return result
    if (
        declared
        and isinstance(value, str)
        and re.fullmatch(r"!secret [A-Za-z0-9_.-]+", value)
    ):
        return {"$ha_secret": value.removeprefix("!secret ")}
    if value is None or isinstance(value, (str, int, float, bool)):
        try:
            canonical(value)
            return value
        except ValueError:
            pass
    findings.append(
        {
            "code": "non-json-yaml-scalar",
            "source": "configuration.yaml",
            "confidence": "low",
        }
    )
    return {"$unresolved": "non-json-yaml-scalar"}


def configuration(value, findings, declared=False):
    if not isinstance(value, dict):
        findings.append(
            {
                "code": "configuration-is-not-mapping",
                "source": "configuration.yaml",
                "confidence": "low",
            }
        )
        return {}, {kind: {} for kind in SPECIAL}, {}
    normalized = {}
    groups = {kind: {} for kind in SPECIAL}

    def identity(kind, key, item):
        key = str(key) if key is not None else "missing-id-" + digest(item)[:16]
        if not IDENTITY.fullmatch(key):
            findings.append(
                {"code": "unsupported-identity", "source": kind, "confidence": "low"}
            )
            key = "opaque-id-" + digest(key)[:16]
        if key in groups[kind]:
            findings.append(
                {"code": "duplicate-identity", "source": kind, "confidence": "low"}
            )
            key += "-duplicate-" + str(len(groups[kind]))
        groups[kind][key] = item

    def section(key, item):
        kind = key.split(" ", 1)[0]
        if kind not in SPECIAL:
            return normalize(item, findings, declared)
        if kind == "script":
            if not isinstance(item, dict):
                findings.append(
                    {
                        "code": "script-is-not-mapping",
                        "source": kind,
                        "confidence": "low",
                    }
                )
                return normalize(item, findings, declared)
            result = {}
            for script_id, body in item.items():
                result[script_id] = normalize(body, findings, declared, "script")
                identity(kind, script_id, result[script_id])
            return result
        items = item if isinstance(item, list) else [item]
        result = []
        for body in items:
            converted = normalize(body, findings, declared, kind)
            result.append(converted)
            if not isinstance(converted, dict) or "id" not in converted:
                findings.append(
                    {
                        "code": "missing-stable-identity",
                        "source": kind,
                        "confidence": "low",
                    }
                )
            identity(
                kind,
                converted.get("id") if isinstance(converted, dict) else None,
                converted,
            )
        return result

    for key, item in value.items():
        if declared and item is None:
            continue
        normalized[key] = section(key, {} if item is None else item)
    packages = value.get("homeassistant", {})
    packages = packages.get("packages", {}) if isinstance(packages, dict) else {}
    if packages:
        findings.append(
            {
                "code": "package-merge-needs-review",
                "source": "homeassistant.packages",
                "confidence": "low",
            }
        )
        if isinstance(packages, dict):
            for package in packages.values():
                if isinstance(package, dict):
                    for key, item in package.items():
                        if key.split(" ", 1)[0] in SPECIAL:
                            section(key, item)
    other = {
        key: item
        for key, item in normalized.items()
        if key.split(" ", 1)[0] not in SPECIAL
    }
    return normalized, groups, other


def paths(left, right, prefix=""):
    """Field paths only; never put old/new scalar values into delta reports."""
    if type(left) is not type(right):
        return [prefix or "/"]
    if isinstance(left, dict):
        result = []
        for key in sorted(left.keys() | right.keys()):
            safe_key = (
                key
                if re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", key)
                else "opaque-key-" + digest(key)[:12]
            )
            child = prefix + "/" + safe_key
            result.extend(
                [child]
                if key not in left or key not in right
                else paths(left[key], right[key], child)
            )
        return result
    if isinstance(left, list):
        result = []
        for index in range(max(len(left), len(right))):
            child = prefix + "/" + str(index)
            result.extend(
                [child]
                if index >= len(left) or index >= len(right)
                else paths(left[index], right[index], child)
            )
        return result
    return [] if left == right else [prefix or "/"]


def inventory(root, findings):
    result = {
        "core_version": "unknown",
        "custom_components": [],
        "integrations": {},
        "storage_files": {},
        "runtime_only": [
            "authentication",
            "OAuth tokens",
            "registries and IDs",
            "pairings and fabrics",
            "dashboards",
            "Assist pipelines",
            "history and enabled states",
        ],
    }
    try:
        version_file = root / ".HA_VERSION"
        version_file.resolve(strict=True).relative_to(root)
        version = version_file.read_text().strip()
        if re.fullmatch(r"\d{4}\.\d{1,2}\.\d+(?:[a-z0-9.+-]*)", version):
            result["core_version"] = version
        else:
            raise ValueError
    except (OSError, ValueError, RuntimeError):
        findings.append(
            {
                "code": "core-version-unreadable",
                "source": ".HA_VERSION",
                "confidence": "low",
            }
        )
    for component in sorted((root / "custom_components").glob("*/manifest.json")):
        if not re.fullmatch(r"[a-z][a-z0-9_]*", component.parent.name):
            continue
        try:
            component.resolve(strict=True).relative_to(root)
            data = json.loads(component.read_text())
            if not isinstance(data, dict):
                raise ValueError
            version = str(data.get("version", "unknown"))
            hashes = {}
            for source in sorted(component.parent.rglob("*")):
                if source.is_file() and "__pycache__" not in source.parts:
                    source.resolve(strict=True).relative_to(root)
                    hashes[str(source.relative_to(component.parent))] = hashlib.sha256(
                        source.read_bytes()
                    ).hexdigest()
            result["custom_components"].append(
                {
                    "domain": component.parent.name,
                    "version": version if IDENTITY.fullmatch(version) else "invalid",
                    "source_digest": digest(hashes),
                }
            )
        except (OSError, ValueError, RuntimeError):
            findings.append(
                {
                    "code": "component-inventory-unreadable",
                    "source": "custom_components",
                    "confidence": "low",
                }
            )
    storage = root / ".storage"
    for path in sorted(storage.glob("*")):
        if path.is_file():
            try:
                path.resolve(strict=True).relative_to(root)
                result["storage_files"][path.name] = hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()
                if re.search(r"automation|script|scene", path.name):
                    findings.append(
                        {
                            "code": "ui-storage-code-needs-review",
                            "source": ".storage",
                            "confidence": "low",
                        }
                    )
            except (OSError, ValueError, RuntimeError):
                findings.append(
                    {
                        "code": "runtime-inventory-unreadable",
                        "source": ".storage",
                        "confidence": "low",
                    }
                )
    try:
        entries_file = storage / "core.config_entries"
        entries_file.resolve(strict=True).relative_to(root)
        entries = json.loads(entries_file.read_text())["data"]["entries"]
        for entry in entries:
            domain = entry["domain"]
            if not isinstance(domain, str) or not re.fullmatch(
                r"[a-z][a-z0-9_]*", domain
            ):
                raise ValueError
            result["integrations"][domain] = result["integrations"].get(domain, 0) + 1
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        findings.append(
            {
                "code": "integration-inventory-unreadable",
                "source": ".storage/core.config_entries",
                "confidence": "low",
            }
        )
    result["retained_code"] = {}
    for name in ("blueprints", "pyscript", "python_scripts", "www"):
        files = {}
        tree = root / name
        try:
            if tree.exists() or tree.is_symlink():
                tree.resolve(strict=True).relative_to(root)
                if not tree.is_dir() or tree.is_symlink():
                    raise ValueError

                def walk_error(_error):
                    raise ValueError

                for directory, dirs, names in os.walk(
                    tree, followlinks=False, onerror=walk_error
                ):
                    kept = []
                    for child in sorted(dirs):
                        if child in ("__pycache__", ".git"):
                            continue
                        directory_path = Path(directory) / child
                        directory_path.resolve(strict=True).relative_to(root)
                        if directory_path.is_symlink():
                            raise ValueError
                        kept.append(child)
                    dirs[:] = kept
                    for child in sorted(names):
                        path = Path(directory) / child
                        path.resolve(strict=True).relative_to(root)
                        if not path.is_file():
                            raise ValueError
                        hashed = hashlib.sha256()
                        with path.open("rb") as stream:
                            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                                hashed.update(chunk)
                        files[str(path.relative_to(tree))] = hashed.hexdigest()
        except (OSError, ValueError, RuntimeError):
            findings.append(
                {
                    "code": "retained-code-inventory-incomplete",
                    "source": name,
                    "confidence": "low",
                }
            )
        result["retained_code"][name] = {
            "file_count": len(files),
            "digest": digest(files),
            "files": files,
        }
    return result


def write(path, value):
    with path.open("x", encoding="utf8") as stream:
        os.chmod(path, 0o600)
        stream.write(value)


def run(args):
    root = Path(args.snapshot).resolve(strict=True)
    if not root.is_dir() or not (root / "configuration.yaml").is_file():
        raise InvalidInput("use an unpacked cold HA configuration snapshot")
    output = Path(args.output)
    if not output.is_absolute() or output.exists() or output.is_symlink():
        raise InvalidInput("output must be a new absolute private directory")
    output = output.resolve()
    if output.is_relative_to(root) or output.is_relative_to(Path("/nix/store")):
        raise InvalidInput("output must be outside the snapshot and Nix store")
    if any(
        (parent / ".git").is_file() or (parent / ".git/HEAD").is_file()
        for parent in (output, *output.parents)
    ):
        raise InvalidInput("private output must stay outside Git checkouts")
    try:
        declaration = json.loads(Path(args.declarations).read_text())
        declared_raw = declaration["configuration"]
        if not isinstance(declared_raw, dict):
            raise ValueError
    except (OSError, ValueError, TypeError, KeyError):
        raise InvalidInput(
            "declarations must contain the public configuration mapping"
        ) from None
    loader = CaptureYaml(root)
    raw = loader.load(root / "configuration.yaml")
    findings = loader.findings
    source, live, other_live = configuration(raw, findings)
    declared, wanted, other_wanted = configuration(
        declared_raw, findings, declared=True
    )
    unreferenced = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(
            name for name in dirs if name not in SKIP_DIRS and not name.startswith(".")
        )
        for name in sorted(files):
            path = Path(directory) / name
            relative = str(path.relative_to(root))
            if (
                name.endswith((".yaml", ".yml"))
                and name != "secrets.yaml"
                and relative not in loader.files
            ):
                try:
                    loader.checked_path(path)
                    unreferenced[relative] = hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                except (Unresolved, OSError):
                    findings.append(
                        {
                            "code": "unreferenced-yaml-unreadable",
                            "source": relative,
                            "confidence": "low",
                        }
                    )
                findings.append(
                    {
                        "code": "unreferenced-yaml-needs-review",
                        "source": relative,
                        "confidence": "low",
                    }
                )
    state = inventory(root, findings)
    state["unreferenced_yaml_files"] = unreferenced
    rows = []
    for kind, left, right in [
        (kind, live[kind], wanted[kind]) for kind in sorted(SPECIAL)
    ] + [("configuration", other_live, other_wanted)]:
        for identity in sorted(left.keys() | right.keys()):
            if (
                identity in left
                and identity in right
                and canonical(left[identity]) == canonical(right[identity])
            ):
                continue
            safe_id = (
                identity
                if IDENTITY.fullmatch(identity)
                else "opaque-id-" + digest(identity)[:16]
            )
            rows.append(
                {
                    "row_id": kind + ":" + digest(identity),
                    "kind": kind,
                    "id": safe_id,
                    "change": "declared_only"
                    if identity not in left
                    else "live_only"
                    if identity not in right
                    else "changed",
                    "changed_paths": paths(left[identity], right[identity])
                    if identity in left and identity in right
                    else ["/"],
                    "decision": None,
                    "reason": "",
                    "target_file": "",
                    "validation": "",
                }
            )
    findings = sorted(
        {canonical(item): item for item in findings}.values(), key=canonical
    )
    fingerprint = digest(
        {
            "source": source,
            "declared": declared,
            "files": loader.files,
            "runtime": state,
            "findings": findings,
        }
    )
    for finding in findings:
        finding["finding_id"] = digest(finding)
        finding["acknowledged"] = False
    if args.decisions:
        path = Path(args.decisions)
        try:
            info = path.lstat()
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_mode & 0o077
                or info.st_uid not in (0, os.geteuid())
            ):
                raise ValueError
            ledger = json.loads(path.read_text())
            if (
                ledger.get("schema_version") != 1
                or ledger.get("fingerprint") != fingerprint
                or not isinstance(ledger.get("decisions"), list)
            ):
                raise ValueError
            by_id = {row["row_id"]: row for row in rows}
            seen = set()
            for decision in ledger["decisions"]:
                row_id = decision["row_id"]
                if (
                    row_id in seen
                    or row_id not in by_id
                    or decision["decision"]
                    not in ("accept-live", "keep-declared", "merge")
                ):
                    raise ValueError
                if not all(
                    isinstance(decision.get(key), str) and decision[key].strip()
                    for key in ("reason", "target_file", "validation")
                ):
                    raise ValueError
                target = Path(decision["target_file"])
                if (
                    target.is_absolute()
                    or ".." in target.parts
                    or target.suffix != ".nix"
                ):
                    raise ValueError
                seen.add(row_id)
                by_id[row_id].update(
                    {
                        key: decision[key]
                        for key in ("decision", "reason", "target_file", "validation")
                    }
                )
            by_finding = {item["finding_id"]: item for item in findings}
            acknowledged = set()
            acknowledgements = ledger.get("acknowledgements", [])
            if not isinstance(acknowledgements, list):
                raise ValueError
            for acknowledgement in acknowledgements:
                finding_id = acknowledgement["finding_id"]
                if finding_id in acknowledged or finding_id not in by_finding:
                    raise ValueError
                finding = by_finding[finding_id]
                if finding["code"] not in ACKNOWLEDGEABLE or acknowledgement[
                    "disposition"
                ] not in ("preserve-runtime", "retire-unused"):
                    raise ValueError
                if not all(
                    isinstance(acknowledgement.get(key), str)
                    and acknowledgement[key].strip()
                    for key in ("reason", "validation")
                ):
                    raise ValueError
                acknowledged.add(finding_id)
                finding.update(
                    {
                        "acknowledged": True,
                        "resolution": {
                            key: acknowledgement[key]
                            for key in ("disposition", "reason", "validation")
                        },
                    }
                )
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            raise InvalidInput(
                "decision ledger is invalid, incomplete, duplicated or belongs to different captured inputs"
            ) from None
    unresolved_findings = sum(not item["acknowledged"] for item in findings)
    unresolved = sum(row["decision"] is None for row in rows) + unresolved_findings
    status = (
        "incomplete"
        if unresolved_findings
        else "needs_review"
        if unresolved
        else "accounted"
        if rows or findings
        else "no_yaml_drift"
    )
    report = {
        "schema_version": 1,
        "fingerprint": fingerprint,
        "status": status,
        "unresolved_count": unresolved,
        "rows": rows,
        "findings": findings,
        "source_files": loader.files,
        "scope": "Two-way YAML drift; runtime inventory is preserved state, not generated configuration. Accounted decisions are records, not approval or automated validation.",
    }
    output.mkdir(mode=0o700, parents=True)
    for name, document in (
        ("source-normalized.json", source),
        ("declared-normalized.json", declared),
        ("runtime-inventory.json", state),
        ("drift.json", report),
        (
            "decisions-template.json",
            {
                "schema_version": 1,
                "fingerprint": fingerprint,
                "decisions": [
                    {
                        key: row[key]
                        for key in (
                            "row_id",
                            "decision",
                            "reason",
                            "target_file",
                            "validation",
                        )
                    }
                    for row in rows
                ],
                "acknowledgements": [
                    {
                        "finding_id": item["finding_id"],
                        "disposition": None,
                        "reason": "",
                        "validation": "",
                    }
                    for item in findings
                    if item["code"] in ACKNOWLEDGEABLE
                ],
            },
        ),
    ):
        write(
            output / name,
            json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )
    lines = [
        "# Fresh-capture configuration reconciliation",
        "",
        "Compare the protected normalized JSON files locally. No values appear in this workbook.",
        "",
        "A live-only row may be a live addition or a deliberate branch removal; a declared-only row may be a planned addition or a live deletion. Choose from evidence, preserving IDs.",
        "",
        "Record accept-live, keep-declared or merge, a reason, owning Nix target_file and validation evidence in decisions-template.json. State-only is never a valid YAML decision. Only unreferenced YAML and possible UI-storage code findings allow a preserve-runtime/retire-unused acknowledgement with reason and validation; parser, identity and include errors cannot be waived. Rerun with --decisions into a new output directory; its fingerprint rejects stale inputs.",
        "",
        "A zero exit with accounted rows records decisions only; implement/review them, rebuild, and repeat against fresh declarations. Runtime-only auth, pairings, registries and dashboards belong in protected state backups.",
        "",
        f"Status: {status}. Differences: {len(rows)}. Unresolved findings/rows: {unresolved}.",
        "",
        "| Kind | Identity | Difference | Changed fields | Decision / reason / owner / validation |",
        "| --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        fields = ", ".join(row["changed_paths"])
        lines.append(
            f"| {row['kind']} | `{row['id']}` | {row['change']} | `{fields}` | {row['decision'] or 'pending'}; see private ledger |"
        )
    lines += ["", "## Low-confidence inputs", ""]
    lines.extend(
        f"- `{item['code']}` ({'acknowledged' if item['acknowledged'] else 'unresolved'}): inspect the protected source inventory; no automatic clean result."
        for item in findings
    )
    lines += [
        "",
        "## Runtime and custom code inventory",
        "",
        f"Core: {state['core_version']}. Custom components: {len(state['custom_components'])}. Integration domains: {len(state['integrations'])}.",
        "",
        "Inspect runtime-inventory.json for captured component versions/source hashes, integration counts and runtime storage fingerprints. Compare custom integration code with declared package pins separately; this YAML audit does not prove code or hardware equivalence.",
        "",
    ]
    write(output / "workbook.md", "\n".join(lines))
    print(
        "Private configuration workbook created; review its status and unresolved rows."
    )
    return 1 if unresolved else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--declarations", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--decisions")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        return run(args)
    except (InvalidInput, OSError, ValueError, TypeError, RecursionError) as error:
        message = (
            str(error)
            if isinstance(error, InvalidInput)
            else "cannot audit these inputs safely"
        )
        print("configuration drift: " + message, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
