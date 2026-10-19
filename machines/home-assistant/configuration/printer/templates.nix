{ entities }:
let
  template = import ../template.nix;
  ignoredPrinterErrors = [
    "HMS_0701_2500_0002_0001" # AMS B drying without a power adapter
    "HMS_0300_A700_0003_0001" # Informational chamber/filtration fan notice
  ];
in
{
  printer_errors = {
    output = "text";
    file = "printer/printer-errors.jinja";
    bindings = {
      IGNORED_PRINTER_ERRORS = ignoredPrinterErrors;
      BALCONY_H2_C_HMS_ERRORS = entities.binary_sensor.balconyH2CHmsErrors;
      BALCONY_H2_C_PRINT_ERROR = entities.binary_sensor.balconyH2CPrintError;
    };
  };
  restore_chamber = template.variable "chamber_light_was_off" // {
    output = "boolean";
  };
  print_finished = {
    output = "text";
    file = "printer/print-finished.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
  chamber_was_off = {
    output = "boolean";
    file = "printer/chamber-was-off.jinja";
    bindings = {
      BALCONY_H2_C_CHAMBER_LIGHT = entities.light.balconyH2CChamberLight;
    };
  };
  print_chronometer = {
    output = "boolean";
    file = "printer/print-chronometer.jinja";
  };
  print_percent = {
    output = "text";
    file = "printer/print-percent.jinja";
  };
  print_color = {
    output = "text";
    file = "printer/print-color.jinja";
  };
  print_progress = template.variable "progress" // {
    output = "integer";
  };
  print_when = template.variable "end_ts" // {
    output = "integer";
  };
  print_status = {
    output = "text";
    file = "printer/print-status.jinja";
    bindings = {
      BALCONY_H2_C_CURRENT_STAGE = entities.sensor.balconyH2CCurrentStage;
    };
  };
  print_ok = {
    output = "boolean";
    file = "printer/print-ok.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
  print_final_text = {
    output = "text";
    file = "printer/print-final-text.jinja";
  };
  print_final_icon = {
    output = "text";
    file = "printer/print-final-icon.jinja";
  };
  print_final_color = {
    output = "text";
    file = "printer/print-final-color.jinja";
  };
  print_final_progress = {
    output = "integer";
    file = "printer/print-final-progress.jinja";
  };
  print_final_status = {
    output = "text";
    file = "printer/print-final-status.jinja";
  };
  end_ts = {
    output = "integer";
    file = "printer/end-ts.jinja";
    bindings = {
      BALCONY_H2_C_END_TIME = entities.sensor.balconyH2CEndTime;
    };
  };
  layer = {
    output = "integer";
    file = "printer/layer.jinja";
    bindings = {
      BALCONY_H2_C_CURRENT_LAYER = entities.sensor.balconyH2CCurrentLayer;
    };
  };
  layers = {
    output = "integer";
    file = "printer/layers.jinja";
    bindings = {
      BALCONY_H2_C_TOTAL_LAYER_COUNT = entities.sensor.balconyH2CTotalLayerCount;
    };
  };
  paused = {
    output = "boolean";
    file = "printer/paused.jinja";
    bindings = {
      BALCONY_H2_C_PRINT_STATUS = entities.sensor.balconyH2CPrintStatus;
    };
  };
  progress = {
    output = "integer";
    file = "printer/progress.jinja";
    bindings = {
      BALCONY_H2_C_PRINT_PROGRESS = entities.sensor.balconyH2CPrintProgress;
    };
  };
  task = {
    output = "text";
    file = "printer/task.jinja";
    bindings = {
      BALCONY_H2_C_TASK_NAME = entities.sensor.balconyH2CTaskName;
    };
  };
  print_answer = {
    output = "text";
    file = "printer/print-answer.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
  print_prompt = {
    output = "text";
    file = "printer/print-prompt.jinja";
    bindings = {
      BALCONY_H2_C_TASK_NAME = entities.sensor.balconyH2CTaskName;
      BALCONY_H2_C_PRINT_STATUS = entities.sensor.balconyH2CPrintStatus;
      BALCONY_H2_C_CURRENT_STAGE = entities.sensor.balconyH2CCurrentStage;
      BALCONY_H2_C_PRINT_PROGRESS = entities.sensor.balconyH2CPrintProgress;
      BALCONY_H2_C_CURRENT_LAYER = entities.sensor.balconyH2CCurrentLayer;
      BALCONY_H2_C_TOTAL_LAYER_COUNT = entities.sensor.balconyH2CTotalLayerCount;
    };
  };
  print_verdict = {
    output = "text";
    file = "printer/print-verdict.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
  print_eta = {
    output = "text";
    file = "printer/print-eta.jinja";
    bindings = {
      BALCONY_H2_C_END_TIME = entities.sensor.balconyH2CEndTime;
    };
  };
  print_error = {
    output = "nullable-text";
    file = "printer/print-error.jinja";
    bindings = {
      BALCONY_H2_C_PRINT_ERROR = entities.binary_sensor.balconyH2CPrintError;
    };
  };
}
