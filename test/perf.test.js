/*
 * Performance regression tests.
 *
 * These cannot tell you the cabinet holds 60fps — only a Pi can do that, with
 * the in-app frame timer. What they CAN do is fail the build when a change
 * reintroduces the shapes of cost that make a Pi 4 miss frames: unbounded
 * draw calls, per-frame allocation, uncached glow, or letter-spaced text
 * being re-rasterised every frame.
 *
 * Budgets are set well above current measurements, so they flag a regression
 * rather than bikeshedding a few draw calls.
 */
'use strict';

const { makeEnv } = require('./harness.js');

/** Draw calls per frame, averaged over `frames`. */
function perFrame(env, frames) {
  const before = { ...env.stats };
  for (let i = 0; i < frames; i++) env.tick(16.667);
  const d = (k) => (env.stats[k] - before[k]) / frames;
  const fills = d('fills'), strokes = d('strokes');
  const texts = d('texts'), images = d('images');
  return { fills, strokes, texts, images, total: fills + strokes + texts + images };
}

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

describe('draw budget', () => {
  it('the dashboard stays within budget', () => {
    const env = makeEnv();
    bootToMenu(env);
    const m = perFrame(env, 90);
    assert.ok(m.total < 700,
      `dashboard drew ${m.total.toFixed(0)} calls/frame (budget 700)`);
    /* The specific regression: nine cards of letter-spaced titles and tags
     * being re-rasterised glyph by glyph, every frame. */
    assert.ok(m.texts < 60,
      `dashboard issued ${m.texts.toFixed(0)} fillText/frame — static text is not being cached`);
  });

  it('every game stays within budget', () => {
    const env = makeEnv();
    const { Shell, GAMES, VERSUS_GAMES, seedRng } = env.api();
    bootToMenu(env);
    for (const g of GAMES.concat(VERSUS_GAMES)) {
      seedRng(99);
      Shell._startGame(g);
      const m = perFrame(env, 120);
      assert.ok(m.total < 400,
        `${g.id} drew ${m.total.toFixed(0)} calls/frame (budget 400)`);
    }
  });

  it('caches are bounded, not unbounded', () => {
    const env = makeEnv();
    const { Shell, GAMES, Render, seedRng } = env.api();
    bootToMenu(env);
    /* Walk everything, several times, and confirm the caches level off. */
    for (let pass = 0; pass < 3; pass++) {
      for (const g of GAMES) {
        seedRng(pass * 7 + 1);
        Shell._startGame(g);
        for (let i = 0; i < 90; i++) env.tick(16.667);
      }
      Shell._go('menu');
      for (let i = 0; i < 60; i++) env.tick(16.667);
    }
    const sizes = Render._cacheSizes();
    assert.ok(sizes.glow <= 96, `glow cache is capped, got ${sizes.glow}`);
    assert.ok(sizes.text <= 192, `text cache is capped, got ${sizes.text}`);
  });
});

describe('allocation discipline', () => {
  it('particle pools are fixed size and never grow', () => {
    const env = makeEnv();
    const { Shell, GAMES, seedRng } = env.api();
    bootToMenu(env);
    /* ASCENT is the worst case: bullets, foes, stars and debris all at once. */
    seedRng(4);
    Shell._startGame(env.api().gameById('ascent'));

    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < 3000; i++) env.tick(16.667);
    global.gc && global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    /* 3000 frames of a bullet-heavy game must not grow the heap without
     * bound. A generous ceiling: this is catching runaway arrays, not
     * measuring the allocator. */
    const grownMb = (heapAfter - heapBefore) / (1024 * 1024);
    assert.ok(grownMb < 64,
      `heap grew ${grownMb.toFixed(1)}MB over 3000 frames — something is not pooled`);
  });

  it('the frame timer reports plausible numbers', () => {
    const env = makeEnv();
    const { Shell, Settings } = env.api();
    Settings.set('showFps', true);
    bootToMenu(env);
    for (let i = 0; i < 120; i++) env.tick(16.667);
    const s = Shell._frameStats();
    assert.close(s.mean, 16.667, 0.5, `mean frame time ${s.mean}`);
    /* Epsilon: with a perfectly uniform dt, summing then dividing lands a
     * few ulps above the identical per-frame value. */
    assert.ok(s.worst >= s.mean - 1e-6, 'worst is at least the mean');
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16.667); },
      'drawing the overlay does not throw');
  });

  it('holds up at a 4K-ish backing size without changing logic', () => {
    /* The logical spaces are resolution independent; only the transform
     * changes. This catches anything that accidentally reads device pixels. */
    const env = makeEnv({ width: 2160, height: 3840, dpr: 1.5 });
    const { Shell, GAMES, seedRng } = env.api();
    bootToMenu(env);
    assert.equal(Shell.state(), 'menu');
    for (const g of GAMES) {
      seedRng(11);
      Shell._startGame(g);
      assert.doesNotThrow(() => { for (let i = 0; i < 60; i++) env.tick(16.667); },
        `${g.id} at 2160x3840`);
    }
  });

  it('handles a landscape panel by letterboxing, not by breaking', () => {
    const env = makeEnv({ width: 1920, height: 1080 });
    const { Shell, gameById, seedRng } = env.api();
    bootToMenu(env);
    assert.equal(Shell.state(), 'menu');
    seedRng(3);
    Shell._startGame(gameById('tetris'));
    assert.doesNotThrow(() => { for (let i = 0; i < 90; i++) env.tick(16.667); });
  });
});
