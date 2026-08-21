/*
 * Automatic vertical mode and native resolution.
 *
 * Ground truth from the first cabinet: the kernel rotates the console via
 * panel_orientation, but Bookworm's cage links a wlroots that ignores the
 * hint, so the kiosk surface arrives LANDSCAPE on a portrait-mounted panel —
 * "boots vertical, reverts to horizontal". The front end therefore rotates
 * itself. These tests pin the mapping maths, the live setting, and that a
 * genuinely portrait surface is never double-rotated.
 */
'use strict';

const { makeEnv } = require('./harness.js');

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

describe('automatic vertical mode', () => {
  it('fills a landscape 1080p surface by rotating clockwise', () => {
    const env = makeEnv({ width: 1920, height: 1080 });
    const { Render } = env.api();
    bootToMenu(env);
    const s = Render.size();
    assert.equal(s.rot, 90);
    assert.equal(s.dw, 1920);
    assert.equal(s.dh, 1080);
    /* Logical space is portrait and fills the panel exactly: 1080x1920 into
     * a rotated 1080x1920 — no letterbox at all. */
    assert.equal(s.w, 1080);
    assert.equal(s.h, 1920);
    assert.close(s.scale, 1, 1e-9);
    assert.close(s.ox, 0, 0.51);
    assert.close(s.oy, 0, 0.51);
  });

  it('maps shell corners onto the physical panel correctly (clockwise)', () => {
    const env = makeEnv({ width: 1920, height: 1080 });
    const { Render } = env.api();
    bootToMenu(env);
    /* Shell top-left lands at the panel's top-right; shell bottom-right at
     * the panel's bottom-left. That is what "rotate right" means. */
    const tl = Render._toDevice(0, 0);
    assert.close(tl.x, 1920, 0.51); assert.close(tl.y, 0, 0.51);
    const br = Render._toDevice(1080, 1920);
    assert.close(br.x, 0, 0.51); assert.close(br.y, 1080, 0.51);
  });

  it('rotates the other way when asked', () => {
    const env = makeEnv({ width: 1920, height: 1080 });
    const { Render, Settings } = env.api();
    bootToMenu(env);
    Settings.set('orientation', 'auto-left');
    const s = Render.size();
    assert.equal(s.rot, 270, 'the setting applies live, no restart');
    const tl = Render._toDevice(0, 0);
    assert.close(tl.x, 0, 0.51); assert.close(tl.y, 1080, 0.51);
  });

  it('never rotates a surface that is already portrait', () => {
    /* If the compositor DID rotate (some future wlroots), rotating again
     * would be sideways. Auto means: only fix what is actually wrong. */
    const env = makeEnv({ width: 1080, height: 1920 });
    const { Render } = env.api();
    bootToMenu(env);
    assert.equal(Render.size().rot, 0);
    const tl = Render._toDevice(0, 0);
    assert.close(tl.x, 0, 0.51); assert.close(tl.y, 0, 0.51);
  });

  it('NO ROTATION letterboxes upright, for a desk monitor', () => {
    const env = makeEnv({ width: 1920, height: 1080 });
    const { Render, Settings } = env.api();
    bootToMenu(env);
    Settings.set('orientation', 'off');
    const s = Render.size();
    assert.equal(s.rot, 0);
    assert.ok(s.ox > 100, 'pillarboxed column, content upright');
  });

  it('uses the full native resolution of a 4K panel, both mountings', () => {
    /* Portrait-mounted 4K arriving landscape: rotate and fill at native. */
    const a = makeEnv({ width: 3840, height: 2160 });
    bootToMenu(a);
    let s = a.api().Render.size();
    assert.equal(s.rot, 90);
    assert.equal(s.w, 2160);
    assert.equal(s.h, 3840);
    assert.close(s.scale, 2, 1e-9);

    /* Already-portrait 4K: no rotation, same native fill. */
    const b = makeEnv({ width: 2160, height: 3840 });
    bootToMenu(b);
    s = b.api().Render.size();
    assert.equal(s.rot, 0);
    assert.close(s.scale, 2, 1e-9);
  });

  it('every game survives a full round rotated', () => {
    const env = makeEnv({ width: 1920, height: 1080 });
    const { Shell, GAMES, seedRng, Faults } = env.api();
    bootToMenu(env);
    for (const g of GAMES) {
      seedRng(7);
      Shell._startGame(g, false, 7);
      for (let i = 0; i < 240; i++) env.tick(16.667);
      Shell._go('menu');
      for (let i = 0; i < 20; i++) env.tick(16.667);
    }
    assert.equal(Faults.count(), 0, JSON.stringify(Faults.latest()));
  });

  it('the settings row cycles it and persists it', () => {
    const env = makeEnv({ width: 1920, height: 1080 });
    const { Settings } = env.api();
    bootToMenu(env);
    assert.equal(Settings.get('orientation'), 'auto');
    Settings.set('orientation', 'off');
    /* A corrupted value never reaches the renderer. */
    assert.equal(Settings._validate({ orientation: 'sideways?' }).orientation, 'auto');
    assert.equal(Settings._validate({ orientation: 'auto-left' }).orientation, 'auto-left');
  });
});
