{ entities }:
let
  template = import ../template.nix;
in
{
  announcement = template.variable "announcement" // {
    output = "text";
  };
  has_announcement = {
    output = "boolean";
    file = "system/has-announcement.jinja";
  };
  device_offline = {
    output = "text";
    file = "system/device-offline.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
  message = template.variable "message" // {
    output = "text";
  };
  provider_changed = {
    output = "text";
    file = "system/provider-changed.jinja";
    bindings = {
      INTERNET_PROVIDER = entities.sensor.internetProvider;
    };
  };
}
