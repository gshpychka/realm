"""Current media and power contracts exercised by HA's native action engine.

External services are local recording stubs. Expectations specify requests,
responses, ordering, captured variables and failure propagation.
"""

import copy

from homeassistant.core import Context, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.script import Script

MEDIA = "Voice / Add media using Assist"


async def run_script(hass, sequence, variables, responses, fail=None, on_call=None):
    """Run HA's real action engine; every possible external service is a stub."""
    calls = []
    services = [
        ("conversation", "process"),
        ("hassarr", "add_overseerr_movie"),
        ("hassarr", "add_overseerr_tv_show"),
        ("ai_task", "generate_data"),
        ("assist_satellite", "announce"),
        ("telegram_bot", "send_message"),
        ("weather", "get_forecasts"),
    ]

    async def record(call):
        name = f"{call.domain}.{call.service}"
        calls.append((name, dict(call.data)))
        if on_call:
            on_call(name)
        if name == fail:
            raise HomeAssistantError("fixture service failure")
        return responses.get(name)

    for domain, service in services:
        assert not hass.services.has_service(domain, service)
        hass.services.async_register(
            domain, service, record, supports_response=SupportsResponse.OPTIONAL
        )
    script = None
    try:
        native = await cv.async_validate(
            hass, cv.SCRIPT_SCHEMA, copy.deepcopy(sequence)
        )
        script = Script(
            hass, native, "service contract", "automation", log_exceptions=False
        )
        try:
            result = await script.async_run(copy.deepcopy(variables), Context())
        except HomeAssistantError as error:
            return calls, (type(error).__name__, str(error)), None
        assert result is not None
        return (
            calls,
            None,
            (
                result.conversation_response,
                result.service_response,
                dict(result.variables),
            ),
        )
    finally:
        if script:
            await script.async_unload()
        for domain, service in services:
            hass.services.async_remove(domain, service)


def classification(kind):
    return {"response": {"speech": {"plain": {"speech": kind}}}}


async def validate_media(hass, config):
    current = next(a for a in config["automation"] if a["alias"] == MEDIA)["actions"]
    cases = []

    def add(
        slots,
        kind,
        *,
        title="Fixture title",
        reply=None,
        remark=None,
        fail=None,
        rejected=False,
    ):
        cases.append((slots, kind, title, reply, remark, fail, rejected))

    for slots, kind, title in [
        (
            {"movie_title": "The Matrix to my Plex library please"},
            "movie",
            "The Matrix",
        ),
        ({"show_title": "Severance"}, "show", "Severance"),
        ({"title": "movie Arrival"}, "movie", "Arrival"),
        ({"title": "tv Severance"}, "show", "Severance"),
        ({"title": "Arrival"}, "movie", "Arrival"),
        ({"title": "Severance"}, "show", "Severance"),
    ]:
        add(
            slots,
            kind,
            title=title,
            reply=classification(kind),
            remark={"data": "Added the fixture."},
        )
    for reply in [
        None,
        42,
        "unavailable",
        [],
        {},
        {"response": None},
        {"response": {"speech": {}}},
        classification([]),
        classification("MOVIE."),
        classification(" movie "),
        classification("unknown"),
    ]:
        add({"title": "Ambiguous"}, "unknown", title="Ambiguous", reply=reply)
    for slots, title in [
        (None, ""),
        ([], ""),
        ({}, ""),
        ({"title": ""}, ""),
        ({"title": "milk to my shopping list"}, "milk to my shopping list"),
        ({"title": "meeting on monday"}, "meeting on monday"),
        ({"title": "dentist to my calendar"}, "dentist to my calendar"),
    ]:
        add(slots, "unknown", title=title, rejected=True)
    for kind, slot in [("movie", "movie_title"), ("show", "show_title")]:
        for remark in [None, {}, {"data": []}, {"data": 42}, {"data": ""}]:
            add({slot: "Fixture title"}, kind, remark=remark)
        for fail in [
            f"hassarr.add_overseerr_{'movie' if kind == 'movie' else 'tv_show'}",
            "ai_task.generate_data",
        ]:
            add({slot: "Fixture title"}, kind, fail=fail)
    add(
        {"title": "Ambiguous"},
        "unknown",
        title="Ambiguous",
        reply=classification("movie"),
        fail="conversation.process",
    )
    rejected_text = "That sounds like a list or calendar item, not a movie or show, so I didn't add anything."
    for slots, kind, title, reply, remark, fail, rejected in cases:
        responses = {"conversation.process": reply, "ai_task.generate_data": remark}
        variables = {"trigger": {"slots": slots}}
        calls, error, result = await run_script(
            hass, current, variables, responses, fail
        )
        names = [name for name, _ in calls]
        classified = not rejected and slots.get("title") in [
            "Arrival",
            "Severance",
            "Ambiguous",
        ]
        expected = ["conversation.process"] if classified else []
        if not rejected and kind != "unknown":
            expected += [
                f"hassarr.add_overseerr_{'movie' if kind == 'movie' else 'tv_show'}",
                "ai_task.generate_data",
            ]
        # HA rejects a non-mapping response before assigning the response
        # variable. Read-only classification and optional confirmation must
        # continue to their explicit fallback in that case too.
        missing_response = (
            "conversation.process"
            if classified and not isinstance(reply, dict)
            else "ai_task.generate_data"
            if not rejected and kind != "unknown" and remark is None
            else None
        )
        if fail:
            expected = expected[: expected.index(fail) + 1]
        if missing_response and not fail:
            expected = expected[: expected.index(missing_response) + 1]
        if fail and fail.startswith("hassarr."):
            assert (
                error == ("HomeAssistantError", "fixture service failure")
                and result is None
            )
        else:
            assert error is None
            text = result[0]
            if rejected:
                assert text == rejected_text
            elif kind == "unknown":
                assert (
                    text
                    == 'Sorry, I\'m not sure if Ambiguous is a movie or a show.. Try saying, "Add the movie Ambiguous to my library".'
                )
            else:
                expected_text = (
                    "Added the fixture."
                    if remark and remark.get("data") == "Added the fixture."
                    else f'Got it — "Fixture title" has been added to your {kind} queue.'
                )
                assert text == expected_text
            assert result[1] is None
            bound = result[2]
            assert bound["trigger"] == variables["trigger"]
            assert bound["slots"] == (slots if isinstance(slots, dict) else {})
            assert bound["clean_title"] == title and bound["media_kind"] == kind
            if classified:
                if isinstance(reply, dict) and fail != "conversation.process":
                    assert bound["llm_kind"] == reply
                else:
                    assert "llm_kind" not in bound
            if kind != "unknown":
                assert bound.get("witty_remark") == remark
        assert names == expected, (slots, names, expected)
        for name, data in calls:
            if name == "conversation.process":
                assert data == {
                    "agent_id": "conversation.chatgpt_2",
                    "text": (
                        'You are a classifier. Reply with **exactly one word**: "movie" '
                        f'if "{title}" is primarily a feature film, "show"  if it is '
                        'primarily a television/streaming series, otherwise "unknown". '
                        "No punctuation. No extra words."
                    ),
                }
            elif name.startswith("hassarr."):
                assert data == {"title": title.title()}
            else:
                assert name == "ai_task.generate_data"
                assert set(data) == {"entity_id", "task_name", "instructions"}
                assert data["entity_id"] == "ai_task.openai_ai_task"
                assert data["task_name"] == "Media added confirmation"
                assert f"add a {kind} to their Plex library" in data["instructions"]
                assert data["instructions"].endswith(
                    f'Now generate a similar confirmation line for "{title.title()}".'
                )
    return len(cases)


async def validate_power(hass, config):
    # Speech can yield while sensors change. Telegram must receive the original
    # captured message, for both restoration and outage notifications.
    count = 0
    for alias in ["Power / City power is off", "Power / City power back on"]:
        actions = next(a for a in config["automation"] if a["alias"] == alias)[
            "actions"
        ]
        for fail in [None, "assist_satellite.announce", "telegram_bot.send_message"]:
            hass.states.async_set("sensor.battery_charge", "40")
            hass.states.async_set("sensor.yasno_power", "normal")
            hass.states.async_set("sensor.multiplus_output_power_l1", "120")

            def changed(name):
                if name == "assist_satellite.announce":
                    hass.states.async_set("sensor.battery_charge", "5")
                    hass.states.async_set("sensor.yasno_power", "outage")
                    hass.states.async_set("sensor.multiplus_output_power_l1", "900")

            calls, error, result = await run_script(
                hass, actions, {}, {}, fail, changed
            )
            count += 1
            assert [name for name, _ in calls] == (
                ["assist_satellite.announce"]
                if fail == "assist_satellite.announce"
                else ["assist_satellite.announce", "telegram_bot.send_message"]
            )
            message = calls[0][1]["message"]
            if alias == "Power / City power back on":
                assert message == "Power is back on. Battery is at 40 percent."
            else:
                assert " ".join(message.split()) == (
                    "City power is off. This is not a scheduled outage. "
                    "Battery is at 40 percent. Current power draw is 120 Watts."
                )
            assert hass.states.get("sensor.battery_charge").state == "5"
            assert hass.states.get("sensor.yasno_power").state == "outage"
            assert hass.states.get("sensor.multiplus_output_power_l1").state == "900"
            assert calls[0][1]["preannounce"] is True
            if len(calls) == 2:
                assert calls[1][1] == {"message": message, "disable_notification": True}
            if fail:
                assert (
                    error == ("HomeAssistantError", "fixture service failure")
                    and result is None
                )
            else:
                assert error is None and result[2]["message"] == message

    return count


async def validate_weather(hass, config):
    actions = next(
        item
        for item in config["automation"]
        if item["alias"] == "System / Weather report"
    )["actions"]
    count = 0
    for state, attributes, responses, fail in [
        (
            "sunny",
            {"temperature": 20},
            {"weather.get_forecasts": {"weather.openweathermap": {"forecast": []}}},
            None,
        ),
        ("unavailable", {}, {}, "weather.get_forecasts"),
        ("unknown", {}, {"weather.get_forecasts": None}, None),
        ("unavailable", {}, {"weather.get_forecasts": {}}, None),
    ]:
        hass.states.async_set("weather.openweathermap", state, attributes)
        calls, error, result = await run_script(hass, actions, {}, responses, fail)
        count += 1
        assert error is None and result is not None
        assert [name for name, _ in calls] == ["weather.get_forecasts"]
        assert calls[0][1] == {
            "type": "hourly",
            "entity_id": ["weather.openweathermap"],
        }
        assert result[2]["fc"] == []
        if state == "sunny":
            assert result[0] == "It's 20 degrees and sunny."
        else:
            assert result[0] == "Current weather information is unavailable."
    return count


async def validate_service_contracts(hass, config):
    media_count = await validate_media(hass, config)
    power_count = await validate_power(hass, config)
    weather_count = await validate_weather(hass, config)
    print(
        f"Service contracts passed: {media_count} media scenarios / {media_count} native script runs; "
        f"{power_count} power and {weather_count} weather script runs; "
        "request data, replies, captured values, service order and provider failures."
    )
