from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


def validate_slots(slots):
    if not isinstance(slots, list):
        raise ValueError("Slots must be a list")
    previous_end = 0
    for slot in slots:
        if not isinstance(slot, dict) or slot.get("type") not in {
            "Definite",
            "NotPlanned",
        }:
            raise ValueError("Unknown slot type")
        start, end = slot.get("start"), slot.get("end")
        if (
            type(start) is not int
            or type(end) is not int
            or not 0 <= start < end <= 1440
            or start < previous_end
        ):
            raise ValueError("Invalid or overlapping slot range")
        previous_end = end


def validate_planned(api, raw, now, require_available=False):
    """Validate dated slots and status, optionally requiring today's schedule."""
    today = now.astimezone(ZoneInfo("Europe/Kyiv")).date()
    group = raw.get(api.group) if isinstance(raw, dict) else None
    if not isinstance(group, dict):
        raise ValueError("Missing selected planned group")
    for key, expected in (("today", today), ("tomorrow", today + timedelta(days=1))):
        day = group.get(key)
        if key == "tomorrow" and day is None:
            continue
        if not isinstance(day, dict):
            raise ValueError("Missing dated schedule")
        date = datetime.fromisoformat(day["date"])
        actual = (
            date.astimezone(ZoneInfo("Europe/Kyiv")).date()
            if date.tzinfo
            else date.date()
        )
        if actual != expected or day.get("status") not in {
            "NoOutages",
            "ScheduleApplies",
            "WaitingForSchedule",
            "EmergencyShutdowns",
        }:
            raise ValueError("Stale date or unknown status")
        if (
            require_available
            and key == "today"
            and day["status"] == "WaitingForSchedule"
        ):
            raise ValueError("Current schedule not yet available")
        validate_slots(day.get("slots"))
        if day["status"] == "ScheduleApplies" and not day["slots"]:
            raise ValueError("Applied schedule without usable slots")


def validate_probable(api, raw):
    group = raw[str(api.region_id)]["dsos"][str(api.provider_id)]["groups"][api.group]
    slots = group["slots"]
    if not isinstance(slots, dict) or set(slots) != {str(i) for i in range(7)}:
        raise ValueError("Invalid probable weekday structure")
    for value in slots.values():
        validate_slots(value)
