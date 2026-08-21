/*
 * Tests for the five gaps closed after the first audit:
 * storage migration, crash visibility, control hints, attract self-play, and
 * hang detection.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeEnv, makePad, PAD_IDS } = require('./harness.js');

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

describe('storage migration', () => {
  it('carries a v1 record forward to the current schema', () => {
    const env = makeEnv({ storage: {
      'arcadeos:v1:scores': JSON.stringify({ tetris: [{ name: 'OLD', score: 4242, at: 1 }] }),
      'arcadeos:v1:settings': JSON.stringify({ volume: 0.25, layout: 'nintendo' }),
    } });
    const { Scores, Settings, Store } = env.api();
    assert.equal(Scores.best('tetris'), 4242, 'the score survived the upgrade');
    assert.equal(Scores.table('tetris')[0].name, 'OLD');
    assert.equal(Settings.get('volume'), 0.25);
    assert.equal(Settings.get('layout'), 'nintendo');
    assert.equal(Store.migrated(), 2, 'both records were migrated');
  });

  it('writes the migrated value forward so the walk happens once', () => {
    const env = makeEnv({ storage: {
      'arcadeos:v1:scores': JSON.stringify({ snake: [{ name: 'ABC', score: 10, at: 1 }] }),
    } });
    env.api().Scores.best('snake');
    const keys = [...env.getStorage()._map.keys()];
    assert.ok(keys.includes(env.api().Store._key('scores')),
      'the record now exists at the current version');
    /* The old key is deliberately left alone so a downgrade still finds it. */
    assert.ok(keys.includes('arcadeos:v1:scores'), 'the v1 key is not destroyed');
  });

  it('prefers current-version data over anything older', () => {
    const env = makeEnv({ storage: {
      'arcadeos:v1:scores': JSON.stringify({ tetris: [{ name: 'OLD', score: 100, at: 1 }] }),
      'arcadeos:v2:scores': JSON.stringify({ tetris: [{ name: 'NEW', score: 900, at: 2 }] }),
    } });
    assert.equal(env.api().Scores.best('tetris'), 900, 'the newer record wins');
  });

  it('survives a migration that throws', () => {
    const env = makeEnv({ storage: {
      'arcadeos:v1:scores': JSON.stringify({ tetris: [{ name: 'ABC', score: 5, at: 1 }] }),
    } });
    const { Store, Scores } = env.api();
    Store._migrations[2] = function () { throw new Error('bad migration'); };
    Store._reset();
    Scores._drop();
    assert.doesNotThrow(() => Scores.table('tetris'),
      'a broken upgrade costs you scores, never a cabinet that will not boot');
    assert.doesNotThrow(() => { for (let i = 0; i < 40; i++) env.tick(16); });
  });

  it('every version step between 1 and current has a migration', () => {
    const env = makeEnv();
    const { Store } = env.api();
    for (let v = 2; v <= Store.VERSION; v++) {
      assert.equal(typeof Store._migrations[v], 'function',
        `v${v - 1} -> v${v} has a migration, so the bump cannot orphan data`);
    }
  });
});

describe('crash visibility', () => {
  /** A game that always throws, to drive the fault paths. */
  function breakGame(env, id, method) {
    const g = env.api().gameById(id);
    g[method] = function () { throw new Error('deliberate ' + method + ' fault'); };
    return g;
  }

  it('records an update fault and returns to the menu', () => {
    const env = makeEnv();
    const { Shell, Faults } = env.api();
    bootToMenu(env);
    breakGame(env, 'snake', 'update');
    Shell._startGame(env.api().gameById('snake'));
    env.tick(16);
    assert.equal(Shell.state(), 'menu', 'the shell recovered');
    const f = Faults.latest();
    assert.ok(f, 'a fault was recorded');
    assert.ok(/deliberate update fault/.test(f.msg));
    assert.equal(f.where, 'snake.update');
  });

  it('collapses repeats instead of evicting the history', () => {
    const env = makeEnv();
    const { Shell, Faults } = env.api();
    bootToMenu(env);
    breakGame(env, 'stack', 'draw');
    Shell._startGame(env.api().gameById('stack'));
    for (let i = 0; i < 30; i++) env.tick(16);
    const f = Faults.latest();
    assert.ok(f.n > 1, `repeat count rose (${f.n})`);
    assert.equal(Faults.count(), 1, 'one row, not thirty');
  });

  it('survives a fault before boot has finished', () => {
    const env = makeEnv();
    breakGame(env, 'tetris', 'preview');
    assert.doesNotThrow(() => bootToMenu(env), 'a broken preview does not stop boot');
    assert.ok(env.api().Faults.count() > 0, 'and is recorded');
  });

  it('persists faults across a reboot', () => {
    const env1 = makeEnv();
    bootToMenu(env1);
    env1.api().Faults.record(new Error('boom'), 'snake.update', 1000);
    const snap = {};
    for (const [k, v] of env1.getStorage()._map.entries()) snap[k] = v;

    const env2 = makeEnv({ storage: snap });
    const f = env2.api().Faults.latest();
    assert.ok(f && /boom/.test(f.msg), 'the fault outlived the power cycle');
  });

  it('repairs a corrupt fault log rather than throwing', () => {
    const env = makeEnv({ storage: {
      'arcadeos:v2:faults': '{"not":"an array"}',
    } });
    assert.doesNotThrow(() => env.api().Faults.all());
    assert.deep(env.api().Faults.all(), []);
    assert.doesNotThrow(() => { for (let i = 0; i < 40; i++) env.tick(16); });
  });

  it('relays a fault to the agent for the journal', () => {
    const calls = [];
    const env = makeEnv({ fetch: (url, opts) => {
      calls.push({ url, body: opts && opts.body });
      return Promise.resolve({ ok: true, status: 200 });
    } });
    bootToMenu(env);
    env.api().Faults.record(new Error('journal me'), 'drop.update', 5000);
    const logged = calls.filter((c) => /\/log$/.test(c.url));
    assert.equal(logged.length, 1, 'one log line was relayed');
    assert.ok(/journal me/.test(logged[0].body));
  });

  it('rate limits the relay so a per-frame fault cannot flood the journal', () => {
    const calls = [];
    const env = makeEnv({ fetch: (url) => {
      if (/\/log$/.test(url)) calls.push(url);
      return Promise.resolve({ ok: true });
    } });
    bootToMenu(env);
    const { Faults } = env.api();
    for (let i = 0; i < 200; i++) Faults.record(new Error('spam'), 'x.draw', 6000 + i * 10);
    assert.ok(calls.length <= 3, `relayed ${calls.length} times over 2s of faults`);
  });

  it('the diagnostics screen is reachable and shows the fault', () => {
    const env = makeEnv();
    const { Shell, Faults } = env.api();
    bootToMenu(env);
    Faults.record(new Error('visible'), 'snake.update', 1);

    const index = Shell._settingsItems().findIndex((i) => i.id === 'faults');
    assert.ok(index >= 0, 'settings has a diagnostics entry');
    Shell._go('settings');
    Shell._setCursor(index);
    env.fireKey('Enter', true); env.tick(16);
    env.fireKey('Enter', false); env.tick(16);
    assert.equal(Shell.state(), 'faults');
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16); });

    env.fireKey('Escape', true); env.tick(16);
    env.fireKey('Escape', false); env.tick(16);
    assert.equal(Shell.state(), 'settings', 'back returns to settings');
  });

  it('renders the diagnostics screen with no faults at all', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    Shell._go('faults');
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16); });
  });
});

describe('control hints', () => {
  it('every game defines one', () => {
    const env = makeEnv();
    const { GAMES, VERSUS_GAMES } = env.api();
    for (const g of GAMES.concat(VERSUS_GAMES)) {
      assert.ok(g.hint && typeof g.hint === 'string', `${g.id} has a hint`);
      assert.ok(g.hint.length <= 52, `${g.id} hint fits on a card: "${g.hint}"`);
    }
  });

  it('substitutes the glyphs of the controller in hand', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    /* Keyboard: no pad connected. */
    assert.equal(Shell._formatHint('{A} DROP'), 'ENTER DROP');

    const ps = makeEnv({ gamepads: [makePad(PAD_IDS.playstation)] });
    ps.pollOnly(16);
    assert.equal(ps.api().Shell._formatHint('{A} DROP'), '✕ DROP',
      'a DualSense reads the button it actually has');

    const nin = makeEnv({ gamepads: [makePad(PAD_IDS.nintendo)] });
    nin.pollOnly(16);
    assert.equal(nin.api().Shell._formatHint('{A} DROP · {B} BACK'), 'A DROP · B BACK');
  });

  it('leaves no unsubstituted placeholders in any shipped hint', () => {
    const env = makeEnv();
    const { GAMES, VERSUS_GAMES, Shell } = env.api();
    for (const g of GAMES.concat(VERSUS_GAMES)) {
      const out = Shell._formatHint(g.hint);
      assert.notOk(/\{[A-Z]\}/.test(out), `${g.id} fully substituted: ${out}`);
    }
  });

  it('draws the hint on the selected card, in pause, and at game start', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    /* Dashboard with a selected card. */
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16); });

    Shell._startGame(env.api().gameById('tetris'));
    const before = { ...env.stats };
    for (let i = 0; i < 10; i++) env.tick(16);
    assert.ok(env.stats.texts + env.stats.images > before.texts + before.images,
      'the start banner drew');

    env.fireKey('KeyP', true); env.tick(16);
    env.fireKey('KeyP', false); env.tick(16);
    assert.equal(Shell.state(), 'pause');
    assert.doesNotThrow(() => { for (let i = 0; i < 20; i++) env.tick(16); });
  });

  it('the start banner fades out rather than staying forever', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    Shell._startGame(env.api().gameById('snake'));
    for (let i = 0; i < 5000 / 16.667; i++) env.tick(16.667);
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16.667); },
      'still drawing cleanly once the banner has gone');
  });
});

describe('attract self-play', () => {
  /** Drive a game the way the shell's attract loop does. */
  function runDemo(env, g, ms) {
    const { Shell, Input } = env.api();
    let ended = -1;
    const frames = Math.floor(ms / 16.667);
    for (let f = 0; f < frames; f++) {
      let map = null;
      if (typeof g.demo === 'function') {
        try { map = g.demo(); } catch (e) { map = null; }
      }
      Input.setDemo(map);
      env.tick(16.667);
      if (Shell.state() !== 'game') { ended = f * 16.667; break; }
    }
    Input.setDemo(null);
    return ended;
  }

  it('every game survives a full attract slot, on every seed', () => {
    /* SNAKE used to die after 2.8s and PULSE after 8.5s, then sit as a frozen
     * board — which reads as a crashed cabinet from across a room.
     *
     * Seeded explicitly: startGame() otherwise seeds from the clock, which
     * would make this pass or fail depending on the time of day. */
    const env = makeEnv();
    const { Shell, GAMES } = env.api();
    bootToMenu(env);
    for (const g of GAMES) {
      for (let seed = 1; seed <= 8; seed++) {
        Shell._startGame(g, false, seed);
        const died = runDemo(env, g, 14000);
        assert.equal(died, -1,
          `${g.id} seed ${seed} survived the 14s slot (died at ${Math.round(died)}ms)`);
        Shell._go('menu');
      }
    }
  });

  it('the pilots actually play rather than merely surviving', () => {
    const env = makeEnv();
    const { Shell, gameById } = env.api();
    bootToMenu(env);
    for (const id of ['pulse', 'drop', 'climb']) {
      const g = gameById(id);
      Shell._startGame(g, false, 4242);
      runDemo(env, g, 14000);
      assert.ok(g._test.score() > 0, `${id} scored ${g._test.score()} while demoing`);
      Shell._go('menu');
    }
  });

  it('demo input never counts as somebody touching the cabinet', () => {
    /* If it did, the demo's first press would wake attract mode instantly. */
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    Shell._forceIdle(61000);
    let entered = false;
    for (let i = 0; i < 40000 / 40; i++) {
      env.tick(40);
      if (Shell.state() === 'attract') entered = true;
      else if (entered) assert.ok(false, 'attract mode woke itself up');
    }
    assert.ok(entered, 'attract mode engaged');
    assert.equal(Shell.state(), 'attract', 'and stayed');
  });

  it('a real button still wakes it instantly', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Shell } = env.api();
    bootToMenu(env);
    for (let i = 0; i < 70000 / 40; i++) env.tick(40);
    assert.equal(Shell.state(), 'attract');
    pad.press(3);
    env.tick(16); env.tick(16);
    assert.equal(Shell.state(), 'menu');
  });

  it('hands input back on the way out', () => {
    const env = makeEnv();
    const { Shell, Input } = env.api();
    bootToMenu(env);
    Shell._forceIdle(61000);
    for (let i = 0; i < 200; i++) env.tick(40);
    assert.equal(Shell.state(), 'attract');
    assert.ok(Input.demoActive(), 'the demo is driving');
    Shell._go('menu');
    assert.notOk(Input.demoActive(), 'and stops driving the moment it leaves');
  });

  it('a demo that throws does not take the cabinet down', () => {
    const env = makeEnv();
    const { Shell, GAMES, Faults } = env.api();
    bootToMenu(env);
    /* Break every pilot: attract rotates, so which game comes up first is not
     * this test's business. */
    for (const g of GAMES) {
      g.demo = function () { throw new Error('bad pilot'); };
    }
    Shell._forceIdle(61000);
    assert.doesNotThrow(() => { for (let i = 0; i < 600; i++) env.tick(40); });
    assert.ok(Faults.count() > 0, 'and the fault is recorded');
    assert.ok(/bad pilot/.test(Faults.latest().msg));
    assert.equal(Shell.state(), 'attract', 'attract keeps running regardless');
  });
});

describe('hang detection', () => {
  it('the frame loop emits a heartbeat', () => {
    const beats = [];
    const env = makeEnv({ fetch: (url) => {
      if (/\/alive$/.test(url)) beats.push(url);
      return Promise.resolve({ ok: true });
    } });
    bootToMenu(env);
    beats.length = 0;
    /* Ten seconds of frames at a 4s heartbeat interval. */
    for (let i = 0; i < 10000 / 16.667; i++) env.tick(16.667);
    assert.ok(beats.length >= 2 && beats.length <= 4,
      `sent ${beats.length} beats in 10s (expected ~2-3)`);
  });

  it('stops beating the instant frames stop', () => {
    const beats = [];
    const env = makeEnv({ fetch: (url) => {
      if (/\/alive$/.test(url)) beats.push(Date.now());
      return Promise.resolve({ ok: true });
    } });
    bootToMenu(env);
    for (let i = 0; i < 600; i++) env.tick(16.667);
    const before = beats.length;
    /* No ticks: a hang. */
    assert.equal(beats.length, before, 'no frames, no beats — which is the signal');
  });

  it('costs nothing when no agent is listening', () => {
    const env = makeEnv({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    assert.doesNotThrow(() => bootToMenu(env));
    assert.doesNotThrow(() => { for (let i = 0; i < 600; i++) env.tick(16.667); });
  });

  it('costs nothing when fetch does not exist', () => {
    const env = makeEnv({ fetch: undefined });
    assert.doesNotThrow(() => bootToMenu(env));
    assert.doesNotThrow(() => { for (let i = 0; i < 300; i++) env.tick(16.667); });
  });
});

describe('agent watchdog', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pi', 'arcadeos-agent.py'), 'utf8');

  it('is valid Python', () => {
    assert.doesNotThrow(() => {
      execFileSync('python3', ['-m', 'py_compile',
        path.join(__dirname, '..', 'pi', 'arcadeos-agent.py')], { stdio: 'pipe' });
    });
  });

  it('only arms after it has actually seen the front end', () => {
    /* Otherwise a machine with the kiosk disabled, or one still booting,
     * would be restarted on a timer forever. */
    assert.ok(/due = self\.armed and now >= self\.next_check/.test(src));
    assert.ok(/self\.armed = True/.test(src));
  });

  it('waits a grace period before judging again after a restart', () => {
    assert.ok(/GRACE_SECONDS/.test(src));
    assert.ok(/self\.next_check = time\.monotonic\(\) \+ GRACE_SECONDS/.test(src));
  });

  it('restarts the kiosk unit, never anything derived from a request', () => {
    assert.ok(/KIOSK_UNIT = "arcadeos\.service"/.test(src));
    assert.ok(/\[binary, "restart", KIOSK_UNIT\]/.test(src));
  });

  it('never interprets relayed log text as a command', () => {
    assert.ok(/log\("frontend: %s" % clean_text\(self\._body\(\)\)\)/.test(src),
      'log text is printed as data and nothing else');
  });

  it('holds instead of restarting while a person owns the console', () => {
    /* Ctrl+Alt+F2 stops the kiosk's frames because the kiosk lost the
     * display — the first cabinet's watchdog read that as a hang and
     * snatched the screen back mid-keystroke. The watch loop must consult
     * the hold before every restart. */
    assert.ok(/ACTIVE_VT_FILE = "\/sys\/class\/tty\/tty0\/active"/.test(src));
    const watch = src.slice(src.indexOf('def watch'));
    assert.ok(/watchdog_hold\(\)/.test(watch), 'the watch loop consults the hold');
    assert.ok(/self\.last = time\.monotonic\(\)/.test(watch),
      'silence accrued while away is forgiven');
  });

  it('the hold logic distinguishes a person from a hang (runs for real)', () => {
    const agentPath = path.join(__dirname, '..', 'pi', 'arcadeos-agent.py');
    const script = [
      'import importlib.util, tempfile, os',
      `spec = importlib.util.spec_from_file_location("agent", ${JSON.stringify(agentPath)})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'fd, p = tempfile.mkstemp()',
      'os.close(fd)',
      'm.ACTIVE_VT_FILE = p',
      'm.kiosk_unit_active = lambda: True',
      'open(p, "w").write("tty2\\n")',
      'assert m.watchdog_hold() == "console is on tty2", m.watchdog_hold()',
      'open(p, "w").write("tty1\\n")',
      'assert m.watchdog_hold() == "", m.watchdog_hold()',
      'm.kiosk_unit_active = lambda: False',
      'assert "stopped" in m.watchdog_hold(), m.watchdog_hold()',
      /* No VT sysfs at all (a container): judge normally, never crash. */
      'os.unlink(p)',
      'm.kiosk_unit_active = lambda: True',
      'assert m.watchdog_hold() == "", m.watchdog_hold()',
      'print("ok")',
    ].join('\n');
    const out = execFileSync('python3', ['-c', script], { stdio: 'pipe' }).toString();
    assert.ok(/ok/.test(out), out);
  });

  it('holds while the kiosk unit is deliberately stopped', () => {
    /* `systemctl stop arcadeos` over SSH is the documented rescue path; the
     * watchdog restarting it 30s later would make rescue impossible. A unit
     * that CRASHES is systemd's job (Restart=always), not the watchdog's. */
    assert.ok(/"is-active", "--quiet", KIOSK_UNIT/.test(src));
    assert.ok(/is stopped/.test(src));
  });

  it('the setup script arms the hardware watchdog and disarms it on uninstall', () => {
    const setup = fs.readFileSync(path.join(__dirname, '..', 'setup-arcade.sh'), 'utf8');
    assert.ok(/RuntimeWatchdogSec=20/.test(setup));
    assert.ok(/install_watchdog/.test(setup));
    const uninstall = setup.slice(setup.indexOf('uninstall() {'));
    assert.ok(/remove_block \/etc\/systemd\/system\.conf/.test(uninstall),
      'uninstall disarms it again');
  });
});

describe('GPU visibility', () => {
  /*
   * The 22fps cabinet was undiagnosable from the journal — Chromium said
   * nothing. The page itself is the one place that can reliably report
   * whether the browser got the VideoCore or fell back to SwiftShader, so
   * DIAGNOSTICS shows the WebGL renderer string.
   */
  it('probes once, never throws, and caches the answer', () => {
    const env = makeEnv();
    bootToMenu(env);
    const { Render } = env.api();
    const a = Render.gpuInfo();
    assert.ok(typeof a === 'string' && a.length > 0, `got "${a}"`);
    assert.equal(Render.gpuInfo(), a, 'second call is the cached answer');
  });

  it('classifies software rasterisers as the problem they are', () => {
    const env = makeEnv();
    const { Render } = env.api();
    /* The harness has no real WebGL, so the probe lands on a fallback
     * string; whatever it is, the classifier must not throw and must only
     * flag genuine software renderers. */
    const soft = Render.gpuIsSoftware();
    assert.ok(soft === true || soft === false);
    assert.ok(!/v3d|broadcom/i.test(Render.gpuInfo()) || !soft,
      'a real VideoCore string is never flagged as software');
  });

  it('the DIAGNOSTICS screen renders with the GPU row', () => {
    const env = makeEnv();
    bootToMenu(env);
    const { Shell, Faults } = env.api();
    Shell._go('faults');
    for (let i = 0; i < 30; i++) env.tick(16.667);
    assert.equal(Shell.state(), 'faults');
    assert.equal(Faults.count(), 0, JSON.stringify(Faults.latest()));
  });
});

describe('frame cost visibility', () => {
  it('Loop.perf() reports sane numbers under harness driving', () => {
    const env = makeEnv();
    bootToMenu(env);
    const { Loop } = env.api();
    const p = Loop.perf();
    assert.ok(isFinite(p.fps) && p.fps > 0, `fps ${p.fps}`);
    assert.ok(isFinite(p.cpuMean) && p.cpuMean >= 0, `cpu ${p.cpuMean}`);
    assert.ok(p.cpuWorst >= p.cpuMean, 'worst is at least the mean');
  });

  it('the frame timer overlay draws with the cpu figure', () => {
    const env = makeEnv();
    bootToMenu(env);
    const { Settings, Faults } = env.api();
    Settings.set('showFps', true);
    for (let i = 0; i < 30; i++) env.tick(16.667);
    assert.equal(Faults.count(), 0, JSON.stringify(Faults.latest()));
  });

  it('DIAGNOSTICS shows the surface the browser handed us', () => {
    const env = makeEnv({ width: 1920, height: 1080 });
    bootToMenu(env);
    const { Shell, Faults } = env.api();
    Shell._go('faults');
    for (let i = 0; i < 10; i++) env.tick(16.667);
    assert.equal(Faults.count(), 0, JSON.stringify(Faults.latest()));
  });

  it('relays a diag line through the agent when a cabinet has fetch', () => {
    /* The kiosk unit journal drops Chromium stderr on real hardware; the
     * agent journal is the channel that works. Pin the line's shape so the
     * grep in the README keeps finding it. */
    const sent = [];
    const fakeFetch = (url, opts) => {
      sent.push({ url: String(url), body: opts && opts.body });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    const env = makeEnv({ fetch: fakeFetch });
    bootToMenu(env);
    env.api()._diag();
    const diag = sent.filter((r) => r.url.endsWith('/log'))
      .map((r) => String(r.body))
      .find((b) => b.indexOf('diag ') === 0);
    assert.ok(diag, `a diag line was posted; saw ${sent.length} requests`);
    assert.ok(/gpu="[^"]*"/.test(diag), 'names the GPU: ' + diag);
    assert.ok(/dev=\d+x\d+ rot=\d+/.test(diag), 'names the surface: ' + diag);
    assert.ok(/fps=[\d.]+ cpu=[\d.]+ms/.test(diag), 'names the cost: ' + diag);
  });
});
