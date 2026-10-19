"""Compile every template and audit fixture types and ordered variable scope.

Uses the pinned HA environment, not a parallel Jinja implementation. Scope checks
are conservative for the action forms used here; unsupported dynamic action forms
must be reviewed before extending them. No services or integration setup run.
"""

import copy
import itertools
import json
import math
from collections import Counter
from collections.abc import Mapping
from pathlib import Path

from homeassistant.core import State
from homeassistant.exceptions import TemplateError
from homeassistant.helpers import device_registry, entity_registry
from homeassistant.helpers.template import (
    Template,
    TemplateEnvironment,
    is_template_string,
)
from homeassistant.util import dt as dt_util
from jinja2 import meta


def templates_in(value, path=()):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from templates_in(item, (*path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from templates_in(item, (*path, index))
    elif isinstance(value, str) and is_template_string(value):
        yield path, value


def audit_scope(hass, configuration):
    """Check every use, not just each unique template or declared dependencies."""
    env = TemplateEnvironment(hass, strict=True)
    audited = Counter()

    def check(value, available, path):
        for location, source in templates_in(value, path):
            audited[source] += 1
            names = meta.find_undeclared_variables(env.parse(source))
            missing = names - available
            if missing:
                raise ValueError(
                    f"{location}: variables used before binding: {sorted(missing)}"
                )

    def bindings(values, available, path):
        for name, value in values.items():
            check(value, available, (*path, name))
            available.add(name)

    def actions(sequence, available, path):
        available = set(available)
        for index, action in enumerate(sequence):
            location = (*path, index)
            # Branches get the current scope. A variable first bound in an
            # optional/parallel branch is not assumed to exist afterward.
            nested = {
                "variables",
                "if",
                "then",
                "else",
                "choose",
                "default",
                "parallel",
                "sequence",
            }
            check(
                {k: v for k, v in action.items() if k not in nested},
                available,
                location,
            )
            if "variables" in action:
                bindings(action["variables"], available, (*location, "variables"))
            if "if" in action:
                check(action["if"], available, (*location, "if"))
            for key in ["then", "else", "default", "parallel", "sequence"]:
                if key in action:
                    actions(action[key], available, (*location, key))
            for branch_index, branch in enumerate(action.get("choose", [])):
                check(
                    branch["conditions"],
                    available,
                    (*location, "choose", branch_index, "conditions"),
                )
                actions(
                    branch["sequence"],
                    available,
                    (*location, "choose", branch_index, "sequence"),
                )
            # Response variables are available only after their service call.
            if "response_variable" in action and "action" in action:
                available.add(action["response_variable"])
        return available

    for item in configuration["automation"]:
        available = {"trigger", "this", "context"}
        bindings(item.get("variables", {}), available, (item["alias"], "variables"))
        check(item.get("conditions", []), available, (item["alias"], "conditions"))
        check(item["triggers"], {"this"}, (item["alias"], "triggers"))
        actions(item["actions"], available, (item["alias"], "actions"))
    for name, item in configuration["script"].items():
        available = {"this", "context", *item.get("fields", {})}
        bindings(item.get("variables", {}), available, (name, "variables"))
        actions(item["sequence"], available, (name, "sequence"))
    # Sensor templates are rendered by HA with these documented input names.
    check(
        configuration.get("binary_sensor", []),
        {"value", "value_json", "this"},
        ("binary_sensor",),
    )
    check(
        configuration.get("command_line", []),
        {"value", "value_json", "this"},
        ("command_line",),
    )
    expected = Counter(source for _, source in templates_in(configuration))
    if audited != expected:
        raise ValueError("Template use outside the audited HA scopes")


def output_matches(kind, result):
    number = type(result) in (int, float) and math.isfinite(result)
    # HA's native result parser can convert numeric/boolean text to a scalar.
    # Text service fields use cv.string; mappings/lists/None are not text.
    return {
        "text": isinstance(result, (str, bool, int, float)),
        "nullable-text": result is None or isinstance(result, str),
        "boolean": type(result) is bool,
        "integer": type(result) is int,
        "number": number,
        "number-or-unknown": number or result == "unknown",
        "mapping": isinstance(result, Mapping),
        "list": isinstance(result, list),
    }[kind]


def checked_render(hass, contract, variables=None):
    result = Template(contract["source"], hass).async_render(variables, strict=True)
    assert output_matches(contract["output"], result), (
        contract["output"],
        type(result),
        result,
    )
    return result


def assert_rejected(callback, exceptions):
    try:
        callback()
    except exceptions:
        return
    raise AssertionError("negative fixture was accepted")


def validate_weather(hass, contracts):
    """Sentence tables cover threshold equality, branch priority and bad sensors."""
    unavailable = "Current weather information is unavailable."
    current = "It's 20 degrees and sunny."
    feels = "Feels like 15 degrees."
    precipitation = "There's precipitation right now."
    rain = "Rain is likely within the next few hours."
    warm = "It will warm up to about {} degrees in the next six hours."
    cool = "Expect it to cool down to around {} degrees in the next six hours."
    # Each axis declares its expected sentence independently. Warming takes
    # priority when both forecast extremes cross the three-degree threshold.
    axes = [
        [
            (20, current),
            ("20", current),
            (None, unavailable),
            ("unknown", unavailable),
            ("unavailable", unavailable),
            ("NaN", unavailable),
            ("inf", unavailable),
            ({}, unavailable),
            ([], unavailable),
            (True, current),
        ],
        [(0, ""), (2, ""), (2.01, feels), (5, feels)],
        [(0, ""), (0.1, precipitation)],
        [(False, ""), (True, rain)],
        [(20, ""), (23, ""), (23.01, warm.format(23)), (26, warm.format(26))],
        [(20, ""), (17, ""), (16.99, cool.format(17)), (14, cool.format(14))],
    ]
    count = 0
    for sensor, difference, precip, raining, high, low in itertools.product(*axes):
        hass.states.async_set(
            "weather.openweathermap", "sunny", {"temperature": sensor[0]}
        )
        values = {
            "now_temp": 20,
            "now_feels": 15,
            "now_cond": "sunny",
            "diff": difference[0],
            "now_precip": precip[0],
            "will_rain": raining[0],
            "max_t": high[0],
            "min_t": low[0],
        }
        expected = " ".join(
            filter(
                None,
                [
                    sensor[1],
                    difference[1],
                    precip[1],
                    raining[1],
                    high[1] or low[1],
                ],
            )
        )
        actual = checked_render(hass, contracts["weather_report"], values)
        assert actual == expected, (sensor[0], values, actual, expected)
        count += 1

    # Negative temperatures use the same signed three-degree boundaries.
    hass.states.async_set("weather.openweathermap", "snowy", {"temperature": -5})
    for high, low, ending in [
        (-2, -8, ""),
        (-2, -8.01, cool.format(-8)),
        (-1.99, -8, warm.format(-2)),
        (-1.99, -8.01, warm.format(-2)),
    ]:
        values = {
            "now_temp": -5,
            "now_feels": -10,
            "now_cond": "snowy",
            "now_precip": 0,
            "diff": 5,
            "will_rain": False,
            "max_t": high,
            "min_t": low,
        }
        expected = " ".join(
            filter(
                None,
                [
                    "It's -5 degrees and snowy.",
                    "Feels like -10 degrees.",
                    ending,
                ],
            )
        )
        actual = checked_render(hass, contracts["weather_report"], values)
        assert actual == expected, (values, actual, expected)
        count += 1
    return count


def validate_confirmation_prompt(hass, contracts):
    """Interpolated titles stay data; prompt requirements remain reviewable."""
    prompt = TemplateEnvironment(hass, strict=True).from_string(
        contracts["confirmation_prompt"]["source"]
    )
    count = 0
    for kind, (title, titled) in itertools.product(
        ["movie", "show", "unknown"],
        [
            ("The Matrix", "The Matrix"),
            ("Breaking Bad", "Breaking Bad"),
            ("Україна", "Україна"),
            ('quote " and slash \\', 'Quote " And Slash \\'),
            ("first\nsecond", "First\nSecond"),
            ("{{ syntax }} {% data %}", "{{ Syntax }} {% Data %}"),
        ],
    ):
        result = prompt.render(media_kind=kind, clean_title=title)
        for requirement in [
            f"successfully add a {kind} to their Plex library",
            f"confirm the {kind} was added",
            f'mention "{titled}" naturally',
            "be no more than 2 sentences",
            "avoid spoilers or summaries",
            "not imply that the media is already available or downloaded",
            "let the user know if you are not familiar with the media",
            "only include remarks specifically relevant to the chosen media",
        ]:
            assert requirement in result, (kind, title, requirement)
        assert result.endswith(
            f'Now generate a similar confirmation line for "{titled}".'
        ), (kind, title, result)
        count += 1
    return count


async def validate_templates(hass, config, contracts, literals):
    device_registry.async_setup(hass)
    await device_registry.async_load(hass, load_empty=True)
    await entity_registry.async_load(hass, load_empty=True)
    used = {source for _, source in templates_in(config)}
    registered = {item["source"] for item in contracts.values()}
    # This is the coverage inventory for current programs and their native
    # result types. A new/renamed program needs an explicit fixture here.
    output_groups = {
        "boolean": (
            "ac_ready chamber_was_off condition_change gpt_ready has_announcement movie_media "
            "ollama_online paused print_chronometer print_ok reject_media restore_chamber "
            "show_media unknown_media will_rain "
        ),
        "integer": "end_ts layer layers print_final_progress print_progress print_when progress",
        "list": "forecast next_hours",
        "mapping": "gpt_request slots",
        "nullable-text": "print_error",
        "number": "max_temp min_temp now_feels now_precip now_temp target_temperature temp_diff",
        "number-or-unknown": "fan_speed",
        "text": (
            "announcement battery_level battery_low battery_time_low city_power_off "
            "city_power_on classified_media classifier_prompt clean_title confirmation_prompt "
            "device_offline gpt_conversation gpt_speech hvac_mode media_confirmation "
            "media_kind message now_cond power_alarm print_answer print_color print_eta "
            "print_final_color print_final_icon print_final_status print_final_text "
            "print_finished print_percent print_prompt print_status print_verdict "
            "printer_errors provider_changed raw_title raw_type task title_case unsure_media "
            "weather_report "
        ),
    }
    expected_outputs = {
        name: output
        for output, names in output_groups.items()
        for name in names.split()
    }
    assert {
        name: item["output"] for name, item in contracts.items()
    } == expected_outputs
    assert all(set(item) == {"source", "output"} for item in contracts.values())
    assert used == registered, {
        "unchecked": sorted(used - registered),
        "unused": sorted(registered - used),
    }
    for name, contract in contracts.items():
        try:
            Template(contract["source"], hass).ensure_valid()
        except TemplateError as error:
            raise AssertionError(f"{name}: compile failed") from error
    audit_scope(hass, config)
    # Derive the program inventory and every use path from the evaluated tree.
    names = {item["source"]: name for name, item in contracts.items()}
    inventory = [
        {"program": names[source], "path": list(path)}
        for path, source in templates_in(config)
    ]
    Path("template-scope-inventory.json").write_text(
        json.dumps(inventory, indent=2) + "\n"
    )

    weather = "weather.openweathermap"
    forecast = {"temperature": 20, "condition": "sunny", "precipitation_probability": 0}
    states = {
        weather: ("sunny", {"temperature": 20}),
        "light.balcony_h2c_chamber_light": ("off", {}),
        "sensor.balcony_h2c_current_stage": ("printing", {}),
        "sensor.balcony_h2c_print_status": ("running", {}),
        "sensor.balcony_h2c_task_name": ("Fixture print", {}),
        "sensor.balcony_h2c_print_progress": ("25", {}),
        "sensor.balcony_h2c_current_layer": ("2", {}),
        "sensor.balcony_h2c_total_layer_count": ("8", {}),
        "sensor.balcony_h2c_end_time": ("2026-10-19T18:00:00+00:00", {}),
        "binary_sensor.balcony_h2c_hms_errors": (
            "on",
            {"0-Code": "fixture", "0-Error": "Check nozzle"},
        ),
        "binary_sensor.balcony_h2c_print_error": ("off", {}),
        "sensor.battery_charge": ("40", {}),
        "sensor.yasno_power": ("normal", {}),
        "sensor.yasno_next_power": ("unknown", {}),
        "sensor.multiplus_output_power_l1": ("120", {}),
        "sensor.internet_provider": ("Fixture ISP", {}),
        "climate.air_conditioner": ("cool", {"current_temperature": 25}),
    }
    prompt = 'Explain "quotes", \\slashes\\, \nnewlines, Україна, {{ literal }} and {% data %}.'
    context = {
        "announcement": "Printer error. Check nozzle",
        "chamber_light_was_off": True,
        "guess": {"data": "A fixture print."},
        "trigger": {
            "event": {"data": {"device_id": "fixture"}},
            "to_state": State(
                "sensor.fixture", "finish", {"friendly_name": "Fixture alarm"}
            ),
            "slots": {"movie_title": "The Matrix"},
        },
        "device_attr": lambda device, attr: "Fixture device",
        "end_ts": 1,
        "paused": False,
        "progress": 25,
        "layer": 2,
        "layers": 8,
        "task": "Fixture print",
        "ok": True,
        "wx": {weather: {"forecast": [forecast] * 6}},
        "fc": [forecast] * 6,
        "nxt": [forecast] * 6,
        "now_temp": 20,
        "now_feels": 20,
        "now_cond": "sunny",
        "now_precip": 0,
        "diff": 0,
        "max_t": 20,
        "min_t": 20,
        "will_rain": False,
        "cond_change": False,
        "message": "Fixture message",
        "slots": {"movie_title": "The Matrix"},
        "raw_title": "The Matrix",
        "raw_type": "movie",
        "media_kind": "movie",
        "clean_title": "The Matrix",
        "llm_kind": {"response": {"speech": {"plain": {"speech": "show"}}}},
        "witty_remark": {"data": "Added the fixture."},
        "verdict": {"data": "Healthy print.", "answer": "Healthy print."},
        "value_json": {"models": [{"name": "qwen3.5:9b-q8_0"}]},
        "value": "25 60.0",
        "prompt": prompt,
        "gpt_response": {
            "conversation_id": "fixture-thread",
            "response": {"speech": {"plain": {"speech": "Expert fixture."}}},
        },
        "eta": "18:00",
        "print_error": None,
        "target_temperature": 22,
    }
    exact = {
        "announcement": "Printer error. Check nozzle",
        "has_announcement": True,
        "printer_errors": "Printer error. Check nozzle",
        "restore_chamber": True,
        "print_finished": "Print finished. A fixture print.",
        "chamber_was_off": True,
        "device_offline": "Fixture device is offline",
        "print_chronometer": True,
        "print_percent": "25%",
        "print_color": "#00AE42",
        "print_progress": 25,
        "print_when": 1,
        "print_status": "Fixture print · printing · layer 2/8",
        "print_ok": True,
        "print_final_text": "Done",
        "print_final_icon": "mdi:check-circle",
        "print_final_color": "#00AE42",
        "print_final_progress": 100,
        "print_final_status": "Fixture print · Finished",
        "end_ts": 1792432800,
        "layer": 2,
        "layers": 8,
        "paused": False,
        "progress": 25,
        "task": "Fixture print",
        "message": "Fixture message",
        "battery_low": "Warning: The battery level is - 40  percent...",
        "battery_time_low": "Warning: Less than one hour of battery power remaining. Battery is at 40 percent.",
        "city_power_on": "Power is back on. Battery is at 40 percent.",
        "forecast": [forecast] * 6,
        "now_temp": 20,
        "now_feels": 20,
        "now_cond": "sunny",
        "now_precip": 0,
        "temp_diff": 0,
        "next_hours": [forecast] * 6,
        "max_temp": 20,
        "min_temp": 20,
        "will_rain": False,
        "condition_change": False,
        "provider_changed": "Internet provider changed to Fixture ISP",
        "slots": {"movie_title": "The Matrix"},
        "raw_title": "The Matrix",
        "raw_type": "movie",
        "media_kind": "movie",
        "clean_title": "The Matrix",
        "reject_media": False,
        "unknown_media": False,
        "classified_media": "show",
        "movie_media": True,
        "title_case": "The Matrix",
        "show_media": False,
        "media_confirmation": "Added the fixture.",
        "battery_level": "Battery is at 40 percent.",
        "power_alarm": "Attention - alarm triggered: Fixture alarm",
        "print_answer": "Healthy print.",
        "ollama_online": True,
        "fan_speed": 25,
        "gpt_request": {"text": prompt, "agent_id": "conversation.chatgpt_expert"},
        "gpt_conversation": "fixture-thread",
        "gpt_speech": "Expert fixture.",
        "print_verdict": "Healthy print.",
        "print_eta": "18:00",
        "print_error": None,
        "target_temperature": 22,
        "hvac_mode": "cool",
        "ac_ready": True,
        "gpt_ready": True,
    }
    contains = {
        "city_power_off": [
            "This is not a scheduled outage.",
            "Battery is at 40 percent.",
        ],
        "weather_report": ["20", "sunny"],
        "classifier_prompt": ["The Matrix", '"movie"'],
        "unsure_media": ["The Matrix", "not sure"],
        "confirmation_prompt": ["The Matrix", "movie"],
        "print_prompt": ["Fixture print", "18:00", "25 percent"],
    }
    assert set(exact) | set(contains) == set(contracts)
    counts = dict.fromkeys(contracts, 0)

    def render(name, values=None):
        contract = contracts[name]
        result = checked_render(hass, contract, context if values is None else values)
        counts[name] += 1
        return result

    def set_states(mode=None):
        for entity, (state, attributes) in states.items():
            if mode == "missing":
                hass.states.async_remove(entity)
            else:
                hass.states.async_set(entity, mode or state, {} if mode else attributes)

    set_states()
    for value in [None, "unknown", "unavailable", "NaN", "inf", {}, []]:
        hass.states.async_set(
            weather,
            "unknown",
            {
                "temperature": value,
                "apparent_temperature": value,
                "precipitation": value,
            },
        )
        for name in ["now_temp", "now_feels", "now_precip"]:
            render(name)
    set_states()
    # UTC makes date-format expectations reproducible, including print ETA.
    dt_util.set_default_time_zone(dt_util.UTC)
    for name, expected in exact.items():
        assert render(name) == expected, (name, render(name), expected)
    for name, fragments in contains.items():
        result = render(name)
        assert all(fragment in result for fragment in fragments), (name, result)

    # Check both sides of notification branches and the scheduled-outage ETA.
    failed = {**context, "ok": False, "paused": True, "layers": 0}
    for name, expected in {
        "print_chronometer": False,
        "print_color": "#FFB300",
        "print_status": "Fixture print · Paused",
        "print_final_text": "Failed",
        "print_final_icon": "mdi:alert-circle",
        "print_final_color": "#E53935",
        "print_final_progress": 25,
        "print_final_status": "Fixture print · Failed",
    }.items():
        assert render(name, failed) == expected
    hass.states.async_set("sensor.yasno_power", "outage")
    fixed_now = dt_util.parse_datetime("2026-10-19T17:00:00+00:00")
    for restoration, expected in [
        ("2026-10-19T17:30:00+00:00", "less than an hour"),
        ("2026-10-19T18:00:00+00:00", "about 1 hour."),
        ("2026-10-19T20:00:00+00:00", "about 3 hours."),
        ("2026-10-19T16:00:00+00:00", "No information about how long"),
        ("unavailable", "No information about how long"),
    ]:
        hass.states.async_set("sensor.yasno_next_power", restoration)
        result = render("city_power_off", {**context, "now": lambda: fixed_now})
        assert "This is a scheduled outage." in result and expected in result
    set_states()

    # All programs render under absent, unknown and unavailable entity states.
    for mode in ["missing", "unknown", "unavailable"]:
        set_states(mode)
        for name in contracts:
            render(name)
        assert render("ac_ready") is False
        assert render("hvac_mode") == "off"
        assert render("chamber_was_off") is False
        assert render("ollama_online", {**context, "value_json": {}}) is False
        assert "unavailable" in render("weather_report")
        assert "unknown" in render("battery_low")
    set_states()

    # Missing and malformed provider responses never become a positive result.
    for response in [
        None,
        {},
        {"response": None},
        {"response": {"speech": {}}},
        42,
        "unavailable",
        {
            "data": {},
            "answer": [],
            "conversation_id": 42,
            "response": {"speech": {"plain": {"speech": []}}},
        },
    ]:
        values = {
            **context,
            "llm_kind": response,
            "gpt_response": response,
            "verdict": response,
            "guess": response,
            "witty_remark": response,
            "wx": response,
            "value_json": response,
        }
        assert render("classified_media", values) == "unknown"
        assert render("forecast", values) == []
        assert render("ollama_online", values) is False
        for name in [
            "gpt_conversation",
            "gpt_speech",
            "print_verdict",
            "print_answer",
            "print_finished",
            "media_confirmation",
        ]:
            render(name, values)
    for value in ["", "unavailable", "garbage", "NaN 60", "inf 60", "-1 60", "101 60"]:
        assert render("fan_speed", {**context, "value": value}) == "unknown"
    for target in [None, "22", True, 15, 32, float("nan"), float("inf")]:
        assert render("ac_ready", {**context, "target_temperature": target}) is False
    assert (
        render(
            "ac_ready", {k: v for k, v in context.items() if k != "target_temperature"}
        )
        is False
    )
    for fc in [
        [],
        [None, {}, {"temperature": "unavailable", "precipitation_probability": None}],
        [{"temperature": "19", "precipitation_probability": "80"}],
    ]:
        values = {**context, "nxt": fc}
        for name in ["max_temp", "min_temp", "will_rain", "condition_change"]:
            render(name, values)
    for kind in ["movie", "show", "unknown", "MOVIE.", "", None]:
        values = {
            **context,
            "llm_kind": {"response": {"speech": {"plain": {"speech": kind}}}},
        }
        assert render("classified_media", values) == (
            kind if kind in ["movie", "show"] else "unknown"
        )
    for extra in [{}, {"conversation_id": "fixture-thread"}]:
        assert render("gpt_request", {**context, **extra}) == {
            "text": prompt,
            "agent_id": "conversation.chatgpt_expert",
            **extra,
        }
    assert render("gpt_ready", {**context, "conversation_id": None}) is True
    assert render("gpt_request", {**context, "conversation_id": None}) == {
        "text": prompt,
        "agent_id": "conversation.chatgpt_expert",
    }
    for prompt_value in [None, "", "   ", 42, {}, []]:
        assert render("gpt_ready", {**context, "prompt": prompt_value}) is False
    assert (
        render("gpt_ready", {k: v for k, v in context.items() if k != "prompt"})
        is False
    )
    assert render("gpt_ready", {**context, "conversation_id": {}}) is False
    for trigger in [{}, None, {"to_state": None}]:
        assert render("print_ok", {**context, "trigger": trigger}) is False
        assert (
            render("device_offline", {**context, "trigger": trigger})
            == "Zigbee device is offline"
        )

    # Round trips exercise the same Nix constructor used for every interpolation.
    for fixture in literals:
        assert (
            Template(fixture["source"], hass).async_render(strict=True)
            == fixture["expected"]
        )
    assert_rejected(lambda: Template("{{ broken", hass).ensure_valid(), TemplateError)
    assert_rejected(
        lambda: Template("{{ missing_name }}", hass).async_render(strict=True),
        TemplateError,
    )
    assert_rejected(
        lambda: Template("{{ 'unsafe'quote' }}", hass).ensure_valid(), TemplateError
    )
    assert not output_matches("boolean", "false") and not output_matches("number", True)
    assert_rejected(
        lambda: checked_render(hass, {"output": "boolean", "source": "{{ 'false' }}"}),
        AssertionError,
    )
    assert_rejected(
        lambda: checked_render(hass, {"output": "number", "source": "{{ true }}"}),
        AssertionError,
    )
    bad = copy.deepcopy(config)
    weather_actions = next(
        a for a in bad["automation"] if a["alias"] == "System / Weather report"
    )["actions"]
    weather_actions[2], weather_actions[3] = weather_actions[3], weather_actions[2]
    assert_rejected(lambda: audit_scope(hass, bad), ValueError)
    bad = copy.deepcopy(config)
    media = next(
        a for a in bad["automation"] if a["alias"] == "Voice / Add media using Assist"
    )["actions"]
    media[0], media[1] = media[1], media[0]
    assert_rejected(lambda: audit_scope(hass, bad), ValueError)
    # Nix sorts mapping keys. Merging ordered actions into one map must fail.
    bad = copy.deepcopy(config)
    media = next(
        a for a in bad["automation"] if a["alias"] == "Voice / Add media using Assist"
    )["actions"]
    merged = {k: v for action in media[:5] for k, v in action["variables"].items()}
    media[:5] = [{"variables": dict(sorted(merged.items()))}]
    assert_rejected(lambda: audit_scope(hass, bad), ValueError)
    # Classification binds its response before use, and an
    # optional branch's new response name must not leak to later actions.
    bad = copy.deepcopy(config)
    media = next(
        a for a in bad["automation"] if a["alias"] == "Voice / Add media using Assist"
    )["actions"]
    classifier = next(
        a for a in media if a.get("alias") == "Classify media kind via LLM if necessary"
    )["then"]
    classifier.reverse()
    assert_rejected(lambda: audit_scope(hass, bad), ValueError)
    bad = copy.deepcopy(config)
    media = next(
        a for a in bad["automation"] if a["alias"] == "Voice / Add media using Assist"
    )["actions"]
    media.append(
        {"variables": {"leaked_kind": contracts["classified_media"]["source"]}}
    )
    assert_rejected(lambda: audit_scope(hass, bad), ValueError)
    weather_count = validate_weather(hass, contracts)
    prompt_count = validate_confirmation_prompt(hass, contracts)
    # Restore a clean state fixture set for the separate behavioral tests.
    for entity in list(hass.states.async_entity_ids()):
        hass.states.async_remove(entity)
    print(
        f"Template QA passed: {len(contracts)} programs, {sum(counts.values())} strict typed renders, {len(literals)} strict literal round trips, {len(list(templates_in(config)))} audited uses, scope/quoting/undefined/order negatives."
    )
    print(
        f"Weather/prompt contracts passed: {weather_count} weather cases / {weather_count} strict typed renders; {prompt_count} raw prompt renders."
    )
