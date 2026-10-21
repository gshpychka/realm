"""Exercise Yasno schedule boundaries in pinned HA on a virtual clock.

Reproduces the 2026-10-21 incident: the 11:30-15:00 Kyiv outage slot was
cached since the previous evening, polls ran at 11:27:45 and 11:42:45, and the
electricity sensor and calendar kept the expired 04:30-11:30 normal slot until
the second poll. The config entry is set up through HA's real loader, entity
platforms and timers; only Yasno's network methods are replaced by recorders
and sockets are refused.

Usage: schedule-boundaries-test.py COMPONENT_DIR {patched,upstream}
`upstream` runs the incident against the unpatched source and requires the
stale state, so the fixture is shown to detect the original failure.
"""

import asyncio
import copy
import datetime as dt
import itertools
import shutil
import socket
import sys
import tempfile
import time
from pathlib import Path
from types import MappingProxyType, SimpleNamespace
from unittest.mock import patch


def denied(*_args, **_kwargs):
    raise RuntimeError("network is forbidden in offline QA")


socket.create_connection = denied
socket.socket.connect = denied
socket.socket.connect_ex = denied
socket.getaddrinfo = denied

UTC = dt.UTC
KYIV = "Europe/Kyiv"
REGION = "Київ"
PROVIDER = "ПРАТ «ДТЕК КИЇВСЬКІ ЕЛЕКТРОМЕРЕЖІ»"
GROUP = "12.1"
REGIONS = [{"value": REGION, "id": 25, "dsos": [{"name": PROVIDER, "id": 902}]}]


def utc(text):
    return dt.datetime.fromisoformat(text).astimezone(UTC)


def slot(start, end, kind):
    return {"start": start, "end": end, "type": kind}


def planned(today_slots, tomorrow_slots, day="2026-10-21", tomorrow="2026-10-22"):
    return {
        GROUP: {
            "today": {
                "slots": today_slots,
                "date": f"{day}T00:00:00+03:00",
                "status": "ScheduleApplies",
            },
            "tomorrow": {
                "slots": tomorrow_slots,
                "date": f"{tomorrow}T00:00:00+03:00",
                "status": "ScheduleApplies",
            },
            "updatedOn": "2026-10-20T19:15:01+00:00",
        }
    }


# Incident schedule, in minutes from local midnight.
INCIDENT = planned(
    [
        slot(0, 270, "Definite"),
        slot(270, 690, "NotPlanned"),
        slot(690, 900, "Definite"),
        slot(900, 1440, "NotPlanned"),
    ],
    [slot(0, 1440, "NotPlanned")],
)
# Wednesday 16:00-18:00 probable slot, keyed by weekday as upstream does.
PROBABLE = {
    "25": {
        "dsos": {
            "902": {"groups": {GROUP: {"slots": {"2": [slot(960, 1080, "Definite")]}}}}
        }
    }
}


class VirtualClockLoop(asyncio.SelectorEventLoop):
    """Event loop whose monotonic clock only moves when the test advances it.

    Timers fire in the normal asyncio way once their deadline has passed, so HA
    helpers run unmodified. I/O and executor wake-ups still work in real time.
    """

    def __init__(self, wall):
        super().__init__()
        self.monotonic = 1000.0
        self.origin = (self.monotonic, wall)

    def time(self):
        return self.monotonic

    def wall(self):
        monotonic, wall = self.origin
        return wall + dt.timedelta(seconds=self.monotonic - monotonic)


class Recorder:
    """Network fakes for the Yasno API and timer bookkeeping for the coordinator."""

    def __init__(self, loop):
        self.loop = loop
        self.planned = copy.deepcopy(INCIDENT)
        self.probable = None
        self.fail = False
        self.fetches = []
        self.timers = []

    async def fetch_regions(self, api):
        api.regions_data = REGIONS

    async def fetch_planned(self, api, errors):
        self.fetches.append(("planned", self.loop.wall()))
        if self.fail:
            raise errors.YasnoApiError("fixture network failure")
        api.planned_outages_data = copy.deepcopy(self.planned)

    async def fetch_probable(self, api, errors):
        self.fetches.append(("probable", self.loop.wall()))
        if self.fail:
            raise errors.YasnoApiError("fixture network failure")
        api.probable_outages_data = copy.deepcopy(self.probable)

    def track(self, real):
        from homeassistant.core import callback

        def track_point_in_time(hass, action, point):
            # The coordinator cancels its previous timer before arming one.
            assert not self.active(), self.active()
            timer = SimpleNamespace(point=point, active=True)
            self.timers.append(timer)

            def fired(now):
                timer.active = False
                return action(now)

            # Keep HA's callback job type for the wrapped @callback handler.
            cancel = real(hass, callback(fired), point)

            def unsubscribe():
                timer.active = False
                cancel()

            return unsubscribe

        return track_point_in_time

    def active(self):
        return [timer.point for timer in self.timers if timer.active]

    def polls(self):
        return [at for kind, at in self.fetches if kind == "planned"]


async def start(component, mode, wall):
    from homeassistant import bootstrap, config_entries, loader
    from homeassistant.core import CoreState, HomeAssistant
    from homeassistant.util import dt as dt_util

    loop = asyncio.get_running_loop()
    config_dir = Path(tempfile.mkdtemp())
    shutil.copytree(component, config_dir / "custom_components" / "yasno_outages")
    sys.path.insert(0, str(config_dir))
    hass = HomeAssistant(str(config_dir))
    await hass.config.async_set_time_zone(KYIV)
    hass.config.skip_pip = True
    loader.async_setup(hass)
    hass.config_entries = config_entries.ConfigEntries(hass, {})
    assert await bootstrap.async_load_base_functionality(hass)
    # Calendar registers HTTP views; the HTTP server itself is not under test.
    hass.http = SimpleNamespace(register_view=lambda view: None)
    hass.config.components.add("http")
    hass.set_state(CoreState.running)
    assert dt_util.now().tzinfo is not None and loop.wall() == wall
    return hass, config_dir


async def scenario(component, mode):
    from homeassistant.config_entries import ConfigEntry, ConfigEntryState
    from homeassistant.helpers import entity_registry as er
    from homeassistant.helpers import event
    from homeassistant.util import dt as dt_util

    loop = asyncio.get_running_loop()
    recorder = Recorder(loop)
    clock = [
        patch.object(dt_util, "utcnow", loop.wall),
        patch.object(
            dt_util,
            "now",
            lambda time_zone=None: loop.wall().astimezone(
                time_zone or dt_util.get_default_time_zone()
            ),
        ),
        patch.object(event, "time_tracker_utcnow", loop.wall),
        patch.object(event, "time_tracker_timestamp", lambda: loop.wall().timestamp()),
        # _TrackPointUTCTime converts the wall deadline with time.time().
        patch.object(time, "time", lambda: loop.wall().timestamp()),
    ]
    for item in clock:
        item.start()
    hass, config_dir = await start(component, mode, loop.wall())

    from custom_components.yasno_outages import coordinator as coordinator_module
    from custom_components.yasno_outages.api import base, models
    from custom_components.yasno_outages.api import planned as planned_api
    from custom_components.yasno_outages.api import probable as probable_api

    async def fetch_regions(api):
        await recorder.fetch_regions(api)

    async def fetch_planned(api):
        await recorder.fetch_planned(api, models)

    async def fetch_probable(api):
        await recorder.fetch_probable(api, models)

    fakes = [
        patch.object(base.BaseYasnoApi, "fetch_regions", fetch_regions),
        patch.object(
            planned_api.PlannedOutagesApi, "fetch_planned_outages_data", fetch_planned
        ),
        patch.object(
            probable_api.ProbableOutagesApi,
            "fetch_probable_outages_data",
            fetch_probable,
        ),
    ]
    if hasattr(coordinator_module, "async_track_point_in_time"):
        fakes.append(
            patch.object(
                coordinator_module,
                "async_track_point_in_time",
                recorder.track(coordinator_module.async_track_point_in_time),
            )
        )
    for item in fakes:
        item.start()

    async def settle():
        for _ in range(3):
            await hass.async_block_till_done()
            await asyncio.sleep(0)

    async def advance(target, step=1.0):
        """Move the virtual clock to `target` in steps, firing due timers."""
        target = utc(target)
        assert target >= loop.wall()
        while (remaining := (target - loop.wall()).total_seconds()) > 0:
            loop.monotonic += min(step, remaining)
            await settle()
        assert loop.wall() == target

    async def next_poll():
        """Step until the coordinator's own poll timer fetches again."""
        count = len(recorder.polls())
        for _ in range(902):
            loop.monotonic += 1.0
            await settle()
            if len(recorder.polls()) > count:
                return
        raise AssertionError("poll interval elapsed without a fetch")

    async def jump(target):
        """Move straight to `target`; every due timer fires late."""
        await advance(target, step=float("inf"))

    entry = ConfigEntry(
        data={"region": REGION, "provider": PROVIDER, "group": GROUP},
        discovery_keys=MappingProxyType({}),
        domain="yasno_outages",
        minor_version=1,
        options={"scan_interval": 15},
        source="user",
        subentries_data=None,
        title="Yasno fixture",
        unique_id=None,
        version=2,
    )
    await hass.config_entries.async_add(entry)
    await settle()
    assert entry.state is ConfigEntryState.LOADED, entry.state
    coordinator = entry.runtime_data.coordinator
    registry = er.async_get(hass)

    def entity(platform, key):
        unique_id = f"{entry.entry_id}-{GROUP}-{key}"
        return registry.async_get_entity_id(platform, "yasno_outages", unique_id)

    power = entity("sensor", "electricity")
    calendar = entity("calendar", "planned_outages")
    assert power and calendar

    def observed():
        state = hass.states.get(power)
        return (
            state.state,
            state.attributes.get("event_start"),
            state.attributes.get("event_end"),
            hass.states.get(calendar).state,
        )

    before = ("normal", "2026-10-21T04:30:00+03:00", "2026-10-21T11:30:00+03:00", "off")
    during = ("outage", "2026-10-21T11:30:00+03:00", "2026-10-21T15:00:00+03:00", "on")
    after = ("normal", "2026-10-21T15:00:00+03:00", "2026-10-22T00:00:00+03:00", "off")
    assert observed() == before, observed()
    assert recorder.polls() == [utc("2026-10-21T11:27:45+03:00")]
    # Local 11:30 EEST is 08:30 UTC, the instant the slot starts.
    assert utc("2026-10-21T11:30:00+03:00") == utc("2026-10-21T08:30:00+00:00")

    if mode == "upstream":
        await advance("2026-10-21T11:36:04.935324+03:00")
        assert recorder.polls() == [utc("2026-10-21T11:27:45+03:00")]
        stale = observed()
        assert stale == before, stale
        print(f"Upstream reproduces the incident at 11:36:04.935 Kyiv: {stale}")
        return hass, config_dir

    boundary = utc("2026-10-21T11:30:00+03:00")
    assert recorder.active() == [boundary], recorder.active()

    # The boundary republishes cached data on time, without a network fetch.
    await advance("2026-10-21T11:29:59+03:00")
    assert observed() == before, observed()
    await advance("2026-10-21T11:30:00+03:00")
    assert observed() == during, observed()
    await advance("2026-10-21T11:36:04.935324+03:00")
    assert observed() == during, observed()
    assert recorder.polls() == [utc("2026-10-21T11:27:45+03:00")]
    assert recorder.active() == [utc("2026-10-21T15:00:00+03:00")]

    # Polling cadence is unchanged: the next poll is one interval after the first.
    await advance("2026-10-21T11:42:46+03:00", step=0.25)
    first, second = recorder.polls()
    assert (
        dt.timedelta(minutes=15) <= second - first < dt.timedelta(minutes=15, seconds=1)
    )

    # Network failures keep the cache; the 15:00 end still republishes on time.
    recorder.fail = True
    await advance("2026-10-21T14:59:59+03:00")
    assert observed() == during, observed()
    await advance("2026-10-21T15:00:00+03:00")
    assert observed() == after, observed()
    polls = recorder.polls()
    # One-second virtual steps can fire a poll up to a second late.
    gaps = [(b - a).total_seconds() for a, b in itertools.pairwise(polls)]
    assert all(900 <= gap < 902 for gap in gaps), gaps
    assert recorder.active() == [utc("2026-10-22T00:00:00+03:00")]

    # A fetched schedule change replaces the armed timer instead of adding one.
    recorder.fail = False
    recorder.planned = planned(
        [slot(900, 990, "NotPlanned"), slot(990, 1050, "Definite")],
        [slot(0, 1440, "NotPlanned")],
    )
    old = recorder.active()
    await next_poll()
    replaced = recorder.active()
    assert replaced == [utc("2026-10-21T16:30:00+03:00")], replaced
    assert old != replaced and len(replaced) == 1
    # Probable slots are boundaries too; their 16:00 start now arms first.
    recorder.probable = copy.deepcopy(PROBABLE)
    await next_poll()
    assert recorder.active() == [utc("2026-10-21T16:00:00+03:00")], recorder.active()

    # A late timer (event loop stalled) republishes current state and re-arms
    # from the real time, skipping passed points instead of looping on them.
    await jump("2026-10-21T16:40:00+03:00")
    late = observed()
    assert late == (
        "outage",
        "2026-10-21T16:30:00+03:00",
        "2026-10-21T17:30:00+03:00",
        "on",
    ), late
    assert recorder.active() == [utc("2026-10-21T17:30:00+03:00")], recorder.active()
    assert all(not timer.active for timer in recorder.timers[:-1])

    # Unload cancels the boundary timer with the poll timer.
    fetches = len(recorder.fetches)
    assert await hass.config_entries.async_unload(entry.entry_id)
    await settle()
    assert recorder.active() == []
    await advance("2026-10-21T18:30:00+03:00", step=300)
    assert len(recorder.fetches) == fetches and recorder.active() == []

    # Day rollover and malformed/empty schedules arm the next local midnight
    # once, across the end of DST (Kyiv leaves EEST at 04:00 on Oct 25).
    now = dt.datetime(2026, 10, 25, 1, 0, tzinfo=dt_util.get_time_zone(KYIV))
    midnight = utc("2026-10-25T22:00:00+00:00")
    for data in [
        None,
        {},
        {GROUP: {}},
        planned([], []),
        planned([{"start": "x", "end": 60, "type": "Definite"}], []),
        {GROUP: {"today": {"slots": [slot(0, 60, "Definite")], "date": "garbage"}}},
    ]:
        coordinator.api.planned.planned_outages_data = data
        coordinator.api.probable.probable_outages_data = None
        assert coordinator.next_schedule_boundary(now) == midnight, data
    # Boundaries compare as instants regardless of the slot's UTC offset.
    coordinator.api.planned.planned_outages_data = planned(
        [slot(300, 360, "Definite")], [], day="2026-10-25", tomorrow="2026-10-26"
    )
    assert coordinator.next_schedule_boundary(now) == utc("2026-10-25T05:00:00+03:00")
    assert coordinator.next_schedule_boundary(utc("2026-10-25T05:00:00+03:00")) == utc(
        "2026-10-25T06:00:00+03:00"
    )
    print(
        "Yasno boundary QA passed: 11:30 and 15:00 republished without fetches, "
        f"{len(polls)} polls at 900 s cadence, {len(recorder.timers)} timers "
        "with at most one armed, late/replace/unload/malformed/DST cases."
    )
    return hass, config_dir


async def main(component, mode):
    hass, config_dir = await scenario(component, mode)
    await hass.async_stop(force=True)
    # Store-copied component files are read-only.
    for path in config_dir.rglob("*"):
        path.chmod(0o700)
    shutil.rmtree(config_dir)


if __name__ == "__main__":
    component, mode = Path(sys.argv[1]), sys.argv[2]
    assert mode in {"patched", "upstream"}
    loop = VirtualClockLoop(dt.datetime(2026, 10, 21, 8, 27, 45, tzinfo=UTC))
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(main(component, mode))
    finally:
        loop.close()
