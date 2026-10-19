"""Keep HA declarations, QA, runtime components and integration patches separate."""

import re
import sys
from pathlib import Path

PACKAGE = Path("packages/home-assistant")
MACHINE = Path("machines/home-assistant")


def validate_field_order(root, config):
    order = [
        "alias",
        "description",
        "triggers",
        "conditions",
        "actions",
        "variables",
        "mode",
        "max",
        "max_exceeded",
    ]
    aliases = []
    for path in sorted((root / "configuration" / "automations").glob("*.nix")):
        declarations = path.read_text().split(
            "services.home-assistant.config.automation =", 1
        )[1]
        for body in re.findall(r"^    \{\n(.*?)^    \}", declarations, re.M | re.S):
            fields = re.findall(r"^      (\w+) =", body, re.M)
            assert fields and fields[0] == "alias", (path, fields)
            assert fields == sorted(fields, key=order.index), (path, fields)
            assert "id" not in fields
            aliases.append(re.search(r'alias = "([^"\n]+)";', body)[1])
    assert sorted(aliases) == sorted(a["alias"] for a in config["automation"])
    print(
        f"Automation source order passed: {len(aliases)} declarations; no top-level IDs."
    )


def check_layout(root):
    errors = []
    removed = {PACKAGE / "check.nix", MACHINE / "yasno-address-guard"}
    for base in (PACKAGE, MACHINE):
        for path in sorted((root / base).rglob("*")):
            relative = path.relative_to(root)
            local = path.relative_to(root / base)
            if path.is_symlink():
                errors.append(f"{relative}: source symlinks hide layout boundaries")
            if not path.is_file() or "__pycache__" in local.parts:
                continue
            suffix = path.suffix
            if suffix == ".py":
                if base == PACKAGE:
                    valid = local.parent == Path("tests/python")
                    removed.add(base / path.name)
                else:
                    valid = len(local.parts) == 3 and local.parts[0] == "runtime"
                    removed.add(
                        base / "yasno-address-guard" / path.name
                        if local.parent.name == "yasno-address-guard"
                        else base / path.name
                    )
            elif suffix == ".patch":
                valid = (
                    base == PACKAGE
                    and len(local.parts) == 3
                    and local.parts[0] == "patches"
                )
                removed.add(base / path.name)
            elif suffix == ".nix":
                if "tests" in local.parts:
                    valid = base == PACKAGE and (
                        local == Path("tests/default.nix")
                        or local.parent == Path("tests/nix")
                    )
                else:
                    valid = not any(
                        part in local.parts for part in ("runtime", "patches")
                    )
                    valid = (
                        valid
                        and not path.name.endswith("-test.nix")
                        and path.name != "check.nix"
                    )
                if path.name.endswith("-test.nix"):
                    removed.add(base / path.name)
            elif suffix == ".jinja":
                valid = base == MACHINE and local.parent == Path(
                    "configuration/template-macros"
                )
                removed.add(base / "configuration" / path.name)
            elif suffix == ".json":
                valid = base == PACKAGE and local.parent == Path("tests/fixtures")
                removed.add(base / "fixtures" / path.name)
            else:
                continue
            if not valid:
                errors.append(f"{relative}: file belongs outside this responsibility")

    # Include repository entrypoints and documentation, not just the moved files.
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in {
            ".nix",
            ".py",
            ".md",
            ".toml",
            ".yaml",
            ".yml",
            ".sh",
        }:
            continue
        if any(
            part
            in {".git", ".direnv", ".agents", ".codex", "node_modules", "__pycache__"}
            for part in path.relative_to(root).parts
        ):
            continue
        source = path.read_text()
        for name in removed:
            if name.as_posix() in source:
                errors.append(
                    f"{path.relative_to(root)}: reference to removed path {name}"
                )
        if path.suffix == ".nix":
            for reference in re.findall(r"(?<![\w/])\.\.?/[\w./-]+", source):
                target = (path.parent / reference).resolve()
                if target.is_relative_to(root) and target.relative_to(root) in removed:
                    errors.append(
                        f"{path.relative_to(root)}: reference to removed path {reference}"
                    )
    return errors


if __name__ == "__main__":
    failures = check_layout(Path(sys.argv[1]).resolve())
    assert not failures, "\n".join(failures)
    print(
        "HA layout passed: declarations, tests, runtime components, patches and template macros separated; no removed path references."
    )
