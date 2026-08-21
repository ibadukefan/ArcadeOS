/*
 * Shell tests: initials entry, high score tables, settings, the shutdown
 * path, attract mode, and the hard requirement that every single feature is
 * reachable with a d-pad and two buttons.
 */
'use strict';

const { makeEnv, makePad, PAD_IDS } = require('./harness.js');

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

/** Snapshot a harness localStorage so a second env can "reboot" onto it. */
function snapshot(env) {
  const out = {};
  for (const [k, v] of env.getStorage()._map.entries()) out[k] = v;
  return out;
}

/** Press and release a keyboard action across two frames. */
function tap(env, code, times = 1) {
  for (let i = 0; i < times; i++) {
    env.fireKey(code, true); env.tick(16);
    env.fireKey(code, false); env.tick(16);
  }
}

/** Press and release a gamepad button across two frames. */
function padTap(env, pad, button, times = 1) {
  for (let i = 0; i < times; i++) {
    pad.press(button); env.tick(16);
    pad.release(button); env.tick(16);
  }
}

describe('initials entry', () => {
  it('is driven entirely by d-pad and confirm', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Shell, Scores } = env.api();
    bootToMenu(env);

    Shell._startGame(env.api().gameById('tetris'));
    Shell.gameOver(4321);
    assert.equal(Shell.state(), 'initials', 'a qualifying score asks for initials');

    /* Wait out the entry lock-out. */
    for (let i = 0; i < 30; i++) env.tick(16);

    /* A -> C on the first slot (up twice), then across and down for Z. */
    padTap(env, pad, 12, 2);            /* d-pad up x2  => 'C' */
    padTap(env, pad, 15);               /* d-pad right  => slot 2 */
    padTap(env, pad, 13);               /* d-pad down   => wraps to 'Z' */
    padTap(env, pad, 15);               /* slot 3 */
    padTap(env, pad, 12);               /* 'B' */

    padTap(env, pad, 0);                /* confirm on the last slot commits */
    assert.equal(Shell.state(), 'over', 'committing returns to the game-over card');

    const table = Scores.table('tetris');
    assert.equal(table.length, 1);
    assert.equal(table[0].name, 'CZB', `got ${table[0].name}`);
    assert.equal(table[0].score, 4321);
  });

  it('confirm walks forward through the slots before committing', () => {
    const env = makeEnv();
    const { Shell, Scores } = env.api();
    bootToMenu(env);
    Shell._startGame(env.api().gameById('snake'));
    Shell.gameOver(900);
    for (let i = 0; i < 30; i++) env.tick(16);

    tap(env, 'Enter');
    assert.equal(Shell.state(), 'initials', 'first confirm advances, does not commit');
    tap(env, 'Enter');
    assert.equal(Shell.state(), 'initials', 'second confirm advances');
    tap(env, 'Enter');
    assert.equal(Shell.state(), 'over', 'third confirm commits');
    assert.equal(Scores.table('snake')[0].name, 'AAA');
  });

  it('back steps a slot and commits from the first slot', () => {
    const env = makeEnv();
    const { Shell, Scores } = env.api();
    bootToMenu(env);
    Shell._startGame(env.api().gameById('stack'));
    Shell.gameOver(150);
    for (let i = 0; i < 30; i++) env.tick(16);

    tap(env, 'Escape');
    assert.equal(Shell.state(), 'over', 'back on slot one commits rather than trapping');
    assert.equal(Scores.table('stack').length, 1);
  });

  it('does not ask for initials on a non-qualifying score', () => {
    const env = makeEnv();
    const { Shell, Scores } = env.api();
    bootToMenu(env);
    for (let i = 1; i <= 5; i++) Scores.submit('ascent', i * 1000, 'ZZZ', i);
    Shell._startGame(env.api().gameById('ascent'));
    Shell.gameOver(10);
    assert.equal(Shell.state(), 'over');
    assert.equal(Scores.table('ascent').length, 5, 'table is unchanged');
  });

  it('does not ask for initials on a zero score', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    Shell._startGame(env.api().gameById('tetris'));
    Shell.gameOver(0);
    assert.equal(Shell.state(), 'over');
  });
});

describe('persistence across a reboot', () => {
  it('high scores and settings survive', () => {
    const env1 = makeEnv();
    const { Shell, Scores, Settings } = env1.api();
    bootToMenu(env1);
    Scores.submit('tetris', 12345, 'RLE', 1000);
    Settings.set('volume', 0.35);
    Settings.set('layout', 'nintendo');
    Settings.set('crt', false);

    /* Power cycle: brand new process, same storage medium. */
    const env2 = makeEnv({ storage: snapshot(env1) });
    const api2 = env2.api();
    bootToMenu(env2);

    assert.equal(api2.Scores.best('tetris'), 12345, 'high score survived');
    assert.equal(api2.Scores.table('tetris')[0].name, 'RLE');
    assert.equal(api2.Settings.get('volume'), 0.35, 'volume survived');
    assert.equal(api2.Settings.get('layout'), 'nintendo', 'layout survived');
    assert.equal(api2.Settings.get('crt'), false, 'CRT veil survived');
  });

  it('a truncated write costs one row, not the table', () => {
    const env1 = makeEnv();
    env1.api().Scores.submit('snake', 100, 'AAA', 1);
    env1.api().Scores.submit('snake', 200, 'BBB', 2);
    env1.api().Scores.submit('snake', 300, 'CCC', 3);

    /* Corrupt exactly one row, as a partial flush would. Key is derived from
     * the live schema version so a future bump does not silently turn this
     * into a test of the migration path instead. */
    const snap = snapshot(env1);
    const scoresKey = env1.api().Store._key('scores');
    const parsed = JSON.parse(snap[scoresKey]);
    parsed.snake[1] = { name: null, score: 'corrupted' };
    snap[scoresKey] = JSON.stringify(parsed);

    const env2 = makeEnv({ storage: snap });
    const t = env2.api().Scores.table('snake');
    assert.equal(t.length, 2, 'the two good rows are kept');
    assert.equal(t[0].score, 300);
    assert.equal(t[1].score, 100);
  });
});

describe('high score screen', () => {
  it('is reachable from the dashboard and shows per-game tables', () => {
    const env = makeEnv();
    const { Shell, Scores, GAMES } = env.api();
    Scores.submit('tetris', 777, 'ABC', 1);
    bootToMenu(env);

    const rows = Shell._rows();
    for (let i = 0; i < rows.length; i++) tap(env, 'ArrowDown');
    /* Last row is [HIGH SCORES, SETTINGS]; make sure we are on the left. */
    for (let i = 0; i < 3; i++) tap(env, 'ArrowLeft');
    tap(env, 'Enter');
    assert.equal(Shell.state(), 'scores');

    /* Cycle every game's table without throwing. */
    assert.doesNotThrow(() => {
      for (let i = 0; i < GAMES.length + 2; i++) tap(env, 'ArrowRight');
    });

    tap(env, 'Escape');
    assert.equal(Shell.state(), 'menu');
  });
});

describe('settings', () => {
  /** Cursor position of a settings row by id — indexes shift as rows grow. */
  function rowIndex(env, id) {
    const items = env.api().Shell._settingsItems();
    for (let i = 0; i < items.length; i++) if (items[i].id === id) return i;
    throw new Error('no settings row: ' + id);
  }

  function openSettings(env) {
    const { Shell } = env.api();
    bootToMenu(env);
    const rows = Shell._rows();
    for (let i = 0; i < rows.length; i++) tap(env, 'ArrowDown');
    for (let i = 0; i < 3; i++) tap(env, 'ArrowRight');
    tap(env, 'Enter');
    assert.equal(Shell.state(), 'settings', 'settings opened');
  }

  it('opens from the dashboard and closes with back', () => {
    const env = makeEnv();
    openSettings(env);
    tap(env, 'Escape');
    assert.equal(env.api().Shell.state(), 'menu');
  });

  it('exposes every required control', () => {
    const env = makeEnv();
    const ids = env.api().Shell._settingsItems().map((i) => i.id);
    for (const required of ['volume', 'muted', 'layout', 'crt', 'reducedMotion',
      'reset', 'restart', 'shutdown']) {
      assert.ok(ids.includes(required), `settings has ${required}`);
    }
  });

  it('adjusts volume with left/right and persists it', () => {
    const env = makeEnv();
    const { Settings, Shell } = env.api();
    openSettings(env);
    Shell._setCursor(rowIndex(env, 'volume'));
    const before = Settings.get('volume');
    tap(env, 'ArrowLeft', 3);
    const after = Settings.get('volume');
    assert.ok(after < before, `volume fell from ${before} to ${after}`);
    assert.ok(after >= 0, 'volume never goes negative');

    tap(env, 'ArrowLeft', 40);
    assert.equal(Settings.get('volume'), 0, 'clamps at zero');
    tap(env, 'ArrowRight', 60);
    assert.equal(Settings.get('volume'), 1, 'clamps at one');
  });

  it('toggles mute, CRT veil and reduced motion with confirm', () => {
    const env = makeEnv();
    const { Settings, Shell } = env.api();
    openSettings(env);
    for (const key of ['muted', 'crt', 'reducedMotion', 'rumble']) {
      Shell._setCursor(rowIndex(env, key));
      const before = Settings.get(key);
      tap(env, 'Enter');
      assert.equal(Settings.get(key), !before, `${key} toggled`);
    }
  });

  it('cycles the controller layout override', () => {
    const env = makeEnv();
    const { Settings, Shell } = env.api();
    openSettings(env);
    Shell._setCursor(rowIndex(env, 'layout'));
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      seen.add(Settings.get('layout'));
      tap(env, 'ArrowRight');
    }
    assert.deep([...seen].sort(), ['auto', 'nintendo', 'playstation', 'xbox']);
  });

  it('the rumble toggle suppresses haptics; reduced motion does not', () => {
    /* Haptics moved to their own switch: rumble is touch, not motion, and a
     * player sensitive to screen shake may still want it. */
    const pad = makePad(PAD_IDS.xbox, { rumble: true });
    let effects = 0;
    pad.vibrationActuator = { playEffect: () => { effects++; return Promise.resolve(); } };
    const env = makeEnv({ gamepads: [pad] });
    const { Input, Settings } = env.api();
    env.tick(16);

    Input.rumble(0.5, 0.5, 100);
    assert.equal(effects, 1, 'rumble fires normally');

    Settings.set('reducedMotion', true);
    Input.rumble(0.5, 0.5, 100);
    assert.equal(effects, 2, 'reduced motion leaves haptics alone');

    Settings.set('rumble', false);
    Input.rumble(0.5, 0.5, 100);
    assert.equal(effects, 2, 'the rumble toggle turns them off');
  });

  it('resets high scores only after an explicit confirm', () => {
    const env = makeEnv();
    const { Shell, Scores } = env.api();
    Scores.submit('tetris', 999, 'AAA', 1);
    openSettings(env);

    const resetIndex = Shell._settingsItems().findIndex((i) => i.id === 'reset');
    Shell._setCursor(resetIndex);
    tap(env, 'Enter');
    assert.ok(Shell._confirm(), 'a confirmation box appeared');
    assert.equal(Scores.best('tetris'), 999, 'nothing erased yet');

    /* Default selection is CANCEL; cancelling must not erase. */
    tap(env, 'Escape');
    assert.notOk(Shell._confirm(), 'box dismissed');
    assert.equal(Scores.best('tetris'), 999, 'cancel kept the scores');

    /* Now confirm properly: open, move to YES, press confirm. */
    tap(env, 'Enter');
    assert.ok(Shell._confirm());
    tap(env, 'ArrowLeft');
    tap(env, 'Enter');
    assert.equal(Scores.best('tetris'), 0, 'scores were erased');
  });

  it('shutdown and restart ask first, then call the local agent', () => {
    const calls = [];
    const fetchMock = (url, opts) => {
      calls.push({ url, method: opts && opts.method });
      return Promise.resolve({ ok: true, status: 200 });
    };
    const env = makeEnv({ fetch: fetchMock });
    const { Shell } = env.api();
    openSettings(env);

    for (const [id, expected] of [['restart', 'restart'], ['shutdown', 'shutdown']]) {
      const index = Shell._settingsItems().findIndex((i) => i.id === id);
      Shell._setCursor(index);
      tap(env, 'Enter');
      assert.ok(Shell._confirm(), `${id} asks for confirmation`);
      tap(env, 'ArrowLeft');       /* select YES */
      tap(env, 'Enter');
      const last = calls[calls.length - 1];
      assert.ok(last, `${id} issued a request`);
      assert.ok(last.url.includes(expected), `request targets ${expected}: ${last.url}`);
      assert.ok(last.url.startsWith('http://127.0.0.1:'), 'agent is loopback only');
      assert.equal(last.method, 'POST');
    }
  });

  it('survives the agent being absent', () => {
    const env = makeEnv({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    const { Shell, System } = env.api();
    openSettings(env);
    const index = Shell._settingsItems().findIndex((i) => i.id === 'shutdown');
    Shell._setCursor(index);
    tap(env, 'Enter');
    tap(env, 'ArrowLeft');
    assert.doesNotThrow(() => tap(env, 'Enter'));
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16); });
    assert.equal(Shell.state(), 'settings', 'the UI is still usable');
  });

  it('does nothing at all when there is no fetch', () => {
    const env = makeEnv({ fetch: undefined });
    const { System } = env.api();
    assert.doesNotThrow(() => System.request('shutdown'));
    assert.ok(/failed/.test(System.lastResult()), 'reports the failure honestly');
  });

  it('ignores an unknown system command', () => {
    const calls = [];
    const env = makeEnv({ fetch: (u) => { calls.push(u); return Promise.resolve({ ok: true }); } });
    env.api().System.request('rm -rf /');
    env.api().System.request('format');
    assert.deep(calls, [], 'only the three known commands are ever sent');
  });
});

describe('attract mode', () => {
  it('starts after about 60 seconds idle on the dashboard', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    assert.equal(Shell.state(), 'menu');

    /* 40 seconds is not enough. */
    for (let i = 0; i < 40000 / 40; i++) env.tick(40);
    assert.equal(Shell.state(), 'menu', 'still on the dashboard at 40s');

    /* Past 60 seconds it takes over. */
    for (let i = 0; i < 25000 / 40; i++) env.tick(40);
    assert.equal(Shell.state(), 'attract', 'attract mode engaged');
  });

  it('returns instantly on any input', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Shell } = env.api();
    bootToMenu(env);
    for (let i = 0; i < 70000 / 40; i++) env.tick(40);
    assert.equal(Shell.state(), 'attract');

    pad.press(3);                  /* an arbitrary face button */
    env.tick(16);
    env.tick(16);
    assert.equal(Shell.state(), 'menu', 'any input wakes the cabinet');
  });

  it('idle timer resets on input and never fires mid-game', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    for (let i = 0; i < 30000 / 40; i++) env.tick(40);
    tap(env, 'ArrowDown');
    assert.ok(Shell._idle() < 5000, 'input reset the idle timer');

    Shell._startGame(env.api().gameById('tetris'));
    for (let i = 0; i < 90000 / 40; i++) env.tick(40);
    assert.notEqual(Shell.state(), 'attract', 'a game in progress never attracts');
  });

  it('cycles through demos without throwing', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    Shell._forceIdle(61000);
    assert.doesNotThrow(() => {
      for (let i = 0; i < 120000 / 40; i++) env.tick(40);
    });
    assert.equal(Shell.state(), 'attract');
  });
});

describe('gamepad-only reachability', () => {
  it('every screen is reachable with a d-pad and two buttons', () => {
    /* No keyboard events are fired anywhere in this test. If a feature needs
     * a key, this fails. */
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Shell } = env.api();

    padTap(env, pad, 0);                       /* confirm past the boot splash */
    for (let i = 0; i < 200; i++) env.tick(16);
    assert.equal(Shell.state(), 'menu');

    /* Into a game and back out, pad only. */
    padTap(env, pad, 0);
    assert.equal(Shell.state(), 'game');
    padTap(env, pad, 9);                       /* Start = pause */
    assert.equal(Shell.state(), 'pause');
    padTap(env, pad, 13, 2);                   /* down to QUIT */
    padTap(env, pad, 0);
    assert.equal(Shell.state(), 'menu');

    /* Down to the system row, then into settings. */
    const rows = Shell._rows();
    padTap(env, pad, 13, rows.length + 2);
    padTap(env, pad, 15, 3);                   /* right to SETTINGS */
    padTap(env, pad, 0);
    assert.equal(Shell.state(), 'settings');

    /* Reach the shutdown entry and back out again — all on the pad. */
    const items = Shell._settingsItems();
    const shutdownIndex = items.findIndex((i) => i.id === 'shutdown');
    /* Headers are skipped by the cursor, so count selectable rows only. */
    const downs = items.slice(0, shutdownIndex + 1)
      .filter((i) => i.type !== 'header').length - 1;
    padTap(env, pad, 13, downs);
    padTap(env, pad, 0);
    assert.ok(Shell._confirm(), 'shutdown is reachable on the pad alone');
    padTap(env, pad, 1);                       /* B cancels */
    assert.notOk(Shell._confirm());

    padTap(env, pad, 1);
    assert.equal(Shell.state(), 'menu', 'B leaves settings');

    /* High scores, pad only. */
    padTap(env, pad, 13, rows.length + 2);
    padTap(env, pad, 14, 3);
    padTap(env, pad, 0);
    assert.equal(Shell.state(), 'scores');
    padTap(env, pad, 1);
    assert.equal(Shell.state(), 'menu');
  });

  it('a Nintendo pad drives the same walk with swapped buttons', () => {
    const pad = makePad(PAD_IDS.nintendo);
    const env = makeEnv({ gamepads: [pad] });
    const { Shell } = env.api();

    for (let i = 0; i < 200; i++) env.tick(16);
    assert.equal(Shell.state(), 'menu');

    padTap(env, pad, 1);            /* right face button = confirm on Nintendo */
    assert.equal(Shell.state(), 'game', 'Nintendo confirm starts a game');

    padTap(env, pad, 9);
    assert.equal(Shell.state(), 'pause');
    padTap(env, pad, 0);            /* bottom face button = back on Nintendo */
    assert.equal(Shell.state(), 'game', 'Nintendo back resumes');
  });
});
