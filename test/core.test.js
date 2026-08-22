/*
 * Core module tests: build integrity, colour helpers, storage in all four
 * states, controller detection and the frame-rate independence of auto-repeat.
 */
'use strict';

const { makeEnv, makePad, PAD_IDS } = require('./harness.js');
const { bundle } = require('../build.js');

describe('build', () => {
  it('produces a single self-contained HTML document', () => {
    const out = bundle();
    assert.ok(out.html.includes('<!doctype html>'), 'has a doctype');
    assert.ok(out.html.includes('<canvas id="screen">'), 'has the screen canvas');
    assert.ok(out.html.length > 40000, 'bundle looks substantial');
    assert.notOk(/\{\{CSS\}\}|\{\{JS\}\}/.test(out.html), 'placeholders were replaced');
  });

  it('makes no reference to any external origin', () => {
    const out = bundle();
    /* The offline constraint is the whole product. Assert it mechanically
     * rather than trusting review. */
    const urls = out.html.match(/\b(?:https?:)?\/\/[a-z0-9-]+\.[a-z]{2,}/gi) || [];
    assert.deep(urls, [], `found external references: ${urls.join(', ')}`);
    assert.notOk(/@import|fonts\.googleapis|cdn\./i.test(out.html), 'no CDN or webfont imports');
  });

  it('never uses shadowBlur in a draw path', () => {
    /* Glow is pre-rendered. A stray shadowBlur is the known Pi bottleneck. */
    const js = bundle().js;
    const hits = js.split('\n').filter((l) => /shadowBlur\s*=/.test(l) && !/^\s*\/[/*]/.test(l));
    assert.deep(hits, [], `shadowBlur assigned in: ${hits.join(' | ')}`);
  });

  it('boots without throwing and reaches the dashboard', () => {
    const env = makeEnv();
    const { Shell } = env.api();
    assert.equal(Shell.state(), 'boot');
    for (let i = 0; i < 200; i++) env.tick(16);
    assert.equal(Shell.state(), 'menu');
    assert.ok(env.stats.fills > 0, 'something was drawn');
  });
});

describe('colour helpers', () => {
  it('parses both hex forms and rejects everything else', () => {
    const env = makeEnv();
    const { hexRgb } = env.api();
    assert.deep(hexRgb('#8B7BF0'), [139, 123, 240]);
    assert.deep(hexRgb('#abc'), [170, 187, 204]);
    assert.equal(hexRgb('rgb(1,2,3)'), null, 'an rgb() string is not hex');
    assert.equal(hexRgb('nonsense'), null);
    assert.equal(hexRgb(null), null);
    assert.equal(hexRgb(undefined), null);
    assert.equal(hexRgb(42), null);
  });

  it('never emits NaN from rgba() or shade() — the addColorStop bug', () => {
    const env = makeEnv();
    const { rgba, shade } = env.api();
    /* This is the exact regression: an rgb() string fed back into a hex
     * parser used to yield "#NaNNaNNaN" and throw inside addColorStop. */
    const round = rgba(rgba('#8B7BF0', 0.5), 0.5);
    assert.notOk(/NaN|undefined/.test(round), `round-trip produced ${round}`);
    assert.notOk(/NaN|undefined/.test(shade('rgb(10,20,30)', 0.4)));
    assert.notOk(/NaN|undefined/.test(shade('#8B7BF0', NaN)));
    assert.notOk(/NaN|undefined/.test(rgba('#8B7BF0', NaN)));
    assert.notOk(/NaN|undefined/.test(rgba('#8B7BF0', Infinity)));
    assert.notOk(/NaN|undefined/.test(shade(undefined, 0.5)));
  });

  it('clamps alpha into 0..1', () => {
    const env = makeEnv();
    const { rgba } = env.api();
    assert.equal(rgba('#000000', 5), 'rgba(0,0,0,1)');
    assert.equal(rgba('#000000', -3), 'rgba(0,0,0,0)');
  });
});

describe('storage', () => {
  it('works from fresh', () => {
    const env = makeEnv();
    const { Store, Settings, Scores } = env.api();
    assert.ok(Store.persistent(), 'backend is usable');
    assert.equal(Settings.get('volume'), 0.7);
    assert.deep(Scores.table('tetris'), []);
  });

  it('reads a populated store', () => {
    const seeded = {
      'arcadeos:v1:scores': JSON.stringify({
        tetris: [{ name: 'ABC', score: 5000, at: 1 }, { name: 'XYZ', score: 100, at: 2 }],
      }),
      'arcadeos:v1:settings': JSON.stringify({ volume: 0.25, muted: true, layout: 'nintendo', crt: false, reducedMotion: true }),
    };
    const env = makeEnv({ storage: seeded });
    const { Scores, Settings } = env.api();
    assert.equal(Scores.best('tetris'), 5000);
    assert.equal(Scores.table('tetris').length, 2);
    assert.equal(Settings.get('volume'), 0.25);
    assert.equal(Settings.get('layout'), 'nintendo');
    assert.equal(Settings.get('crt'), false);
  });

  it('survives corrupt and partial records without throwing', () => {
    const cases = [
      'not json at all',
      '{"tetris": "not an array"}',
      '{"tetris": [null, 3, {"score": "abc"}, {"name": 7, "score": 12}]}',
      '[]',
      'null',
      '{"tetris": [{"score": 1e999}]}',
      '{"tetris":[{"name":"ab","score":10},{"name":"TOOLONG","score":20}]}',
    ];
    for (const raw of cases) {
      const env = makeEnv({ storage: { 'arcadeos:v1:scores': raw } });
      const { Scores } = env.api();
      assert.doesNotThrow(() => Scores.table('tetris'), `corrupt case: ${raw}`);
      const t = Scores.table('tetris');
      assert.ok(Array.isArray(t), `table is an array for: ${raw}`);
      for (const e of t) {
        assert.equal(e.name.length, 3, `name repaired to 3 chars for: ${raw}`);
        assert.ok(isFinite(e.score) && e.score >= 0, `score is finite for: ${raw}`);
      }
      /* And the cabinet must still run. */
      assert.doesNotThrow(() => { for (let i = 0; i < 40; i++) env.tick(16); });
    }
  });

  it('degrades to memory when localStorage throws', () => {
    const env = makeEnv({ storage: 'throwing' });
    const { Store, Settings, Scores } = env.api();
    assert.notOk(Store.persistent(), 'reports itself as non-persistent');
    assert.doesNotThrow(() => Settings.set('volume', 0.3));
    assert.equal(Settings.get('volume'), 0.3, 'in-memory value still works');
    assert.doesNotThrow(() => Scores.submit('tetris', 500, 'AAA', 1));
    assert.equal(Scores.best('tetris'), 500, 'scores work for the session');
    assert.doesNotThrow(() => { for (let i = 0; i < 60; i++) env.tick(16); });
  });

  it('degrades when localStorage is absent entirely', () => {
    const env = makeEnv({ storage: 'absent' });
    const { Store, Settings } = env.api();
    assert.notOk(Store.persistent());
    assert.doesNotThrow(() => Settings.set('muted', true));
    assert.equal(Settings.get('muted'), true);
    assert.doesNotThrow(() => { for (let i = 0; i < 60; i++) env.tick(16); });
  });

  it('keeps only the top five, sorted', () => {
    const env = makeEnv();
    const { Scores, TOP_N } = env.api();
    for (let i = 1; i <= 9; i++) Scores.submit('snake', i * 100, 'AAA', i);
    const t = Scores.table('snake');
    assert.equal(t.length, TOP_N);
    assert.equal(t[0].score, 900);
    assert.equal(t[4].score, 500);
    for (let i = 1; i < t.length; i++) {
      assert.ok(t[i - 1].score >= t[i].score, 'table stays sorted');
    }
  });

  it('reports qualification correctly', () => {
    const env = makeEnv();
    const { Scores } = env.api();
    assert.notOk(Scores.qualifies('stack', 0), 'zero never qualifies');
    assert.ok(Scores.qualifies('stack', 10), 'any score on an empty table qualifies');
    for (let i = 1; i <= 5; i++) Scores.submit('stack', i * 100, 'AAA', i);
    assert.notOk(Scores.qualifies('stack', 50), 'below the floor does not qualify');
    assert.ok(Scores.qualifies('stack', 250), 'above the floor qualifies');
  });

  it('namespaces and versions its keys', () => {
    const env = makeEnv();
    const { Settings } = env.api();
    Settings.set('volume', 0.4);
    const keys = [...env.getStorage()._map.keys()];
    assert.ok(keys.length > 0, 'something was written');
    for (const k of keys) assert.ok(/^arcadeos:v\d+:/.test(k), `key is namespaced: ${k}`);
  });
});

describe('controller detection', () => {
  const cases = [
    ['xbox', PAD_IDS.xbox, 'xbox'],
    ['playstation', PAD_IDS.playstation, 'playstation'],
    ['nintendo by vendor id', PAD_IDS.nintendo, 'nintendo'],
    ['nintendo by name', PAD_IDS.nintendoName, 'nintendo'],
    ['unknown encoder', PAD_IDS.unknown, 'unknown'],
    ['empty id', '', 'unknown'],
  ];

  for (const [label, id, expected] of cases) {
    it(`identifies ${label}`, () => {
      const env = makeEnv();
      assert.equal(env.api().Input.detect(id), expected);
    });
  }

  it('swaps confirm and back for Nintendo only', () => {
    const env = makeEnv();
    const { Input } = env.api();
    assert.deep(Input._faceMap('xbox'), { confirm: 0, back: 1 });
    assert.deep(Input._faceMap('playstation'), { confirm: 0, back: 1 });
    assert.deep(Input._faceMap('nintendo'), { confirm: 1, back: 0 },
      'Nintendo confirms with the RIGHT face button');
  });

  it('a Nintendo pad confirms with button 1, not button 0', () => {
    const pad = makePad(PAD_IDS.nintendo);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();

    env.pollOnly(16);                   /* discovery */
    pad.press(0);                       /* bottom face button */
    env.pollOnly(16);
    assert.notOk(Input.hit('confirm'), 'bottom button must NOT confirm on Nintendo');
    assert.ok(Input.hit('back'), 'bottom button is back on Nintendo');

    pad.releaseAll();
    env.pollOnly(16);
    pad.press(1);                       /* right face button */
    env.pollOnly(16);
    assert.ok(Input.hit('confirm'), 'right button confirms on Nintendo');
  });

  it('an Xbox pad confirms with button 0', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    env.pollOnly(16);
    pad.press(0);
    env.pollOnly(16);
    assert.ok(Input.hit('confirm'), 'bottom button confirms on Xbox');
    assert.notOk(Input.hit('back'));
  });

  it('renders the glyphs of the physical controller', () => {
    const env = makeEnv();
    const { Input } = env.api();
    assert.equal(Input._glyphsFor('xbox', 'xbox').confirm, 'A');
    assert.equal(Input._glyphsFor('nintendo', 'nintendo').confirm, 'A',
      'Nintendo still labels its confirm button A');
    assert.equal(Input._glyphsFor('nintendo', 'nintendo').back, 'B');
    assert.equal(Input._glyphsFor('playstation', 'playstation').confirm, '✕');
    assert.equal(Input._glyphsFor('playstation', 'playstation').back, '○');
    assert.equal(Input._glyphsFor('xbox', 'keyboard').confirm, 'ENTER');
  });

  it('honours the manual layout override for an unrecognised pad', () => {
    const pad = makePad(PAD_IDS.unknown);
    const env = makeEnv({ gamepads: [pad] });
    const { Input, Settings } = env.api();
    env.pollOnly(16);
    assert.equal(Input.kindOf(0), 'unknown');
    assert.equal(Input.layoutOf(0), 'xbox', 'unknown pads default to the common layout');

    Settings.set('layout', 'nintendo');
    pad.press(1);
    env.pollOnly(16);
    assert.ok(Input.hit('confirm'), 'override makes the right button confirm');
    assert.equal(Input.glyphs(0).confirm, 'A');
  });

  it('detects hot-plug and hot-unplug', () => {
    const env = makeEnv({ gamepads: [] });
    const { Input } = env.api();
    env.tick(16);
    const v0 = Input.padsVersion();
    assert.equal(Input.padCount(), 0);

    const pad = makePad(PAD_IDS.xbox);
    env.setGamepads([pad]);
    env.tick(16);
    assert.notEqual(Input.padsVersion(), v0, 'plugging a pad bumps the version');
    assert.equal(Input.padCount(), 1);
    assert.equal(Input.kindOf(0), 'xbox');

    env.setGamepads([]);
    env.tick(16);
    assert.equal(Input.padCount(), 0, 'unplugging releases the slot');
    assert.equal(Input.playerCount(), 1, 'player 1 survives on the keyboard');
  });

  it('re-renders on-screen hints after a hot-plug', () => {
    const env = makeEnv({ gamepads: [] });
    const { Input, Shell } = env.api();
    for (let i = 0; i < 200; i++) env.tick(16);
    assert.equal(Shell.state(), 'menu');
    assert.equal(Input.glyphs(0).confirm, 'ENTER', 'keyboard legend before plug-in');

    env.setGamepads([makePad(PAD_IDS.playstation)]);
    env.tick(16);
    assert.equal(Input.glyphs(0).confirm, '✕', 'legend follows the new pad immediately');
    assert.ok(Shell._toast(), 'the player is told a controller arrived');

    env.setGamepads([makePad(PAD_IDS.nintendo)]);
    env.tick(16);
    assert.equal(Input.glyphs(0).confirm, 'A', 'legend follows a swap mid-session');
    assert.doesNotThrow(() => env.tick(16));
  });
});

describe('auto-repeat', () => {
  it('is frame-rate independent — the 60Hz vs 144Hz menu bug', () => {
    /* Hold a direction for the same wall-clock span at three refresh rates
     * and assert the number of steps matches. A frame-counter implementation
     * fails this immediately. */
    function stepsOver(dtPerFrame, totalMs) {
      const pad = makePad(PAD_IDS.xbox);
      const env = makeEnv({ gamepads: [pad] });
      const { Input } = env.api();
      env.pollOnly(16);
      pad.press(13);                 /* d-pad down */
      let steps = 0;
      let elapsed = 0;
      while (elapsed < totalMs) {
        env.pollOnly(dtPerFrame);
        steps += Input.repCount('down');
        elapsed += dtPerFrame;
      }
      return steps;
    }

    const at60 = stepsOver(16.667, 2000);
    const at144 = stepsOver(6.944, 2000);
    const at30 = stepsOver(33.333, 2000);

    /* 2000ms = first step + 360ms delay, then (2000-360)/120 ≈ 13 more. */
    assert.close(at60, 14, 1, `60Hz produced ${at60} steps`);
    assert.close(at144, at60, 1, `144Hz produced ${at144} vs 60Hz ${at60}`);
    assert.close(at30, at60, 1, `30Hz produced ${at30} vs 60Hz ${at60}`);
  });

  it('uses a 360ms initial delay then 120ms', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    env.pollOnly(16);

    pad.press(13);
    env.pollOnly(1);
    assert.equal(Input.repCount('down'), 1, 'first press steps immediately');

    /* Nothing between the press and 360ms. */
    let elapsed = 0, steps = 0;
    while (elapsed < 350) { env.pollOnly(10); elapsed += 10; steps += Input.repCount('down'); }
    assert.equal(steps, 0, 'nothing repeats inside the initial delay');

    /* One repeat at 360ms, the next not until 480ms. */
    while (elapsed < 470) { env.pollOnly(10); elapsed += 10; steps += Input.repCount('down'); }
    assert.equal(steps, 1, 'exactly one repeat between 360ms and 480ms');

    while (elapsed < 590) { env.pollOnly(10); elapsed += 10; steps += Input.repCount('down'); }
    assert.equal(steps, 2, 'a second repeat one 120ms interval later');
  });

  it('does not fire a hundred steps after a long stall', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    env.pollOnly(16);
    pad.press(13);
    env.pollOnly(16);
    env.pollOnly(400);               /* a stall the clamp should absorb */
    const n = Input.repCount('down');
    assert.ok(n <= 8, `catch-up was capped, got ${n}`);
  });

  it('applies the same cadence to the shared repeater helper', () => {
    const env = makeEnv();
    const { makeRepeater } = env.api();
    function total(dt) {
      const r = makeRepeater(360, 120);
      let steps = 0, elapsed = 0;
      while (elapsed < 2000) { steps += r.step(true, dt); elapsed += dt; }
      return steps;
    }
    assert.close(total(16.667), total(6.944), 1);
    assert.close(total(16.667), total(33.333), 1);
  });
});

describe('input plumbing', () => {
  it('produces identical actions from keyboard and gamepad', () => {
    const envK = makeEnv();
    const { Input: IK } = envK.api();
    envK.fireKey('ArrowLeft', true);
    envK.pollOnly(16);
    assert.ok(IK.down('left') && IK.hit('left'));

    const pad = makePad(PAD_IDS.xbox);
    const envG = makeEnv({ gamepads: [pad] });
    const { Input: IG } = envG.api();
    envG.pollOnly(16);
    pad.press(14);
    envG.pollOnly(16);
    assert.ok(IG.down('left') && IG.hit('left'));
  });

  it('reads the left stick with a hysteresis deadzone', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    env.pollOnly(16);

    pad.setAxis(0, 0.45);
    env.pollOnly(16);
    assert.notOk(Input.down('right'), '0.45 does not engage; it takes 0.5');

    pad.setAxis(0, 0.55);
    env.pollOnly(16);
    assert.ok(Input.down('right'), '0.55 engages');

    /* Once engaged it holds down to 0.35, so a hand resting slightly off
     * centre keeps its direction instead of stuttering. */
    pad.setAxis(0, 0.40);
    env.pollOnly(16);
    assert.ok(Input.down('right'), 'holds at 0.40 once engaged');

    pad.setAxis(0, 0.30);
    env.pollOnly(16);
    assert.notOk(Input.down('right'), 'releases below 0.35');

    pad.setAxis(0, 0).setAxis(1, -0.9);
    env.pollOnly(16);
    assert.ok(Input.down('up'));
  });

  it('a worn stick jittering at the deadzone edge produces nothing', () => {
    /* Measured before hysteresis: 120 phantom menu steps per second from a
     * stick nobody was touching. Latching every 250Hz crossing amplified an
     * existing single-threshold problem into an unusable one. */
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    env.pollOnly(16);

    let steps = 0;
    for (let f = 0; f < 60; f++) {
      for (let s2 = 0; s2 < 4; s2++) {
        pad.setAxis(1, 0.38 + (s2 % 2) * 0.06);   /* jitters 0.38 <-> 0.44 */
        Input.sample();
      }
      env.pollOnly(16.667);
      steps += Input.repCount('down');
    }
    assert.equal(steps, 0, `a resting stick generated ${steps} menu steps`);
  });

  it('a deliberate stick flick still registers immediately', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const { Input } = env.api();
    env.pollOnly(16);
    pad.setAxis(1, 0.95);
    Input.sample();
    pad.setAxis(1, 0);
    Input.sample();
    env.pollOnly(16.667);
    assert.ok(Input.hit('down'), 'a full deflection and release still counts');
  });

  it('ignores non-finite axis values', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    env.tick(16);
    pad.axes[0] = NaN;
    pad.axes[1] = Infinity;
    assert.doesNotThrow(() => env.tick(16));
    assert.notOk(env.api().Input.down('right'));
  });

  it('releases stuck keys when the window loses focus', () => {
    const env = makeEnv();
    const { Input } = env.api();
    env.fireKey('ArrowRight', true);
    env.pollOnly(16);
    assert.ok(Input.down('right'));
    (env.listeners.blur || []).forEach((fn) => fn({}));
    env.pollOnly(16);
    assert.notOk(Input.down('right'), 'blur clears held keys');
  });

  it('accepts arcade-encoder keyboard mappings', () => {
    const env = makeEnv();
    const { Input } = env.api();
    for (const [code, action] of [['ControlLeft', 'confirm'], ['AltLeft', 'back'], ['KeyZ', 'confirm']]) {
      env.fireKey(code, true);
      env.pollOnly(16);
      assert.ok(Input.down(action), `${code} maps to ${action}`);
      env.fireKey(code, false);
      env.pollOnly(16);
    }
  });
});
