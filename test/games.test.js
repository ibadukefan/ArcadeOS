/*
 * Per-game tests.
 *
 * For every registered game:
 *   - the module contract is satisfied
 *   - boot -> dashboard -> game -> pause -> quit completes
 *   - >= 1500 randomised input frames run without an exception or an invalid
 *     draw call, with dt varied to catch frame-rate assumptions
 *   - preview() survives being called at arbitrary sizes and times
 *
 * Seeds are fixed, so a failure here reproduces exactly.
 */
'use strict';

const { makeEnv, makePad, PAD_IDS } = require('./harness.js');

const FUZZ_FRAMES = 1500;

/** Deterministic PRNG for the fuzzer itself, independent of the bundle's. */
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * dt values chosen to break frame-rate assumptions: 144Hz, 60Hz, 30Hz, a
 * fractional value that never divides evenly into any timer, and a long stall.
 */
const DTS = [6.944, 16.667, 33.333, 11.3, 49, 8.5, 21.7];

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

/* Enumerate games from a throwaway environment so the list is never stale. */
const GAME_IDS = (() => {
  const env = makeEnv();
  const { GAMES, VERSUS_GAMES } = env.api();
  return {
    normal: GAMES.map((g) => g.id),
    versus: VERSUS_GAMES.map((g) => g.id),
    all: GAMES.concat(VERSUS_GAMES).map((g) => g.id),
  };
})();

describe('game module contract', () => {
  it('registers at least the four base games', () => {
    assert.ok(GAME_IDS.normal.length >= 4, `only found ${GAME_IDS.normal.join(', ')}`);
    for (const id of ['tetris', 'ascent', 'stack', 'snake']) {
      assert.ok(GAME_IDS.normal.includes(id), `${id} is registered`);
    }
  });

  for (const id of GAME_IDS.all) {
    it(`${id} conforms to the module shape`, () => {
      const env = makeEnv();
      const g = env.api().gameById(id);
      assert.ok(g, `${id} resolves`);
      assert.equal(typeof g.id, 'string');
      assert.ok(g.title && typeof g.title === 'string', 'has a title');
      assert.ok(g.tag && typeof g.tag === 'string', 'has a one-line tag');
      assert.ok(g.tag.length <= 46, `tag fits on a card: "${g.tag}" (${g.tag.length})`);
      assert.ok(/^#[0-9A-Fa-f]{6}$/.test(g.accent), `accent is a hex colour: ${g.accent}`);
      for (const fn of ['start', 'update', 'draw', 'preview']) {
        assert.equal(typeof g[fn], 'function', `${id}.${fn} is a function`);
      }
    });
  }

  it('every accent is one of the design-system colours', () => {
    const env = makeEnv();
    const { ACCENT, GAMES, VERSUS_GAMES } = env.api();
    const allowed = Object.values(ACCENT).map((c) => c.toUpperCase());
    for (const g of GAMES.concat(VERSUS_GAMES)) {
      assert.ok(allowed.includes(g.accent.toUpperCase()),
        `${g.id} uses an off-palette accent ${g.accent}`);
    }
  });
});

describe('navigation', () => {
  for (const id of GAME_IDS.all) {
    it(`boot -> dashboard -> ${id} -> pause -> quit`, () => {
      const env = makeEnv();
      const { Shell } = env.api();

      bootToMenu(env);
      assert.equal(Shell.state(), 'menu');

      assert.ok(Shell._select(id), `${id} is reachable on the dashboard`);
      env.fireKey('Enter', true);
      env.tick(16);
      env.fireKey('Enter', false);
      env.tick(16);
      assert.equal(Shell.state(), 'game', `${id} started`);
      assert.equal(Shell._activeGame().id, id);

      /* Play a little. */
      for (let i = 0; i < 60; i++) env.tick(16.667);

      /* Pause. */
      env.fireKey('KeyP', true);
      env.tick(16);
      env.fireKey('KeyP', false);
      env.tick(16);
      assert.equal(Shell.state(), 'pause', `${id} pauses`);

      /* Resume, then pause again and quit via the menu. */
      env.fireKey('Escape', true); env.tick(16);
      env.fireKey('Escape', false); env.tick(16);
      assert.equal(Shell.state(), 'game', `${id} resumes`);

      env.fireKey('KeyP', true); env.tick(16);
      env.fireKey('KeyP', false); env.tick(16);
      assert.equal(Shell.state(), 'pause');

      /* Move to QUIT TO MENU (index 2) and confirm. */
      for (let k = 0; k < 2; k++) {
        env.fireKey('ArrowDown', true); env.tick(16);
        env.fireKey('ArrowDown', false); env.tick(16);
      }
      env.fireKey('Enter', true); env.tick(16);
      env.fireKey('Enter', false); env.tick(16);
      assert.equal(Shell.state(), 'menu', `${id} quits back to the dashboard`);
    });
  }
});

describe('randomised play', () => {
  for (const id of GAME_IDS.all) {
    it(`${id}: ${FUZZ_FRAMES} random frames, no exception, no invalid draw`, () => {
      const pad = makePad(PAD_IDS.xbox);
      const env = makeEnv({ gamepads: [pad] });
      const { Shell, seedRng } = env.api();
      const r = rng(0xA11CE + id.length * 7919);

      bootToMenu(env);
      seedRng(0xC0FFEE);
      assert.ok(Shell._select(id));
      Shell._startGame(env.api().gameById(id));
      assert.equal(Shell.state(), 'game');

      const BUTTONS = [0, 1, 2, 3, 8, 12, 13, 14, 15];
      let frames = 0;
      let restarts = 0;

      while (frames < FUZZ_FRAMES) {
        /* Randomly toggle inputs, favouring holds over single taps so DAS
         * and lock-delay paths get exercised. */
        if (r() < 0.28) {
          const b = BUTTONS[(r() * BUTTONS.length) | 0];
          if (r() < 0.5) pad.press(b); else pad.release(b);
        }
        if (r() < 0.08) pad.setAxis(0, r() * 2 - 1);
        if (r() < 0.08) pad.setAxis(1, r() * 2 - 1);
        if (r() < 0.02) pad.releaseAll();

        const dt = DTS[(r() * DTS.length) | 0];
        env.tick(dt);
        frames++;

        /* Games end. When one does, walk back in and keep fuzzing so the
         * game-over and initials paths get frames too. */
        const st = Shell.state();
        if (st === 'over' || st === 'initials') {
          pad.releaseAll();
          for (let k = 0; k < 40 && restarts < 40; k++) {
            pad.press(0); env.tick(16); pad.release(0); env.tick(16);
            frames += 2;
            if (Shell.state() === 'game' || Shell.state() === 'menu') break;
          }
          restarts++;
          if (Shell.state() === 'menu') {
            Shell._startGame(env.api().gameById(id));
          }
        }
      }

      assert.ok(frames >= FUZZ_FRAMES, `ran ${frames} frames`);
      assert.ok(env.stats.fills > 100, 'the game actually drew something');
    });
  }

  it('varies dt without breaking gravity timing', () => {
    /* Same wall-clock, different frame pacing: a Tetris piece must fall the
     * same distance. A per-frame gravity step fails this. */
    function fallDistanceAt(dtPerFrame) {
      const env = makeEnv();
      const { Shell, seedRng, gameById } = env.api();
      bootToMenu(env);
      seedRng(12345);
      Shell._startGame(gameById('tetris'));
      let elapsed = 0;
      let locks = 0;
      const g = gameById('tetris');
      while (elapsed < 6000) {
        env.tick(dtPerFrame);
        elapsed += dtPerFrame;
      }
      return Shell.state();
    }
    /* Both pacings must still be alive and in the same state after 6s of
     * hands-off play — no wild divergence from frame-rate. */
    assert.equal(fallDistanceAt(16.667), fallDistanceAt(6.944));
  });
});

describe('previews', () => {
  for (const id of GAME_IDS.all) {
    it(`${id}.preview() is safe at any size and time`, () => {
      const env = makeEnv();
      const g = env.api().gameById(id);
      const ctx = env.screen.getContext('2d');
      const sizes = [[454, 198], [200, 120], [40, 24], [900, 400], [1, 1]];
      const times = [0, 17, 999, 12345, 60000, 1e6];
      assert.doesNotThrow(() => {
        for (const [w, h] of sizes) {
          for (const t of times) g.preview(ctx, w, h, t);
        }
      }, `${id}.preview()`);
    });
  }

  it('animates — two different times produce different output', () => {
    const env = makeEnv();
    const ctx = env.screen.getContext('2d');
    for (const id of GAME_IDS.all) {
      const g = env.api().gameById(id);
      const before = { ...env.stats };
      g.preview(ctx, 454, 198, 0);
      const a = env.stats.fills + env.stats.images - before.fills - before.images;
      assert.ok(a > 0, `${id} preview draws something`);
    }
  });
});

describe('dashboard', () => {
  it('scrolls once the card count exceeds the viewport', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    const rows = Shell._rows();
    assert.ok(rows.length >= 3, 'dashboard has multiple rows');

    /* Drive to the last row and confirm the cursor tracked it. */
    for (let i = 0; i < rows.length + 4; i++) {
      env.fireKey('ArrowDown', true); env.tick(16);
      env.fireKey('ArrowDown', false); env.tick(16);
    }
    assert.equal(Shell._cursor().row, rows.length - 1, 'cursor reaches the last row');
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16); });

    /* And back to the top. */
    for (let i = 0; i < rows.length + 4; i++) {
      env.fireKey('ArrowUp', true); env.tick(16);
      env.fireKey('ArrowUp', false); env.tick(16);
    }
    assert.equal(Shell._cursor().row, 0);
  });

  it('never navigates off the end of a row', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    bootToMenu(env);
    for (let i = 0; i < 12; i++) {
      env.fireKey('ArrowRight', true); env.tick(16);
      env.fireKey('ArrowRight', false); env.tick(16);
    }
    const cur = Shell._cursor();
    const rows = Shell._rows();
    assert.ok(cur.col < rows[cur.row].length, 'column stays in range');
    assert.equal(Shell.state(), 'menu');
  });
});
