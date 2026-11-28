import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import automation
from esphome.automation import maybe_simple_id
from esphome.components import esp32, microphone, speaker
from esphome.const import CONF_ID, CONF_MICROPHONE, CONF_SPEAKER, CONF_URL

DEPENDENCIES = ["esp32", "api", "microphone", "speaker"]
AUTO_LOAD = ["audio", "json", "ring_buffer"]

CONF_TOKEN = "token"
CONF_WAKE_WORD = "wake_word"
CONF_ON_PHASE = "on_phase"
CONF_ON_ADMITTED = "on_admitted"
CONF_ON_END = "on_end"
CONF_ON_ERROR = "on_error"
CONF_ON_STARTUP_FAILURE = "on_startup_failure"

voice_broker_ns = cg.esphome_ns.namespace("voice_broker")
VoiceBroker = voice_broker_ns.class_("VoiceBroker", cg.Component)
StartAction = voice_broker_ns.class_(
    "StartAction", automation.Action, cg.Parented.template(VoiceBroker)
)
StopAction = voice_broker_ns.class_(
    "StopAction", automation.Action, cg.Parented.template(VoiceBroker)
)
IsRunningCondition = voice_broker_ns.class_(
    "IsRunningCondition", automation.Condition, cg.Parented.template(VoiceBroker)
)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(VoiceBroker),
        cv.Required(CONF_URL): cv.string_strict,
        # One 16-bit channel: the broker's echo canceller works on mono.
        cv.Required(CONF_MICROPHONE): microphone.microphone_source_schema(
            min_bits_per_sample=16,
            max_bits_per_sample=16,
            min_channels=1,
            max_channels=1,
        ),
        # Must accept 24 kHz mono 16-bit (a resampler speaker does).
        cv.Required(CONF_SPEAKER): cv.use_id(speaker.Speaker),
        # `phase` is "listening", "thinking" or "replying".
        cv.Optional(CONF_ON_PHASE): automation.validate_automation(single=True),
        cv.Optional(CONF_ON_ADMITTED): automation.validate_automation(single=True),
        cv.Optional(CONF_ON_END): automation.validate_automation(single=True),
        cv.Optional(CONF_ON_STARTUP_FAILURE): automation.validate_automation(
            single=True
        ),
        cv.Optional(CONF_ON_ERROR): automation.validate_automation(single=True),
    }
).extend(cv.COMPONENT_SCHEMA)

FINAL_VALIDATE_SCHEMA = cv.Schema(
    {
        cv.Required(
            CONF_MICROPHONE
        ): microphone.final_validate_microphone_source_schema("voice_broker", 16000)
    },
    extra=cv.ALLOW_EXTRA,
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    esp32.add_idf_component(name="espressif/esp_websocket_client", ref="1.7.0")

    cg.add(var.set_url(config[CONF_URL]))
    cg.add(
        var.set_microphone_source(
            await microphone.microphone_source_to_code(config[CONF_MICROPHONE])
        )
    )
    cg.add(var.set_speaker(await cg.get_variable(config[CONF_SPEAKER])))

    if CONF_ON_PHASE in config:
        await automation.build_automation(
            var.get_phase_trigger(), [(cg.std_string, "phase")], config[CONF_ON_PHASE]
        )
    if CONF_ON_ADMITTED in config:
        await automation.build_automation(
            var.get_admitted_trigger(), [(cg.uint32, "generation")], config[CONF_ON_ADMITTED]
        )
    if CONF_ON_END in config:
        await automation.build_automation(
            var.get_end_trigger(), [], config[CONF_ON_END]
        )
    if CONF_ON_STARTUP_FAILURE in config:
        await automation.build_automation(
            var.get_startup_failure_trigger(),
            [(cg.std_string, "wake_word")],
            config[CONF_ON_STARTUP_FAILURE],
        )
    if CONF_ON_ERROR in config:
        await automation.build_automation(
            var.get_error_trigger(), [], config[CONF_ON_ERROR]
        )


ACTION_SCHEMA = maybe_simple_id({cv.GenerateID(): cv.use_id(VoiceBroker)})


@automation.register_action(
    "voice_broker.start",
    StartAction,
    cv.Schema(
        {
            cv.GenerateID(): cv.use_id(VoiceBroker),
            cv.Optional(CONF_WAKE_WORD, default=""): cv.templatable(cv.string),
        }
    ),
    synchronous=True,
)
async def start_to_code(config, action_id, template_arg, args):
    var = cg.new_Pvariable(action_id, template_arg)
    await cg.register_parented(var, config[CONF_ID])
    wake_word = await cg.templatable(config[CONF_WAKE_WORD], args, cg.std_string)
    cg.add(var.set_wake_word(wake_word))
    return var


@automation.register_action(
    "voice_broker.stop", StopAction, ACTION_SCHEMA, synchronous=True
)
async def stop_to_code(config, action_id, template_arg, args):
    var = cg.new_Pvariable(action_id, template_arg)
    await cg.register_parented(var, config[CONF_ID])
    return var


@automation.register_condition(
    "voice_broker.is_running", IsRunningCondition, ACTION_SCHEMA
)
async def is_running_to_code(config, condition_id, template_arg, args):
    var = cg.new_Pvariable(condition_id, template_arg)
    await cg.register_parented(var, config[CONF_ID])
    return var
