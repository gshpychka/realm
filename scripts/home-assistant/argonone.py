"""Native Argon ONE I2C fan control; never executed by migration validation.

The V3 add-on's 55/75 Celsius linear profile is retained. Pi5 I2C routing and
the case controller MUST pass the future physical acceptance checks. This
does not implement the case's separate power-button/shutdown protocol.
"""

import json
import math
import signal
import time
from pathlib import Path


def fan_speed(celsius):
    if not math.isfinite(celsius) or celsius < -20 or celsius > 150:
        raise ValueError("invalid temperature")
    # The installed add-on truncates Celsius before its integer linear curve.
    return max(0, min(100, (int(celsius) - 55) * 5))


def write_speed(bus, speed):
    # V3 uses register 0x80, unlike the older Pi4 write-byte protocol.
    # adamoutler/HassOSArgonOneAddon@fb3c5c9, argonOneV3Linear/run.sh.
    bus.write_byte_data(0x1A, 0x80, speed)


def main():
    from smbus2 import SMBus

    state = Path("/run/argonone/fan.json")

    def terminate(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    with SMBus(1) as bus:
        # Full speed until a valid thermal reading is available.
        write_speed(bus, 100)
        try:
            while True:
                temperature = (
                    int(Path("/sys/class/thermal/thermal_zone0/temp").read_text())
                    / 1000
                )
                speed = fan_speed(temperature)
                write_speed(bus, speed)
                temporary = state.with_suffix(".tmp")
                temporary.write_text(
                    json.dumps({"speed": speed, "temperature": temperature}) + "\n"
                )
                temporary.replace(state)
                time.sleep(30)
        finally:
            state.unlink(missing_ok=True)
            write_speed(bus, 100)


if __name__ == "__main__":
    main()
