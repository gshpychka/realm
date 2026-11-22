"""`voice-broker-ha-setup`: the broker's home-only agent and pipeline in Home Assistant.

Home Assistant's configuration lives in Home Assistant, outside this flake, so
this creates it through Home Assistant's own supported APIs (home-assistant/core
2026.10.1):
- An OpenAI conversation agent: a `conversation` subentry of the
  openai_conversation entry, made by its subentry flow
  (openai_conversation/config_flow.py async_step_init, "recommended" settings).
  It has the Assist API, a home-only prompt, and no web search or code
  interpreter, which are off in the recommended settings.
- An Assist pipeline (`assist_pipeline/pipeline/create`) with the source
  pipeline's speech recognition and languages, unchanged, that agent, and no
  TTS: GPT-Live speaks.

It creates the home-only configuration and enables its integration-disabled
conversation entity. User-disabled entities and existing configuration differences
require operator resolution. The preferred pipeline and every other agent,
pipeline and exposure stay as they are. It writes a backup before applying changes.
The token is read from stdin and never printed.

    sudo cat /run/secrets/voice-broker/home-assistant-token |
      voice-broker-ha-setup --url http://homeassistant.<domain>:8123 \\
        --backup-dir <private dir> [--apply]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.request
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Self

from websockets.asyncio.client import connect

# The names the Nix config uses: my.voice-broker.homeAssistant.pipeline on hoard.
DEFAULT_NAME = "Voice broker home"
# "Remote", whose speech recognition (stt.groq, English) the new pipeline keeps.
DEFAULT_SOURCE_PIPELINE = "01jmq3hbakt5r0e136vd886hy9"
OPENAI_DOMAIN = "openai_conversation"
# Home Assistant adds a new agent's conversation entity when it reloads the
# entry, after the subentry flow has returned: on 2026-10-17 the state read
# right after the flow had the subentry but not yet its entity.
AGENT_ENTITY_WAIT_S = 30.0

# The agent's prompt. Abstaining needs no wording the broker reads: the broker
# takes ownership from tool calls alone (assist.py), so this prompt only keeps
# the agent from doing or saying non-home work, which the voice's agent does.
HOME_PROMPT = """You control and report on this home only, through your tools.
Handle only requests about the home: its devices, sensors, scenes, scripts that control it, and their state.
For anything else, such as general knowledge, weather forecasts, news, the time or date, calendars, messages, \
reminders or small talk, call no tool and reply only: Not a home request. Never ask a question about such a request.
Never use a script to answer a question that is not about the home.
When a request mixes the home with anything else, do only the home part and mention only that.
When it is unclear which device is meant, ask one short question.
The brightness of lights is 0 to 100, where 0 is off.
Reply in one short plain sentence, without lists or markup, and spell out units."""


class SetupError(Exception):
    """Home Assistant is not in a state this tool may change."""


@dataclass(frozen=True, slots=True)
class State:
    """What the tool reads from Home Assistant."""

    pipelines: list[dict[str, Any]]
    preferred_pipeline: str | None
    # openai_conversation entries: (entry_id, [subentry dicts])
    openai_entries: list[tuple[str, list[dict[str, Any]]]]
    # conversation entity_id by config_subentry_id
    agents_by_subentry: dict[str, str]


@dataclass(frozen=True, slots=True)
class Plan:
    entry_id: str
    # None: the agent exists.
    create_agent: bool
    agent_entity: str | None
    # The pipeline to create, without its conversation engine when the agent is still to be made; None: it exists.
    pipeline: dict[str, Any] | None


def plan(state: State, name: str, source_pipeline: str, *, entity_pending: bool = False) -> Plan:
    """What to create, from what exists; raises SetupError on anything it must not touch.

    entity_pending: the agent was just created, so its conversation entity may not exist yet.
    """
    if len(state.openai_entries) != 1:
        raise SetupError(f"expected one {OPENAI_DOMAIN} entry, found {len(state.openai_entries)}")
    entry_id, subentries = state.openai_entries[0]
    agents = [s for s in subentries if s.get("subentry_type") == "conversation" and s.get("title") == name]
    if len(agents) > 1:
        raise SetupError(f"{len(agents)} agents named {name!r}")
    agent_entity = state.agents_by_subentry.get(agents[0]["subentry_id"]) if agents else None
    if agents and agent_entity is None and not entity_pending:
        raise SetupError(f"agent {name!r} has no conversation entity")

    existing = [p for p in state.pipelines if p.get("name") == name]
    if len(existing) > 1:
        raise SetupError(f"{len(existing)} pipelines named {name!r}")
    sources = [p for p in state.pipelines if p.get("id") == source_pipeline]
    if not sources:
        raise SetupError(f"source pipeline {source_pipeline} not found")
    source = sources[0]
    wanted = {
        "name": name,
        "language": source["language"],
        "stt_engine": source["stt_engine"],
        "stt_language": source["stt_language"],
        "conversation_language": source["conversation_language"],
        "prefer_local_intents": bool(source.get("prefer_local_intents")),
        "tts_engine": None,
        "tts_language": None,
        "tts_voice": None,
        "wake_word_entity": None,
        "wake_word_id": None,
    }
    if existing:
        pipeline = existing[0]
        differences = sorted(
            key
            for key, value in {**wanted, "conversation_engine": agent_entity}.items()
            if key not in ("tts_language", "tts_voice", "wake_word_id")
            and pipeline.get(key) != value
            # Compared once the agent just created has its entity, on a later read.
            and not (key == "conversation_engine" and entity_pending and agent_entity is None)
        )
        if differences:
            raise SetupError(f"pipeline {name!r} exists with different {', '.join(differences)}; left as it is")
        return Plan(entry_id, not agents, agent_entity, None)
    return Plan(entry_id, not agents, agent_entity, wanted)


async def wait_for_agent(
    read: Callable[[], Awaitable[State]],
    name: str,
    source_pipeline: str,
    timeout_s: float = AGENT_ENTITY_WAIT_S,
    interval_s: float = 0.5,
) -> Plan:
    """The plan once the agent just created has its conversation entity; SetupError after timeout_s."""
    deadline = time.monotonic() + timeout_s
    while True:
        steps = plan(await read(), name, source_pipeline, entity_pending=True)
        if steps.create_agent:
            raise SetupError(f"agent {name!r} is missing after it was created")
        if steps.agent_entity is not None:
            return steps
        if time.monotonic() >= deadline:
            raise SetupError(f"agent {name!r} has no conversation entity after {timeout_s:.0f} s")
        await asyncio.sleep(interval_s)


class _HomeAssistant:
    def __init__(self, url: str, token: str) -> None:
        self._url = url.rstrip("/")
        self._token = token
        self._ws: Any = None
        self._id = 0

    async def __aenter__(self) -> Self:
        ws_url = self._url.replace("https://", "wss://").replace("http://", "ws://") + "/api/websocket"
        self._ws = await connect(ws_url, max_size=2**25)
        if json.loads(await self._ws.recv()).get("type") != "auth_required":
            raise SetupError("no auth_required")
        await self._ws.send(json.dumps({"type": "auth", "access_token": self._token}))
        if json.loads(await self._ws.recv()).get("type") != "auth_ok":
            raise SetupError("authentication refused")
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._ws.close()

    async def call(self, type_: str, **fields: Any) -> Any:
        self._id += 1
        await self._ws.send(json.dumps({"id": self._id, "type": type_, **fields}))
        while True:
            message = json.loads(await self._ws.recv())
            if message.get("id") == self._id:
                if not message.get("success"):
                    raise SetupError(f"{type_} failed: {(message.get('error') or {}).get('code')}")
                return message.get("result")

    def rest(self, method: str, path: str, body: Any = None) -> Any:
        request = urllib.request.Request(
            self._url + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
        return json.loads(raw) if raw else None

    async def state(self) -> State:
        pipelines = await self.call("assist_pipeline/pipeline/list")
        entries = [e for e in await self.call("config_entries/get") if e.get("domain") == OPENAI_DOMAIN]
        openai = [
            (e["entry_id"], await self.call("config_entries/subentries/list", entry_id=e["entry_id"])) for e in entries
        ]
        registry = await self.call("config/entity_registry/list")
        agents = {
            r["config_subentry_id"]: r["entity_id"]
            for r in registry
            if r.get("config_subentry_id") and r["entity_id"].startswith("conversation.")
        }
        return State(pipelines["pipelines"], pipelines.get("preferred_pipeline"), openai, agents)

    async def agent_entity(self, entity_id: str) -> dict[str, Any] | None:
        """The home-only conversation entity's registry record."""
        registry = await self.call("config/entity_registry/list")
        return next((row for row in registry if row["entity_id"] == entity_id), None)

    async def ensure_agent_available(self, entry_id: str, entity_id: str) -> None:
        """The home-only agent is enabled and registered for conversation requests."""
        entity = await self.agent_entity(entity_id)
        if entity is None or entity.get("config_entry_id") != entry_id:
            raise SetupError(f"agent {entity_id} has no matching entity registry entry")
        if entity.get("disabled_by") not in (None, "integration"):
            raise SetupError(f"agent {entity_id} is disabled by {entity['disabled_by']}; left as it is")
        if entity.get("disabled_by") == "integration":
            await self.call("config/entity_registry/update", entity_id=entity_id, disabled_by=None)
        agents = await self.call("conversation/agent/list")
        if not any(agent["id"] == entity_id for agent in agents["agents"]):
            self.rest("POST", "/api/services/homeassistant/reload_config_entry", {"entry_id": entry_id})
            agents = await self.call("conversation/agent/list")
            if not any(agent["id"] == entity_id for agent in agents["agents"]):
                raise SetupError(f"agent {entity_id} is not registered after reloading its integration")

    def create_agent(self, entry_id: str, name: str) -> None:
        flow = self.rest(
            "POST",
            "/api/config/config_entries/subentries/flow",
            {"handler": [entry_id, "conversation"], "source": "user"},
        )
        if flow.get("type") != "form" or flow.get("step_id") != "init":
            self._abort(flow)
            raise SetupError(f"agent flow opened at {flow.get('type')}/{flow.get('step_id')}, not the init form")
        result = self.rest(
            "POST",
            f"/api/config/config_entries/subentries/flow/{flow['flow_id']}",
            {"name": name, "prompt": HOME_PROMPT, "llm_hass_api": ["assist"], "recommended": True},
        )
        if result.get("type") != "create_entry":
            self._abort(result)
            raise SetupError(f"agent flow ended {result.get('type')}: {result.get('errors') or result.get('reason')}")

    def _abort(self, flow: dict[str, Any]) -> None:
        if flow.get("flow_id") and flow.get("type") == "form":
            self.rest("DELETE", f"/api/config/config_entries/subentries/flow/{flow['flow_id']}")


def _backup(directory: Path, state: State, agent_entity: dict[str, Any] | None) -> Path:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # microseconds: a dry run right after --apply, within the same second, must not collide
    path = directory / f"ha-voice-setup-before-{datetime.now().astimezone().strftime('%Y%m%dT%H%M%S.%f')}.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(
            {
                "pipelines": state.pipelines,
                "preferred_pipeline": state.preferred_pipeline,
                "openai_entries": state.openai_entries,
                "agents_by_subentry": state.agents_by_subentry,
                "agent_entity": agent_entity,
            },
            f,
            indent=1,
        )
    return path


async def _run(args: argparse.Namespace, token: str) -> None:
    async with _HomeAssistant(args.url, token) as ha:
        before = await ha.state()
        steps = plan(before, args.name, args.source_pipeline)
        entity = await ha.agent_entity(steps.agent_entity) if steps.agent_entity else None
        print(f"backup: {_backup(args.backup_dir, before, entity)}")
        print(f"agent {args.name!r}: {'create' if steps.create_agent else f'exists as {steps.agent_entity}'}")
        print(f"pipeline {args.name!r}: {'create' if steps.pipeline else 'exists, matching'}")
        if steps.pipeline:
            print(f"  {json.dumps(steps.pipeline)}")
        if entity:
            print(f"agent entity disabled_by: {entity.get('disabled_by')}")
        if not args.apply:
            print("dry run: --apply creates missing configuration, enables an integration-disabled home agent,")
            print(
                "and reloads its OpenAI integration if the agent is not registered; user-disabled entities stay unchanged"
            )
            return
        if steps.create_agent:
            ha.create_agent(steps.entry_id, args.name)
        steps = await wait_for_agent(ha.state, args.name, args.source_pipeline)
        if steps.agent_entity is None:
            raise SetupError("the home-only agent has no conversation entity")
        await ha.ensure_agent_available(steps.entry_id, steps.agent_entity)
        if steps.pipeline is not None:
            created = await ha.call(
                "assist_pipeline/pipeline/create", **steps.pipeline, conversation_engine=steps.agent_entity
            )
            print(f"created pipeline {created.get('id')}")
        final = await ha.state()
        if plan(final, args.name, args.source_pipeline).pipeline is not None:
            raise SetupError("the pipeline is still missing")
        if final.preferred_pipeline != before.preferred_pipeline:
            raise SetupError("the preferred pipeline changed")
        print(f"done: {args.name!r} uses {steps.agent_entity}; preferred pipeline unchanged")


def main() -> None:
    parser = argparse.ArgumentParser(prog="voice-broker-ha-setup", description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", required=True, help="Home Assistant's base URL")
    parser.add_argument("--backup-dir", type=Path, required=True, help="private directory for the backup")
    parser.add_argument("--name", default=DEFAULT_NAME, help="name of the agent and of the pipeline")
    parser.add_argument("--source-pipeline", default=DEFAULT_SOURCE_PIPELINE, help="pipeline whose STT is kept")
    parser.add_argument("--apply", action="store_true", help="create what is missing; without it, only report")
    args = parser.parse_args()
    token = sys.stdin.read().strip()
    try:
        asyncio.run(_run(args, token))
    except SetupError as e:
        print(f"stopped, nothing more changed: {e}", file=sys.stderr)
        sys.exit(1)
