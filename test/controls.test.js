/*
 * Cabinet-requested game feel, pinned so it never regresses:
 *
 *  - TETRIS modern controls: face buttons rotate (both directions), up on
 *    the d-pad slams, down soft-drops, X holds. Requested from the cabinet:
 *    "a button to rotate the piece, up slams it down immediately, down makes
 *    it go down faster, and one of the buttons to hold/swap a piece."
 *  - VERSUS uses the same mapping per pad.
 *  - SNAKE glides between cells instead of teleporting once per step
 *    ("Snake feels choppy") — head and retracting tail interpolate by
 *    acc/stepMs, and a step that eats retracts nothing.
 */
'use strict';

const { makeEnv, makePad, PAD_IDS } = require('./harness.js');

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

function tap(env, code) {
  env.fireKey(code, true);
  env.tick(16);
  env.fireKey(code, false);
  env.tick(16);
}

describe('TETRIS modern controls', () => {
  function fresh() {
    const env = makeEnv();
    bootToMenu(env);
    const { Shell, gameById, seedRng } = env.api();
    seedRng(4242);
    const g = gameById('tetris');
    Shell._startGame(g);
    return { env, g, Shell };
  }

  it('confirm rotates the piece clockwise', () => {
    const { env, g, Shell } = fresh();
    assert.equal(g._test.cur().rot, 0);
    tap(env, 'KeyZ');
    assert.equal(g._test.cur().rot, 1, 'A rotates clockwise');
    assert.equal(Shell.state(), 'game');
  });

  it('back rotates counter-clockwise without leaving the game', () => {
    const { env, g, Shell } = fresh();
    tap(env, 'KeyX');
    assert.equal(g._test.cur().rot, 3, 'B rotates the other way');
    assert.equal(Shell.state(), 'game',
      'back is a game control here, not an exit');
  });

  it('up slams the piece down and locks it immediately', () => {
    const { env, g, Shell } = fresh();
    assert.equal(g._test.filled(), 0, 'the well starts empty');
    const before = g._test.score();
    tap(env, 'ArrowUp');
    assert.equal(g._test.filled(), 4, 'the piece locked on the floor');
    assert.ok(g._test.score() > before, 'hard drop pays per cell');
    assert.ok(g._test.cur().y < 2, 'the next piece spawned at the top');
    assert.equal(Shell.state(), 'game');
  });

  it('down soft-drops faster than gravity', () => {
    const { env, g } = fresh();
    const y0 = g._test.cur().y;
    const s0 = g._test.score();
    env.fireKey('ArrowDown', true);
    for (let i = 0; i < 6; i++) env.tick(16.667);
    env.fireKey('ArrowDown', false);
    /* 100ms of gravity at level 1 (800ms/row) moves nothing on its own. */
    assert.ok(g._test.cur().y > y0, 'soft drop moved the piece down');
    assert.ok(g._test.score() > s0, 'soft drop pays per row');
  });

  it('alt holds the piece, and only once per drop', () => {
    const { env, g } = fresh();
    const first = g._test.cur().type;
    assert.equal(g._test.holdType(), -1);
    tap(env, 'KeyC');
    assert.equal(g._test.holdType(), first, 'the piece went to the hold box');
    assert.notEqual(g._test.cur().type, first, 'a new piece is live');

    const held = g._test.holdType();
    tap(env, 'KeyC');
    assert.equal(g._test.holdType(), held, 'a second hold is denied');
  });
});

describe('VERSUS uses the same mapping per pad', () => {
  function match() {
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const p2 = makePad(PAD_IDS.xbox, { index: 1 });
    const env = makeEnv({ gamepads: [p1, p2] });
    bootToMenu(env);
    const { Shell, gameById } = env.api();
    const g = gameById('versus');
    Shell._startGame(g);
    p1.press(9); p2.press(9);
    env.tick(16); env.tick(16);
    p1.release(9); p2.release(9);
    env.tick(16);
    return { env, g, p1, p2 };
  }

  it('A rotates only your own piece', () => {
    const { env, g, p1 } = match();
    const boards = g._test.boards();
    p1.press(0);
    env.tick(16); env.tick(16);
    p1.release(0);
    assert.equal(boards[0].cur.rot, 1, 'P1 rotated');
    assert.equal(boards[1].cur.rot, 0, 'P2 did not');
  });

  it('B rotates counter-clockwise', () => {
    const { env, g, p2 } = match();
    const boards = g._test.boards();
    p2.press(1);
    env.tick(16); env.tick(16);
    p2.release(1);
    assert.equal(boards[1].cur.rot, 3);
  });

  it('up slams your piece into the well', () => {
    const { env, g, p1 } = match();
    const boards = g._test.boards();
    const filled = (b) => {
      let n = 0;
      for (let i = 0; i < b.grid.length; i++) if (b.grid[i] !== 0) n++;
      return n;
    };
    assert.equal(filled(boards[0]), 0);
    p1.press(12);
    env.tick(16); env.tick(16);
    p1.release(12);
    assert.equal(filled(boards[0]), 4, 'P1 piece locked');
    assert.equal(filled(boards[1]), 0, 'P2 well untouched');
  });
});

describe('SNAKE motion interpolation', () => {
  function fresh() {
    const env = makeEnv();
    bootToMenu(env);
    const { Shell, gameById, seedRng } = env.api();
    seedRng(99);
    const g = gameById('snake');
    Shell._startGame(g);
    return { env, g };
  }

  it('reports a mid-step fraction between steps', () => {
    const { env, g } = fresh();
    /* 4 frames = ~67ms into a 140ms step. */
    for (let i = 0; i < 4; i++) env.tick(16.667);
    const a = g._anim();
    assert.close(a.p, 66.7 / 140, 0.1, `p was ${a.p}`);
    assert.equal(a.prevHead, -1, 'nothing to glide from before the first step');
  });

  it('records the vacated head and tail cells after a step', () => {
    const { env, g } = fresh();
    /* Cross one step boundary (140ms) but not two. */
    for (let i = 0; i < 10; i++) env.tick(16.667);
    const a = g._anim();
    assert.ok(a.prevHead >= 0, 'the head glide has a source cell');
    assert.ok(a.poppedTail >= 0, 'the tail retraction has a source cell');
    assert.ok(a.p >= 0 && a.p <= 1, `p in range, was ${a.p}`);
  });

  it('a step that eats retracts no tail — the snake grows', () => {
    const { env, g } = fresh();
    /* Park the food directly in the snake's path, then step onto it. */
    const h = g._test.head();
    const d = g._test.dir();
    g._test.setFood(h.x + d.x, h.y + d.y);
    for (let i = 0; i < 10; i++) env.tick(16.667);
    assert.equal(g._test.eaten(), 1, 'the food was eaten');
    assert.equal(g._anim().poppedTail, -1,
      'no tail cell vacated on the growth step');
  });
});
