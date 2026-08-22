/*
 * VERSUS — head-to-head Tetris with garbage lines.
 *
 * Two independent wells side by side in the 600x1000 space. Clearing lines
 * sends garbage to the opponent on the standard curve (1 line sends nothing,
 * a Tetris sends four), and garbage lands only when the receiver next locks a
 * piece without clearing — so a player under pressure can always answer with
 * a clear instead of being buried mid-thought.
 *
 * INPUT ROUTING
 * -------------
 * Each board reads Input.p(n) and nothing else. Player 1 is slot 0 (keyboard
 * plus the first pad), player 2 is slot 1. The aggregate Input.down/hit that
 * every single-player game uses is never consulted here, which is what keeps
 * two-player routing from leaking into one-player behaviour.
 *
 * Piece shapes, rotations and wall kicks are taken from TETRIS rather than
 * duplicated — one set of rules, two games.
 */

var VERSUS = (function () {
  var T = TETRIS._internals;
  var COLS = T.COLS, ROWS = T.ROWS;
  var NAMES = T.NAMES, SHAPES = T.SHAPES, KICKS = T.KICKS;

  var CELL = 26;
  var BOARD_W = COLS * CELL;          /* 260 */
  var BOARD_H = ROWS * CELL;          /* 520 */
  var BOARD_Y = 196;
  var BOARD_X = [20, GW - 20 - BOARD_W];

  var GARBAGE_FOR = [0, 0, 1, 2, 4];  /* lines cleared -> lines sent */

  var boards = [null, null];
  var state = 'join';                 /* join | play | done */
  var winner = -1;
  var doneT = 0;
  var joinT = 0;

  function makeBoard(playerIndex) {
    return {
      p: playerIndex,
      grid: new Int8Array(COLS * ROWS),
      bag: [],
      next: [],
      cur: { type: 0, rot: 0, x: 3, y: -1 },
      score: 0, lines: 0, level: 1,
      dropTimer: 0, lockTimer: 0, grounded: false,
      clearing: null, clearTimer: 0,
      pending: 0,                     /* garbage waiting to be inserted */
      alive: true,
      flashT: 0, shakeT: 0,
      dasL: makeRepeater(170, 50),
      dasR: makeRepeater(170, 50),
      dasD: makeRepeater(60, 40),
      particles: makeParticles(40),
    };
  }

  function idx(x, y) { return y * COLS + x; }
  function cells(type, rot) { return SHAPES[NAMES[type]][((rot % 4) + 4) % 4]; }

  function refillBag(b) {
    var bag = [0, 1, 2, 3, 4, 5, 6];
    for (var i = bag.length - 1; i > 0; i--) {
      var j = rndInt(0, i);
      var tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;
    }
    for (var k = 0; k < bag.length; k++) b.bag.push(bag[k]);
  }

  function nextType(b) {
    if (!b.bag.length) refillBag(b);
    return b.bag.shift();
  }

  function collides(b, type, rot, px, py) {
    var cs = cells(type, rot);
    for (var i = 0; i < cs.length; i++) {
      var x = px + cs[i][0];
      var y = py + cs[i][1];
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && b.grid[idx(x, y)] !== 0) return true;
    }
    return false;
  }

  function spawn(b) {
    while (b.next.length < 2) b.next.push(nextType(b));
    b.cur.type = b.next.shift();
    b.cur.rot = 0;
    b.cur.x = 3;
    b.cur.y = -1;
    b.dropTimer = 0;
    b.lockTimer = 0;
    b.grounded = false;
    if (collides(b, b.cur.type, b.cur.rot, b.cur.x, b.cur.y)) knockOut(b);
  }

  function knockOut(b) {
    if (!b.alive) return;
    b.alive = false;
    b.shakeT = 300;
    var other = boards[b.p === 0 ? 1 : 0];
    winner = other && other.alive ? other.p : -1;
    state = 'done';
    doneT = 0;
    Audio2.sfx('over');
    Input.rumble(0.9, 0.7, 400, b.p);
    if (winner >= 0) {
      Audio2.sfx('highscore');
      Input.rumble(0.4, 0.6, 260, winner);
    }
  }

  function ghostY(b) {
    var y = b.cur.y;
    while (!collides(b, b.cur.type, b.cur.rot, b.cur.x, y + 1)) y++;
    return y;
  }

  function tryRotate(b, dir) {
    var nr = (b.cur.rot + dir + 4) % 4;
    for (var i = 0; i < KICKS.length; i++) {
      var kx = KICKS[i][0], ky = KICKS[i][1];
      if (!collides(b, b.cur.type, nr, b.cur.x + kx, b.cur.y + ky)) {
        b.cur.rot = nr;
        b.cur.x += kx;
        b.cur.y += ky;
        Audio2.sfx('rotate');
        if (b.grounded) b.lockTimer = 0;
        return true;
      }
    }
    return false;
  }

  /**
   * Push `n` garbage rows in from the bottom. All rows in one delivery share a
   * hole column, which is the convention that makes garbage answerable — you
   * can dig one channel rather than N.
   */
  function insertGarbage(b, n) {
    if (n <= 0) return;
    var hole = rndInt(0, COLS - 1);
    for (var g = 0; g < n; g++) {
      /* Anything pushed off the top ends the game. */
      for (var c = 0; c < COLS; c++) {
        if (b.grid[idx(c, 0)] !== 0) { knockOut(b); return; }
      }
      for (var y = 0; y < ROWS - 1; y++) {
        for (var x = 0; x < COLS; x++) b.grid[idx(x, y)] = b.grid[idx(x, y + 1)];
      }
      for (var x2 = 0; x2 < COLS; x2++) {
        /* Type 8 marks garbage: outside the 0..6 piece range, drawn grey. */
        b.grid[idx(x2, ROWS - 1)] = (x2 === hole) ? 0 : 8;
      }
    }
    b.shakeT = 160;
    Audio2.sfx('drop');
    Input.rumble(0.5, 0.4, 120, b.p);
  }

  function lockPiece(b) {
    var cs = cells(b.cur.type, b.cur.rot);
    var above = false;
    for (var i = 0; i < cs.length; i++) {
      var x = b.cur.x + cs[i][0];
      var y = b.cur.y + cs[i][1];
      if (y < 0) { above = true; continue; }
      if (x >= 0 && x < COLS && y < ROWS) b.grid[idx(x, y)] = b.cur.type + 1;
    }
    if (above) { knockOut(b); return; }

    var full = [];
    for (var r = 0; r < ROWS; r++) {
      var solid = true;
      for (var c = 0; c < COLS; c++) {
        if (b.grid[idx(c, r)] === 0) { solid = false; break; }
      }
      if (solid) full.push(r);
    }

    if (full.length) {
      b.clearing = full;
      b.clearTimer = 240;
      Audio2.sfx('clear', full.length);
      Input.rumble(0.5, 0.4, 120, b.p);
      for (var f = 0; f < full.length; f++) {
        b.particles.burst(BOARD_W / 2, full[f] * CELL + CELL / 2, 8, ACCENT.versus,
          { speed: 0.3, life: 380, size: 4 });
      }
    } else {
      Audio2.sfx('lock');
      /* Garbage lands now — never mid-piece. */
      if (b.pending > 0) {
        insertGarbage(b, b.pending);
        b.pending = 0;
      }
      spawn(b);
    }
  }

  function finishClear(b) {
    var rows = b.clearing;
    b.clearing = null;
    if (!rows) return;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      for (var y = r; y > 0; y--) {
        for (var c = 0; c < COLS; c++) b.grid[idx(c, y)] = b.grid[idx(c, y - 1)];
      }
      for (var c2 = 0; c2 < COLS; c2++) b.grid[idx(c2, 0)] = 0;
    }

    var n = rows.length;
    b.score += ([0, 100, 300, 500, 800][n] || 0) * b.level;
    b.lines += n;
    b.level = 1 + Math.floor(b.lines / 10);

    /* Cancel incoming garbage before sending any onward — a clear should
     * defend as well as attack. */
    var send = GARBAGE_FOR[n] || 0;
    if (b.pending > 0) {
      var cancelled = Math.min(b.pending, send);
      b.pending -= cancelled;
      send -= cancelled;
    }
    if (send > 0) {
      var other = boards[b.p === 0 ? 1 : 0];
      if (other && other.alive) {
        other.pending += send;
        other.flashT = 260;
      }
    }
    if (b.pending > 0) { insertGarbage(b, b.pending); b.pending = 0; }
    spawn(b);
  }

  function gravityMs(b) { return Math.max(70, 800 - (b.level - 1) * 70); }

  function updateBoard(b, dt) {
    b.particles.update(dt, 0.0004);
    if (b.flashT > 0) b.flashT = Math.max(0, b.flashT - dt);
    if (b.shakeT > 0) b.shakeT = Math.max(0, b.shakeT - dt);
    if (!b.alive) return;

    if (b.clearing) {
      b.clearTimer -= dt;
      if (b.clearTimer <= 0) finishClear(b);
      return;
    }

    /* Per-player input. Never the aggregate. */
    var pad = Input.p(b.p);
    var i;
    var stepsL = b.dasL.step(pad.down('left'), dt);
    var stepsR = b.dasR.step(pad.down('right'), dt);
    for (i = 0; i < stepsL; i++) {
      if (!collides(b, b.cur.type, b.cur.rot, b.cur.x - 1, b.cur.y)) {
        b.cur.x--; if (b.grounded) b.lockTimer = 0;
      }
    }
    for (i = 0; i < stepsR; i++) {
      if (!collides(b, b.cur.type, b.cur.rot, b.cur.x + 1, b.cur.y)) {
        b.cur.x++; if (b.grounded) b.lockTimer = 0;
      }
    }
    if (stepsL || stepsR) Audio2.sfx('move');

    if (pad.hit('confirm')) tryRotate(b, 1);
    if (pad.hit('back')) tryRotate(b, -1);

    if (pad.hit('up')) {
      var target = ghostY(b);
      b.score += Math.max(0, target - b.cur.y) * 2;
      b.cur.y = target;
      b.shakeT = 110;
      Audio2.sfx('drop');
      lockPiece(b);
      return;
    }

    var soft = b.dasD.step(pad.down('down'), dt);
    for (i = 0; i < soft; i++) {
      if (!collides(b, b.cur.type, b.cur.rot, b.cur.x, b.cur.y + 1)) {
        b.cur.y++; b.score += 1; b.dropTimer = 0;
      }
    }

    b.dropTimer += dt;
    var g = gravityMs(b);
    var guard = 0;
    while (b.dropTimer >= g && guard < 6) {
      b.dropTimer -= g;
      guard++;
      if (collides(b, b.cur.type, b.cur.rot, b.cur.x, b.cur.y + 1)) break;
      b.cur.y++;
    }

    b.grounded = collides(b, b.cur.type, b.cur.rot, b.cur.x, b.cur.y + 1);
    if (b.grounded) {
      b.lockTimer += dt;
      if (b.lockTimer >= 500) lockPiece(b);
    } else {
      b.lockTimer = 0;
    }
  }

  /* -------------------------------------------------------- lifecycle --- */

  function start() {
    boards[0] = makeBoard(0);
    boards[1] = makeBoard(1);
    winner = -1;
    doneT = 0;
    joinT = 0;
    state = Input.playerCount() >= 2 ? 'play' : 'join';
    if (state === 'play') beginMatch();
  }

  function beginMatch() {
    for (var i = 0; i < 2; i++) {
      refillBag(boards[i]);
      spawn(boards[i]);
    }
    state = 'play';
    Audio2.sfx('start');
  }

  function update(dt) {
    if (state === 'join') {
      joinT += dt;
      /* Input.poll assigns a pad to slot 1 when Start is pressed on it, so
       * all this has to do is watch for the second player appearing. */
      if (Input.playerCount() >= 2) beginMatch();
      return;
    }

    if (state === 'done') {
      doneT += dt;
      for (var k = 0; k < 2; k++) if (boards[k]) updateBoard(boards[k], dt);
      if (doneT > 2600) {
        var w = winner >= 0 && boards[winner] ? boards[winner].score : 0;
        Shell.gameOver(w);
        state = 'over';
      }
      return;
    }

    if (state !== 'play') return;
    updateBoard(boards[0], dt);
    updateBoard(boards[1], dt);
  }

  /* ------------------------------------------------------------ draw --- */

  function cellColour(v) {
    if (v === 8) return ['#3A3560', '#5A5488'];    /* garbage */
    return PIECE_COL[NAMES[v - 1]];
  }

  function drawBoard(c, b, ox) {
    c.save();
    if (b.shakeT > 0) {
      var k = b.shakeT / 300;
      c.translate(Math.sin(b.shakeT * 1.1) * 4 * k, 0);
    }
    c.translate(ox, BOARD_Y);

    panel(c, -6, -6, BOARD_W + 12, BOARD_H + 12, {
      fill: 'rgba(8,6,18,0.55)',
      stroke: b.alive ? rgba(ACCENT.versus, 0.24) : rgba(COL.bad, 0.5),
      radius: 10,
    });

    if (b.flashT > 0) {
      c.globalAlpha = clamp(b.flashT / 260 * 0.22, 0, 1);
      c.fillStyle = COL.bad;
      c.fillRect(0, 0, BOARD_W, BOARD_H);
      c.globalAlpha = 1;
    }

    c.save();
    c.beginPath();
    c.rect(-6, -6, BOARD_W + 12, BOARD_H + 12);
    c.clip();

    var r, col;
    for (r = 0; r < ROWS; r++) {
      var flashing = false;
      if (b.clearing) {
        for (var q = 0; q < b.clearing.length; q++) if (b.clearing[q] === r) flashing = true;
      }
      for (col = 0; col < COLS; col++) {
        var v = b.grid[idx(col, r)];
        if (v === 0) continue;
        var cc = cellColour(v);
        tile(c, col * CELL, r * CELL, CELL, cc[0], cc[1], flashing ? 'flash' : 'solid');
      }
    }

    if (b.alive && !b.clearing) {
      var gy = ghostY(b);
      var cs = cells(b.cur.type, b.cur.rot);
      var pc = PIECE_COL[NAMES[b.cur.type]];
      var i;
      for (i = 0; i < cs.length; i++) {
        var gr = gy + cs[i][1];
        if (gr >= 0) tile(c, (b.cur.x + cs[i][0]) * CELL, gr * CELL, CELL, pc[0], pc[1], 'ghost');
      }
      for (i = 0; i < cs.length; i++) {
        var cr = b.cur.y + cs[i][1];
        if (cr >= 0) tile(c, (b.cur.x + cs[i][0]) * CELL, cr * CELL, CELL, pc[0], pc[1], 'glow');
      }
    }

    b.particles.draw(c);
    c.restore();

    if (!b.alive) {
      c.fillStyle = 'rgba(7,5,14,0.66)';
      c.fillRect(0, 0, BOARD_W, BOARD_H);
      text(c, 'KO', BOARD_W / 2, BOARD_H / 2, {
        size: 46, weight: '700', track: 8, color: COL.bad,
        align: 'center', baseline: 'middle',
      });
    }

    c.restore();
  }

  /** Pending-garbage meter, drawn up the inside edge of each board. */
  function drawMeter(c, b, x) {
    var h = BOARD_H;
    var w = 8;
    c.fillStyle = 'rgba(110,106,160,.16)';
    c.fillRect(x, BOARD_Y, w, h);
    if (b.pending <= 0) return;
    var fill = clamp(b.pending / ROWS, 0, 1) * h;
    var g = c.createLinearGradient(0, BOARD_Y + h - fill, 0, BOARD_Y + h);
    g.addColorStop(0, COL.warn);
    g.addColorStop(1, COL.bad);
    c.fillStyle = g;
    c.fillRect(x, BOARD_Y + h - fill, w, fill);
    Render.glow(c, x + w / 2, BOARD_Y + h - fill / 2, 40, COL.bad, 0.5);
  }

  function drawPlayerHeader(c, b, ox, label) {
    text(c, label, ox + BOARD_W / 2, BOARD_Y - 52, {
      size: 15, weight: '700', track: 4,
      color: b.alive ? COL.text : COL.dim, align: 'center',
    });
    dataText(c, fmtScore(b.score), ox + BOARD_W / 2, BOARD_Y - 24, {
      size: 22, align: 'center', color: b.alive ? COL.data : COL.dim,
    });
    /* Next piece, small, above the well. */
    if (b.next.length) {
      var t2 = b.next[0];
      var cs = SHAPES[NAMES[t2]][0];
      var pc = PIECE_COL[NAMES[t2]];
      var s = 9;
      for (var i = 0; i < cs.length; i++) {
        tile(c, ox + BOARD_W - 46 + cs[i][0] * s, BOARD_Y - 66 + cs[i][1] * s, s,
          pc[0], pc[1], 'solid');
      }
    }
  }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.versus);

    if (state === 'join') {
      gHud(ACCENT.versus, [{ label: 'MODE', value: 'VERSUS' }]);
      text(c, 'PLAYER 2', GW / 2, GH * 0.40, {
        size: 40, weight: '700', track: 10, aurora: true,
        align: 'center', baseline: 'middle',
      });
      var pulse = 0.5 + Math.sin(joinT * 0.005) * 0.5;
      c.globalAlpha = clamp(0.4 + pulse * 0.6, 0, 1);
      text(c, 'PRESS START ON A SECOND PAD', GW / 2, GH * 0.40 + 60, {
        size: 20, weight: '600', track: 3, color: COL.text,
        align: 'center', baseline: 'middle',
      });
      c.globalAlpha = 1;
      text(c, Input.padCount() + ' CONTROLLER' + (Input.padCount() === 1 ? '' : 'S') + ' CONNECTED',
        GW / 2, GH * 0.40 + 110, {
          size: 15, weight: '500', track: 2, color: COL.dim,
          align: 'center', baseline: 'middle',
        });
      text(c, 'PAUSE TO GO BACK', GW / 2, GH * 0.40 + 150, {
        size: 14, weight: '500', track: 2, color: COL.text2,
        align: 'center', baseline: 'middle',
      });
      return;
    }

    gHud(ACCENT.versus, [
      { label: 'P1 LINES', value: pad(boards[0].lines, 3) },
      { label: 'VERSUS', value: boards[0].alive && boards[1].alive ? 'LIVE' : 'KO' },
      { label: 'P2 LINES', value: pad(boards[1].lines, 3) },
    ]);

    drawPlayerHeader(c, boards[0], BOARD_X[0], 'PLAYER 1');
    drawPlayerHeader(c, boards[1], BOARD_X[1], 'PLAYER 2');
    drawBoard(c, boards[0], BOARD_X[0]);
    drawBoard(c, boards[1], BOARD_X[1]);
    drawMeter(c, boards[0], BOARD_X[0] + BOARD_W + 8);
    drawMeter(c, boards[1], BOARD_X[1] - 16);

    if (state === 'done' || state === 'over') {
      c.fillStyle = 'rgba(7,5,14,0.55)';
      c.fillRect(0, 0, GW, GH);
      var label = winner >= 0 ? 'PLAYER ' + (winner + 1) + ' WINS' : 'DRAW';
      text(c, label, GW / 2, GH / 2, {
        size: 44, weight: '700', track: 8, aurora: true,
        align: 'center', baseline: 'middle',
      });
    }
  }

  /* --------------------------------------------------------- preview --- */

  function preview(c, w, h, t) {
    var bw = w * 0.42;
    var s = bw / 6;
    var loop = (t % 2000) / 2000;
    for (var side = 0; side < 2; side++) {
      var ox = side === 0 ? w * 0.03 : w - bw - w * 0.03;
      panel(c, ox - 2, h * 0.10, bw + 4, h * 0.78, {
        fill: 'rgba(8,6,18,0.5)', stroke: rgba(ACCENT.versus, 0.3), radius: 6,
      });
      /* A short stack, taller on the losing side. */
      var rowsP = side === 0 ? 3 : 5;
      for (var r = 0; r < rowsP; r++) {
        for (var cc = 0; cc < 6; cc++) {
          if ((cc + r * 3 + side) % 5 === 2) continue;
          var isGarbage = (side === 1 && r < 2);
          var col = isGarbage ? ['#3A3560', '#5A5488'] : PIECE_COL[NAMES[(cc + r + side * 2) % 7]];
          tile(c, ox + cc * s, h * 0.88 - (r + 1) * s, s, col[0], col[1], 'solid');
        }
      }
      /* A falling piece on each side, offset in phase. */
      var fy = lerp(h * 0.12, h * 0.88 - (rowsP + 2) * s, (loop + side * 0.4) % 1);
      var pcol = PIECE_COL[NAMES[side === 0 ? 0 : 2]];
      for (var k = 0; k < 4; k++) {
        tile(c, ox + (1 + k) * s, fy, s, pcol[0], pcol[1], 'glow');
      }
    }
    text(c, 'VS', w / 2, h * 0.5, {
      size: Math.max(10, h * 0.16), weight: '700', track: 2,
      color: rgba(ACCENT.versus, 0.9), align: 'center', baseline: 'middle',
    });
  }

  return registerVersus({
    id: 'versus',
    title: 'VERSUS',
    tag: 'Two wells, one pile of garbage',
    accent: ACCENT.versus,
    hint: 'TWO PADS · {A} ROTATE · ▲ SLAM',
    start: start,
    update: update,
    draw: draw,
    preview: preview,
    _test: {
      boards: function () { return boards; },
      state: function () { return state; },
      winner: function () { return winner; },
      insertGarbage: insertGarbage,
      lockPiece: lockPiece,
      GARBAGE_FOR: GARBAGE_FOR,
      COLS: COLS, ROWS: ROWS,
    },
  });
})();
