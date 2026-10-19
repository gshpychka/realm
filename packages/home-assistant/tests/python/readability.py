"""Compatibility with ed89082, using compact fingerprints and native HA scripts.

The fixture stores source hashes, one old weather program, and the old media
control flow with named template references, rather than a full config snapshot.
Update it only after reviewing an intentional change to these contracts.
"""

import copy
import hashlib
import itertools
import json
import re
from pathlib import Path

from homeassistant.core import Context, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.script import Script
from homeassistant.helpers.template import Template, TemplateEnvironment
from jinja2 import meta, nodes

FIXTURE = Path(__file__).parent.parent / "fixtures" / "readability.json"
MEDIA = "Voice / Add media using Assist"


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()


def weather_ast(value):
    """Ignore only whitespace output; retain literals, tests and statement order."""
    if isinstance(value, nodes.TemplateData):
        assert not value.data.strip(), repr(value.data)
        return None
    if isinstance(value, nodes.Node):
        fields = {name: weather_ast(item) for name, item in value.iter_fields()}
        if isinstance(value, nodes.Output) and not fields["nodes"]:
            return None
        return type(value).__name__, fields
    if isinstance(value, list):
        return [result for item in value if (result := weather_ast(item)) is not None]
    return value


def validate_field_order(root):
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
    count = 0
    for path in sorted((root / "configuration" / "automations").glob("*.nix")):
        declarations = path.read_text().split(
            "services.home-assistant.config.automation =", 1
        )[1]
        for body in re.findall(r"^    \{\n(.*?)^    \}", declarations, re.M | re.S):
            fields = re.findall(r"^      (\w+) =", body, re.M)
            assert fields and fields[0] == "alias", (path, fields)
            assert fields == sorted(fields, key=order.index), (path, fields)
            assert "id" not in fields
            count += 1
    assert count == 45, count
    print(f"Automation source order passed: {count} declarations; no top-level IDs.")


def expand(value, contracts):
    if isinstance(value, dict):
        if set(value) == {"template"}:
            return contracts[value["template"]]["source"]
        return {key: expand(item, contracts) for key, item in value.items()}
    if isinstance(value, list):
        return [expand(item, contracts) for item in value]
    return value


async def run_script(
    hass, sequence, variables, responses, fail=None, on_call=None, context=None
):
    """Run HA's real action engine; every possible external service is a stub."""
    calls = []
    services = [
        ("conversation", "process"),
        ("hassarr", "add_overseerr_movie"),
        ("hassarr", "add_overseerr_tv_show"),
        ("ai_task", "generate_data"),
        ("assist_satellite", "announce"),
        ("telegram_bot", "send_message"),
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
            hass, native, "readability fixture", "automation", log_exceptions=False
        )
        try:
            result = await script.async_run(
                copy.deepcopy(variables), context or Context()
            )
        except HomeAssistantError as error:
            return calls, (type(error).__name__, str(error)), None
        assert result is not None
        # Trace paths and explicit stop reasons are allowed to change. Returned
        # data, conversation text, bound values and service order are not.
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


def validate_contracts(config, contracts, fixture):
    assert set(contracts) == set(fixture["contracts"]) and len(contracts) == 74
    for name, contract in contracts.items():
        assert set(contract) == {"source", "output"}, name
        assert contract["output"] == fixture["contracts"][name]["output"], name
        if name != "weather_report":
            assert (
                hashlib.sha256(contract["source"].encode()).hexdigest()
                == fixture["contracts"][name]["sha256"]
            ), name
    # Pin everything outside the two explicitly reviewed allowances. This also
    # proves the power helper still emits exactly the original three actions.
    stable = copy.deepcopy(config)
    next(a for a in stable["automation"] if a["alias"] == MEDIA)["actions"] = (
        "<voice control flow>"
    )

    def normalize(value):
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        return (
            "<weather source whitespace>"
            if value == contracts["weather_report"]["source"]
            else value
        )

    assert fingerprint(normalize(stable)) == fixture["unchanged_config_sha256"]


def validate_weather(hass, contracts, fixture):
    env = TemplateEnvironment(hass, strict=True)
    sources = [fixture["weather_source"], contracts["weather_report"]["source"]]
    syntax = [env.parse(source) for source in sources]
    assert weather_ast(syntax[0]) == weather_ast(syntax[1])
    assert meta.find_undeclared_variables(syntax[0]) == meta.find_undeclared_variables(
        syntax[1]
    )
    weather = [Template(source, hass) for source in sources]
    fixtures = []
    for current, diff, precip, rain, high, low in itertools.product(
        [20, "20", None, "unknown", "unavailable", "NaN", "inf", {}, [], True],
        [0, 2, 2.01, 5],
        [0, 0.1],
        [False, True],
        [20, 23, 23.01, 26],
        [20, 17, 16.99, 14],
    ):
        fixtures.append(
            (
                current,
                {
                    "now_temp": 20,
                    "now_feels": 15,
                    "now_cond": "sunny",
                    "now_precip": precip,
                    "diff": diff,
                    "will_rain": rain,
                    "max_t": high,
                    "min_t": low,
                },
            )
        )
    assert len(fixtures) == 2560
    for high, low in itertools.product([-2, -1.99], [-8, -8.01]):
        fixtures.append(
            (
                -5,
                {
                    "now_temp": -5,
                    "now_feels": -10,
                    "now_cond": "snowy",
                    "now_precip": 0,
                    "diff": 5,
                    "will_rain": False,
                    "max_t": high,
                    "min_t": low,
                },
            )
        )
    for current, variables in fixtures:
        hass.states.async_set(
            "weather.openweathermap", "sunny", {"temperature": current}
        )
        results = [
            template.async_render(variables, strict=True) for template in weather
        ]
        assert results[0] == results[1], (variables, results)
    prompt = env.from_string(contracts["confirmation_prompt"]["source"])
    prompt_hashes = []
    for kind, title in itertools.product(
        ["movie", "show", "unknown"],
        [
            "The Matrix",
            "Breaking Bad",
            "Україна",
            'quote " and slash \\',
            "first\nsecond",
            "{{ syntax }} {% data %}",
        ],
    ):
        result = prompt.render(media_kind=kind, clean_title=title)
        prompt_hashes.append(hashlib.sha256(result.encode()).hexdigest())
    assert prompt_hashes == fixture["prompt_sha256"]

    return len(fixtures)


async def validate_media(hass, config, contracts, fixture):
    current = next(a for a in config["automation"] if a["alias"] == MEDIA)["actions"]
    baseline = expand(fixture["media_actions"], contracts)
    cases = []

    def add(slots, kind, *, reply=None, remark=None, fail=None, rejected=False):
        cases.append((slots, kind, reply, remark, fail, rejected))

    for slots, kind in [
        ({"movie_title": "The Matrix to my Plex library please"}, "movie"),
        ({"show_title": "Severance"}, "show"),
        ({"title": "movie Arrival"}, "movie"),
        ({"title": "tv Severance"}, "show"),
        ({"title": "Arrival"}, "movie"),
        ({"title": "Severance"}, "show"),
    ]:
        add(
            slots,
            kind,
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
        add({"title": "Ambiguous"}, "unknown", reply=reply)
    for slots in [
        None,
        [],
        {},
        {"title": ""},
        {"title": "milk to my shopping list"},
        {"title": "meeting on monday"},
        {"title": "dentist to my calendar"},
    ]:
        add(slots, "unknown", rejected=True)
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
        "movie",
        reply=classification("movie"),
        fail="conversation.process",
    )
    rejected_text = "That sounds like a list or calendar item, not a movie or show, so I didn't add anything."
    for slots, kind, reply, remark, fail, rejected in cases:
        responses = {"conversation.process": reply, "ai_task.generate_data": remark}
        variables = {"trigger": {"slots": slots}}
        context = Context()
        before = await run_script(
            hass, baseline, variables, responses, fail, context=context
        )
        after = await run_script(
            hass, current, variables, responses, fail, context=context
        )
        assert before == after, (slots, kind, reply, fail, before, after)
        calls, error, result = after
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
        # HA rejects a missing response before a template can render it. Keep
        # that protocol failure distinct from malformed mapping fallbacks.
        missing_response = (
            "conversation.process"
            if classified and not isinstance(reply, dict)
            else "ai_task.generate_data"
            if not rejected and kind != "unknown" and remark is None
            else None
        )
        if fail:
            expected = expected[: expected.index(fail) + 1]
            assert (
                error == ("HomeAssistantError", "fixture service failure")
                and result is None
            )
        elif missing_response:
            expected = expected[: expected.index(missing_response) + 1]
            assert (
                error == ("HomeAssistantError", "service_reponse_invalid")
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
        assert names == expected, (slots, names, expected)
    return len(cases)


async def validate_power(hass, config):
    # Speech can yield while sensors change. Telegram must receive the original
    # captured message, for both restoration and outage notifications.
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
            assert [name for name, _ in calls] == (
                ["assist_satellite.announce"]
                if fail == "assist_satellite.announce"
                else ["assist_satellite.announce", "telegram_bot.send_message"]
            )
            message = calls[0][1]["message"]
            assert "40 percent" in message and "5 percent" not in message
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


async def validate_readability(hass, config, contracts):
    fixture = json.loads(FIXTURE.read_text())
    validate_contracts(config, contracts, fixture)
    weather_count = validate_weather(hass, contracts, fixture)
    media_count = await validate_media(hass, config, contracts, fixture)
    await validate_power(hass, config)
    print(
        f"Readability QA passed: 73 exact sources; {weather_count} weather comparisons / "
        f"{2 * weather_count} strict renders; 18 raw prompt renders; {media_count} media cases / "
        f"{2 * media_count} native script runs; 6 power script runs; "
        "baseline actions/results/call order preserved."
    )
