# Entity names are the public interface used by automations, scripts and scenes.
{
  ai_task = {
    openaiAiTask = "ai_task.openai_ai_task";
    printWatcher = "ai_task.print_watcher";
  };
  binary_sensor = {
    balconyH2CHmsErrors = "binary_sensor.balcony_h2c_hms_errors";
    balconyH2CPrintError = "binary_sensor.balcony_h2c_print_error";
    cityPower = "binary_sensor.city_power";
    hoard = "binary_sensor.hoard";
    leakSensorAMoisture = "binary_sensor.leak_sensor_a_moisture";
    leakSensorBMoisture = "binary_sensor.leak_sensor_b_moisture";
    ollamaStatus = "binary_sensor.ollama_status";
    reaperPing = "binary_sensor.reaper_ping";
    slzb06P10Ethernet = "binary_sensor.slzb_06p10_ethernet";
  };
  button = {
    reaperWake = "button.wake_on_lan_c8_7f_54_0b_fb_8c";
  };
  camera = {
    balconyH2CCamera = "camera.balcony_h2c_camera";
  };
  climate = {
    airConditioner = "climate.air_conditioner";
  };
  conversation = {
    chatgpt2 = "conversation.chatgpt_2";
    chatgptExpert = "conversation.chatgpt_expert";
  };
  input_boolean = {
    fullyLoaded = "input_boolean.homeassistant_fully_loaded";
  };
  input_button = {
    reaperWindows = "input_button.reaper_windows";
  };
  light = {
    balconyH2CChamberLight = "light.balcony_h2c_chamber_light";
    bedLight = "light.bed_light";
    cuteLights = "light.cute_lights";
    kitchenLights = "light.kitchen_lights";
    lavaLamp = "light.lava_lamp";
    overhead4Light = "light.overhead_4_light";
    partyLight = "light.party_light";
    plantLight = "light.plant_light";
    roomOverheadLights = "light.room_overhead_lights";
  };
  media_player = {
    allHearingGod = "media_player.all_hearing_god";
    plexTv = "media_player.plex_tv";
    soundbar = "media_player.soundbar";
    soundbarSmartthings2 = "media_player.soundbar_smartthings_2";
    tv = "media_player.tv";
    tvQe65S95Cauxua = "media_player.tv_qe65s95cauxua";
  };
  scene = {
    night = "scene.night";
    tvWatching = "scene.tv_watching";
  };
  select = {
    kitchenAssistant = "select.home_assistant_voice_09e1bb_assistant";
    roomAssistant = "select.room_assistant_assistant";
  };
  sensor = {
    balconyH2CCurrentLayer = "sensor.balcony_h2c_current_layer";
    balconyH2CCurrentStage = "sensor.balcony_h2c_current_stage";
    balconyH2CEndTime = "sensor.balcony_h2c_end_time";
    balconyH2CPrintProgress = "sensor.balcony_h2c_print_progress";
    balconyH2CPrintStatus = "sensor.balcony_h2c_print_status";
    balconyH2CTaskName = "sensor.balcony_h2c_task_name";
    balconyH2CTotalLayerCount = "sensor.balcony_h2c_total_layer_count";
    batteryCellImbalance = "sensor.battery_cell_imbalance";
    batteryCharge = "sensor.battery_charge";
    batteryHighCellVoltage = "sensor.battery_high_cell_voltage";
    batteryHighChargeCurrent = "sensor.battery_high_charge_current";
    batteryHighChargeTemperature = "sensor.battery_high_charge_temperature";
    batteryHighDischargeCurrent = "sensor.battery_high_discharge_current";
    batteryHighTemperature = "sensor.battery_high_temperature";
    batteryLowChargeTemperature = "sensor.battery_low_charge_temperature";
    batteryLowTemperature = "sensor.battery_low_temperature";
    batteryLowVoltage = "sensor.battery_low_voltage";
    batteryRemainingTime = "sensor.battery_remaining_time";
    internetProvider = "sensor.internet_provider";
    multiplusHighDcCurrentAlarm = "sensor.multiplus_high_dc_current_alarm";
    multiplusHighDcVoltageAlarm = "sensor.multiplus_high_dc_voltage_alarm";
    multiplusHighTemperatureAlarm = "sensor.multiplus_high_temperature_alarm";
    multiplusLowBatteryAlarm = "sensor.multiplus_low_battery_alarm";
    multiplusOutputPowerL1 = "sensor.multiplus_output_power_l1";
    multiplusOverloadAlarm = "sensor.multiplus_overload_alarm";
    multiplusRippleAlarm = "sensor.multiplus_ripple_alarm";
    multiplusTemperatureSensorAlarm = "sensor.multiplus_temperature_sensor_alarm";
    multiplusVoltageSensorAlarm = "sensor.multiplus_voltage_sensor_alarm";
    yasnoNextPower = "sensor.yasno_next_power";
    yasnoPower = "sensor.yasno_power";
  };
  stt = {
    whisperReaper = "stt.whisper_reaper";
  };
  switch = {
    coldWaterValve = "switch.cold_water_valve";
    dysonNightMode = "switch.dyson_night_mode";
    hotWaterValve = "switch.hot_water_valve";
    reaperPower = "switch.reaper_power";
  };
  timer = {
    movieSceneCooldown = "timer.movie_scene_cooldown";
    movieSceneOfferWindow = "timer.movie_scene_offer_window";
  };
  tts = {
    elevenlabs = "tts.elevenlabs";
    openaiTtsKokoro = "tts.openai_tts_kokoro";
  };
  weather = {
    openweathermap = "weather.openweathermap";
  };
}
