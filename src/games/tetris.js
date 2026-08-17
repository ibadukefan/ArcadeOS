/*
 * TETRIS — the flagship. 10x20 well, 7-bag randomiser, ghost piece, hold,
 * lock delay, soft/hard drop.
 *
 * Controls (d-pad + one button is enough to play; hold is optional):
 *   left/right  move          up       rotate clockwise
 *   down        soft drop     confirm  hard drop
 *   alt         hold          pause    pause
 */

var TETRIS = (function () {
  var COLS = 10, ROWS = 20;
  var CELL = 42;
  var BX = 20, BY = 108;              /* board origin in game space */
  var PANEL_X = BX + COLS * CELL + 10; /* 450 */
  var PANEL_W = GW - PANEL_X - 10;     /* 140 */

  var NAMES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

  /* Spawn shapes on a 4x4 grid, as [col,row] cells. */
  var BASE = {
    I: [[0, 1], [1, 1], [2, 1], [3, 1]],
    O: [[1, 0], [2, 0], [1, 1], [2, 1]],
    T: [[1, 0], [0, 1], [1, 1], [2, 1]],
    S: [[1, 0], [2, 0], [0, 1], [1, 1]],
    Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
    J: [[0, 0], [0, 1], [1, 1], [2, 1]],
    L: [[2, 0], [0, 1], [1, 1], [2, 1]],
  };

  /**
   * Rotations are precomputed at load. Rotating in update() would allocate
   * four arrays per keypress; a Pi 4 notices that kind of churn.
   */
  var SHAPES = {};
  (function build() {
    for (var n = 0; n < NAMES.length; n++) {
      var name = NAMES[n];
      var size = (name === 'I') ? 4 : (name === 'O') ? 4 : 3;
      var states = [BASE[name]];
      for (var r = 1; r < 4; r++) {
        var prev = states[r - 1];
        var next = [];
        for (var i = 0; i < prev.length; i++) {
          var x = prev[i][0], y = prev[i][1];
          /* clockwise within an size x size box */
          next.push([size - 1 - y, x]);
        }
        states.push(next);
      }
      SHAPES[name] = states;
    }
  })();

  /* Wall-kick candidates, tried in order. Not full SRS, but it handles every
   * kick a player actually attempts and never wedges a piece. */
  var KICKS = [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1]];

  /* ------------------------------------------------------------ state --- */

  var grid = new Int8Array(COLS * ROWS);
  var bag = [];
  var cur = { type: 0, rot: 0, x: 0, y: 0 };
  var nextQueue = [];
  var holdType = -1;
  var holdUsed = false;

  var score = 0, lines = 0, level = 1;
  var dropTimer = 0, lockTimer = 0, grounded = false;
  var clearing = null, clearTimer = 0;
  var over = false;
  var shakeT = 0;
  var dasL = makeRepeater(170, 50);
  var dasR = makeRepeater(170, 50);
  var dasD = makeRepeater(60, 40);
  var particles = makeParticles(72);

  function idx(x, y) { return y * COLS + x; }

  function refillBag() {
    /* 7-bag: every piece appears once per bag, Fisher-Yates shuffled. */
    var b = [0, 1, 2, 3, 4, 5, 6];
    for (var i = b.length - 1; i > 0; i--) {
      var j = rndInt(0, i);
      var t = b[i]; b[i] = b[j]; b[j] = t;
    }
    for (var k = 0; k < b.length; k++) bag.push(b[k]);
  }

  function nextType() {
    if (bag.length === 0) refillBag();
    return bag.shift();
  }

  function cells(type, rot) {
    return SHAPES[NAMES[type]][((rot % 4) + 4) % 4];
  }

  function collides(type, rot, px, py) {
    var cs = cells(type, rot);
    for (var i = 0; i < cs.length; i++) {
      var x = px + cs[i][0];
      var y = py + cs[i][1];
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && grid[idx(x, y)] !== 0) return true;
    }
    return false;
  }

  function spawn(type) {
    cur.type = type;
    cur.rot = 0;
    cur.x = (type === 0) ? 3 : 3;
    cur.y = -1;
    holdUsed = false;
    dropTimer = 0;
    lockTimer = 0;
    grounded = false;
    if (collides(cur.type, cur.rot, cur.x, cur.y)) {
      topOut();
    }
  }

  function pullNext() {
    while (nextQueue.length < 3) nextQueue.push(nextType());
    spawn(nextQueue.shift());
  }

  function topOut() {
    if (over) return;
    over = true;
    Audio2.sfx('over');
    Input.rumble(0.8, 0.6, 400);
    Shell.gameOver(score);
  }

  /* ----------------------------------------------------------- moves --- */

  function tryMove(dx, dy) {
    if (collides(cur.type, cur.rot, cur.x + dx, cur.y + dy)) return false;
    cur.x += dx;
    cur.y += dy;
    return true;
  }

  function tryRotate(dir) {
    var nr = (cur.rot + dir + 4) % 4;
    for (var i = 0; i < KICKS.length; i++) {
      var kx = KICKS[i][0], ky = KICKS[i][1];
      if (!collides(cur.type, nr, cur.x + kx, cur.y + ky)) {
        cur.rot = nr;
        cur.x += kx;
        cur.y += ky;
        Audio2.sfx('rotate');
        /* Any successful move resets lock delay — this is what makes the
         * piece feel alive rather than glued down. */
        if (grounded) lockTimer = 0;
        return true;
      }
    }
    return false;
  }

  function ghostY() {
    var y = cur.y;
    while (!collides(cur.type, cur.rot, cur.x, y + 1)) y++;
    return y;
  }

  function hardDrop() {
    var target = ghostY();
    var dist = target - cur.y;
    if (dist > 0) score += dist * 2;
    cur.y = target;
    Audio2.sfx('drop');
    Input.rumble(0.35, 0.2, 70);
    shakeT = 140;
    lockPiece();
  }

  function doHold() {
    if (holdUsed) { Audio2.sfx('denied'); return; }
    var prev = holdType;
    holdType = cur.type;
    holdUsed = true;
    if (prev === -1) pullNext();
    else spawn(prev);
    holdUsed = true;
    Audio2.sfx('select');
  }

  function lockPiece() {
    var cs = cells(cur.type, cur.rot);
    var above = false;
    for (var i = 0; i < cs.length; i++) {
      var x = cur.x + cs[i][0];
      var y = cur.y + cs[i][1];
      if (y < 0) { above = true; continue; }
      if (x >= 0 && x < COLS && y < ROWS) grid[idx(x, y)] = cur.type + 1;
    }
    if (above) { topOut(); return; }

    var full = [];
    for (var r = 0; r < ROWS; r++) {
      var solid = true;
      for (var c = 0; c < COLS; c++) {
        if (grid[idx(c, r)] === 0) { solid = false; break; }
      }
      if (solid) full.push(r);
    }

    if (full.length) {
      clearing = full;
      clearTimer = 280;
      Audio2.sfx('clear', full.length);
      Input.rumble(0.5, 0.4, 120 + full.length * 40);
      for (var f = 0; f < full.length; f++) {
        var py = BY + full[f] * CELL + CELL / 2;
        particles.burst(BX + GW * 0.0 + COLS * CELL / 2, py, 10, ACCENT.tetris,
          { speed: 0.34, life: 420, size: 5 });
      }
    } else {
      Audio2.sfx('lock');
      pullNext();
    }
  }

  function finishClear() {
    var rows = clearing;
    clearing = null;
    if (!rows) return;

    /* Collapse from the bottom up. */
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      for (var y = r; y > 0; y--) {
        for (var c = 0; c < COLS; c++) grid[idx(c, y)] = grid[idx(c, y - 1)];
      }
      for (var c2 = 0; c2 < COLS; c2++) grid[idx(c2, 0)] = 0;
    }

    var n = rows.length;
    var award = [0, 100, 300, 500, 800][n] || 0;
    score += award * level;
    lines += n;
    level = 1 + Math.floor(lines / 10);
    pullNext();
  }

  function gravityMs() {
    return Math.max(60, 800 - (level - 1) * 70);
  }

  /* -------------------------------------------------------- lifecycle --- */

  function start() {
    grid = new Int8Array(COLS * ROWS);
    bag = [];
    nextQueue = [];
    holdType = -1;
    holdUsed = false;
    score = 0; lines = 0; level = 1;
    dropTimer = 0; lockTimer = 0; grounded = false;
    clearing = null; clearTimer = 0;
    over = false; shakeT = 0;
    dasL.reset(); dasR.reset(); dasD.reset();
    particles.clear();
    refillBag();
    pullNext();
  }

  function update(dt) {
    particles.update(dt, 0.0004);
    if (shakeT > 0) shakeT = Math.max(0, shakeT - dt);
    if (over) return;

    if (clearing) {
      clearTimer -= dt;
      if (clearTimer <= 0) finishClear();
      return;
    }

    /* Horizontal movement with its own DAS. */
    var stepsL = dasL.step(Input.down('left'), dt);
    var stepsR = dasR.step(Input.down('right'), dt);
    var i;
    for (i = 0; i < stepsL; i++) if (tryMove(-1, 0) && grounded) lockTimer = 0;
    for (i = 0; i < stepsR; i++) if (tryMove(1, 0) && grounded) lockTimer = 0;
    if (stepsL || stepsR) Audio2.sfx('move');

    if (Input.hit('up')) tryRotate(1);
    if (Input.hit('alt')) doHold();
    if (Input.hit('confirm')) { hardDrop(); return; }

    /* Soft drop. */
    var soft = dasD.step(Input.down('down'), dt);
    for (i = 0; i < soft; i++) {
      if (tryMove(0, 1)) { score += 1; dropTimer = 0; }
    }

    /* Gravity. */
    dropTimer += dt;
    var g = gravityMs();
    while (dropTimer >= g) {
      dropTimer -= g;
      if (!tryMove(0, 1)) break;
    }

    /* Lock delay: 500ms of grace once the piece is resting. */
    grounded = collides(cur.type, cur.rot, cur.x, cur.y + 1);
    if (grounded) {
      lockTimer += dt;
      if (lockTimer >= 500) lockPiece();
    } else {
      lockTimer = 0;
    }
  }

  /* ------------------------------------------------------------ draw --- */

  function drawCell(c, col, row, type, mode) {
    if (row < 0) return;
    tile(c, BX + col * CELL, BY + row * CELL, CELL,
      PIECE_COL[NAMES[type]][0], PIECE_COL[NAMES[type]][1], mode);
  }

  function drawWell(c) {
    /* Well backing and column guides. */
    panel(c, BX - 6, BY - 6, COLS * CELL + 12, ROWS * CELL + 12, {
      fill: 'rgba(8,6,18,0.55)', stroke: rgba(ACCENT.tetris, 0.22), radius: 12,
    });
    c.globalAlpha = 0.06;
    c.strokeStyle = COL.a2;
    c.lineWidth = 1;
    for (var x = 1; x < COLS; x++) {
      c.beginPath();
      c.moveTo(BX + x * CELL, BY);
      c.lineTo(BX + x * CELL, BY + ROWS * CELL);
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  function drawMini(c, type, cx, cy, size) {
    var cs = cells(type, 0);
    var minX = 9, maxX = -9, minY = 9, maxY = -9;
    for (var i = 0; i < cs.length; i++) {
      minX = Math.min(minX, cs[i][0]); maxX = Math.max(maxX, cs[i][0]);
      minY = Math.min(minY, cs[i][1]); maxY = Math.max(maxY, cs[i][1]);
    }
    var w = (maxX - minX + 1) * size, h = (maxY - minY + 1) * size;
    var x0 = cx - w / 2 - minX * size;
    var y0 = cy - h / 2 - minY * size;
    for (var j = 0; j < cs.length; j++) {
      tile(c, x0 + cs[j][0] * size, y0 + cs[j][1] * size, size,
        PIECE_COL[NAMES[type]][0], PIECE_COL[NAMES[type]][1], 'solid');
    }
  }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.tetris);
    gHud(ACCENT.tetris, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'LINES', value: pad(lines, 3) },
      { label: 'LEVEL', value: pad(level, 2) },
    ]);

    c.save();
    if (shakeT > 0) {
      var k = shakeT / 140;
      c.translate(0, Math.sin(shakeT * 0.9) * 3 * k);
    }

    drawWell(c);

    /* Settled blocks. */
    for (var r = 0; r < ROWS; r++) {
      var flashing = false;
      if (clearing) {
        for (var q = 0; q < clearing.length; q++) if (clearing[q] === r) flashing = true;
      }
      for (var col = 0; col < COLS; col++) {
        var v = grid[idx(col, r)];
        if (v === 0) continue;
        drawCell(c, col, r, v - 1, flashing ? 'flash' : 'solid');
      }
    }

    if (!over && !clearing) {
      /* Ghost, then the live piece on top. */
      var gy = ghostY();
      var cs = cells(cur.type, cur.rot);
      var i;
      for (i = 0; i < cs.length; i++) {
        drawCell(c, cur.x + cs[i][0], gy + cs[i][1], cur.type, 'ghost');
      }
      for (i = 0; i < cs.length; i++) {
        drawCell(c, cur.x + cs[i][0], cur.y + cs[i][1], cur.type, 'glow');
      }
    }

    particles.draw(c);
    c.restore();

    /* Side panel: next queue and hold. */
    var py = BY - 6;
    text(c, 'NEXT', PANEL_X + PANEL_W / 2, py + 20, {
      size: 12, track: 2.6, color: COL.text2, align: 'center',
    });
    for (var n = 0; n < nextQueue.length && n < 3; n++) {
      var by = py + 40 + n * 78;
      panel(c, PANEL_X, by, PANEL_W, 68, {
        fill: 'rgba(12,9,26,0.5)', stroke: COL.cardLine, radius: 12,
      });
      drawMini(c, nextQueue[n], PANEL_X + PANEL_W / 2, by + 34, 15);
    }

    var hy = py + 40 + 3 * 78 + 24;
    text(c, 'HOLD', PANEL_X + PANEL_W / 2, hy - 10, {
      size: 12, track: 2.6, color: COL.text2, align: 'center',
    });
    panel(c, PANEL_X, hy, PANEL_W, 68, {
      fill: 'rgba(12,9,26,0.5)',
      stroke: holdUsed ? 'rgba(140,150,255,.06)' : COL.cardLine,
      radius: 12,
    });
    if (holdType >= 0) {
      c.globalAlpha = holdUsed ? 0.35 : 1;
      drawMini(c, holdType, PANEL_X + PANEL_W / 2, hy + 34, 15);
      c.globalAlpha = 1;
    }
  }

  /* --------------------------------------------------------- preview --- */

  /* A short scripted loop: a piece falls into a partial stack and locks. */
  var PREV_STACK = [
    [0, 0, 1, 1, 0, 0],
    [0, 1, 1, 1, 1, 0],
    [1, 1, 1, 0, 1, 1],
  ];

  function preview(c, w, h, t) {
    var cols = 6;
    var s = Math.min(w / (cols + 1.2), h / 7.2);
    var ox = (w - cols * s) / 2;
    var oy = h - PREV_STACK.length * s - s * 0.5;

    for (var r = 0; r < PREV_STACK.length; r++) {
      for (var col = 0; col < cols; col++) {
        if (!PREV_STACK[r][col]) continue;
        var type = (col + r) % 7;
        tile(c, ox + col * s, oy + r * s, s,
          PIECE_COL[NAMES[type]][0], PIECE_COL[NAMES[type]][1], 'solid');
      }
    }

    /* Falling T piece on a 2.4s loop. */
    var loop = (t % 2400) / 2400;
    var fall = Math.min(1, loop / 0.78);
    var fy = lerp(-s * 1.5, oy - 2 * s, fall);
    var cs = SHAPES.T[0];
    var landed = fall >= 1;
    for (var i = 0; i < cs.length; i++) {
      tile(c, ox + (cs[i][0] + 1.5) * s, fy + cs[i][1] * s, s,
        PIECE_COL.T[0], PIECE_COL.T[1], landed ? 'flash' : 'glow');
    }
  }

  return registerGame({
    id: 'tetris',
    title: 'TETRIS',
    tag: 'Stack, clear, survive the climb',
    accent: ACCENT.tetris,
    hint: 'UP rotate · A hard drop · X hold',
    start: start,
    update: update,
    draw: draw,
    preview: preview,
    /* Exposed for the versus mode, which reuses this engine's rules. */
    _internals: {
      COLS: COLS, ROWS: ROWS, NAMES: NAMES, SHAPES: SHAPES, KICKS: KICKS,
    },
  });
})();
