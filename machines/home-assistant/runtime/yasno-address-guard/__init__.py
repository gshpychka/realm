"""Pyscript entry point for scheduled and on-demand Yasno address checks."""

import asyncio
import importlib.util
import pathlib


@pyscript_compile
def run_guard(ha, config, dry_run, force_check):
    # Compiled Python loads and runs the engine in Pyscript's supported executor.
    path = pathlib.Path(config["app_path"]) / "engine.py"
    spec = importlib.util.spec_from_file_location("yasno_guard_engine", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return asyncio.run(
        module.run(config, dry_run=dry_run, force_check=force_check, hass=ha)
    )


@time_trigger("cron(*/15 * * * *)")
@service
async def yasno_address_check(dry_run=False, force_check=False, **kwargs):
    task.unique("yasno_address_check", kill_me=True)
    try:
        result = await task.executor(
            run_guard, hass, dict(pyscript.app_config), bool(dry_run), bool(force_check)
        )
    except Exception:
        # Preserve the journal for recovery and report bootstrap failures through
        # HA's native persistent-notification service.
        result = {
            "status": "bootstrap_error",
            "error": "app_journal_context_or_module_unavailable",
            "retry_minutes": 15,
        }
        if not dry_run:
            try:
                persistent_notification.create(
                    notification_id="yasno_address_guard",
                    title="Yasno address guard cannot start",
                    message="The app journal, HA context, or module could not be read. No correction was attempted. Existing integration state is unchanged; repair the app configuration. Retry on the next 15-minute trigger.",
                )
            except Exception:
                result["notification_failed"] = True
    attributes = (
        dict(state.getattr("pyscript.yasno_address_guard"))
        if state.exist("pyscript.yasno_address_guard")
        else {}
    )
    if result["status"] == "bootstrap_error":
        attributes.pop("next_check", None)
    elif result["status"] in ("verified", "validated_unchanged", "validated_change"):
        attributes["error"] = None
        attributes["notification_failed"] = False
    attributes.update(result)
    state.set(
        "pyscript.yasno_address_guard", result["status"], new_attributes=attributes
    )


@time_trigger("startup")
async def yasno_address_startup(**kwargs):
    await yasno_address_check(force_check=True)
