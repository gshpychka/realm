"""Pure planner for the integration's public reconfigure flow; no HA internals."""


class IncompatibleFlow(ValueError):
    pass


def next_input(response, settings, group):
    """Fail closed on unexpected forms or errors, before final config commit."""
    if response.get("errors"):
        raise IncompatibleFlow("Reconfigure reported validation errors")
    kind, step = response.get("type"), response.get("step_id")
    if kind == "abort":
        if response.get("reason") == "reconfigure_successful":
            return None
        raise IncompatibleFlow("Unexpected abort")
    payloads = {
        "reconfigure": {"region": settings["region"]},
        "provider": {"provider": settings["provider"]},
        "group": {"group": group},
        "preferences": {
            "scan_interval": settings["scan_interval"],
            "filter_probable": settings["filter_probable"],
            "status_all_day_events": settings["status_all_day_events"],
        },
    }
    if (
        kind == "menu"
        and step == "method"
        and "group" in response.get("menu_options", [])
    ):
        return {"next_step_id": "group"}
    if kind != "form" or step not in payloads:
        raise IncompatibleFlow("Unsupported integration flow contract")
    fields = {field["name"] for field in response.get("data_schema", [])}
    payload = payloads[step]
    required = {
        field["name"]
        for field in response.get("data_schema", [])
        if field.get("required")
    }
    if not set(payload).issubset(fields) or not required.issubset(payload):
        raise IncompatibleFlow("Integration form schema changed")
    if step == "group":
        field = next(f for f in response["data_schema"] if f["name"] == "group")
        options = field.get("selector", {}).get("select", {}).get("options", [])
        allowed = {o if isinstance(o, str) else o.get("value") for o in options}
        if group not in allowed:
            raise IncompatibleFlow("Candidate is not offered by integration")
    return payload
