/*
 * MINES — Minesweeper for the cabinet, made into an endless run. Clear every
 * safe cell without uncovering a mine; a number says how many of a cell's
 * eight neighbours are mined. Clear the board and a bigger, denser one loads
 * and your score climbs. Uncover a mine and the run ends.
 *
 * The first reveal is always safe — mines are laid after it, never under it
 * or its neighbours — so no run dies on the opening move.
 *
 * Controls: the d-pad moves the cursor, confirm uncovers, the flag button
 * (or back) plants or lifts a flag over a suspected mine.
 */

var MINES = (function () {
  var COLS = 10, ROWS = 13;
  var CELL = 54, GAP = 2;
  var BW = COLS * CELL + (COLS - 1) * GAP;
  var BH = ROWS * CELL + (ROWS - 1) * GAP;
  var BX = (GW - BW) / 2;
  var BY = HUD_H + 40;

  /* Number colours, one distinct existing token per count 1..8. */
  var NUMCOL = [null, COL.a1, COL.good, COL.bad, COL.a2, COL.warn, COL.a3, COL.data, COL.text];

  /* Cell arrays, row-major. */
  var mine, shown, flag, near;
  var placed = false;         /* mines laid yet? (after the first reveal) */
  var cur = { r: 6, c: 5 };
  var score = 0, board = 1, cleared = 0, mineCount = 0, flags = 0;
  var over = false, won = false, revealAll = false;
  var winT = 0, buf = 0;
  var particles = makeParticles(56);

  var dasL = makeRepeater(200, 90), dasR = makeRepeater(200, 90);
  var dasU = makeRepeater(200, 90), dasD = makeRepeater(200, 90);
  var demoBeat = 0;

  function idx(r, c) { return r * COLS + c; }
  function inb(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }

  function minesForBoard(b) {
    /* ~15% climbing toward ~26%, capped so a board is always solvable-ish. */
    var frac = Math.min(0.26, 0.15 + (b - 1) * 0.02);
    return Math.round(COLS * ROWS * frac);
  }

  function newBoard() {
    var n = COLS * ROWS;
    mine = new Uint8Array(n);
    shown = new Uint8Array(n);
    flag = new Uint8Array(n);
    near = new Int8Array(n);
    placed = false;
    cleared = 0; flags = 0;
    won = false; revealAll = false; winT = 0;
    mineCount = minesForBoard(board);
    cur.r = (ROWS / 2) | 0;
    cur.c = (COLS / 2) | 0;
  }

  function start() {
    score = 0; board = 1; over = false; buf = 0;
    particles.clear();
    newBoard();
  }

  /** Lay mines after the first reveal, keeping the opening cell and its ring
   * clear so the first move always opens something. */
  function place(safeR, safeC) {
    var forbidden = Object.create(null);
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        var rr = safeR + dr, cc = safeC + dc;
        if (inb(rr, cc)) forbidden[idx(rr, cc)] = true;
      }
    }
    var spots = [];
    for (var i = 0; i < COLS * ROWS; i++) if (!forbidden[i]) spots.push(i);
    /* Fisher-Yates, take the first mineCount. */
    for (var s = spots.length - 1; s > 0; s--) {
      var j = rndInt(0, s);
      var tmp = spots[s]; spots[s] = spots[j]; spots[j] = tmp;
    }
    var lay = Math.min(mineCount, spots.length);
    mineCount = lay;
    for (var m = 0; m < lay; m++) mine[spots[m]] = 1;

    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        if (mine[idx(r, c)]) { near[idx(r, c)] = -1; continue; }
        var k = 0;
        for (var a = -1; a <= 1; a++) {
          for (var b = -1; b <= 1; b++) {
            if (a === 0 && b === 0) continue;
            if (inb(r + a, c + b) && mine[idx(r + a, c + b)]) k++;
          }
        }
        near[idx(r, c)] = k;
      }
    }
    placed = true;
  }

  /** Flood-reveal from (r,c); zero cells open their neighbours. Iterative so
   * a big open region can never blow the stack. */
  function reveal(r, c) {
    var stack = [idx(r, c)];
    while (stack.length) {
      var i = stack.pop();
      if (shown[i] || flag[i]) continue;
      shown[i] = 1;
      cleared++;
      if (near[i] === 0) {
        var cr = (i / COLS) | 0, cc = i % COLS;
        for (var a = -1; a <= 1; a++) {
          for (var b = -1; b <= 1; b++) {
            if (a === 0 && b === 0) continue;
            if (inb(cr + a, cc + b)) stack.push(idx(cr + a, cc + b));
          }
        }
      }
    }
  }

  function dig(r, c) {
    var i = idx(r, c);
    if (flag[i] || shown[i]) return;
    if (!placed) place(r, c);
    if (mine[i]) {
      shown[i] = 1;
      over = true; revealAll = true;
      Audio2.sfx('over');
      Input.rumble(0.9, 0.7, 360);
      particles.burst(cellX(c) + CELL / 2, cellY(r) + CELL / 2, 24, COL.bad,
        { speed: 0.34, life: 620, size: 5 });
      Shell.gameOver(score);
      return;
    }
    reveal(r, c);
    score += 2;
    Audio2.sfx('move');
    if (cleared >= COLS * ROWS - mineCount) {
      won = true; winT = 900;
      score += 100 * board;
      Audio2.sfx('clear', 3);
      Input.rumble(0.4, 0.5, 200);
      particles.burst(GW / 2, BY + BH / 2, 26, ACCENT.mines,
        { speed: 0.3, life: 640, size: 5 });
    }
  }

  function toggleFlag(r, c) {
    var i = idx(r, c);
    if (shown[i]) return;
    flag[i] = flag[i] ? 0 : 1;
    flags += flag[i] ? 1 : -1;
    Audio2.sfx(flag[i] ? 'select' : 'back');
  }

  function update(dt) {
    particles.update(dt, 0.0003);

    if (winT > 0) {
      winT -= dt;
      if (winT <= 0) { board++; newBoard(); }
      return;
    }
    if (over) return;

    var i;
    for (i = dasL.step(Input.down('left'), dt); i > 0; i--) cur.c = (cur.c + COLS - 1) % COLS;
    for (i = dasR.step(Input.down('right'), dt); i > 0; i--) cur.c = (cur.c + 1) % COLS;
    for (i = dasU.step(Input.down('up'), dt); i > 0; i--) cur.r = (cur.r + ROWS - 1) % ROWS;
    for (i = dasD.step(Input.down('down'), dt); i > 0; i--) cur.r = (cur.r + 1) % ROWS;

    if (Input.hit('confirm')) dig(cur.r, cur.c);
    if (Input.hit('alt') || Input.hit('back')) toggleFlag(cur.r, cur.c);
  }

  /* ------------------------------------------------------------ draw --- */

  function cellX(c) { return BX + c * (CELL + GAP); }
  function cellY(r) { return BY + r * (CELL + GAP); }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.mines);
    gHud(ACCENT.mines, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'BOARD', value: pad(board, 2) },
      { label: 'MINES', value: pad(Math.max(0, mineCount - flags), 3) },
    ]);

    for (var r = 0; r < ROWS; r++) {
      for (var col = 0; col < COLS; col++) {
        var i = idx(r, col);
        var x = cellX(col), y = cellY(r);
        var isCur = (r === cur.r && col === cur.c && !over);

        if (shown[i] || (revealAll && mine[i])) {
          /* Revealed well. */
          panel(c, x, y, CELL, CELL, {
            fill: mine[i] ? 'rgba(240,100,94,.30)' : 'rgba(10,8,20,.55)',
            stroke: 'rgba(140,150,255,.08)', radius: 6,
          });
          if (mine[i]) {
            c.fillStyle = COL.bad;
            c.beginPath();
            c.arc(x + CELL / 2, y + CELL / 2, CELL * 0.22, 0, Math.PI * 2);
            c.fill();
          } else if (near[i] > 0) {
            dataText(c, String(near[i]), x + CELL / 2, y + CELL / 2 + CELL * 0.2, {
              size: CELL * 0.5, align: 'center', color: NUMCOL[near[i]] || COL.text,
            });
          }
        } else {
          /* Covered cap. */
          tile(c, x, y, CELL, '#3A3568', '#4E4886', isCur ? 'glow' : 'solid');
          if (flag[i]) {
            c.fillStyle = COL.warn;
            c.beginPath();
            c.moveTo(x + CELL * 0.34, y + CELL * 0.26);
            c.lineTo(x + CELL * 0.34, y + CELL * 0.74);
            c.lineTo(x + CELL * 0.38, y + CELL * 0.74);
            c.lineTo(x + CELL * 0.38, y + CELL * 0.26);
            c.closePath();
            c.fill();
            c.beginPath();
            c.moveTo(x + CELL * 0.38, y + CELL * 0.28);
            c.lineTo(x + CELL * 0.64, y + CELL * 0.37);
            c.lineTo(x + CELL * 0.38, y + CELL * 0.46);
            c.closePath();
            c.fill();
          }
        }

        if (isCur) {
          c.strokeStyle = rgba(ACCENT.mines, 0.95);
          c.lineWidth = 3;
          roundRect(c, x + 1, y + 1, CELL - 2, CELL - 2, 6);
          c.stroke();
        }
      }
    }

    particles.draw(c);

    if (won && winT > 0) {
      text(c, 'BOARD CLEAR', GW / 2, BY + BH + 40, {
        size: 24, weight: '700', track: 6, color: COL.a1, align: 'center',
      });
    }
  }

  /* --------------------------------------------------------- preview --- */

  function preview(c, w, h, t) {
    var n = 5;
    var s = Math.min(w, h) / (n + 0.6);
    var ox = (w - n * s) / 2;
    var oy = (h - n * s) / 2;
    /* A tidy little field: a couple of numbers, a flag, the rest capped, with
     * the cursor sweeping across on a loop. */
    var nums = { '11': 1, '13': 2, '22': 3, '31': 1 };
    var flagCell = '24';
    var sweep = Math.floor(t / 260) % (n * n);
    for (var r = 0; r < n; r++) {
      for (var col = 0; col < n; col++) {
        var x = ox + col * s, y = oy + r * s;
        var key = '' + r + col;
        if (nums[key] !== undefined) {
          panel(c, x + 1, y + 1, s - 2, s - 2, {
            fill: 'rgba(10,8,20,.55)', stroke: 'rgba(140,150,255,.08)', radius: s * 0.12,
          });
          dataText(c, String(nums[key]), x + s / 2, y + s / 2 + s * 0.2, {
            size: s * 0.5, align: 'center', color: NUMCOL[nums[key]],
          });
        } else {
          tile(c, x + 1, y + 1, s - 2, '#3A3568', '#4E4886', 'solid');
          if (key === flagCell) {
            c.fillStyle = COL.warn;
            c.fillRect(x + s * 0.44, y + s * 0.28, s * 0.05, s * 0.44);
            c.beginPath();
            c.moveTo(x + s * 0.49, y + s * 0.3);
            c.lineTo(x + s * 0.68, y + s * 0.37);
            c.lineTo(x + s * 0.49, y + s * 0.44);
            c.closePath();
            c.fill();
          }
        }
        if (r * n + col === sweep) {
          c.strokeStyle = rgba(ACCENT.mines, 0.95);
          c.lineWidth = 2;
          roundRect(c, x + 2, y + 2, s - 4, s - 4, s * 0.1);
          c.stroke();
        }
      }
    }
  }

  /* Pick the cursor's next move toward a chosen cell, pulsed for the demo. */
  function stepToward(tr, tc) {
    if (cur.r !== tr) return cur.r < tr ? 'down' : 'up';
    if (cur.c !== tc) return cur.c < tc ? 'right' : 'left';
    return null;
  }

  return registerGame({
    id: 'mines',
    title: 'MINES',
    tag: 'Clear the field, flag the bombs',
    accent: ACCENT.mines,
    hint: '✚ MOVE · {A} DIG · {X} FLAG',
    /**
     * Attract-mode pilot: a demo may see the board. It walks to the nearest
     * safe covered cell and digs, opening the field without ever hitting a
     * mine. Pulsed on alternate frames so each press is a fresh edge.
     */
    demo: function () {
      var out = {};
      if (over || winT > 0) return out;
      demoBeat++;
      if (demoBeat % 2 === 0) return out;

      /* Nearest safe, still-covered, unflagged cell (Manhattan). */
      var best = -1, bestD = 1e9, br = 0, bc = 0;
      for (var r = 0; r < ROWS; r++) {
        for (var c = 0; c < COLS; c++) {
          var i = idx(r, c);
          if (shown[i] || flag[i]) continue;
          if (placed && mine[i]) continue;   /* the demo knows; avoid it */
          var d = Math.abs(r - cur.r) + Math.abs(c - cur.c);
          if (d < bestD) { bestD = d; best = i; br = r; bc = c; }
        }
      }
      if (best < 0) return out;
      var mv = stepToward(br, bc);
      if (mv) { out[mv] = true; return out; }
      out.confirm = true;
      return out;
    },

    start: start,
    update: update,
    draw: draw,
    preview: preview,
    _test: {
      dims: function () { return { COLS: COLS, ROWS: ROWS }; },
      dig: function (r, c) { dig(r, c); },
      flag: function (r, c) { toggleFlag(r, c); },
      isShown: function (r, c) { return !!shown[idx(r, c)]; },
      isFlag: function (r, c) { return !!flag[idx(r, c)]; },
      isMine: function (r, c) { return !!mine[idx(r, c)]; },
      near: function (r, c) { return near[idx(r, c)]; },
      placed: function () { return placed; },
      mineCount: function () { return mineCount; },
      cleared: function () { return cleared; },
      score: function () { return score; },
      board: function () { return board; },
      over: function () { return over; },
      won: function () { return won; },
      /* Force a deterministic mine layout for tests, then compute neighbours. */
      forceMines: function (cells) {
        for (var i = 0; i < COLS * ROWS; i++) mine[i] = 0;
        for (var k = 0; k < cells.length; k++) mine[idx(cells[k][0], cells[k][1])] = 1;
        mineCount = cells.length;
        for (var r = 0; r < ROWS; r++) {
          for (var c = 0; c < COLS; c++) {
            if (mine[idx(r, c)]) { near[idx(r, c)] = -1; continue; }
            var n = 0;
            for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) {
              if ((a || b) && inb(r + a, c + b) && mine[idx(r + a, c + b)]) n++;
            }
            near[idx(r, c)] = n;
          }
        }
        placed = true;
      },
    },
  });
})();
