"""Documented HA author APIs only; every HA operation runs on HA's loop."""

import asyncio
import inspect


class InProcessAPI:
    def __init__(self, hass, external_session, config):
        self.hass = hass
        self.session = external_session
        self.config = config
        self.owned_flows = set()

    async def on_loop(self, fn, *args, **kwargs):
        async def invoke():
            value = fn(*args, **kwargs)
            return await value if inspect.isawaitable(value) else value

        # HA's async author APIs are not thread-safe. The caller runs in the
        # Pyscript executor; submit only the API operation to HA's public loop.
        future = asyncio.run_coroutine_threadsafe(invoke(), self.hass.loop)
        return await asyncio.wrap_future(future)

    def registry(self):
        from homeassistant.helpers import entity_registry

        return entity_registry.async_get(self.hass)

    def row(self, entry):
        names = (
            "id",
            "entity_id",
            "config_entry_id",
            "unique_id",
            "platform",
            "translation_key",
            "area_id",
            "name",
            "icon",
            "hidden_by",
        )
        result = {name: getattr(entry, name) for name in names}
        result["labels"] = sorted(entry.labels)
        result["options"] = {
            domain: dict(options) for domain, options in entry.options.items()
        }
        return result

    def flow_result(self, result):
        # Same maintained serializer used by HA's public flow HTTP views.
        import probatio
        from homeassistant.helpers import config_validation

        value = {
            key: result[key]
            for key in (
                "type",
                "step_id",
                "flow_id",
                "errors",
                "reason",
                "menu_options",
            )
            if key in result
        }
        if "data_schema" in result:
            schema = result["data_schema"]
            value["data_schema"] = (
                probatio.to_field_list(
                    schema, custom_serializer=config_validation.custom_serializer
                )
                if schema is not None
                else []
            )
        return value

    async def http(self, method, path, data=None, external=False):
        if external:
            if (
                method != "GET"
                or data is not None
                or not path.startswith(
                    "https://app.yasno.ua/api/blackout-service/public/shutdowns/"
                )
            ):
                raise ValueError("Unexpected provider operation")
            async with self.session.get(path, allow_redirects=False) as response:
                if response.status != 200:
                    raise RuntimeError("Official provider HTTP failure")
                return await response.json()

        async def action():
            if method == "GET" and path == "/api/states":
                return [
                    {"entity_id": s.entity_id, "state": s.state}
                    for s in self.hass.states.async_all()
                ]
            if method == "GET" and path == "/api/config/config_entries/entry":
                entry = self.hass.config_entries.async_get_entry(
                    self.config["entry_id"]
                )
                return (
                    []
                    if entry is None
                    else [{"entry_id": entry.entry_id, "state": entry.state.value}]
                )
            flow = self.hass.config_entries.flow
            if method == "POST" and path == "/api/config/config_entries/flow":
                if data != {
                    "handler": "yasno_outages",
                    "entry_id": self.config["entry_id"],
                }:
                    raise ValueError("Unexpected reconfigure target")
                result = await flow.async_init(
                    "yasno_outages",
                    context={
                        "source": "reconfigure",
                        "entry_id": self.config["entry_id"],
                    },
                )
                if result.get("flow_id"):
                    self.owned_flows.add(result["flow_id"])
                return self.flow_result(result)
            prefix = "/api/config/config_entries/flow/"
            if path.startswith(prefix):
                flow_id = path[len(prefix) :]
                if not flow_id or "/" in flow_id or flow_id not in self.owned_flows:
                    raise ValueError("Invalid flow identifier")
                if method == "POST":
                    return self.flow_result(await flow.async_configure(flow_id, data))
                if method == "DELETE":
                    try:
                        flow.async_abort(flow_id)
                    finally:
                        self.owned_flows.discard(flow_id)
                    return {}
            raise ValueError("Unsupported internal operation")

        return await self.on_loop(action)

    async def ws(self, kind, **data):
        def action():
            registry = self.registry()
            if kind == "config/entity_registry/list" and not data:
                return [self.row(entry) for entry in registry.entities.values()]
            if kind != "config/entity_registry/update":
                raise ValueError("Unsupported registry operation")
            values = dict(data)
            entity_id = values.pop("entity_id")
            entry = registry.async_get(entity_id)
            if entry is None or entry.config_entry_id != self.config["entry_id"]:
                raise ValueError("Registry mutation outside Yasno entry refused")
            if "options_domain" in values:
                if set(values) != {"options_domain", "options"}:
                    raise ValueError("Unexpected registry options update")
                result = registry.async_update_entity_options(
                    entity_id, values["options_domain"], values["options"]
                )
            else:
                if not set(values) <= {
                    "new_entity_id",
                    "area_id",
                    "labels",
                    "name",
                    "icon",
                    "hidden_by",
                }:
                    raise ValueError("Unsupported registry fields")
                if values.get("hidden_by") is not None:
                    from homeassistant.helpers import entity_registry

                    values["hidden_by"] = entity_registry.RegistryEntryHider(
                        values["hidden_by"]
                    )
                if "labels" in values:
                    values["labels"] = set(values["labels"])
                result = registry.async_update_entity(entity_id, **values)
            return self.row(result)

        return await self.on_loop(action)

    async def notification(self, message):
        await self.on_loop(
            self.hass.services.async_call,
            "persistent_notification",
            "create",
            {
                "notification_id": "yasno_address_guard",
                "title": "Yasno address check needs attention",
                "message": message,
            },
            blocking=True,
        )
