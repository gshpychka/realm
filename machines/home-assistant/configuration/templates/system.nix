{
  entities,
  literal,
  mk,
  fields,
}:
{
  announcement = mk "text" "{{ announcement }}";
  has_announcement = mk "boolean" "{{ announcement != '' }}";
  device_offline = fields "text" "{% set device = dig(trigger | default(none), ['event', 'data', 'device_id']) %}{{ (device_attr(device, 'name_by_user') or device_attr(device, 'name') or 'Zigbee device') if device else 'Zigbee device' }} is offline";
  message = mk "text" "{{ message }}";
  provider_changed = mk "text" "Internet provider changed to {{states(${literal entities.sensor.internetProvider})}}";
}
