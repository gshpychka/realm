# ZHA button and device-offline events bind to device identities.
{
  roomLightswitch = "d7f71ba6e41eaa5f4e1673b72cac5de5";
  bedButton = "2f71ab6f29ad7b89d7067ae6da4afe76";
  roomTableButton = "6cfb4e8f3b78212cb5a5c37e730bc245";
  bedShelfButton = "1d6d18c0607f109486576f159ae0d7c0";
  kitchenLightswitch = "57a19124691d23a75510acb5b4f70903";
  kitchenTableButton = "7d75a987c8709f5ca514f1d820703461";
  hotWaterValve = "509308a00a0dba896fe955f85dc9eaf6";
  coldWaterValve = "df5c8ea1666ecfadccb338daa5cd41fb";
  # These device targets preserve voice fan-out and wake requests; their entity
  # bindings require private-inventory verification during acceptance.
  roomVoiceTarget = "6711f762ca5f27d9aca0a0cfcdab92ba";
  kitchenVoiceTarget = "e2a9b5f6b3842bc75aa39038200b8a79";
  reaperWakeTarget = "e3155405d8b7e8259c71146a6f111324";
  # The API client constructs device URLs from this vendor identity.
  soundbarCloud = "53930054-9a59-2383-a9fb-abfef7d05518";
}
