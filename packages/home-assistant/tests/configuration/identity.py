"""Keep imported registry identity when Nix takes ownership of definitions."""

import logging
from datetime import timedelta
from tempfile import TemporaryDirectory

from homeassistant.components.automation import AutomationEntity
from homeassistant.components.homeassistant.scene import HomeAssistantScene, SceneConfig
from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import device_registry, entity_registry, restore_state
from homeassistant.helpers.entity_platform import EntityPlatform
from homeassistant.helpers.script import Script
from homeassistant.util.dt import utcnow


async def validate_identity(config):
    # These are the original exported identities, independent of the declarations
    # under test. Changing aliases or removing IDs must not allocate new entities.
    automation = next(
        item
        for item in config["automation"]
        if item["alias"] == "Lighting / Overhead lights toggle"
    )
    scene_ids = {
        "Night": ("1741877284270", "night"),
        "TV watching": ("1743964862836", "tv_watching"),
    }
    scene_identities = [scene["id"] for scene in config["scene"]]
    assert len(scene_identities) == len(set(scene_identities))
    with TemporaryDirectory() as root:
        hass = HomeAssistant(root)
        platforms = []
        try:
            device_registry.async_setup(hass)
            await device_registry.async_load(hass, load_empty=True)
            await entity_registry.async_load(hass, load_empty=True)
            await restore_state.async_load(hass, load_empty=True)
            registry = entity_registry.async_get(hass)
            restored = restore_state.async_get(hass)

            def platform(domain, integration):
                value = EntityPlatform(
                    hass=hass,
                    logger=logging.getLogger(__name__),
                    domain=domain,
                    platform_name=integration,
                    platform=None,
                    scan_interval=timedelta(seconds=30),
                    entity_namespace=None,
                )
                platforms.append(value)
                return value

            entry = registry.async_get_or_create(
                "automation",
                "automation",
                "1735822501432",
                suggested_object_id="overhead_lights_toggle",
            )
            # A previously disabled automation must remain disabled even though
            # the imported alias gains a domain prefix in its Nix declaration.
            restored.last_states[entry.entity_id] = restore_state.StoredState(
                State(entry.entity_id, "off", {}), None, utcnow()
            )
            entity = AutomationEntity(
                automation["id"],
                automation["alias"],
                [],
                None,
                Script(hass, [], automation["alias"], "automation"),
                automation.get("initial_state"),
                None,
                None,
                automation,
                None,
                {"stored_traces": 5},
            )
            await platform("automation", "automation")._async_add_entity(
                entity, False, registry, None
            )
            assert entity.entity_id == "automation.overhead_lights_toggle"
            assert entity.unique_id == "1735822501432" and not entity.is_on

            scenes = platform("scene", "homeassistant")
            for scene in config["scene"]:
                identity, object_id = scene_ids[scene["name"]]
                registry.async_get_or_create(
                    "scene", "homeassistant", identity, suggested_object_id=object_id
                )
                entity = HomeAssistantScene(
                    hass,
                    SceneConfig(scene["id"], scene["name"], scene.get("icon"), {}),
                )
                await scenes._async_add_entity(entity, False, registry, None)
                assert entity.entity_id == f"scene.{object_id}"
                assert entity.unique_id == identity
            assert len(registry.entities) == 3
        finally:
            for value in platforms:
                await value.async_reset()
            await hass.async_block_till_done()
            hass.import_executor.shutdown(wait=True)
    print(
        "Registry identity passed: restored scenes, renamed automation and disabled state."
    )
