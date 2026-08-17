/*
 * Latency and responsiveness tests.
 *
 * The headline case: a press and release that both happen between two frames.
 * Before edge latching this was dropped silently and completely — 0 out of 20
 * taps registered, on both gamepad and keyboard. A dropped press feels far
 * worse than a late one, because the player has no idea what they did wrong.
 *
 * These also pin the render budget, because input responsiveness is worthless
 * if the frame it lands on arrives late.
 */
'use strict';

const { makeEnv, makePad, PAD_IDS } = require('./harness.js');

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

describe('sub-frame input', () => {
  it('catches a gamepad tap that starts and ends between two frames', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    env.pollOnly(16);

    let caught = 0;
    for (let i = 0; i < 20; i++) {
      /* This is what the 250Hz sampler sees: down on one sample, up on the
       * next, with no frame boundary anywhere near either. */
      pad.press(0); Input.sample();
      pad.release(0); Input.sample();
      env.pollOnly(16.667);
      if (Input.hit('confirm')) caught++;
    }
    assert.equal(caught, 20, `only ${caught}/20 sub-frame taps registered`);
  });

  it('catches a keyboard tap with no sampling at all', () => {
    /* Key events are exact and already timestamped, so the edge is latched in
     * the handler. An arcade encoder in keyboard mode never needs the timer. */
    const env = makeEnv();
    const { Input } = env.api();
    env.pollOnly(16);

    let caught = 0;
    for (let i = 0; i < 20; i++) {
      env.fireKey('Enter', true);
      env.fireKey('Enter', false);
      env.pollOnly(16.667);
      if (Input.hit('confirm')) caught++;
    }
    assert.equal(caught, 20, `only ${caught}/20 keyboard taps registered`);
  });

  it('counts the taps it saved', () => {
    const env = makeEnv();
    const { Input } = env.api();
    env.pollOnly(16);
    const before = Input.diagnostics().tapsSaved;
    env.fireKey('KeyZ', true);
    env.fireKey('KeyZ', false);
    env.pollOnly(16.667);
    assert.ok(Input.diagnostics().tapsSaved > before,
      'a released-before-the-frame press is counted');
  });

  it('reports one hit per tap, not one per sample', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    env.pollOnly(16);

    /* Held across many samples — still exactly one hit. */
    pad.press(0);
    for (let i = 0; i < 10; i++) Input.sample();
    env.pollOnly(16.667);
    assert.ok(Input.hit('confirm'), 'the press registered');
    assert.equal(Input.repCount('confirm'), 1, 'once, not ten times');

    for (let i = 0; i < 10; i++) Input.sample();
    env.pollOnly(16.667);
    assert.notOk(Input.hit('confirm'), 'a held button does not re-fire hit');
  });

  it('registers two taps inside one frame as two menu steps', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    env.pollOnly(16);

    pad.press(13); Input.sample();
    pad.release(13); Input.sample();
    pad.press(13); Input.sample();
    pad.release(13); Input.sample();
    env.pollOnly(16.667);
    assert.equal(Input.repCount('down'), 2, 'both taps counted');
  });

  it('does not invent presses when nothing happened', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    for (let i = 0; i < 50; i++) { Input.sample(); env.pollOnly(16.667); }
    for (const a of ['up', 'down', 'left', 'right', 'confirm', 'back', 'alt', 'pause']) {
      assert.notOk(Input.hit(a), `${a} stayed quiet`);
      assert.equal(Input.repCount(a), 0, `${a} produced no steps`);
    }
    assert.equal(Input.diagnostics().tapsSaved, 0);
  });

  it('a state change swallows a latched press rather than leaking it', () => {
    const env = makeEnv();
    const { Input } = env.api();
    env.pollOnly(16);
    env.fireKey('Enter', true);
    env.fireKey('Enter', false);
    Input.flush();
    env.pollOnly(16.667);
    assert.notOk(Input.hit('confirm'),
      'the button that opened a screen does not also act inside it');
  });

  it('still holds the auto-repeat cadence with latching in place', () => {
    /* Latching must not disturb the 360/120ms menu cadence, nor its
     * frame-rate independence. */
    function stepsOver(dtPerFrame, totalMs) {
      const pad = makePad(PAD_IDS.xbox);
      const env = makeEnv({ gamepads: [pad] });
      const { Input } = env.api();
      env.pollOnly(16);
      pad.press(13);
      let steps = 0, elapsed = 0;
      while (elapsed < totalMs) {
        env.pollOnly(dtPerFrame);
        steps += Input.repCount('down');
        elapsed += dtPerFrame;
      }
      return steps;
    }
    const at60 = stepsOver(16.667, 2000);
    assert.close(at60, 14, 1, `60Hz produced ${at60}`);
    assert.close(stepsOver(6.944, 2000), at60, 1);
    assert.close(stepsOver(33.333, 2000), at60, 1);
  });

  it('keeps the Nintendo face swap intact through the sampler', () => {
    /* The swap is the thing most likely to be broken by an input rewrite. */
    const pad = makePad(PAD_IDS.nintendo);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    env.pollOnly(16);

    pad.press(0); Input.sample(); pad.release(0); Input.sample();
    env.pollOnly(16.667);
    assert.notOk(Input.hit('confirm'), 'bottom button is not confirm on Nintendo');
    assert.ok(Input.hit('back'), 'bottom button is back on Nintendo');

    pad.press(1); Input.sample(); pad.release(1); Input.sample();
    env.pollOnly(16.667);
    assert.ok(Input.hit('confirm'), 'right button confirms on Nintendo');
  });

  it('routes sub-frame taps to the right player', () => {
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const p2 = makePad(PAD_IDS.xbox, { index: 1 });
    const env = makeEnv({ gamepads: [p1, p2] });
    const { Input } = env.api();
    env.pollOnly(16);
    p2.press(9); env.pollOnly(16); p2.release(9); env.pollOnly(16);

    p2.press(0); Input.sample(); p2.release(0); Input.sample();
    env.pollOnly(16.667);
    assert.ok(Input.p(1).hit('confirm'), 'player 2 got its tap');
    assert.notOk(Input.p(0).hit('confirm'), 'player 1 did not');
  });

  it('boot starts the sampler', () => {
    /* The harness stops it again for determinism, so check it was running. */
    const env = makeEnv({ sampling: true });
    assert.ok(env.api().Input.diagnostics().sampling, 'boot() started sampling');
    env.api().Input.stopSampling();
  });

  it('the sampler can be started and stopped without disturbing state', () => {
    const env = makeEnv();
    const { Input } = env.api();
    assert.notOk(Input.diagnostics().sampling, 'harness stopped it');
    Input.startSampling();
    assert.ok(Input.diagnostics().sampling);
    Input.startSampling();  /* idempotent */
    Input.stopSampling();
    assert.notOk(Input.diagnostics().sampling);
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16.667); });
  });

  it('samples faster than the display refreshes', () => {
    const env = makeEnv();
    assert.ok(env.api().Input.SAMPLE_MS <= 8,
      'the sample interval is shorter than half a frame');
  });
});

describe('render budget', () => {
  it('issues exactly two full-screen operations per frame', () => {
    /* At 1080x1920 each one touches 2.07M pixels, and on a Pi's VideoCore VI
     * that is the cost that decides whether frames land. Five of them (an
     * opaque clear, a plate blit, an aurora blit, a scanline pattern fill and
     * a vignette blit) was ~10.4M pixel touches before anything was drawn. */
    const env = makeEnv();
    const { Shell, Render, GAMES, VERSUS_GAMES, seedRng } = env.api();
    bootToMenu(env);

    function opsPerFrame(frames) {
      Render._resetOps();
      for (let i = 0; i < frames; i++) env.tick(16.667);
      return Render.fullScreenOps() / frames;
    }

    assert.close(opsPerFrame(60), 2, 0.01, 'dashboard');
    for (const g of GAMES.concat(VERSUS_GAMES)) {
      seedRng(5);
      Shell._startGame(g);
      assert.close(opsPerFrame(60), 2, 0.01, `${g.id} full-screen ops`);
    }
  });

  it('does not recompose the backdrop when nothing moved', () => {
    const env = makeEnv();
    const { Shell, Settings } = env.api();
    bootToMenu(env);
    Settings.set('reducedMotion', true);
    /* With the blobs still, the low-res buffer only needs rebuilding when the
     * accent tint changes. The full-screen blit still happens every frame. */
    assert.doesNotThrow(() => { for (let i = 0; i < 120; i++) env.tick(16.667); });
    assert.equal(Shell.state(), 'menu');
  });

  it('rebuilds the overlay when the CRT setting changes, not every frame', () => {
    const env = makeEnv();
    const { Settings, Render } = env.api();
    bootToMenu(env);
    const before = env.canvases.length;
    for (let i = 0; i < 60; i++) env.tick(16.667);
    assert.equal(env.canvases.length, before,
      'no offscreen canvas is allocated per frame');

    Settings.set('crt', false);
    for (let i = 0; i < 5; i++) env.tick(16.667);
    assert.ok(env.canvases.length > before, 'the overlay was rebuilt once');

    const after = env.canvases.length;
    for (let i = 0; i < 60; i++) env.tick(16.667);
    assert.equal(env.canvases.length, after, 'and then left alone');
  });
});

describe('low-latency video', () => {
  it('asks for a desynchronized context by default', () => {
    const env = makeEnv();
    const attrs = env.screen.contextAttrs;
    assert.ok(attrs, 'context attributes were passed');
    assert.equal(attrs.alpha, false, 'opaque canvas: no blend with the page');
    assert.equal(attrs.desynchronized, true, 'low-latency path requested');
  });

  it('honours the setting being turned off', () => {
    const env = makeEnv({ storage: {
      'arcadeos:v1:settings': JSON.stringify({ lowLatency: false }),
    } });
    assert.equal(env.screen.contextAttrs.desynchronized, false);
  });

  it('re-creates the canvas when the setting is changed at runtime', () => {
    /* Context attributes are fixed at creation, so the setting can only apply
     * by making a new canvas. Doing it immediately beats "takes effect after
     * a reboot" on a machine with no keyboard. */
    const env = makeEnv();
    const { Settings } = env.api();
    bootToMenu(env);
    const before = env.canvases.length;
    Settings.set('lowLatency', false);
    assert.ok(env.canvases.length > before, 'a fresh canvas was created');
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) env.tick(16.667); },
      'and the loop keeps running against it');
  });
});

describe('audio latency', () => {
  it('asks for the interactive latency hint', () => {
    const env = makeEnv({ audio: true });
    const { Audio2 } = env.api();
    Audio2.unlock();
    assert.equal(env.sandbox.__audioLatencyHint, 'interactive',
      'a fat default buffer would put 40-80ms between press and sound');
  });

  it('reports its latency without an audio context', () => {
    const env = makeEnv();
    assert.equal(env.api().Audio2.latencyMs(), 0);
  });
});
