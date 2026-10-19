"""Keep HA declarations, QA, runtime components and integration patches separate."""

import re
import sys
from pathlib import Path

PACKAGE = Path("packages/home-assistant")
MACHINE = Path("machines/home-assistant")


def inline_jinja(path):
    """Delimiters are allowed as scanner tokens or clearly marked input data."""
    errors = []
    previous = ""
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.lstrip().startswith("#") and re.search(r"\{(?:\{|%|#)", line):
            # The constructor's delimiter detector contains tokens, not programs.
            tokens = re.sub(r"""["']\{(?:\{|%|#)["']""", "", line)
            if re.search(r"\{(?:\{|%|#)", tokens) and "# jinja-data:" not in previous:
                errors.append(f"{path}:{number}: Jinja programs belong in .jinja files")
        previous = line
    return errors


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
    """Enforce source placement by file type and directory responsibility."""
    errors = []
    for base in (PACKAGE, MACHINE):
        if not (root / base).is_dir():
            errors.append(f"{base}: source directory is missing")
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
                else:
                    valid = len(local.parts) == 3 and local.parts[0] == "runtime"
            elif suffix == ".patch":
                valid = (
                    base == PACKAGE
                    and len(local.parts) == 3
                    and local.parts[0] == "patches"
                )
            elif suffix == ".nix":
                if base == PACKAGE:
                    valid = (
                        local == Path("tests/default.nix")
                        or local.parent == Path("tests/nix")
                        or (
                            local.parent
                            in (Path("."), Path("custom-components"), Path("python"))
                            and not path.name.endswith("-test.nix")
                        )
                    )
                else:
                    valid = (
                        local.parent == Path(".") or local.parts[0] == "configuration"
                    ) and not path.name.endswith("-test.nix")
                    valid = valid and "jinja" not in local.parts
            elif suffix == ".jinja":
                valid = (
                    base == MACHINE
                    and len(local.parts) == 4
                    and local.parts[:2] == ("configuration", "jinja")
                ) or (
                    base == PACKAGE and local.parent == Path("tests/fixtures/templates")
                )
            elif suffix == ".json":
                valid = base == PACKAGE and local.parent == Path("tests/fixtures")
            else:
                continue
            if not valid:
                errors.append(f"{relative}: file belongs outside this responsibility")
            if suffix in (".nix", ".py"):
                errors.extend(inline_jinja(path))

    return errors


if __name__ == "__main__":
    failures = check_layout(Path(sys.argv[1]).resolve())
    assert not failures, "\n".join(failures)
    print(
        "HA layout passed: declarations, tests, runtime components, patches and Jinja files separated; no inline Jinja programs."
    )
