{
  asusrouter = {
    version = "0.40.1";
    source = {
      owner = "Vaskivskyi";
      repo = "ha-asusrouter";
      rev = "0.40.1";
      hash = "sha256-NoorZl9zZdULA42JAXGp/65GDgiLuAMuavn1otJ2KSs=";
    };
  };
  bambu_lab = {
    version = "2.2.26";
    source = {
      owner = "greghesp";
      repo = "ha-bambulab";
      rev = "v2.2.26";
      hash = "sha256-9KsIzem7BjImUW+BTnAUYJ7CnU5bFpet7D2HhmOwTbA=";
    };
  };
  dyson_local = {
    version = "1.5.7";
    source = {
      owner = "libdyson-wg";
      repo = "ha-dyson";
      rev = "v1.5.7";
      hash = "sha256-V5RCepikTDrjZwi6MfRislpV2F9jR1MqwWxTq0GPBp4=";
    };
    patches = [
      ./patches/dyson-local/dyson-vacuum-api.patch
    ];
  };
  fontawesome = {
    version = "2.3.0";
    source = {
      owner = "thomasloven";
      repo = "hass-fontawesome";
      rev = "v.2.3.0";
      hash = "sha256-9jNuBm4lJfv3oQENfEDnmo7x8tMEkhJU8QzwY5hPPxI=";
    };
  };
  glinet_router = {
    version = "1.6.5";
    source = {
      owner = "vithurshanselvarajah";
      repo = "ha-glinet-router";
      rev = "v1.6.5";
      hash = "sha256-IRRpnQI841jgYTvZDhTJNQz5/TPUP9s0Y7NJ0lJpD2k=";
    };
  };
  groq_cloud_api = {
    version = "0.2.4";
    source = {
      owner = "HunorLaczko";
      repo = "ha-groq-cloud-api";
      rev = "v0.2.4";
      hash = "sha256-3Fcr3PojQN8gwh0CiTxY9VRGVVzgMa/0JzSAhCdC/lo=";
    };
  };
  hacs = {
    version = "2.0.5";
    source = {
      url = "https://github.com/hacs/integration/releases/download/2.0.5/hacs.zip";
      hash = "sha256-l75rgkpPOOaDcozG3XI2f2uLrQpDQosbO5h6MIet9BM=";
    };
    releaseAsset = true;
  };
  hassarr = {
    version = "0.2.0";
    source = {
      owner = "TegridyTate";
      repo = "Hassarr";
      rev = "156a5bb3a806af61e3c26e9f3018a909ad4a6eb3";
      hash = "sha256-Zxoq2qHYA77oKqrNSyOJLpMIkhP0fh4+QmFUvFLyHgo=";
    };
  };
  homeeasy_local = {
    version = "1.1.2";
    source = {
      owner = "ki0ki0";
      repo = "homeeasy_ha_local";
      rev = "92a23dfcf8899bc0d035d9690c31d4cbd6165eef";
      hash = "sha256-EOfHNP0VpROQL7wkMG8Ndlc2b1IQ3vBQj1urxDi2Nso=";
    };
  };
  nova_poshta = {
    version = "1.3.4";
    source = {
      owner = "krasnoukhov";
      repo = "homeassistant-nova-poshta";
      rev = "v1.3.4";
      hash = "sha256-qaE4vawbYB6AaeQiNQ09CBj0kKgrQ1cWUZm6JJKJ/e8=";
    };
  };
  openai_tts = {
    version = "3.11";
    source = {
      owner = "sfortis";
      repo = "openai_tts";
      rev = "v3.11";
      hash = "sha256-eBSp1gKPB7NE2zJgs8+czdUrEN1qg7vsKSzr+5484pk=";
    };
  };
  openai_whisper_cloud = {
    version = "2.0.0";
    source = {
      owner = "fabio-garavini";
      repo = "ha-openai-whisper-stt-api";
      rev = "2.0.0";
      hash = "sha256-O7v1yggHId7HD0QDM41XrvG13mYVyMA2EbKh0rA5w24=";
    };
  };
  pyscript = {
    version = "2.1.0";
    source = {
      owner = "custom-components";
      repo = "pyscript";
      rev = "2.1.0";
      hash = "sha256-PGBlMAfkkW7GrZuGHHQgDK4ib1m2nDL7UWpsWkfRojM=";
    };
  };
  samsungtv_smart = {
    version = "0.14.5";
    source = {
      owner = "ollo69";
      repo = "ha-samsungtv-smart";
      rev = "v0.14.5";
      hash = "sha256-J3+HD/jMJDIBSiVJnHvjOJ3yswck+DV3XpPqIoR5/sU=";
    };
  };
  smartthings_soundbar = {
    version = "v1.0.6";
    source = {
      owner = "PiotrMachowski";
      repo = "Home-Assistant-custom-components-SmartThings-Soundbar";
      rev = "v1.0.6";
      hash = "sha256-QPBNLr30kqVLxAnESmtd+uQeOyjw9Lz06Szsb0qDEW0=";
    };
  };
  victron = {
    version = "v0.7.0-beta-6";
    source = {
      owner = "sfstar";
      repo = "hass-victron";
      rev = "v0.7.0-beta-6";
      hash = "sha256-tzhaFwwWxaVSt5+JeHToFKjgn7MVEAqMMpWgNay9Pl4=";
    };
  };
  victron_mqtt = {
    version = "2026.10.0";
    source = {
      owner = "tomer-w";
      repo = "ha-victron-mqtt";
      rev = "v2026.10.0";
      hash = "sha256-JGkHtXpQIhb7/UjGwc3Y7ugUvlQIvco2MSbdSI+bZu0=";
    };
  };
  victron_vrm_api = {
    version = "1.8";
    source = {
      owner = "jayjojayson";
      repo = "hass-victron-vrm-api";
      rev = "v_1.8";
      hash = "sha256-E/ygfDeoHwefKYvhcDzNurnkbos7EkcS0zG7rUpW2Ks=";
    };
  };
  yasno_outages = {
    version = "3.1.4";
    source = {
      owner = "denysdovhan";
      repo = "ha-yasno-outages";
      rev = "v3.1.4";
      hash = "sha256-U6K87lM0IrL8YfkU5L5ywW83DC6U4B+fwp4ZO3UJDgs=";
    };
  };
  zha_toolkit = {
    version = "v1.2.5";
    source = {
      owner = "mdeweerd";
      repo = "zha-toolkit";
      rev = "v1.2.5";
      hash = "sha256-ryAVsxihBGqge0fXJ90px82rvsmb5ecJdUUImcZigDM=";
    };
  };
}
