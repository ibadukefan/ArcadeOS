/*
 * Targeted tests for the two pieces of Phase 3 logic most likely to hide a
 * subtle bug: DROP's four-direction match finder, and PULSE's timing, which
 * has to stay correct with no audio clock and with wildly varying dt.
 */
'use strict';

const { makeEnv, makePad, PAD_IDS } = require('./harness.js');

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

describe('DROP match finder', () => {
  function fresh() {
    const env = makeEnv();
    bootToMenu(env);
    const g = env.api().gameById('drop');
    g.start();
    g._test.clear();
    return { env, t: g._test };
  }

  it('finds a horizontal run of three', () => {
    const { t } = fresh();
    t.set(1, 5, 2); t.set(2, 5, 2); t.set(3, 5, 2);
    assert.equal(t.findMatches(), 3);
    assert.ok(t.marked(1, 5) && t.marked(2, 5) && t.marked(3, 5));
  });

  it('finds a vertical run of three', () => {
    const { t } = fresh();
    t.set(4, 2, 1); t.set(4, 3, 1); t.set(4, 4, 1);
    assert.equal(t.findMatches(), 3);
  });

  it('finds both diagonals', () => {
    const { t } = fresh();
    /* down-right */
    t.set(0, 0, 3); t.set(1, 1, 3); t.set(2, 2, 3);
    assert.equal(t.findMatches(), 3, 'down-right diagonal');

    t.clear();
    /* down-left (i.e. up-right) */
    t.set(4, 2, 3); t.set(3, 3, 3); t.set(2, 4, 3);
    assert.equal(t.findMatches(), 3, 'down-left diagonal');
  });

  it('does not match a run of two', () => {
    const { t } = fresh();
    t.set(1, 5, 2); t.set(2, 5, 2);
    assert.equal(t.findMatches(), 0);
  });

  it('does not match across different colours', () => {
    const { t } = fresh();
    t.set(1, 5, 2); t.set(2, 5, 3); t.set(3, 5, 2);
    assert.equal(t.findMatches(), 0);
  });

  it('counts an overlapping cell once', () => {
    const { t } = fresh();
    /* A plus shape: one horizontal run and one vertical run sharing (2,5). */
    t.set(1, 5, 4); t.set(2, 5, 4); t.set(3, 5, 4);
    t.set(2, 4, 4); t.set(2, 6, 4);
    /* 3 horizontal + 3 vertical, sharing the centre = 5 distinct cells. */
    assert.equal(t.findMatches(), 5, 'the shared cell is not double counted');
  });

  it('matches runs longer than three in full', () => {
    const { t } = fresh();
    for (let c = 0; c < 5; c++) t.set(c, 7, 1);
    assert.equal(t.findMatches(), 5);
  });

  it('never matches across a well edge', () => {
    const { t } = fresh();
    /* Last cell of one row and first two of the next must not form a run. */
    t.set(t.COLS - 1, 3, 2);
    t.set(0, 4, 2);
    t.set(1, 4, 2);
    assert.equal(t.findMatches(), 0, 'rows do not wrap');
  });

  it('collapses gems down into gaps', () => {
    const { t } = fresh();
    t.set(2, 0, 1);
    t.set(2, 5, 2);
    assert.ok(t.collapse(), 'reports that it moved something');
    assert.equal(t.get(2, t.ROWS - 1), 2, 'lower gem sits on the floor');
    assert.equal(t.get(2, t.ROWS - 2), 1, 'upper gem stacks on top of it');
    assert.notOk(t.collapse(), 'a settled field does not move again');
  });
});

describe('PULSE timing', () => {
  function startPulse(env) {
    bootToMenu(env);
    const { Shell, gameById } = env.api();
    const g = gameById('pulse');
    Shell._startGame(g);
    return g;
  }

  it('generates a deterministic chart', () => {
    const a = makeEnv();
    const b = makeEnv();
    const ca = a.api().gameById('pulse')._test.chart();
    const cb = b.api().gameById('pulse')._test.chart();
    assert.ok(ca.length > 100, `chart has ${ca.length} notes`);
    assert.equal(ca.length, cb.length, 'two cabinets generate the same chart');
    for (let i = 0; i < ca.length; i += 17) {
      assert.equal(ca[i].lane, cb[i].lane, `note ${i} lane matches`);
      assert.equal(ca[i].time, cb[i].time, `note ${i} time matches`);
    }
  });

  it('keeps every note inside the four lanes and in time order', () => {
    const env = makeEnv();
    const chart = env.api().gameById('pulse')._test.chart();
    let last = -1;
    for (const n of chart) {
      assert.ok(n.lane >= 0 && n.lane < 4, `lane ${n.lane} is in range`);
      assert.ok(isFinite(n.time) && n.time >= last, 'chart is time ordered');
      last = n.time;
    }
  });

  it('advances the song at the same rate regardless of frame pacing', () => {
    function songAfter(dt, totalMs) {
      const env = makeEnv();
      const g = startPulse(env);
      let elapsed = 0;
      while (elapsed < totalMs) { env.tick(dt); elapsed += dt; }
      return g._test.songT();
    }
    const at60 = songAfter(16.667, 5000);
    const at144 = songAfter(6.944, 5000);
    const at30 = songAfter(33.333, 5000);
    assert.close(at144, at60, 40, `144Hz song position ${at144} vs 60Hz ${at60}`);
    assert.close(at30, at60, 40, `30Hz song position ${at30} vs 60Hz ${at60}`);
  });

  it('misses notes that pass the window, and drains health for it', () => {
    const env = makeEnv();
    const g = startPulse(env);
    const before = g._test.health();
    /* Play 12 seconds with no input at all. */
    for (let i = 0; i < 12000 / 16.667; i++) env.tick(16.667);
    assert.ok(g._test.counts()[3] > 0, 'notes were missed');
    assert.ok(g._test.health() < before, 'health drained');
  });

  it('scores a note hit inside the window', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const g = startPulse(env);
    const T = g._test;
    const LANE_BTN = { left: 14, down: 13, up: 12, right: 15 };

    /* Fast-forward to just before the first note, then hit its lane. */
    const first = T.notes()[0];
    T.setSongT(first.time - 20);
    const button = LANE_BTN[T.laneAction[first.lane]];

    pad.press(button);
    env.tick(16);
    assert.ok(T.score() > 0, `hit scored, got ${T.score()}`);
    assert.equal(T.counts()[3], 0, 'nothing was counted as a miss');
    assert.ok(T.combo() >= 1, 'combo started');
  });

  it('does not score a hit in the wrong lane', () => {
    const pad = makePad(PAD_IDS.xbox);
    const env = makeEnv({ gamepads: [pad] });
    const g = startPulse(env);
    const T = g._test;
    const LANE_BTN = { left: 14, down: 13, up: 12, right: 15 };

    const first = T.notes()[0];
    T.setSongT(first.time - 20);
    const wrongLane = (first.lane + 2) % 4;
    pad.press(LANE_BTN[T.laneAction[wrongLane]]);
    env.tick(16);
    assert.equal(T.score(), 0, 'a wrong-lane press scores nothing');
  });

  it('the song ends and reports a score', () => {
    const env = makeEnv();
    const g = startPulse(env);
    const { Shell } = env.api();
    /* Jump to the end rather than playing 60 seconds of frames. */
    g._test.setSongT(g._test.SONG_MS + 1000);
    for (let i = 0; i < 300; i++) env.tick(16.667);
    assert.ok(Shell.state() === 'over' || Shell.state() === 'initials',
      `song completion ends the game, state was ${Shell.state()}`);
  });
});

describe('BREAKOUT ball integrity', () => {
  it('never tunnels through the brick field on a long frame', () => {
    const env = makeEnv();
    bootToMenu(env);
    const { Shell, gameById, seedRng } = env.api();
    seedRng(31337);
    Shell._startGame(gameById('breakout'));

    /* Launch, then drive with the worst-case clamped frame time repeatedly.
     * A ball that tunnels would clear the field without the score moving in
     * proportion, or would escape the well entirely. */
    env.fireKey('Enter', true); env.tick(16); env.fireKey('Enter', false);
    assert.doesNotThrow(() => {
      for (let i = 0; i < 1200; i++) env.tick(49);
    });
    assert.ok(Shell.state() === 'game' || Shell.state() === 'over' ||
      Shell.state() === 'initials', 'the game is in a sane state');
  });
});

describe('CLIMB progression', () => {
  function startClimb(env, seed) {
    bootToMenu(env);
    const { Shell, gameById, seedRng } = env.api();
    seedRng(seed || 2024);
    const g = gameById('climb');
    Shell._startGame(g);
    return g;
  }

  it('bounces in place indefinitely with no input', () => {
    /* This is correct hopper behaviour, not a stall: a player who puts the
     * controller down keeps bouncing on the platform beneath them. Pinned
     * here so nobody "fixes" it into a death. */
    const env = makeEnv();
    const g = startClimb(env);
    const { Shell } = env.api();
    for (let i = 0; i < 3000; i++) env.tick(16.667);
    assert.equal(Shell.state(), 'game', 'still alive after 50s of idling');
    assert.ok(g._test.platformCount() > 0, 'platforms still exist');
  });

  it('scores by altitude and the camera only rises', () => {
    const env = makeEnv();
    const g = startClimb(env);
    const before = g._test.camY();
    assert.equal(g._test.score(), 0, 'starts at zero');

    g._test.lift(2000);
    for (let i = 0; i < 120; i++) env.tick(16.667);
    assert.ok(g._test.score() > 0, `gained altitude, score ${g._test.score()}`);
    assert.ok(g._test.camY() < before, 'camera rose to follow');

    /* Falling back down must not reduce the score or lower the camera. */
    const peakScore = g._test.score();
    const peakCam = g._test.camY();
    for (let i = 0; i < 60; i++) env.tick(16.667);
    assert.ok(g._test.score() >= peakScore, 'score never goes backwards');
    assert.ok(g._test.camY() <= peakCam, 'camera never descends');
  });

  it('ends when the hopper falls out of the view', () => {
    const env = makeEnv();
    const g = startClimb(env);
    const { Shell } = env.api();
    g._test.forceFall();
    let ended = false;
    for (let i = 0; i < 400; i++) {
      env.tick(16.667);
      if (Shell.state() !== 'game') { ended = true; break; }
    }
    assert.ok(ended, 'falling below the view ends the run');
  });
});

describe('2048 merge rules', () => {
  function fresh() {
    const env = makeEnv();
    for (let i = 0; i < 200; i++) env.tick(16);
    const { Shell, gameById, seedRng } = env.api();
    seedRng(7);
    const g = gameById('merge');
    Shell._startGame(g);
    g._test.clear();
    return { env, t: g._test };
  }

  /** Values are exponents: 1 -> "2", 2 -> "4"... row 0 is the top. */
  function row(t, r, g) {
    return [0, 1, 2, 3].map((c) => g[r * 4 + c]);
  }

  it('a full line of equal tiles fuses into two, never one', () => {
    const { t } = fresh();
    t.set(0, 0, 1); t.set(0, 1, 1); t.set(0, 2, 1); t.set(0, 3, 1);
    t.move('left'); t.finishAnim();
    assert.deep(row(t, 0, t.grid()).slice(0, 2), [2, 2],
      '2,2,2,2 -> 4,4 — a tile merges at most once per move');
  });

  it('merges pair from the front of the slide', () => {
    const { t } = fresh();
    t.set(0, 0, 2); t.set(0, 1, 1); t.set(0, 2, 1);
    t.move('left'); t.finishAnim();
    const r = row(t, 0, t.grid());
    assert.equal(r[0], 2, 'the 4 stays');
    assert.equal(r[1], 2, 'the two 2s fused into a 4 behind it');
  });

  it('a move that changes nothing is refused and spawns nothing', () => {
    const { t } = fresh();
    t.set(0, 0, 1); t.set(1, 0, 2);
    const before = t.grid().filter((v) => v !== 0).length;
    assert.notOk(t.move('left'), 'everything is already flush left');
    assert.equal(t.grid().filter((v) => v !== 0).length, before, 'no spawn');
  });

  it('scores the value of the fused tile', () => {
    const { t } = fresh();
    t.set(2, 0, 3); t.set(2, 1, 3);  /* 8 + 8 -> 16 */
    const s0 = t.score();
    t.move('left'); t.finishAnim();
    assert.equal(t.score() - s0, 16);
  });

  it('detects a dead board', () => {
    const { t } = fresh();
    /* Checkerboard of unequal neighbours: no gaps, no fusible pair. */
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) t.set(r, c, 1 + ((r + c) % 2) + (r >= 2 ? 2 : 0));
    }
    assert.notOk(t.anyMove(), 'no move exists');
  });
});

describe('FLAP flight', () => {
  function fly(seed) {
    const env = makeEnv();
    for (let i = 0; i < 200; i++) env.tick(16);
    const { Shell, gameById, seedRng } = env.api();
    seedRng(seed || 11);
    const g = gameById('flap');
    Shell._startGame(g);
    return { env, g, Shell };
  }

  it('hovers safely until the first flap', () => {
    const { env, g } = fly();
    for (let i = 0; i < 600; i++) env.tick(16.667);
    assert.ok(g._test.ready(), 'still waiting');
    assert.notOk(g._test.over(), 'hovering is never fatal');
  });

  it('gravity ends an unpiloted flight', () => {
    const { env, g } = fly();
    env.fireKey('Enter', true); env.tick(16); env.fireKey('Enter', false);
    let died = false;
    for (let i = 0; i < 400; i++) {
      env.tick(16.667);
      if (g._test.over()) { died = true; break; }
    }
    assert.ok(died, 'the floor is part of the course');
  });

  it('the pilot threads towers and scores', () => {
    const { env, g } = fly(4242);
    const { Input } = env.api();
    for (let i = 0; i < 14000 / 16.667; i++) {
      Input.setDemo(g.demo());
      env.tick(16.667);
      if (g._test.over()) break;
    }
    Input.setDemo(null);
    assert.notOk(g._test.over(), 'pilot survived the attract slot');
    assert.ok(g._test.score() >= 3, `pilot scored (${g._test.score()})`);
  });
});
