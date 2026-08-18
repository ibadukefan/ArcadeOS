#!/usr/bin/env python3
"""
arcadeos-agent — the only thing standing between a player and a yanked power
lead.

Chromium in a kiosk cannot power the machine down, so the settings screen asks
this service to do it. It binds to 127.0.0.1 ONLY, accepts exactly three fixed
commands, and takes no parameters of any kind. There is no path through it
that runs arbitrary input, and nothing off-machine can reach it.

  POST /shutdown   clean poweroff
  POST /restart    clean reboot
  POST /pair       open a Bluetooth pairing window

Standard library only. Runs as root because poweroff requires it; the
correspondingly small attack surface is the point of keeping it this dumb.
"""

import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse

HOST = "127.0.0.1"
PORT = 8127
PAIR_SECONDS = 120

# --- liveness watchdog -------------------------------------------------------
#
# systemd's Restart=always catches a crash. It does nothing for a hang: a
# wedged GPU or a stuck script leaves Chromium alive, the unit "active", and a
# frozen picture on the cabinet indefinitely.
#
# The front end posts /alive at the end of every frame, so the beats stop the
# moment frames stop. If they go quiet for STALL_SECONDS the kiosk is
# restarted. The watchdog only arms after the first beat, so a machine with the
# front end disabled, or one still booting, is never touched.
STALL_SECONDS = 30
# After a restart, wait this long before judging again — Chromium needs time to
# come back before its silence means anything.
GRACE_SECONDS = 90
KIOSK_UNIT = "arcadeos.service"

# Fixed command table. Nothing here is ever built from request data.
COMMANDS = {
    "shutdown": ["/sbin/poweroff"],
    "restart": ["/sbin/reboot"],
}


def log(msg):
    sys.stdout.write("arcadeos-agent: %s\n" % msg)
    sys.stdout.flush()


class Liveness:
    """Tracks front-end heartbeats and restarts the kiosk if they stop."""

    def __init__(self):
        self.lock = threading.Lock()
        self.last = 0.0
        self.armed = False
        self.restarts = 0
        self.next_check = time.monotonic() + GRACE_SECONDS

    def beat(self):
        with self.lock:
            if not self.armed:
                log("front end is alive; watchdog armed")
            self.armed = True
            self.last = time.monotonic()

    def snapshot(self):
        with self.lock:
            age = (time.monotonic() - self.last) if self.armed else None
            return {"armed": self.armed, "age": age, "restarts": self.restarts}

    def watch(self):
        while True:
            time.sleep(5)
            now = time.monotonic()
            with self.lock:
                if not self.armed or now < self.next_check:
                    continue
                stalled = (now - self.last) > STALL_SECONDS
                if not stalled:
                    continue
                self.restarts += 1
                self.next_check = now + GRACE_SECONDS
                # Require a fresh beat before judging again, so a kiosk that
                # never comes back is not restarted every 30 seconds forever.
                self.armed = False
                count = self.restarts

            log("no frames for %ds — restarting %s (restart #%d)"
                % (STALL_SECONDS, KIOSK_UNIT, count))
            binary = resolve("systemctl")
            if not binary:
                log("systemctl not found; cannot restart")
                continue
            try:
                subprocess.Popen([binary, "restart", KIOSK_UNIT], close_fds=True)
            except Exception as exc:  # noqa: BLE001
                log("restart failed: %s" % exc)


LIVENESS = Liveness()


def resolve(path):
    """Find a binary, tolerating sbin not being on PATH under systemd."""
    if os.path.isabs(path) and os.path.exists(path):
        return path
    found = shutil.which(os.path.basename(path))
    if found:
        return found
    for prefix in ("/sbin", "/usr/sbin", "/bin", "/usr/bin"):
        candidate = os.path.join(prefix, os.path.basename(path))
        if os.path.exists(candidate):
            return candidate
    return None


def run_power(command):
    """
    Power off or reboot, after a short delay.

    The delay exists so the HTTP response actually reaches Chromium before the
    system starts tearing down — otherwise the UI shows a failure on the way
    to a perfectly successful shutdown.
    """
    argv = COMMANDS[command]
    binary = resolve(argv[0])
    if not binary:
        log("cannot find %s" % argv[0])
        return

    def go():
        time.sleep(0.7)
        log("executing %s" % binary)
        try:
            subprocess.Popen([binary], close_fds=True)
        except Exception as exc:  # noqa: BLE001 - last line of defence
            log("power command failed: %s" % exc)

    threading.Thread(target=go, daemon=True).start()


def run_pairing():
    """
    Put the adapter into pairing mode for a couple of minutes.

    bluetoothctl is driven on stdin rather than with --agent flags because the
    non-interactive interface differs across BlueZ versions on Bookworm, and
    this form has worked unchanged for years.
    """
    binary = resolve("bluetoothctl")
    if not binary:
        log("bluetoothctl not present; is bluez installed?")
        return

    script = (
        "power on\n"
        "agent NoInputNoOutput\n"
        "default-agent\n"
        "discoverable on\n"
        "pairable on\n"
        "scan on\n"
    )

    def go():
        try:
            proc = subprocess.Popen(
                [binary],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            proc.stdin.write(script)
            proc.stdin.flush()
            log("pairing window open for %ds" % PAIR_SECONDS)
            time.sleep(PAIR_SECONDS)
            try:
                proc.stdin.write("scan off\ndiscoverable off\nquit\n")
                proc.stdin.flush()
            except Exception:  # noqa: BLE001
                pass
            proc.terminate()
            log("pairing window closed")
        except Exception as exc:  # noqa: BLE001
            log("pairing failed: %s" % exc)

    threading.Thread(target=go, daemon=True).start()


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "arcadeos-agent/1.0"

    def _reply(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # The kiosk page is loaded from file://, whose origin is "null".
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _command(self):
        path = urllib.parse.urlparse(self.path).path
        return urllib.parse.unquote(path).strip("/").lower()

    def do_OPTIONS(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        self._reply(204, {})

    def do_GET(self):  # noqa: N802
        if self._command() in ("", "status", "health"):
            state = LIVENESS.snapshot()
            self._reply(200, {
                "ok": True,
                "service": "arcadeos-agent",
                "frontend": "alive" if state["armed"] else "not seen",
                "last_beat_s": round(state["age"], 1) if state["age"] is not None else None,
                "kiosk_restarts": state["restarts"],
            })
        else:
            self._reply(405, {"ok": False, "error": "use POST"})

    def _body(self, limit=600):
        try:
            n = min(int(self.headers.get("Content-Length") or 0), limit)
        except (TypeError, ValueError):
            return ""
        if n <= 0:
            return ""
        try:
            return self.rfile.read(n).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return ""

    def do_POST(self):  # noqa: N802
        command = self._command()

        # Heartbeat and log are hot-ish paths and deliberately do no work
        # beyond a timestamp and a print.
        if command == "alive":
            LIVENESS.beat()
            self._reply(200, {"ok": True})
            return
        if command == "log":
            # Front-end text. Printed as data on one line; it reaches journald
            # and nothing else, and is never interpreted as a command.
            text = self._body().replace("\n", " ").replace("\r", " ")
            log("frontend: %s" % text[:500])
            self._reply(200, {"ok": True})
            return

        if command in COMMANDS:
            log("accepted %s" % command)
            self._reply(200, {"ok": True, "command": command})
            run_power(command)
        elif command == "pair":
            log("accepted pair")
            self._reply(200, {"ok": True, "command": "pair", "seconds": PAIR_SECONDS})
            run_pairing()
        else:
            # Anything not on the list is refused without being echoed back.
            log("refused unknown command")
            self._reply(404, {"ok": False, "error": "unknown command"})

    def log_message(self, fmt, *args):
        """Silence per-request logging; we log decisions, not traffic."""
        return


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        http.server.ThreadingHTTPServer.server_bind(self)


def main():
    if os.geteuid() != 0:
        log("warning: not running as root; poweroff and reboot will fail")
    server = Server((HOST, PORT), Handler)
    threading.Thread(target=LIVENESS.watch, daemon=True).start()
    log("listening on http://%s:%d (loopback only)" % (HOST, PORT))
    log("kiosk watchdog: restart %s after %ds without frames"
        % (KIOSK_UNIT, STALL_SECONDS))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
