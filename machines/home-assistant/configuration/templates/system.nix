{ entities }:
{
  announcement = {
    output = "text";
    file = "system/announcement.jinja";
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
  message = {
    output = "text";
    file = "system/message.jinja";
  };
  provider_changed = {
    output = "text";
    file = "system/provider-changed.jinja";
    bindings = {
      INTERNET_PROVIDER = entities.sensor.internetProvider;
    };
  };
}
