#!/usr/bin/env python3
"""
arcadeos-gpio — watch a GPIO pin and trigger a clean poweroff.

Wire a momentary push button between the configured pin and any ground pin.
The internal pull-up is enabled, so the button only needs two wires and no
external resistor.

  ARCADEOS_GPIO_PIN       BCM pin number          (default 3)
  ARCADEOS_GPIO_HOLD      seconds to hold         (default 1.2)
  ARCADEOS_GPIO_ACTION    poweroff | reboot       (default poweroff)

The hold time exists because a cabinet button gets knocked. A quarter second
of contact should not take the machine down mid-game.

Note: Raspberry Pi firmware also offers `dtoverlay=gpio-shutdown`, which does
this in the kernel and keeps working even if userspace has wedged. It is the
more robust option and setup-arcade.sh can install it instead (--gpio-overlay).
This service exists because it is configurable at runtime and can be watched
with journalctl, which matters when you are debugging a cabinet.
"""

import os
import shutil
import subprocess
import sys
import time

PIN = int(os.environ.get("ARCADEOS_GPIO_PIN", "3"))
HOLD = float(os.environ.get("ARCADEOS_GPIO_HOLD", "1.2"))
ACTION = os.environ.get("ARCADEOS_GPIO_ACTION", "poweroff").strip().lower()

if ACTION not in ("poweroff", "reboot"):
    sys.stderr.write("arcadeos-gpio: invalid ARCADEOS_GPIO_ACTION %r\n" % ACTION)
    raise SystemExit(2)


def log(msg):
    sys.stdout.write("arcadeos-gpio: %s\n" % msg)
    sys.stdout.flush()


def fire():
    binary = shutil.which(ACTION) or "/sbin/%s" % ACTION
    log("button held; running %s" % binary)
    try:
        subprocess.Popen([binary], close_fds=True)
    except Exception as exc:  # noqa: BLE001
        log("failed to run %s: %s" % (binary, exc))


def run_gpiozero():
    """
    Preferred path. gpiozero picks its own backend (lgpio on Bookworm), so
    this keeps working across the sysfs-to-libgpiod transition that broke a
    great many older shutdown scripts.
    """
    from gpiozero import Button  # noqa: PLC0415 - optional dependency

    button = Button(PIN, pull_up=True, hold_time=HOLD)
    button.when_held = lambda: fire()
    log("watching BCM%d via gpiozero, hold %.1fs -> %s" % (PIN, HOLD, ACTION))
    while True:
        time.sleep(3600)


def run_gpiod():
    """Fallback for images without gpiozero but with python3-libgpiod."""
    import gpiod  # noqa: PLC0415 - optional dependency

    chip = gpiod.Chip("gpiochip0")
    line = chip.get_line(PIN)
    line.request(consumer="arcadeos", type=gpiod.LINE_REQ_DIR_IN,
                 flags=gpiod.LINE_REQ_FLAG_BIAS_PULL_UP)
    log("watching BCM%d via libgpiod, hold %.1fs -> %s" % (PIN, HOLD, ACTION))

    pressed_at = None
    fired = False
    while True:
        # Active-low: the button pulls the line to ground.
        down = line.get_value() == 0
        now = time.monotonic()
        if down:
            if pressed_at is None:
                pressed_at = now
            elif not fired and (now - pressed_at) >= HOLD:
                fired = True
                fire()
        else:
            pressed_at = None
            fired = False
        time.sleep(0.05)


def main():
    try:
        run_gpiozero()
        return 0
    except ImportError:
        log("gpiozero unavailable, trying libgpiod")
    except Exception as exc:  # noqa: BLE001
        log("gpiozero backend failed (%s), trying libgpiod" % exc)

    try:
        run_gpiod()
        return 0
    except ImportError:
        log("no GPIO backend available; install python3-gpiozero or python3-libgpiod")
        return 1
    except Exception as exc:  # noqa: BLE001
        log("libgpiod backend failed: %s" % exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
