"""Keep HA sources with the domain, component or QA concern that owns them."""

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
        # Only this closed constructor may emit executable Jinja from Nix.
        # Keep the exception tied to its exact validated-reference expression.
        if (
            path.parts[-4:]
            == ("machines", "home-assistant", "configuration", "template-files.nix")
            and line.strip()
            == 'source = "' + "{{" + ' ${builtins.concatStringsSep "." reference} }}";'
        ):
            continue
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
    for path in sorted((root / "configuration").glob("*/automations.nix")):
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


# Shared entrypoints have explicit responsibilities. Domain/component directories
# own all of their modules, patches, fixtures and other assets together.
PACKAGE_ENTRYPOINTS = {
    "default.nix",
    "core.nix",
    "mcp.nix",
    "update.nix",
    "README.md",
    ".gitattributes",
}
MACHINE_ENTRYPOINTS = {
    "default.nix",
    "hardware.nix",
    "home-assistant.nix",
    "services.nix",
    "README.md",
    ".gitignore",
}
CONFIGURATION_ENTRYPOINTS = {
    "default.nix",
    "lib.nix",
    "constructors.nix",
    "entities.nix",
    "devices.nix",
    "button-profiles.nix",
    "helpers.nix",
    "integrations.nix",
    "scenes.nix",
    "templates.nix",
    "template.nix",
    "template-files.nix",
    "merge-template-domains.nix",
}
DOMAINS = {
    "climate",
    "devices",
    "gpt",
    "lighting",
    "media",
    "power",
    "printer",
    "shared",
    "system",
    "voice",
    "weather",
}
TEST_CONCERNS = {"configuration", "layout", "mcp", "runtime", "templates", "updater"}
RUNTIME_COMPONENTS = {"argonone", "backup", "yasno-address-guard"}


def responsibility(base, local, root):
    """Locate the domain, component or QA concern that owns each source."""
    parts = local.parts
    if len(parts) == 1:
        entrypoints = PACKAGE_ENTRYPOINTS if base == PACKAGE else MACHINE_ENTRYPOINTS
        return local.name in entrypoints
    boundary, owner = parts[:2]
    if base == MACHINE:
        if boundary == "runtime":
            return len(parts) >= 3 and owner in RUNTIME_COMPONENTS
        if boundary == "configuration":
            return (len(parts) == 2 and owner in CONFIGURATION_ENTRYPOINTS) or (
                len(parts) >= 3 and owner in DOMAINS
            )
    elif boundary == "tests":
        return local == Path("tests/default.nix") or (
            len(parts) >= 3 and owner in TEST_CONCERNS
        )
    elif boundary in {"custom-components", "core-dependencies", "mcp-dependencies"}:
        # Package assets share their owner's native package entrypoint.
        if len(parts) == 2:
            return local.suffix == ".nix"
        entrypoint = "package.nix" if boundary == "custom-components" else "default.nix"
        return (root / base / boundary / owner / entrypoint).is_file()
    return False


def check_layout(root):
    """Enforce ownership boundaries while allowing cohesive mixed file types."""
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
            if not responsibility(base, local, root):
                errors.append(
                    f"{relative}: no domain, component or QA concern owns this source"
                )
            if suffix == ".jinja" and base == MACHINE:
                reference = re.fullmatch(
                    r"\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}\s*",
                    path.read_text(),
                )
                if reference and reference[1] not in (
                    "true",
                    "false",
                    "none",
                    "True",
                    "False",
                    "None",
                ):
                    errors.append(
                        f"{relative}: simple references belong in template.ref"
                    )
            if suffix in (".nix", ".py"):
                errors.extend(inline_jinja(path))

    return errors


if __name__ == "__main__":
    failures = check_layout(Path(sys.argv[1]).resolve())
    assert not failures, "\n".join(failures)
    print(
        "HA layout passed: sources grouped by domain, component and QA concern; no inline Jinja programs."
    )
