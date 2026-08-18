/*
 * Cabinet control: shut down, restart, and Bluetooth pairing.
 *
 * Yanking mains power is the single biggest cause of SD card corruption on a
 * Pi, so the front end has to offer a real way out. Chromium in a kiosk cannot
 * call poweroff itself, so setup-arcade.sh installs `arcadeos-agent`, a tiny
 * Python service bound to 127.0.0.1:8127 that accepts three commands.
 *
 * This is loopback IPC, not networking: the request never leaves the machine,
 * there is no external host, and the cabinet still works with the NIC down. If
 * the agent is not installed the call fails harmlessly and the UI says so —
 * the front end degrades, it does not break.
 *
 * AUTHORISATION
 *
 * Loopback keeps the network out but not other local software: a cross-origin
 * POST with no custom headers is a CORS "simple request", so before the agent
 * grew a token any web page in any browser on this machine could have powered
 * the cabinet off. setup-arcade.sh generates a secret, hands it to the agent,
 * and bakes it into the installed page as window.ARCADEOS_AGENT_TOKEN; we send
 * it on every command. Sending a custom header is also what forces a CORS
 * preflight, which is the point — a hostile page cannot forge one.
 *
 * A hand-run dist/arcade.html has no token. That is fine: the agent only
 * demands one when it has been configured with one.
 */

var System = (function () {
  var ENDPOINT = 'http://127.0.0.1:8127/';
  var TOKEN_HEADER = 'X-ArcadeOS-Token';
  var lastResult = '';

  /* Read once. The installer writes it above the bundle, so it is present
   * before any of this runs; a development build simply has none. */
  var token = (function () {
    try {
      var t = (typeof window !== 'undefined') && window.ARCADEOS_AGENT_TOKEN;
      return typeof t === 'string' ? t : '';
    } catch (e) { return ''; }
  })();

  function headers() {
    if (!token) return undefined;
    var h = {};
    h[TOKEN_HEADER] = token;
    return h;
  }

  /*
   * Control characters in a relayed line would reach journald verbatim, where
   * an ESC sequence can repaint an administrator's terminal — a fake root
   * warning in a log tail is a real trick, not a theoretical one. The agent
   * strips them too; doing it at both ends means neither has to be trusted.
   */
  function printable(text) {
    var out = '';
    var s = String(text == null ? '' : text);
    for (var i = 0; i < s.length && out.length < 500; i++) {
      var c = s.charCodeAt(i);
      out += (c < 0x20 || c === 0x7f) ? ' ' : s.charAt(i);
    }
    return out;
  }

  function send(command, onDone) {
    lastResult = 'pending';
    var done = function (ok, detail) {
      lastResult = ok ? 'ok' : ('failed: ' + detail);
      if (onDone) { try { onDone(ok, detail); } catch (e) { /* ignore */ } }
    };

    if (typeof fetch !== 'function') { done(false, 'no fetch'); return; }
    try {
      fetch(ENDPOINT + encodeURIComponent(command), {
        method: 'POST',
        cache: 'no-store',
        headers: headers(),
        /* The agent replies then exits; a hung socket must not wedge the UI. */
        keepalive: true,
      }).then(function (res) {
        done(!!(res && res.ok), res ? String(res.status) : 'no response');
      }, function (err) {
        done(false, String(err && err.message ? err.message : err));
      });
    } catch (e) {
      done(false, String(e && e.message ? e.message : e));
    }
  }

  /**
   * Relay a diagnostic line to the agent, which prints it to stdout and so
   * into journald. Fire and forget: a cabinet with no agent installed simply
   * has no journal entry, and nothing upstream ever waits on this.
   */
  function log(text) {
    if (typeof fetch !== 'function') return;
    var line = printable(text);
    try {
      fetch(ENDPOINT + 'log', {
        method: 'POST',
        cache: 'no-store',
        headers: headers(),
        keepalive: true,
        body: line,
      }).then(function () {}, function () {});
    } catch (e) { /* never let diagnostics break the thing being diagnosed */ }
  }

  /*
   * LIVENESS HEARTBEAT
   *
   * systemd's Restart=always catches a crash. It does nothing for a hang — a
   * wedged GPU or a stuck script leaves Chromium alive, the service "active",
   * and a frozen picture on the cabinet forever.
   *
   * This is sent from the frame loop, so it stops the instant frames stop.
   * The agent restarts the kiosk when it goes quiet. Cheap (once every few
   * seconds, loopback) and the failure mode is benign: no agent means no
   * heartbeat means nothing happens, exactly as before.
   */
  var HEARTBEAT_MS = 4000;
  var lastBeat = 0;

  function heartbeat(nowMs) {
    var now = num(nowMs, 0);
    if (now - lastBeat < HEARTBEAT_MS) return;
    lastBeat = now;
    if (typeof fetch !== 'function') return;
    try {
      fetch(ENDPOINT + 'alive', {
        method: 'POST', cache: 'no-store', headers: headers(), keepalive: true,
      })
        .then(function () {}, function () {});
    } catch (e) { /* a missing agent must never cost a frame */ }
  }

  return {
    log: log,
    heartbeat: heartbeat,
    HEARTBEAT_MS: HEARTBEAT_MS,
    /** command: 'shutdown' | 'restart' | 'pair' */
    request: function (command, onDone) {
      if (command !== 'shutdown' && command !== 'restart' && command !== 'pair') return;
      send(command, onDone);
    },
    pair: function (onDone) { send('pair', onDone); },
    endpoint: function () { return ENDPOINT; },
    lastResult: function () { return lastResult; },
    /** Test seam: has a cabinet token been baked in? Never returns the value. */
    _authorised: function () { return !!token; },
    _printable: printable,
    _tokenHeader: TOKEN_HEADER,
  };
})();
