#!/usr/bin/env python3
"""
arcadeos-agent — the only thing standing between a player and a yanked power
lead.

Chromium in a kiosk cannot power the machine down, so the settings screen asks
this service to do it. It binds to 127.0.0.1 ONLY, accepts a fixed set of
commands, and takes no parameters of any kind.

  POST /shutdown   clean poweroff        (authorised)
  POST /restart    clean reboot          (authorised)
  POST /pair       Bluetooth pairing     (authorised)
  POST /alive      liveness heartbeat    (authorised)
  POST /log        diagnostic line       (authorised)
  GET  /           status, read only     (local, no token)

WHY THERE IS AN AUTHORISATION CHECK AT ALL

Binding to loopback keeps the network out; it does NOT keep web pages out. A
cross-origin POST with no custom headers is a CORS "simple request": the
browser sends it and only withholds the *response* from the caller. So before
this check existed, any web page opened in any browser on this machine could
POST /shutdown and power the cabinet off, and a DNS-rebinding attack could do
the same from a page the user merely visited. Verified, not theorised.

Three layers, cheapest first:

  1. Host must be loopback         — defeats DNS rebinding.
  2. Origin must be absent or null — the kiosk page is file://, so a real web
                                     origin means a website is calling us.
  3. A shared token                — set up alongside the kiosk, so other
                                     local processes cannot power off the box
                                     either. Skipped (loudly) if unconfigured,
                                     so a hand-run dist/arcade.html still works.

Standard library only. Runs as root because poweroff requires it; the
correspondingly small attack surface is the point of keeping it this dumb.
"""

import hmac
import http.server
import json
import os
import re
import shutil
import signal
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

# The VT the kiosk owns (TTYPath in arcadeos.service) and where the kernel
# reports which VT the console is on. Silence alone is not a hang: a person
# who pressed Ctrl+Alt+F2 for a rescue shell took the display away from the
# kiosk on purpose, and frames stopping is the expected result. The first
# cabinet's watchdog restarted the kiosk after 30s of that and snatched the
# screen back mid-keystroke — locking its owner out of their own console.
KIOSK_TTY = "tty1"
ACTIVE_VT_FILE = "/sys/class/tty/tty0/active"

# Shared secret, written by setup-arcade.sh and baked into the installed
# arcade.html. Absent in development, where the checks below still block the
# cross-origin and rebinding cases.
TOKEN_FILE = "/etc/arcadeos/agent.token"
TOKEN = ""

# Hosts we will answer to. Anything else is a rebinding attempt.
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1", "")

# Software updates. The agent only ever runs this one fixed script — nothing
# about the request chooses what executes — and runs it as a detached systemd
# unit so a slow git fetch can never wedge the agent. The script reports its
# progress into STATUS_FILE, which GET /update/status relays to the front end.
UPDATE_SCRIPT = "/opt/arcadeos/arcadeos-update.sh"
UPDATE_STATUS_FILE = "/var/lib/arcadeos/update-status.json"
UPDATE_UNIT = "arcadeos-update"

# Control characters are stripped from anything that reaches the journal: a
# log line carrying ANSI escapes can clear or recolour the terminal of whoever
# is reading `journalctl`, which is a cheap way to hide or fake a message.
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")

# Fixed command table. Nothing here is ever built from request data.
COMMANDS = {
    "shutdown": ["/sbin/poweroff"],
    "restart": ["/sbin/reboot"],
}

# Fallback: systemd's signal interface on PID 1 (systemd(1), "SIGNALS"):
# SIGRTMIN+5 starts reboot.target, SIGRTMIN+4 starts poweroff.target — the
# same clean paths the binaries take. This unit runs under ProtectSystem=
# strict and friends, and on a real cabinet the sandboxed /sbin/reboot
# accepted the command, exited quietly, and the machine stayed up — the
# owner pressed RESTART three times into that silence. A signal needs no
# filesystem, no D-Bus socket and no child process, so the sandbox cannot
# eat it.
POWER_SIGNALS = {
    "shutdown": signal.SIGRTMIN + 4,
    "restart": signal.SIGRTMIN + 5,
}


def log(msg):
    sys.stdout.write("arcadeos-agent: %s\n" % msg)
    sys.stdout.flush()


def load_token():
    """Read the shared token, if setup installed one."""
    try:
        with open(TOKEN_FILE, "r") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def clean_text(text, limit=500):
    """Make caller-supplied text safe to print into the journal."""
    return CONTROL_CHARS.sub(" ", str(text))[:limit]


def read_update_status():
    """Parse the status file the updater writes. None when absent or bad."""
    try:
        with open(UPDATE_STATUS_FILE, "r") as fh:
            raw = fh.read(4096)
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def update_running():
    """True while the update unit is active — refuses double-starts."""
    binary = shutil.which("systemctl")
    if not binary:
        return False
    try:
        rc = subprocess.call(
            [binary, "is-active", "--quiet", UPDATE_UNIT + ".service"],
            timeout=5,
        )
        return rc == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def start_update():
    """
    Launch the updater detached. systemd-run gives it its own unit, so it
    survives an agent restart (the updater restarts services, including this
    one) and its logs land in the journal under its own name.
    """
    if not os.path.isfile(UPDATE_SCRIPT) or not os.access(UPDATE_SCRIPT, os.X_OK):
        return False, "updater not installed"
    if update_running():
        return True, "already running"
    try:
        os.makedirs(os.path.dirname(UPDATE_STATUS_FILE), exist_ok=True)
        with open(UPDATE_STATUS_FILE, "w") as fh:
            json.dump({"phase": "starting", "msg": "starting", "done": False,
                       "updated": False, "error": ""}, fh)
    except OSError:
        pass
    runner = shutil.which("systemd-run")
    try:
        if runner:
            # systemd-run returns as soon as the unit is queued, so waiting on
            # it is cheap — and its exit code is the only way to notice that
            # systemd rejected the launch (e.g. running outside systemd).
            rc = subprocess.call(
                [runner, "--unit=" + UPDATE_UNIT, "--collect", UPDATE_SCRIPT],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
            )
            if rc == 0:
                return True, "started"
            log("systemd-run failed (rc=%d); running updater directly" % rc)
        # Development fallback: detach by session so we never wait on it.
        subprocess.Popen([UPDATE_SCRIPT], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True, "started"
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, "could not start updater: %s" % exc


def active_vt():
    """Which VT owns the console right now ("tty1"...), or "" if unknowable."""
    try:
        with open(ACTIVE_VT_FILE, "r") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def kiosk_unit_active():
    """False when an administrator stopped the kiosk unit on purpose."""
    binary = resolve("systemctl")
    if not binary:
        return True  # cannot tell (dev machine): judge liveness normally
    try:
        rc = subprocess.call(
            [binary, "is-active", "--quiet", KIOSK_UNIT],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return True
    return rc == 0


def watchdog_hold():
    """
    A reason silence must NOT be judged, or "".

    From the beat stream alone a hang and a human look identical: switch VTs
    and the kiosk stops drawing; stop the unit over SSH and the beats end.
    Both are deliberate, and restarting over either steals the machine back
    from its own operator.
    """
    vt = active_vt()
    if vt and vt != KIOSK_TTY:
        return "console is on %s" % vt
    if not kiosk_unit_active():
        return "%s is stopped" % KIOSK_UNIT
    return ""


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
        last_hold = ""
        while True:
            time.sleep(5)
            now = time.monotonic()
            with self.lock:
                due = self.armed and now >= self.next_check
                stalled = due and (now - self.last) > STALL_SECONDS
            if not stalled:
                continue

            hold = watchdog_hold()
            if hold:
                if hold != last_hold:
                    log("beats quiet but %s — watchdog holding" % hold)
                last_hold = hold
                with self.lock:
                    # A fresh window once the hold clears, so returning to the
                    # kiosk VT is not judged on silence accrued while away.
                    self.last = time.monotonic()
                continue
            last_hold = ""

            with self.lock:
                self.restarts += 1
                self.next_check = time.monotonic() + GRACE_SECONDS
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

    def go():
        time.sleep(0.7)
        if binary:
            log("executing %s" % binary)
            try:
                subprocess.Popen([binary], close_fds=True)
            except Exception as exc:  # noqa: BLE001 - last line of defence
                log("power command failed: %s" % exc)
        else:
            log("cannot find %s" % argv[0])
        # If the polite path worked, the system is tearing down and this
        # thread dies with it. If we are STILL RUNNING a few seconds later,
        # the command was eaten — by the unit's sandbox, a missing binary,
        # or a systemctl that could not reach PID 1 — so use the signal
        # interface, which none of those can block.
        time.sleep(3)
        log("still running after %s — signalling PID 1 directly" % command)
        try:
            os.kill(1, POWER_SIGNALS[command])
        except Exception as exc:  # noqa: BLE001
            log("signal fallback failed: %s" % exc)

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
    # Do not let a client that opens a connection and then says nothing hold a
    # worker thread indefinitely.
    timeout = 5

    def _authorised(self, need_token):
        """
        Decide whether to act on a request. See the module docstring for why
        loopback binding alone is not enough.
        """
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        if host not in LOOPBACK_HOSTS:
            return False, "host %s" % clean_text(host, 60)

        origin = self.headers.get("Origin")
        if origin not in (None, "", "null"):
            return False, "origin %s" % clean_text(origin, 60)

        if need_token and TOKEN:
            supplied = self.headers.get("X-ArcadeOS-Token") or ""
            # Constant time: this is a secret comparison, however local.
            if not hmac.compare_digest(supplied, TOKEN):
                return False, "bad token"

        return True, ""

    def _reply(self, code, payload):
        # A 204 carries no body, by RFC and in practice: sending one leaves
        # stray bytes on a kept-alive connection, and the preflight for
        # every authorised command is a 204 — the next request on that
        # socket then parses garbage.
        body = b"" if code == 204 else json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # The kiosk page is loaded from file://, whose origin is "null".
        self.send_header("Access-Control-Allow-Origin", "null")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-ArcadeOS-Token")
        self.send_header("Access-Control-Max-Age", "600")
        if getattr(self, "send_header_extra", False):
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _command(self):
        path = urllib.parse.urlparse(self.path).path
        return urllib.parse.unquote(path).strip("/").lower()

    def do_OPTIONS(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        # The preflight is the one chance to stop a browser sending a request
        # that carries our custom header, so it gets the same origin check.
        ok, why = self._authorised(need_token=False)
        if not ok:
            log("refused preflight: %s" % why)
            self._reply(403, {"ok": False, "error": "forbidden"})
            return
        # Chromium's Private Network Access check applies to a page reaching
        # loopback. It only ever asks on the preflight, and the request is
        # already past the host, origin and (on the POST) token checks by the
        # time we answer, so granting it widens nothing.
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            self.send_header_extra = True
        self._reply(204, {})

    def do_GET(self):  # noqa: N802
        # Read only, so no token — `curl http://127.0.0.1:8127/` stays a usable
        # health check over SSH — but still loopback and same-origin only.
        ok, why = self._authorised(need_token=False)
        if not ok:
            log("refused status: %s" % why)
            self._reply(403, {"ok": False, "error": "forbidden"})
            return
        if self._command() == "update/status":
            state = read_update_status()
            if state is None:
                self._reply(200, {"phase": "idle", "msg": "no update has run",
                                  "done": False, "updated": False, "error": ""})
            else:
                self._reply(200, state)
            return
        if self._command() in ("", "status", "health"):
            state = LIVENESS.snapshot()
            self._reply(200, {
                "ok": True,
                "service": "arcadeos-agent",
                "frontend": "alive" if state["armed"] else "not seen",
                "last_beat_s": round(state["age"], 1) if state["age"] is not None else None,
                "kiosk_restarts": state["restarts"],
                # Non-empty while silence is deliberately not being judged
                # (console on another VT, or the unit stopped by hand).
                "watchdog_hold": watchdog_hold(),
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
        ok, why = self._authorised(need_token=True)
        if not ok:
            # Never echo the rejected command back; just say no.
            log("refused request: %s" % why)
            self._reply(403, {"ok": False, "error": "forbidden"})
            return

        command = self._command()

        # Heartbeat and log are hot-ish paths and deliberately do no work
        # beyond a timestamp and a print.
        if command == "alive":
            LIVENESS.beat()
            self._reply(200, {"ok": True})
            return
        if command == "log":
            # Front-end text. Stripped of every control character before it is
            # printed: ANSI escapes in a log line can clear or recolour the
            # terminal of whoever runs `journalctl`.
            log("frontend: %s" % clean_text(self._body()))
            self._reply(200, {"ok": True})
            return

        if command == "update":
            ok2, why2 = start_update()
            if ok2:
                log("accepted update (%s)" % why2)
                self._reply(200, {"ok": True, "command": "update", "state": why2})
            else:
                log("refused update: %s" % why2)
                self._reply(503, {"ok": False, "error": why2})
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
    global TOKEN
    TOKEN = load_token()
    if TOKEN:
        log("shared token loaded from %s" % TOKEN_FILE)
    else:
        log("WARNING: no token at %s — any local process may issue commands"
            % TOKEN_FILE)

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
