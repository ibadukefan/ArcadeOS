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

# Fixed command table. Nothing here is ever built from request data.
COMMANDS = {
    "shutdown": ["/sbin/poweroff"],
    "restart": ["/sbin/reboot"],
}


def log(msg):
    sys.stdout.write("arcadeos-agent: %s\n" % msg)
    sys.stdout.flush()


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
            self._reply(200, {"ok": True, "service": "arcadeos-agent"})
        else:
            self._reply(405, {"ok": False, "error": "use POST"})

    def do_POST(self):  # noqa: N802
        command = self._command()
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
    log("listening on http://%s:%d (loopback only)" % (HOST, PORT))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
