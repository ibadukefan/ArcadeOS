/*
 * Two-player tests: pad-to-slot routing, joining with Start, the versus
 * garbage rules, and — the one that matters most — that none of it changed
 * how a single player's input behaves.
 */
'use strict';

const { makeEnv, makePad, PAD_IDS } = require('./harness.js');

function bootToMenu(env) {
  for (let i = 0; i < 200; i++) env.tick(16);
}

describe('player slots', () => {
  it('the first pad claims player 1', () => {
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const env = makeEnv({ gamepads: [p1] });
    const { Input } = env.api();
    env.pollOnly(16);
    assert.equal(Input.playerCount(), 1);
    assert.equal(Input.padCount(), 1);
    assert.ok(Input.p(0).active());
    assert.notOk(Input.p(1).active(), 'player 2 has not joined');
  });

  it('a second pad does not join until Start is pressed', () => {
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const p2 = makePad(PAD_IDS.playstation, { index: 1 });
    const env = makeEnv({ gamepads: [p1, p2] });
    const { Input } = env.api();

    env.pollOnly(16);
    env.pollOnly(16);
    assert.equal(Input.padCount(), 1, 'the second pad sits out until it asks in');
    assert.notOk(Input.p(1).active());

    p2.press(9);                        /* Start */
    env.pollOnly(16);
    assert.ok(Input.p(1).active(), 'Start joins player 2');
    assert.equal(Input.playerCount(), 2);
    assert.equal(Input.padCount(), 2);
  });

  it('routes each pad to its own player', () => {
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const p2 = makePad(PAD_IDS.xbox, { index: 1 });
    const env = makeEnv({ gamepads: [p1, p2] });
    const { Input } = env.api();
    env.pollOnly(16);
    p2.press(9); env.pollOnly(16); p2.release(9); env.pollOnly(16);
    assert.ok(Input.p(1).active());

    p1.press(14);                       /* P1 left */
    p2.press(15);                       /* P2 right */
    env.pollOnly(16);

    assert.ok(Input.p(0).down('left'), 'P1 sees its own left');
    assert.notOk(Input.p(0).down('right'), 'P1 does not see P2 input');
    assert.ok(Input.p(1).down('right'), 'P2 sees its own right');
    assert.notOk(Input.p(1).down('left'), 'P2 does not see P1 input');
  });

  it('keeps per-player glyphs for mixed controller types', () => {
    const p1 = makePad(PAD_IDS.nintendo, { index: 0 });
    const p2 = makePad(PAD_IDS.playstation, { index: 1 });
    const env = makeEnv({ gamepads: [p1, p2] });
    const { Input } = env.api();
    env.pollOnly(16);
    p2.press(9); env.pollOnly(16); p2.release(9); env.pollOnly(16);

    assert.equal(Input.glyphs(0).confirm, 'A', 'P1 is a Nintendo pad');
    assert.equal(Input.glyphs(1).confirm, '✕', 'P2 is a PlayStation pad');

    /* And the face swap applies per player, not globally. */
    p1.press(1);                        /* Nintendo confirm = right face */
    p2.press(0);                        /* PlayStation confirm = bottom face */
    env.pollOnly(16);
    assert.ok(Input.p(0).hit('confirm'), 'P1 confirms with button 1');
    assert.ok(Input.p(1).hit('confirm'), 'P2 confirms with button 0');
  });

  it('drops player 2 when their pad is unplugged', () => {
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const p2 = makePad(PAD_IDS.xbox, { index: 1 });
    const env = makeEnv({ gamepads: [p1, p2] });
    const { Input } = env.api();
    env.pollOnly(16);
    p2.press(9); env.pollOnly(16); p2.release(9); env.pollOnly(16);
    assert.equal(Input.playerCount(), 2);

    env.setGamepads([p1]);
    env.pollOnly(16);
    assert.equal(Input.playerCount(), 1, 'player 2 left');
    assert.ok(Input.p(0).active(), 'player 1 is unaffected');
  });
});

describe('single-player is unregressed', () => {
  it('the aggregate still sees player 1 input', () => {
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const env = makeEnv({ gamepads: [p1] });
    const { Input } = env.api();
    env.pollOnly(16);
    p1.press(13);
    env.pollOnly(16);
    assert.ok(Input.down('down'), 'Input.down still works without a player index');
    assert.ok(Input.hit('down'));
    assert.ok(Input.p(0).down('down'), 'and matches player 1 exactly');
  });

  it('a second player can also drive the menus', () => {
    /* Menus read the aggregate, so either pad should navigate. */
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const p2 = makePad(PAD_IDS.xbox, { index: 1 });
    const env = makeEnv({ gamepads: [p1, p2] });
    const { Input } = env.api();
    env.pollOnly(16);
    p2.press(9); env.pollOnly(16); p2.release(9); env.pollOnly(16);

    p2.press(13);
    env.pollOnly(16);
    assert.ok(Input.down('down'), 'player 2 reaches the aggregate too');
  });

  it('every single-player game still runs with two pads connected', () => {
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const p2 = makePad(PAD_IDS.xbox, { index: 1 });
    const env = makeEnv({ gamepads: [p1, p2] });
    const { Shell, GAMES } = env.api();
    bootToMenu(env);
    p2.press(9); env.tick(16); p2.release(9); env.tick(16);

    for (const g of GAMES) {
      Shell._startGame(g);
      assert.doesNotThrow(() => {
        for (let i = 0; i < 120; i++) env.tick(16.667);
      }, `${g.id} runs with two pads connected`);
    }
  });
});

describe('VERSUS', () => {
  function twoPadEnv() {
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const p2 = makePad(PAD_IDS.xbox, { index: 1 });
    const env = makeEnv({ gamepads: [p1, p2] });
    bootToMenu(env);
    p2.press(9); env.tick(16); p2.release(9); env.tick(16);
    return { env, p1, p2 };
  }

  it('appears on the dashboard as a 2P entry', () => {
    const env = makeEnv();
    const { Shell, VERSUS_GAMES } = env.api();
    bootToMenu(env);
    assert.equal(VERSUS_GAMES.length, 1);
    assert.ok(Shell._select('versus'), 'versus is reachable on the dashboard');
    const rows = Shell._rows();
    const flat = rows.reduce((a, r) => a.concat(r), []);
    const entry = flat.find((e) => e.kind === 'game' && e.game.id === 'versus');
    assert.ok(entry && entry.versus, 'it is flagged as a versus entry');
  });

  it('waits for player 2 when only one pad is connected', () => {
    const env = makeEnv({ gamepads: [makePad(PAD_IDS.xbox, { index: 0 })] });
    const { Shell, gameById } = env.api();
    bootToMenu(env);
    const g = gameById('versus');
    Shell._startGame(g);
    for (let i = 0; i < 60; i++) env.tick(16.667);
    assert.equal(g._test.state(), 'join', 'sits on the join prompt');
    assert.equal(Shell.state(), 'game', 'without wedging the shell');
  });

  it('starts the match as soon as player 2 joins', () => {
    const p1 = makePad(PAD_IDS.xbox, { index: 0 });
    const p2 = makePad(PAD_IDS.xbox, { index: 1 });
    const env = makeEnv({ gamepads: [p1, p2] });
    const { Shell, gameById } = env.api();
    bootToMenu(env);
    const g = gameById('versus');
    Shell._startGame(g);
    assert.equal(g._test.state(), 'join');

    p2.press(9);
    env.tick(16);
    env.tick(16);
    assert.equal(g._test.state(), 'play', 'the match begins on Start');
  });

  it('routes each well to its own player', () => {
    const { env, p1, p2 } = twoPadEnv();
    const { Shell, gameById } = env.api();
    const g = gameById('versus');
    Shell._startGame(g);
    assert.equal(g._test.state(), 'play');

    const boards = g._test.boards();
    const x1 = boards[0].cur.x;
    const x2 = boards[1].cur.x;

    p1.press(14);                        /* only P1 presses left */
    for (let i = 0; i < 4; i++) env.tick(16);
    assert.ok(boards[0].cur.x < x1, 'P1 piece moved left');
    assert.equal(boards[1].cur.x, x2, 'P2 piece did not move');

    p1.release(14);
    p2.press(15);
    for (let i = 0; i < 4; i++) env.tick(16);
    assert.ok(boards[1].cur.x > x2, 'P2 piece moved right');
  });

  it('sends garbage on the standard curve', () => {
    const env = makeEnv();
    const g = env.api().gameById('versus');
    const curve = g._test.GARBAGE_FOR;
    assert.equal(curve[1], 0, 'a single is worth no garbage');
    assert.equal(curve[2], 1);
    assert.equal(curve[3], 2);
    assert.equal(curve[4], 4, 'a tetris sends four');
  });

  it('garbage arrives from the bottom with exactly one hole', () => {
    const { env } = twoPadEnv();
    const { Shell, gameById } = env.api();
    const g = gameById('versus');
    Shell._startGame(g);
    const b = g._test.boards()[1];
    const { COLS, ROWS } = g._test;

    g._test.insertGarbage(b, 3);

    for (let r = ROWS - 3; r < ROWS; r++) {
      let holes = 0;
      for (let c = 0; c < COLS; c++) {
        const v = b.grid[r * COLS + c];
        if (v === 0) holes++;
        else assert.equal(v, 8, 'garbage cells are marked as garbage');
      }
      assert.equal(holes, 1, `row ${r} has exactly one hole`);
    }
    /* All three rows share a column, so it can be dug in one channel. */
    const holeOf = (r) => {
      for (let c = 0; c < COLS; c++) if (b.grid[r * COLS + c] === 0) return c;
      return -1;
    };
    assert.equal(holeOf(ROWS - 1), holeOf(ROWS - 2));
    assert.equal(holeOf(ROWS - 2), holeOf(ROWS - 3));
  });

  it('declares a winner when a well tops out', () => {
    const { env } = twoPadEnv();
    const { Shell, gameById } = env.api();
    const g = gameById('versus');
    Shell._startGame(g);
    const boards = g._test.boards();

    /* Bury player 2 completely. */
    g._test.insertGarbage(boards[1], 40);
    env.tick(16);

    assert.equal(g._test.state(), 'done', 'the match ended');
    assert.equal(g._test.winner(), 0, 'player 1 won');
    assert.notOk(boards[1].alive);
  });

  it('returns to the shell after the win banner', () => {
    const { env } = twoPadEnv();
    const { Shell, gameById } = env.api();
    const g = gameById('versus');
    Shell._startGame(g);
    g._test.insertGarbage(g._test.boards()[1], 40);
    for (let i = 0; i < 300; i++) env.tick(16.667);
    assert.notEqual(Shell.state(), 'game', 'the shell took back over');
  });

  it('survives 1500 randomised two-player frames', () => {
    const { env, p1, p2 } = twoPadEnv();
    const { Shell, gameById, seedRng } = env.api();
    seedRng(0xBEEF);
    const g = gameById('versus');
    Shell._startGame(g);

    let a = 0x2F6E2B1 >>> 0;
    const rand = () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const BUTTONS = [0, 1, 12, 13, 14, 15];
    const DTS = [6.944, 16.667, 33.333, 11.3, 49];

    assert.doesNotThrow(() => {
      for (let i = 0; i < 1500; i++) {
        for (const p of [p1, p2]) {
          if (rand() < 0.3) {
            const b = BUTTONS[(rand() * BUTTONS.length) | 0];
            if (rand() < 0.5) p.press(b); else p.release(b);
          }
        }
        env.tick(DTS[(rand() * DTS.length) | 0]);
        if (Shell.state() !== 'game') {
          p1.releaseAll(); p2.releaseAll();
          for (let k = 0; k < 10; k++) {
            p1.press(0); env.tick(16); p1.release(0); env.tick(16);
            if (Shell.state() === 'menu') break;
          }
          if (Shell.state() === 'menu') Shell._startGame(g);
        }
      }
    });
  });
});
