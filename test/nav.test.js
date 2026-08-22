/*
 * Navigation, the global HOME hold, the settings app, and the on-cabinet
 * software update flow.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeEnv, makePad, PAD_IDS } = require('./harness.js');

const ROOT = path.join(__dirname, '..');

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

function tap(env, code, times = 1) {
  for (let i = 0; i < times; i++) {
    env.fireKey(code, true); env.tick(16);
    env.fireKey(code, false); env.tick(16);
  }
}

/** Hold a pad button for `ms` of simulated time. */
function holdButton(env, pad, button, ms) {
  pad.press(button);
  let t = 0;
  while (t < ms) { env.tick(16.667); t += 16.667; }
  pad.release(button);
  env.tick(16.667);
}

/** Open SETTINGS from the dashboard through the real menu path. */
function openSettings(env) {
  const { Shell } = env.api();
  const rows = Shell._rows();
  for (let i = 0; i < rows.length; i++) tap(env, 'ArrowDown');
  for (let i = 0; i < 3; i++) tap(env, 'ArrowRight');
  tap(env, 'Enter');
  if (Shell.state() !== 'settings') throw new Error('settings did not open');
}

/** Activate a settings row by id. */
function openSettingsRow(env, id) {
  const { Shell } = env.api();
  const items = Shell._settingsItems();
  const at = items.findIndex((i) => i.id === id);
  if (at < 0) throw new Error('no row ' + id);
  Shell._setCursor(at);
  tap(env, 'Enter');
}

/**
 * A fetch stand-in that resolves synchronously — run.js runs tests
 * synchronously, so real promises would resolve after the assertions.
 */
function syncThen(value) {
  return { then(onOk) { if (onOk) onOk(value); return syncThen(undefined); } };
}
function syncResponse(body, ok = true, status = 200) {
  return { ok, status, json: () => syncThen(body) };
}

/* ------------------------------------------------------------- home hold --- */

describe('hold START to go home', () => {
  function envWithPad() {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    bootToMenu(env);
    return { env, pad };
  }

  it('returns to the dashboard from inside a game', () => {
    const { env, pad } = envWithPad();
    const { Shell, gameById } = env.api();
    Shell._startGame(gameById('snake'), false, 1);
    assert.equal(Shell.state(), 'game');
    holdButton(env, pad, 9, Shell._homeHoldMs + 400);
    assert.equal(Shell.state(), 'menu', 'held START goes home');
  });

  it('a tap still pauses; only the hold goes home', () => {
    const { env, pad } = envWithPad();
    const { Shell, gameById } = env.api();
    Shell._startGame(gameById('snake'), false, 1);
    holdButton(env, pad, 9, 120);
    assert.equal(Shell.state(), 'pause', 'tap pauses as before');
    holdButton(env, pad, 9, Shell._homeHoldMs + 400);
    assert.equal(Shell.state(), 'menu', 'hold from the pause screen goes home');
  });

  it('works from every menu screen', () => {
    const { env, pad } = envWithPad();
    const { Shell } = env.api();
    for (const screen of ['settings', 'scores', 'faults', 'about', 'update']) {
      Shell._go(screen);
      holdButton(env, pad, 9, Shell._homeHoldMs + 400);
      assert.equal(Shell.state(), 'menu', `home works from ${screen}`);
    }
  });

  it('clears an open confirm box on the way out', () => {
    const { env, pad } = envWithPad();
    const { Shell } = env.api();
    Shell._go('settings');
    const items = Shell._settingsItems();
    Shell._setCursor(items.findIndex((i) => i.id === 'shutdown'));
    pad.press(0); env.tick(16); pad.release(0); env.tick(16);
    assert.ok(Shell._confirm(), 'confirm box open');
    holdButton(env, pad, 9, Shell._homeHoldMs + 400);
    assert.equal(Shell.state(), 'menu');
    assert.notOk(Shell._confirm(), 'no modal left behind');
  });

  it('requires a fresh press — holding through does not re-fire', () => {
    const { env, pad } = envWithPad();
    const { Shell, gameById } = env.api();
    Shell._startGame(gameById('snake'), false, 1);
    pad.press(9);
    for (let t = 0; t < Shell._homeHoldMs + 2000; t += 16.667) env.tick(16.667);
    assert.equal(Shell.state(), 'menu');
    for (let t = 0; t < 1000; t += 16.667) env.tick(16.667);
    assert.equal(Shell.state(), 'menu', 'still on the dashboard while held');
    pad.release(9);
  });
});

/* ------------------------------------------------------------ back stack --- */

describe('navigation back-stack', () => {
  it('sub-screens return to settings, settings returns to menu', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    for (const id of ['faults', 'about', 'update']) {
      openSettings(env);
      openSettingsRow(env, id);
      assert.equal(Shell.state(), id === 'faults' ? 'faults' : id);
      tap(env, 'Escape');
      assert.equal(Shell.state(), 'settings', `${id} returns to settings`);
      tap(env, 'Escape');
      assert.equal(Shell.state(), 'menu', 'settings returns to menu');
    }
  });

  it('scores opened from the dashboard returns to the dashboard', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    const rows = Shell._rows();
    for (let i = 0; i < rows.length; i++) tap(env, 'ArrowDown');
    for (let i = 0; i < 2; i++) tap(env, 'ArrowLeft');
    tap(env, 'Enter');
    assert.equal(Shell.state(), 'scores');
    tap(env, 'Escape');
    assert.equal(Shell.state(), 'menu');
  });
});

/* -------------------------------------------------------------- settings --- */

describe('settings app structure', () => {
  it('groups rows under section headers', () => {
    const env = makeEnv();
    const items = env.api().Shell._settingsItems();
    const headers = items.filter((i) => i.type === 'header').map((i) => i.label);
    assert.ok(headers.length >= 4, 'has sections');
    assert.ok(headers.some((h) => /SYSTEM/.test(h)));
  });

  it('the cursor never rests on a header', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    openSettings(env);
    const n = Shell._settingsItems().length;
    for (let i = 0; i < n * 2; i++) {
      tap(env, 'ArrowDown');
      const cur = Shell._settingsItems()[Shell._settingsCursor()];
      assert.notEqual(cur.type, 'header', 'cursor skipped headers');
    }
    for (let i = 0; i < n * 2; i++) {
      tap(env, 'ArrowUp');
      const cur = Shell._settingsItems()[Shell._settingsCursor()];
      assert.notEqual(cur.type, 'header', 'cursor skipped headers going up too');
    }
  });

  it('has software update, about, rumble and reset-settings rows', () => {
    const env = makeEnv();
    const ids = env.api().Shell._settingsItems().map((i) => i.id);
    for (const need of ['update', 'about', 'rumble', 'resetSettings']) {
      assert.ok(ids.includes(need), `settings has ${need}`);
    }
  });

  it('reset settings restores defaults after a confirm', () => {
    const env = makeEnv();
    const { Shell, Settings } = env.api();
    bootToMenu(env);
    Settings.set('volume', 0.15);
    Settings.set('crt', false);
    openSettings(env);
    openSettingsRow(env, 'resetSettings');
    assert.ok(Shell._confirm(), 'asks first');
    tap(env, 'ArrowLeft');                 /* move to YES */
    tap(env, 'Enter');
    assert.equal(Settings.get('volume'), 0.7, 'volume back to default');
    assert.equal(Settings.get('crt'), true, 'crt back to default');
  });

  it('the about screen renders without an agent and leaves cleanly', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    openSettings(env);
    openSettingsRow(env, 'about');
    assert.equal(Shell.state(), 'about');
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16.667); });
    tap(env, 'Escape');
    assert.equal(Shell.state(), 'settings');
  });
});

/* --------------------------------------------------------- update screen --- */

describe('software update screen', () => {
  function openUpdate(env) {
    const { Shell } = env.api();
    bootToMenu(env);
    openSettings(env);
    openSettingsRow(env, 'update');
    assert.equal(Shell.state(), 'update');
  }

  it('without an agent, says so instead of hanging', () => {
    const env = makeEnv();                       /* no fetch in this env */
    const { Shell } = env.api();
    openUpdate(env);
    tap(env, 'Enter');                           /* CHECK FOR UPDATES */
    for (let i = 0; i < 10; i++) env.tick(100);
    assert.equal(Shell._upd().phase, 'error');
    assert.ok(/BUILD|AGENT/.test(Shell._upd().error), 'a human-readable reason');
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16.667); });
  });

  it('drives the whole flow against a mocked agent', () => {
    const statuses = [
      { phase: 'checking', msg: 'contacting the update server', done: false, updated: false, error: '' },
      { phase: 'installing', msg: 'installing', done: false, updated: false, error: '' },
      { phase: 'done', msg: 'updated to abc12345', done: true, updated: true, error: '', from: 'aaaa1111', to: 'abc12345' },
    ];
    let posts = 0;
    const env = makeEnv({ fetch: (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'POST' && /\/update$/.test(url)) {
        posts++;
        return syncThen(syncResponse({ ok: true }));
      }
      if (/update\/status$/.test(url)) {
        const body = statuses.length > 1 ? statuses.shift() : statuses[0];
        return syncThen(syncResponse(body));
      }
      return syncThen(syncResponse({ ok: true }));
    } });
    const { Shell } = env.api();
    openUpdate(env);
    assert.equal(Shell._upd().phase, 'idle');

    tap(env, 'Enter');                           /* CHECK FOR UPDATES */
    assert.equal(posts, 1, 'one POST /update');
    assert.equal(Shell._upd().phase, 'running');

    for (let i = 0; i < 40 && Shell._upd().phase !== 'done'; i++) env.tick(300);
    assert.equal(Shell._upd().phase, 'done');
    assert.equal(Shell._upd().status.updated, true);
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16.667); });

    tap(env, 'Enter');                           /* BACK from the done card */
    assert.equal(Shell.state(), 'settings');
  });

  it('reports "up to date" without claiming an install happened', () => {
    const env = makeEnv({ fetch: (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'POST') return syncThen(syncResponse({ ok: true }));
      return syncThen(syncResponse(
        { phase: 'done', msg: 'already up to date', done: true, updated: false, error: '' }));
    } });
    const { Shell } = env.api();
    openUpdate(env);
    tap(env, 'Enter');
    for (let i = 0; i < 10 && Shell._upd().phase !== 'done'; i++) env.tick(300);
    assert.equal(Shell._upd().phase, 'done');
    assert.equal(Shell._upd().status.updated, false);
  });

  it('surfaces an updater error and TRY AGAIN really retries', () => {
    let posts = 0;
    const env = makeEnv({ fetch: (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'POST') { posts++; return syncThen(syncResponse({ ok: true })); }
      return syncThen(syncResponse({
        phase: 'failed', msg: 'x', done: true, updated: false,
        error: 'could not reach the update server — check the network',
      }));
    } });
    const { Shell } = env.api();
    openUpdate(env);
    tap(env, 'Enter');
    for (let i = 0; i < 10 && Shell._upd().phase !== 'error'; i++) env.tick(300);
    assert.equal(Shell._upd().phase, 'error');
    assert.ok(/NETWORK/.test(Shell._upd().error));
    assert.equal(posts, 1);
    tap(env, 'Enter');                            /* TRY AGAIN is selected */
    assert.equal(posts, 2, 'try again re-POSTs');
  });

  it('leaving the screen mid-update does not cancel it', () => {
    let statusCalls = 0;
    const env = makeEnv({ fetch: (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'POST') return syncThen(syncResponse({ ok: true }));
      statusCalls++;
      return syncThen(syncResponse(
        { phase: 'installing', msg: 'installing', done: false, updated: false, error: '' }));
    } });
    const { Shell } = env.api();
    openUpdate(env);
    tap(env, 'Enter');
    for (let i = 0; i < 3; i++) env.tick(1100);
    assert.ok(statusCalls >= 2, 'polling while on the screen');
    tap(env, 'Escape');
    assert.equal(Shell.state(), 'settings', 'back works during an update');
    const at = statusCalls;
    for (let i = 0; i < 5; i++) env.tick(1100);
    assert.equal(statusCalls, at, 'no polling once the screen is left');
  });
});

/* ------------------------------------------------------- plumbing on disk --- */

describe('update plumbing on disk', () => {
  const AGENT = fs.readFileSync(path.join(ROOT, 'pi', 'arcadeos-agent.py'), 'utf8');
  const SETUP = fs.readFileSync(path.join(ROOT, 'setup-arcade.sh'), 'utf8');
  const UPDATER = path.join(ROOT, 'pi', 'arcadeos-update.sh');

  it('the agent only ever runs the one fixed script', () => {
    assert.ok(/UPDATE_SCRIPT = "\/opt\/arcadeos\/arcadeos-update\.sh"/.test(AGENT));
    assert.notOk(/UPDATE_SCRIPT\s*=\s*self\./.test(AGENT), 'no request-derived path');
  });

  it('POST /update sits behind the same token gate as shutdown', () => {
    const post = AGENT.slice(AGENT.indexOf('def do_POST'));
    assert.ok(post.indexOf('_authorised(need_token=True)') <
      post.indexOf('command == "update"'), 'auth happens before the update branch');
  });

  it('GET /update/status is read-only and token-free like GET /', () => {
    const get = AGENT.slice(AGENT.indexOf('def do_GET'), AGENT.indexOf('def do_POST'));
    assert.ok(/update\/status/.test(get));
    assert.ok(/_authorised\(need_token=False\)/.test(get));
  });

  it('the updater is valid bash and rolls back on failure', () => {
    assert.doesNotThrow(() => execFileSync('bash', ['-n', UPDATER], { stdio: 'pipe' }));
    const src = fs.readFileSync(UPDATER, 'utf8');
    assert.ok(/PAGE\.prev/.test(src), 'keeps the previous page');
    assert.ok(/previous version restored/.test(src), 'and says when it restores it');
    assert.ok(/set -Eeuo pipefail/.test(src));
  });

  it('the installer ships the updater and records where updates come from', () => {
    assert.ok(/write_update_conf/.test(SETUP));
    assert.ok(/GIT_BRANCH=\$branch/.test(SETUP));
    assert.ok(/arcadeos-update\.sh" "\$APP_DIR\/arcadeos-update\.sh"/.test(SETUP));
  });

  it('the bundle carries a build id for the ABOUT screen', () => {
    const dist = fs.readFileSync(path.join(ROOT, 'dist', 'arcade.html'), 'utf8');
    assert.ok(/window\.ARCADEOS_BUILD='[0-9a-f]{8}'/.test(dist));
  });
});
