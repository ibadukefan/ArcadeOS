/*
 * Tests for the hardening pass.
 *
 * Two halves. The front-end half runs against the harness like everything
 * else. The agent half reads pi/arcadeos-agent.py and setup-arcade.sh as text,
 * because the alternative is booting a root service in CI — the properties
 * asserted here were each verified against a live agent first, and these are
 * the tripwires that keep them from being "simplified" back out.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeEnv } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const AGENT = fs.readFileSync(path.join(ROOT, 'pi', 'arcadeos-agent.py'), 'utf8');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup-arcade.sh'), 'utf8');
const SYSTEM = fs.readFileSync(path.join(ROOT, 'src', 'core', 'system.js'), 'utf8');

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

/* --------------------------------------------------------------- agent --- */

describe('agent authorisation', () => {
  it('answers only to a loopback Host header', () => {
    /* A DNS-rebinding page resolves its own name to 127.0.0.1 and then sends
     * Host: evil.example. Binding to loopback does not stop that; this does.
     * Verified live: POST /shutdown with a foreign Host went 200 -> 403. */
    assert.ok(/LOOPBACK_HOSTS = \("127\.0\.0\.1", "localhost", "::1", ""\)/.test(AGENT));
    assert.ok(/if host not in LOOPBACK_HOSTS:\s*\n\s*return False/.test(AGENT));
  });

  it('rejects any request carrying a real web Origin', () => {
    /* The kiosk page is file://, so its Origin is null or absent. Anything
     * else is a website talking to us. Verified live: a cross-origin POST
     * /restart went 200 -> 403. */
    assert.ok(/if origin not in \(None, "", "null"\):\s*\n\s*return False/.test(AGENT));
  });

  it('requires the shared token on every command', () => {
    assert.ok(/TOKEN_FILE = "\/etc\/arcadeos\/agent\.token"/.test(AGENT));
    assert.ok(/hmac\.compare_digest\(supplied, TOKEN\)/.test(AGENT),
      'constant-time compare, not ==');
    assert.ok(/def do_POST/.test(AGENT));
    const post = AGENT.slice(AGENT.indexOf('def do_POST'));
    assert.ok(/_authorised\(need_token=True\)/.test(post),
      'every command goes through the token check');
  });

  it('leaves the read-only status endpoint usable without a token', () => {
    /* Otherwise `curl http://127.0.0.1:8127/` over SSH — the first thing
     * anyone does when a cabinet misbehaves — stops working. */
    const get = AGENT.slice(AGENT.indexOf('def do_GET'), AGENT.indexOf('def do_POST'));
    assert.ok(/_authorised\(need_token=False\)/.test(get));
  });

  it('never widens CORS to a real origin', () => {
    assert.ok(/Access-Control-Allow-Origin", "null"/.test(AGENT));
    assert.ok(!/Access-Control-Allow-Origin", "\*"/.test(AGENT), 'wildcard would undo all of this');
    assert.ok(/Access-Control-Allow-Headers", "X-ArcadeOS-Token"/.test(AGENT));
  });

  it('strips control characters before anything reaches the journal', () => {
    /* An ESC sequence in a relayed line repaints the terminal of whoever runs
     * journalctl. Verified live: a crafted fault printed a fake root warning
     * in colour before this, and prints as spaces after it. */
    assert.ok(/CONTROL_CHARS = re\.compile\(r"\[\\x00-\\x1f\\x7f\]"\)/.test(AGENT));
    assert.ok(/CONTROL_CHARS\.sub\(" ", str\(text\)\)\[:limit\]/.test(AGENT));
  });

  it('caps how long a client may hold a request open', () => {
    /* Single-threaded server: one socket left hanging is the whole service. */
    assert.ok(/timeout = 5/.test(AGENT));
  });

  it('is valid Python', () => {
    assert.doesNotThrow(() => {
      execFileSync('python3', ['-m', 'py_compile', path.join(ROOT, 'pi', 'arcadeos-agent.py')],
        { stdio: 'pipe' });
    });
  });
});

/* --------------------------------------------------------------- setup --- */

describe('setup script', () => {
  it('is valid bash', () => {
    assert.doesNotThrow(() => {
      execFileSync('bash', ['-n', path.join(ROOT, 'setup-arcade.sh')], { stdio: 'pipe' });
    });
  });

  it('validates ARCADE_USER before interpolating it into unit files', () => {
    /*
     * It comes from the environment and is pasted into systemd units and chown
     * arguments. Run the real script rather than matching the regex as text:
     * this check is the first thing that happens on a cabinet, so a username
     * it wrongly rejects blocks the entire install.
     */
    const run = (user) => {
      try {
        execFileSync('bash', [path.join(ROOT, 'setup-arcade.sh')], {
          env: Object.assign({}, process.env, { ARCADE_USER: user, SUDO_USER: user }),
          stdio: 'pipe',
        });
        return '';
      } catch (e) {
        return String(e.stderr || '') + String(e.stdout || '');
      }
    };
    const REJECTED = /is not a valid username/;

    /* Anything that could break out of a unit file or a shell word. */
    /* An empty value is not in this list on purpose: it falls back to `pi`. */
    for (const bad of ['pi;reboot', 'pi user', 'pi$(id)', 'pi|sh', '../root', 'pi%i']) {
      assert.ok(REJECTED.test(run(bad)), JSON.stringify(bad) + ' should be rejected');
    }
    /* Anything useradd would actually accept. */
    for (const good of ['pi', 'robbie', 'arcade-user', 'bad_user', 'Robbie', 'j.doe']) {
      assert.ok(!REJECTED.test(run(good)), JSON.stringify(good) + ' must not be rejected');
    }
  });

  it('generates the agent token from the kernel CSPRNG', () => {
    assert.ok(/\/dev\/urandom/.test(SETUP));
    assert.ok(/install -m 0600 -o root -g root "\$tmp" "\$TOKEN_FILE"/.test(SETUP),
      'token file is root-only');
  });

  it('reuses an existing token instead of rotating it on every re-run', () => {
    /* Rotating would leave a running agent and a cached page disagreeing. */
    const fn = SETUP.slice(SETUP.indexOf('ensure_token() {'), SETUP.indexOf('install_page() {'));
    assert.ok(/if \[\[ -s "\$TOKEN_FILE" \]\]; then/.test(fn));
    assert.ok(/reusing agent token/.test(fn));
  });

  it('bakes the token into the installed page, readable only by the kiosk user', () => {
    assert.ok(/window\.ARCADEOS_AGENT_TOKEN=%s/.test(SETUP));
    assert.ok(/install -m 0640 -o root -g "\$ARCADE_USER" "\$tmp" "\$APP_DIR\/\.arcade\.html\.new"/.test(SETUP));
  });

  it('replaces the live page atomically', () => {
    /* install(1) truncates in place; a mid-write reload is a renderer crash.
     * Stage-and-rename means Chromium sees old page or new, never half. */
    assert.ok(/mv -f "\$APP_DIR\/\.arcade\.html\.new" "\$APP_DIR\/arcade\.html"/.test(SETUP));
  });

  it('captures Chromium logs in the journal', () => {
    /* The first cabinet crash-looped with an empty journal — undiagnosable. */
    assert.ok(/--enable-logging=stderr/.test(SETUP));
    /* ...and stderr alone printed nothing: GL initialisation logs at INFO,
     * below Chromium's default threshold. */
    assert.ok(/--log-level=0/.test(SETUP), 'INFO-level logging is on');
  });

  it('removes the token directory on uninstall', () => {
    const uninstall = SETUP.slice(SETUP.indexOf('uninstall() {'));
    assert.ok(/rm -rf "\$CONF_DIR"/.test(uninstall));
  });

  it('generates the page fresh from dist each time, so tokens cannot stack', () => {
    /* Appending to the installed file instead would leave two script tags and
     * a stale token winning. */
    const fn = SETUP.slice(SETUP.indexOf('install_page() {'));
    assert.ok(/cat "\$SRC_DIR\/dist\/arcade\.html"/.test(fn.slice(0, 900)));
  });
});

/* ----------------------------------------------------------- front end --- */

describe('System client', () => {
  it('sends the cabinet token on every agent call', () => {
    /* A custom header is also what forces a CORS preflight, which a hostile
     * page cannot forge. */
    assert.ok(/TOKEN_HEADER = 'X-ArcadeOS-Token'/.test(SYSTEM));
    const calls = SYSTEM.match(/headers: headers\(\)/g) || [];
    assert.ok(calls.length >= 3, 'command, log and heartbeat all carry it');
  });

  it('reads the token from the page and never exposes it', () => {
    assert.ok(/window\.ARCADEOS_AGENT_TOKEN/.test(SYSTEM));
    const env = makeEnv();
    const { System } = env.api();
    assert.equal(System._authorised(), false, 'no token in a development build');
    assert.equal(typeof System.token, 'undefined', 'the value is not on the public surface');
  });

  it('sends no header at all when there is no token', () => {
    /* A hand-run dist/arcade.html must still talk to a hand-run agent. */
    assert.ok(/if \(!token\) return undefined;/.test(SYSTEM));
  });

  it('strips control characters client-side too', () => {
    const env = makeEnv();
    const { System } = env.api();
    const ESC = String.fromCharCode(27);
    const out = System._printable('a' + ESC + '[31mred' + String.fromCharCode(10) + 'b');
    assert.equal(out, 'a [31mred b');
    assert.ok(!new RegExp('[\\u0000-\\u001f\\u007f]').test(out));
  });

  it('caps a relayed line so one game cannot flood the journal', () => {
    const env = makeEnv();
    const { System } = env.api();
    assert.equal(System._printable('x'.repeat(5000)).length, 500);
  });
});

/* ------------------------------------------------------------- storage --- */

describe('storage honesty and bounds', () => {
  it('stops claiming persistence once writes start failing', () => {
    /* The card fills up mid-session; the probe at boot said yes and the
     * settings screen went on saying "PERSISTENT" while nothing was saved. */
    const env = makeEnv();
    const { Scores, Store, Settings } = env.api();
    bootToMenu(env);
    assert.equal(Store.persistent(), true);

    env.getStorage().setItem = () => {
      const e = new Error('QuotaExceededError');
      e.name = 'QuotaExceededError';
      throw e;
    };
    Scores.submit('snake', 200, 'BBB', 2);
    Settings.set('volume', 0.1);

    assert.equal(Store.persistent(), false, 'settings must now say SESSION ONLY');
    assert.equal(Scores.best('snake'), 200, 'the session still works perfectly');
    assert.doesNotThrow(() => { for (let i = 0; i < 60; i++) env.tick(16.667); });
  });

  it('says so again if writes start working', () => {
    const env = makeEnv();
    const { Store, Settings } = env.api();
    bootToMenu(env);
    const real = env.getStorage().setItem.bind(env.getStorage());
    env.getStorage().setItem = () => { throw new Error('full'); };
    Settings.set('volume', 0.2);
    assert.equal(Store.persistent(), false);
    env.getStorage().setItem = real;
    Settings.set('volume', 0.3);
    assert.equal(Store.persistent(), true);
  });

  it('bounds a score so it cannot paint across the scores screen', () => {
    const env = makeEnv();
    const { Scores, Shell } = env.api();
    bootToMenu(env);
    Scores.submit('tetris', 1e308, 'ABC', 1);
    assert.equal(Scores.best('tetris'), Scores.MAX_SCORE);
    assert.ok(String(Scores.best('tetris')).length <= 9, 'renders as digits, not 1e+308');
    Shell._go('scores');
    assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) env.tick(16.667); });
  });

  it('bounds a score arriving through a crafted record too', () => {
    const env = makeEnv({ storage: {
      'arcadeos:v2:scores': JSON.stringify({ snake: [{ name: 'EVL', score: 1e308, at: 1 }] }),
    } });
    const { Scores } = env.api();
    bootToMenu(env);
    assert.equal(Scores.best('snake'), Scores.MAX_SCORE);
  });

  it('keeps the score map off Object.prototype', () => {
    /* Game ids come out of a file the player can edit, and {}.constructor is
     * a function rather than a missing entry. */
    const env = makeEnv({ storage: {
      'arcadeos:v2:scores': JSON.stringify({
        constructor: [{ name: 'EVL', score: 2, at: 1 }],
        tetris: [{ name: 'OKA', score: 42, at: 1 }],
      }),
    } });
    const { Scores } = env.api();
    bootToMenu(env);
    assert.equal(Object.getPrototypeOf(Scores.all()), null);
    assert.deep(Scores.table('tetris'), [{ name: 'OKA', score: 42, at: 1 }]);
    assert.deep(Scores.table('toString'), [], 'an unplayed game has no table');
    assert.equal(Scores.best('valueOf'), 0);
    assert.doesNotThrow(() => { for (let i = 0; i < 60; i++) env.tick(16.667); });
  });

  it('leaves Object.prototype alone whatever the record contains', () => {
    const raw = '{"__proto__":{"polluted":true},"snake":[{"name":"OK","score":7,"at":1}]}';
    const env = makeEnv({ storage: { 'arcadeos:v2:scores': raw } });
    const { Scores } = env.api();
    bootToMenu(env);
    assert.equal({}.polluted, undefined);
    assert.equal(Scores.best('snake'), 7);
  });
});

/* ------------------------------------------------------------- attract --- */

describe('attract cost', () => {
  it('SNAKE only re-plans when the snake has actually moved', () => {
    /* Four flood fills at 60Hz measured 35us per call — twenty times the cost
     * of every other pilot. The board only changes when the snake steps. */
    const env = makeEnv();
    const { Shell, gameById, Input } = env.api();
    bootToMenu(env);
    const g = gameById('snake');
    Shell._startGame(g, false, 3);
    for (let i = 0; i < 30; i++) { Input.setDemo(g.demo()); env.tick(16.667); }

    const first = g.demo();
    assert.equal(g.demo(), first, 'same object back with no step between');

    /* One grid step is 140ms. */
    for (let i = 0; i < 12; i++) { Input.setDemo(g.demo()); env.tick(16.667); }
    assert.notEqual(g.demo(), first, 'a step re-plans');
  });

  it('every pilot stays cheap enough to run inside a frame', () => {
    const env = makeEnv();
    const { Shell, gameById, Input } = env.api();
    bootToMenu(env);
    for (const id of ['snake', 'climb', 'pulse', 'drop', 'breakout', 'tetris']) {
      const g = gameById(id);
      Shell._startGame(g, false, 3);
      for (let i = 0; i < 60; i++) { Input.setDemo(g.demo()); env.tick(16.667); }
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 400; i++) g.demo();
      const us = Number(process.hrtime.bigint() - t0) / 1000 / 400;
      /* Generous: a Pi 4 is several times slower than CI, and the whole frame
       * budget is 16.7ms. Anything near this number is a regression. */
      assert.ok(us < 10, id + ' demo() costs ' + us.toFixed(1) + 'us/call');
      Input.setDemo(null);
      Shell._go('menu');
    }
  });
});
