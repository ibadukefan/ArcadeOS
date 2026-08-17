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
 */

var System = (function () {
  var ENDPOINT = 'http://127.0.0.1:8127/';
  var lastResult = '';

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

  return {
    /** command: 'shutdown' | 'restart' | 'pair' */
    request: function (command, onDone) {
      if (command !== 'shutdown' && command !== 'restart' && command !== 'pair') return;
      send(command, onDone);
    },
    pair: function (onDone) { send('pair', onDone); },
    endpoint: function () { return ENDPOINT; },
    lastResult: function () { return lastResult; },
  };
})();
