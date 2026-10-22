"""Exercise public declarations with HA's template and state-trigger engines.

Templates use in-memory fixture states; state triggers invoke recording callbacks.
"""

from pathlib import Path

from homeassistant.components.homeassistant.triggers import state as state_trigger
from homeassistant.core import callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.template import Template


async def validate_behavior(hass, config):
    automations = {item["alias"]: item for item in config["automation"]}
    assert automations and len(automations) == len(config["automation"])
    assert all(" / " in alias for alias in automations)
    ids = [item["id"] for item in config["automation"]]
    assert all(isinstance(identity, str) and identity for identity in ids)
    assert len(ids) == len(set(ids))

    def automation(alias):
        return automations[alias]

    async def variables(actions, context):
        for action in actions:
            if "variables" in action:
                bindings = await cv.async_validate(
                    hass, cv.SCRIPT_VARIABLES_SCHEMA, action["variables"]
                )
                # Action variables replace previous values, as Script does.
                context.update(bindings.async_simple_render(context))
        return context

    def render(text, context):
        return Template(text, hass).async_render(context)

    errors = automation("Devices / Print error notification")
    ignored = "HMS_0701_2500_0002_0001"
    for hms, error, expected in [
        (
            {
                "0-Code": ignored,
                "0-Error": "ignored",
                "1-Code": "fixture",
                "1-Error": "Check nozzle",
            },
            {"code": "fixture", "error": "Fallback"},
            "Printer error. Check nozzle",
        ),
        (
            {"0-Code": ignored, "0-Error": "ignored"},
            {"code": ignored, "error": "ignored"},
            "",
        ),
        (
            {},
            {"code": "fixture", "error": "Check extrusion"},
            "Printer error. Check extrusion",
        ),
    ]:
        hass.states.async_set("binary_sensor.balcony_h2c_hms_errors", "on", hms)
        hass.states.async_set("binary_sensor.balcony_h2c_print_error", "on", error)
        values = await variables([{"variables": errors["variables"]}], {})
        assert values["announcement"] == expected

    offline = automation("Devices / Zigbee device offline notification")["actions"][0][
        "data"
    ]["message"]
    for user_name, expected in [
        ("Kitchen valve", "Kitchen valve is offline"),
        (None, "Fixture valve is offline"),
    ]:
        assert (
            render(
                offline,
                {
                    "trigger": {"event": {"data": {"device_id": "fixture"}}},
                    "device_attr": lambda device, attr, user_name=user_name: (
                        user_name if attr == "name_by_user" else "Fixture valve"
                    ),
                },
            )
            == expected
        )

    # Variable dependencies must survive Nix's sorted maps and YAML rendering.
    hass.states.async_set("weather.openweathermap", "sunny", {"temperature": 20})
    forecast = {"temperature": 20, "condition": "sunny", "precipitation_probability": 0}
    weather = automation("System / Weather report")["actions"]
    values = await variables(
        weather, {"wx": {"weather.openweathermap": {"forecast": [forecast] * 6}}}
    )
    assert "20" in values["message"] and "rain" not in values["message"].lower()
    wet = {**forecast, "precipitation_probability": 80, "temperature": 25}
    values = await variables(
        weather, {"wx": {"weather.openweathermap": {"forecast": [wet] * 6}}}
    )
    assert "Rain is likely" in values["message"] and "warm up" in values["message"]
    for state in [None, "unknown", "unavailable"]:
        if state is None:
            hass.states.async_remove("weather.openweathermap")
        else:
            hass.states.async_set("weather.openweathermap", state)
        values = await variables(weather, {"wx": {}})
        assert values["fc"] == [] and values["nxt"] == []
        assert "unavailable" in values["message"]
        assert "0 degrees" not in values["message"]

    media = automation("Voice / Add media using Assist")["actions"]
    for slots, title, kind in [
        (
            {"movie_title": "The Matrix to my Plex library please"},
            "The Matrix",
            "movie",
        ),
        ({"show_title": "Severance"}, "Severance", "show"),
        ({"title": "movie Arrival"}, "Arrival", "movie"),
        ({"title": "milk to my shopping list"}, "milk to my shopping list", "unknown"),
    ]:
        values = await variables(media[:5], {"trigger": {"slots": slots}})
        assert values["clean_title"] == title and values["media_kind"] == kind
    rejection = next(
        action
        for action in media
        if action.get("alias") == "Stop if this is not a movie or show"
    )["if"][0]["value_template"]
    assert render(rejection, {"raw_title": "milk to my shopping list"}) is True
    assert render(rejection, {"raw_title": "The Matrix"}) is False

    # Native mappings preserve arbitrary prompt text and optional continuation.
    request = next(
        action["data"]
        for action in config["script"]["ask_gpt"]["sequence"]
        if action.get("action") == "conversation.process"
    )
    prompt = 'Explain "quotes", a backslash \\ and a newline\nwithout changing them.'
    for extra in [{}, {"conversation_id": "fixture-thread"}]:
        result = render(request, {"prompt": prompt, **extra})
        assert result == {
            "text": prompt,
            "agent_id": "conversation.chatgpt_expert",
            **extra,
        }
    for script in ["ask_gpt", "set_air_conditioner_temperature"]:
        gate = config["script"][script]["sequence"][0]
        assert gate["condition"] == "template"
        assert render(gate["value_template"], {}) is False

    # The movie offer is armed after speech, and both light toggles yield to it.
    offer = automation("Media / Ask to activate Movie scene")
    assert [a["action"] for a in offer["actions"]] == [
        "timer.start",
        "assist_satellite.announce",
        "timer.start",
    ]
    assert offer["actions"][0]["target"]["entity_id"] == "timer.movie_scene_cooldown"
    assert (
        offer["actions"][2]["target"]["entity_id"] == "timer.movie_scene_offer_window"
    )
    for alias, state in [
        ("Lighting / Cute lights toggle", "idle"),
        ("Lighting / Lava lamp toggle", "idle"),
        ("Media / Activate Movie scene on Table button Long press", "active"),
    ]:
        assert automation(alias)["conditions"] == [
            {
                "condition": "state",
                "entity_id": "timer.movie_scene_offer_window",
                "state": state,
            }
        ]
    assert config["timer"]["movie_scene_offer_window"]["duration"] == "0:00:10"
    assert config["timer"]["movie_scene_cooldown"]["duration"] == "3:00:00"
    assert all(timer["restore"] for timer in config["timer"].values())

    # Omitting initial_state lets HA restore an operator's enabled-state choices.
    for item in config["automation"]:
        assert "initial_state" not in item
        assert len(item["triggers"]) == len({str(t) for t in item["triggers"]})
    loaded = automation("System / Enable fully loaded after startup")["actions"]
    assert (
        loaded[0]["target"]["entity_id"] == "input_boolean.homeassistant_fully_loaded"
    )
    assert loaded[2]["target"] == loaded[0]["target"]
    assert loaded[1]["delay"] == {"minutes": 5}
    assert "homeassistant_fully_loaded" in config["input_boolean"]

    # Snapshot paths are writable native media paths; restoration precedes AI.
    for item, actions in [
        (config["script"]["check_print"], config["script"]["check_print"]["sequence"]),
        (
            automation("Devices / Print finished notification"),
            automation("Devices / Print finished notification")["actions"],
        ),
    ]:
        assert "chamber_light_was_off" in item["variables"]
        assert actions[0]["then"][0]["action"] == "light.turn_on"
        assert actions[1]["action"] == "camera.snapshot"
        snapshot = Path(actions[1]["data"]["filename"])
        assert snapshot.parent == Path(config["homeassistant"]["media_dirs"]["local"])
        assert actions[2]["then"][0]["action"] == "light.turn_off"
        assert render(actions[2]["if"][0], {"chamber_light_was_off": False}) is False
        assert render(actions[2]["if"][0], {"chamber_light_was_off": True}) is True
        assert actions[3]["action"] == "ai_task.generate_data"
        attachment = actions[3]["data"]["attachments"][0]["media_content_id"]
        assert attachment == "media-source://media_source/local/" + snapshot.name

    battery = automation("Power / Low battery")
    assert [(t["below"], t["for"]) for t in battery["triggers"]] == [
        (n, {"seconds": 10}) for n in [31, 21, 11, 6]
    ]
    leak = automation("Devices / Water leak detected")
    assert [(a["action"], a["target"]["entity_id"]) for a in leak["actions"][:2]] == [
        ("switch.turn_off", "switch.hot_water_valve"),
        ("switch.turn_off", "switch.cold_water_valve"),
    ]

    # Trigger IDs select branches; they are distinct from an automation's ID.
    live = automation("Devices / 3D print Live Activity")
    assert [trigger["id"] for trigger in live["triggers"]] == [
        "update",
        "update",
        "update",
        "end",
    ]
    assert live["triggers"][0]["to"] == ["prepare", "running", "pause"]
    assert live["triggers"][3]["to"] == ["finish", "failed"]
    assert [branch["conditions"] for branch in live["actions"][0]["choose"]] == [
        [{"condition": "trigger", "id": "update"}],
        [{"condition": "trigger", "id": "end"}],
    ]
    assert live["conditions"][0]["conditions"][0] == {
        "condition": "trigger",
        "id": "end",
    }

    # Exercise entity state triggers, including startup/unavailable edges and
    # attribute-only changes, through a local recording callback.
    for alias in [
        "Devices / Water leak detected",
        "Devices / Zigbee is back online",
        "Power / Hoard is back online",
    ]:
        for trigger in automation(alias)["triggers"]:
            entity = trigger["entity_id"]
            target = trigger["to"]
            hass.states.async_set(entity, "off")
            await hass.async_block_till_done()
            events = []

            @callback
            def record(variables, _context, events=events):
                events.append(variables["trigger"]["to_state"].state)

            native = dict(trigger)
            native.pop("trigger")
            native["platform"] = "state"
            native = await state_trigger.async_validate_trigger_config(hass, native)
            detach = await state_trigger.async_attach_trigger(
                hass,
                native,
                record,
                {"trigger_data": {"id": "fixture", "idx": "0"}, "variables": {}},
            )
            try:
                for state, attrs in [
                    (target, {}),
                    (target, {"fixture": 1}),
                    ("unavailable", {}),
                    (target, {}),
                ]:
                    hass.states.async_set(entity, state, attrs)
                    await hass.async_block_till_done()
                assert events == [target, target]
            finally:
                detach()
    print(
        "Behavior checks passed: ordered templates, GPT data, movie gating, printer snapshots, alert thresholds and native state triggers."
    )
