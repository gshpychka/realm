"""Generate a complete relocatable project from pinned public inputs, offline."""

import json
import re
import shutil
import sys
import tarfile
import zipfile
from pathlib import Path

from esphome import external_files, writer
from esphome.__main__ import main
from esphome.core import CORE
from esphome.platformio import library
from semantic_version import SimpleSpec, Version

inputs = json.loads(Path(sys.argv[1]).read_text())
root = Path("project")
root.mkdir()


def untar(archive, destination, strip=False):
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tf:
        tf.extractall(destination, filter="data")
    if strip:
        entries = list(destination.iterdir())
        assert len(entries) == 1 and entries[0].is_dir()
        child = entries[0]
        for entry in child.iterdir():
            shutil.move(entry, destination / entry.name)
        child.rmdir()


untar(inputs["upstream"]["base"], root / "upstream", True)
untar(inputs["upstream"]["external"], root / "external", True)
shutil.copytree(inputs["localComponents"], root / "components")
shutil.copyfile(inputs["yaml"], root / "voice-pe.yaml")
for name, paths in inputs["models"].items():
    target = root / "models" / name
    target.mkdir(parents=True)
    shutil.copy(paths["manifest"], target / "manifest.json")
    manifest = json.loads((target / "manifest.json").read_text())
    shutil.copy(paths["model"], target / manifest["model"])

# Upstream mutable defaults become local files from immutable fetched sources.
base = root / "upstream/home-assistant-voice.yaml"
text = base.read_text()
text = re.sub(
    r"https://github.com/esphome/home-assistant-voice-pe/raw/dev/sounds/([^\s]+)",
    r"external/sounds/\1",
    text,
)
start = text.index("external_components:\n")
end = text.index("\naudio_dac:", start)
text = (
    text[:start]
    + "external_components:\n  - source:\n      type: local\n      path: external/esphome/components\n    components: [voice_kit]\n"
    + text[end:]
)
urls = {
    "okay_nabu": "https://github.com/kahrendt/microWakeWord/releases/download/okay_nabu_20241226.3/okay_nabu.json",
    "stop": "https://github.com/kahrendt/microWakeWord/releases/download/stop/stop.json",
    "hey_jarvis": "hey_jarvis",
    "hey_mycroft": "hey_mycroft",
}
for name, original in urls.items():
    text = text.replace(
        "model: " + original, "model: models/" + name + "/manifest.json"
    )
text = text.replace("  vad:\n", "  vad:\n    model: models/vad/manifest.json\n")
base.write_text(text)
local = root / "voice-pe.yaml"
text = local.read_text()
start = text.index("  voice_pe:\n")
end = text.index("\n# Wi-Fi", start)
text = (
    text[:start]
    + "  voice_pe: !include upstream/home-assistant-voice.yaml\n"
    + text[end:]
)
local.write_text(text)

# Voice-kit only supports HTTP URLs; redirect its pinned URL to a declared fetch.
# Any unexpected network dependency aborts. No cache hit or network fallback.


def resolve_vendor(owner, name, requirements):
    canonical = next(n for n in inputs["vendor"] if n.lower() == name.lower())
    item = inputs["vendor"][canonical]
    assert all(SimpleSpec(req).match(Version(item["version"])) for req in requirements)
    return owner, canonical, item["version"], item["url"], None


def extract_vendor(self, dir_suffix, force=False, salt="", namespace="", progress=None):
    item = next(v for v in inputs["vendor"].values() if v["url"] == self.url)
    path = Path(CORE.data_dir) / "pinned-vendor" / dir_suffix
    if not path.exists():
        untar(item["archive"], path, True)
    return path


library._resolve_registry_version = resolve_vendor
library.URLSource.download = extract_vendor


def offline_download(url, path, *args, **kwargs):
    if url != inputs["xmosUrl"]:
        raise RuntimeError("Undeclared download: " + url)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(inputs["xmos"], path)


external_files.download_content = offline_download
original = writer.generate_build_info_data_cpp
writer.generate_build_info_data_cpp = (
    lambda config_hash, build_time, build_time_str, comment: original(
        config_hash, 1791763200, "2026-10-12 00:00:00 +0000", comment
    )
)
sys.argv = ["esphome", "compile", str(local), "--only-generate"]
assert main() == 0
project = root / ".esphome/build/home-assistant-voice"
managed = project / "managed_components"
managed.mkdir()
for name, archive in inputs["components"].items():
    target = managed / name
    target.mkdir()
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(target)
for name in inputs["vendor"]:
    matches = list((root / ".esphome/pinned-vendor").glob("*/" + name))
    assert len(matches) == 1, (name, matches)
    shutil.copytree(matches[0], project / "vendor" / name)
cmake = project / "CMakeLists.txt"
cmake.write_text(
    cmake.read_text().replace(
        "set(EXTRA_COMPONENT_DIRS ${CMAKE_SOURCE_DIR}/src)",
        "set(EXTRA_COMPONENT_DIRS ${CMAKE_SOURCE_DIR}/src ${CMAKE_SOURCE_DIR}/managed_components ${CMAKE_SOURCE_DIR}/vendor)",
    )
)
# YAML manifest paths are not consumed when the IDF registry manager is disabled.
# Explicit CMake requirements are supplied by offline-components.py during build.
for file in project.rglob("idf_component.yml"):
    text = file.read_text()
    text = re.sub(r"(?m)^.*(?:path:|override_path:).*$\n?", "", text)
    file.write_text(text)
# Snapshot authentication at connection creation, not just the global current
# key. A connection opened using the all-zero onboarding key must not gain
# credential-action rights when another client later provisions a real key.
api = project / "src/esphome/components/api"
header = api / "api_connection.h"
text = header.read_text()
marker = "class APIConnection"
start = text.index(marker)
position = text.index(" protected:", start)
text = (
    text[:position]
    + " protected:\n  bool voice_broker_authenticated_noise_{false};\n"
    + text[position + len(" protected:") :]
)
header.write_text(text)
implementation = api / "api_connection.cpp"
text = implementation.read_text()
marker = "APIConnection::APIConnection(std::unique_ptr<socket::Socket> sock, APIServer *parent) : parent_(parent) {"
assert text.count(marker) == 1
text = text.replace(
    marker,
    marker
    + "\n  this->voice_broker_authenticated_noise_ = parent->get_noise_ctx().has_psk();",
)
marker = (
    "void APIConnection::on_execute_service_request(const ExecuteServiceRequest &msg) {"
)
assert text.count(marker) == 1
text = text.replace(
    marker, marker + "\n  if (!this->voice_broker_authenticated_noise_) return;"
)
implementation.write_text(text)
main_cpp = (project / "src/main.cpp").read_text()
for forbidden in ("set_token(", "set_ssid(", "set_password(", "set_noise_psk("):
    assert forbidden not in main_cpp, forbidden
out = Path(inputs["output"])
out.mkdir()
for name in ("src", "managed_components", "vendor"):
    shutil.copytree(project / name, out / name)
for name in (
    "CMakeLists.txt",
    "sdkconfig.home-assistant-voice",
    "partitions.csv",
    "version.txt",
):
    shutil.copy(project / name, out / name)
for directory in out.rglob("__pycache__"):
    shutil.rmtree(directory)
