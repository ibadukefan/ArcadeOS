/*
 * DROP — Columns-style match-3. A vertical triple of gems falls; land it so
 * three or more of a colour line up in any direction, including diagonals.
 * Clears collapse and can cascade.
 *
 * Deliberately built on the same bones as TETRIS: an Int8Array well, the same
 * cell arithmetic, and tile() for every gem, so the two games look like they
 * came out of the same machine — because they did.
 *
 * Controls:
 *   left/right  move       up / confirm  cycle the gems within the piece
 *   down        soft drop  alt           hard drop
 */

var DROP = (function () {
  var COLS = 7, ROWS = 13;
  var CELL = 64;
  var BX = Math.round((GW - COLS * CELL) / 2);   /* 76 */
  var BY = HUD_H + 18;                           /* 110 */

  /* Six gem colours, reusing the tetromino stops. */
  var GEMS = ['I', 'S', 'O', 'L', 'Z', 'T'];
  var PIECE_LEN = 3;
  var MATCH_MIN = 3;

  /* Every direction a run can form: right, down, and both diagonals. */
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  var grid = new Int8Array(COLS * ROWS);         /* 0 empty, else gem+1 */
  var marked = new Uint8Array(COLS * ROWS);

  var piece = { col: 0, row: 0, gems: [0, 0, 0] };
  var nextGems = [0, 0, 0];

  var score = 0, cleared = 0, level = 1, chain = 0;
  var over = false;
  var dropTimer = 0, settleTimer = 0;
  var phase = 'fall';        /* fall | resolve | collapse */
  var flashT = 0;
  var shakeT = 0;
  var dasL = makeRepeater(170, 60);
  var dasR = makeRepeater(170, 60);
  var dasD = makeRepeater(70, 45);
  var particles = makeParticles(96);

  function idx(c, r) { return r * COLS + c; }
  function gemCol(g) { return PIECE_COL[GEMS[g % GEMS.length]]; }

  function rollGems(out) {
    for (var i = 0; i < PIECE_LEN; i++) {
      /* Early levels use four colours; six by level five. Ramping the palette
       * rather than the speed is what keeps this game readable. */
      var palette = Math.min(GEMS.length, 4 + Math.floor((level - 1) / 2));
      out[i] = rndInt(0, palette - 1);
    }
    return out;
  }

  function spawn() {
    piece.col = COLS >> 1;
    piece.row = 0;
    piece.gems[0] = nextGems[0];
    piece.gems[1] = nextGems[1];
    piece.gems[2] = nextGems[2];
    rollGems(nextGems);
    dropTimer = 0;
    phase = 'fall';

    /* Top-out: the spawn column is already occupied at the landing height. */
    for (var i = 0; i < PIECE_LEN; i++) {
      var r = piece.row - i;
      if (r >= 0 && grid[idx(piece.col, r)] !== 0) { topOut(); return; }
    }
    if (grid[idx(piece.col, 0)] !== 0) topOut();
  }

  function topOut() {
    if (over) return;
    over = true;
    Audio2.sfx('over');
    Input.rumble(0.8, 0.6, 340);
    Shell.gameOver(score);
  }

  /** The piece occupies (col, row), (col, row-1), (col, row-2). */
  function canBeAt(col, row) {
    if (col < 0 || col >= COLS) return false;
    if (row >= ROWS) return false;
    for (var i = 0; i < PIECE_LEN; i++) {
      var r = row - i;
      if (r < 0) continue;
      if (grid[idx(col, r)] !== 0) return false;
    }
    return true;
  }

  function cycleGems() {
    var last = piece.gems[PIECE_LEN - 1];
    for (var i = PIECE_LEN - 1; i > 0; i--) piece.gems[i] = piece.gems[i - 1];
    piece.gems[0] = last;
    Audio2.sfx('rotate');
  }

  function lockPiece() {
    for (var i = 0; i < PIECE_LEN; i++) {
      var r = piece.row - i;
      if (r < 0) { topOut(); return; }
      grid[idx(piece.col, r)] = piece.gems[i] + 1;
    }
    Audio2.sfx('lock');
    chain = 0;
    phase = 'resolve';
    settleTimer = 0;
  }

  /**
   * Mark every run of MATCH_MIN or more. Returns how many cells were marked.
   * Scans each direction once from every cell — O(cells * 4), which at 91
   * cells is nothing, and far easier to reason about than a flood fill.
   */
  function findMatches() {
    marked.fill(0);
    var count = 0;

    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var v = grid[idx(c, r)];
        if (v === 0) continue;
        for (var d = 0; d < DIRS.length; d++) {
          var dx = DIRS[d][0], dy = DIRS[d][1];
          /* Only start a run at its beginning, so each is found once. */
          var pc = c - dx, pr = r - dy;
          if (pc >= 0 && pc < COLS && pr >= 0 && pr < ROWS && grid[idx(pc, pr)] === v) continue;

          var len = 1;
          var nc = c + dx, nr = r + dy;
          while (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS && grid[idx(nc, nr)] === v) {
            len++; nc += dx; nr += dy;
          }
          if (len >= MATCH_MIN) {
            for (var k = 0; k < len; k++) {
              var mi = idx(c + dx * k, r + dy * k);
              if (!marked[mi]) { marked[mi] = 1; count++; }
            }
          }
        }
      }
    }
    return count;
  }

  function clearMarked(n) {
    chain++;
    /* Chain bonus is the whole strategy: a cascade is worth far more than the
     * same gems cleared one run at a time. */
    var base = n * 30;
    var bonus = Math.pow(2, chain - 1);
    score += Math.floor(base * bonus * level);
    cleared += n;
    level = 1 + Math.floor(cleared / 24);

    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var i = idx(c, r);
        if (!marked[i]) continue;
        var col = gemCol(grid[i] - 1)[0];
        particles.burst(BX + c * CELL + CELL / 2, BY + r * CELL + CELL / 2,
          5, col, { speed: 0.24, life: 460, size: 5 });
        grid[i] = 0;
      }
    }

    Audio2.sfx('clear', Math.min(4, chain));
    Input.rumble(0.4 + chain * 0.1, 0.3, 120 + chain * 40);
    flashT = 200;
    if (chain > 1) shakeT = 180;
  }

  /** Settle gems downward. Returns true if anything moved. */
  function collapse() {
    var moved = false;
    for (var c = 0; c < COLS; c++) {
      var write = ROWS - 1;
      for (var r = ROWS - 1; r >= 0; r--) {
        var v = grid[idx(c, r)];
        if (v === 0) continue;
        if (write !== r) {
          grid[idx(c, write)] = v;
          grid[idx(c, r)] = 0;
          moved = true;
        }
        write--;
      }
    }
    return moved;
  }

  function gravityMs() { return Math.max(120, 700 - (level - 1) * 55); }

  /* -------------------------------------------------------- lifecycle --- */

  function start() {
    grid = new Int8Array(COLS * ROWS);
    marked = new Uint8Array(COLS * ROWS);
    score = 0; cleared = 0; level = 1; chain = 0;
    over = false;
    dropTimer = 0; settleTimer = 0;
    phase = 'fall';
    flashT = 0; shakeT = 0;
    dasL.reset(); dasR.reset(); dasD.reset();
    particles.clear();
    rollGems(nextGems);
    spawn();
  }

  function update(dt) {
    particles.update(dt, 0.0005);
    if (flashT > 0) flashT = Math.max(0, flashT - dt);
    if (shakeT > 0) shakeT = Math.max(0, shakeT - dt);
    if (over) return;

    if (phase === 'resolve') {
      /* A short beat between landing and clearing so the player can see what
       * they built before it disappears. */
      settleTimer += dt;
      if (settleTimer < 140) return;
      settleTimer = 0;
      var n = findMatches();
      if (n > 0) { clearMarked(n); phase = 'collapse'; }
      else { spawn(); }
      return;
    }

    if (phase === 'collapse') {
      settleTimer += dt;
      if (settleTimer < 160) return;
      settleTimer = 0;
      collapse();
      phase = 'resolve';
      return;
    }

    /* --- falling ---------------------------------------------------- */
    var i;
    var stepsL = dasL.step(Input.down('left'), dt);
    var stepsR = dasR.step(Input.down('right'), dt);
    for (i = 0; i < stepsL; i++) {
      if (canBeAt(piece.col - 1, piece.row)) { piece.col--; Audio2.sfx('move'); }
    }
    for (i = 0; i < stepsR; i++) {
      if (canBeAt(piece.col + 1, piece.row)) { piece.col++; Audio2.sfx('move'); }
    }

    if (Input.hit('up') || Input.hit('confirm')) cycleGems();

    if (Input.hit('alt')) {
      /* Hard drop. */
      var target = piece.row;
      while (canBeAt(piece.col, target + 1)) target++;
      score += (target - piece.row) * 2;
      piece.row = target;
      Audio2.sfx('drop');
      shakeT = 110;
      lockPiece();
      return;
    }

    var soft = dasD.step(Input.down('down'), dt);
    for (i = 0; i < soft; i++) {
      if (canBeAt(piece.col, piece.row + 1)) { piece.row++; score += 1; dropTimer = 0; }
    }

    dropTimer += dt;
    var g = gravityMs();
    var guard = 0;
    while (dropTimer >= g && guard < 6) {
      dropTimer -= g;
      guard++;
      if (canBeAt(piece.col, piece.row + 1)) piece.row++;
      else { lockPiece(); return; }
    }
    if (!canBeAt(piece.col, piece.row + 1) && dropTimer > g * 0.9) lockPiece();
  }

  /* ------------------------------------------------------------ draw --- */

  function drawWell(c) {
    panel(c, BX - 8, BY - 8, COLS * CELL + 16, ROWS * CELL + 16, {
      fill: 'rgba(8,6,18,0.55)', stroke: rgba(ACCENT.drop, 0.22), radius: 12,
    });
    c.globalAlpha = 0.05;
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

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.drop);
    gHud(ACCENT.drop, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'GEMS', value: pad(cleared, 3) },
      { label: 'LEVEL', value: pad(level, 2) },
    ]);

    c.save();
    if (shakeT > 0) {
      var k = shakeT / 180;
      c.translate(Math.sin(shakeT * 1.1) * 4 * k, 0);
    }

    drawWell(c);

    /* Settled gems. */
    for (var r = 0; r < ROWS; r++) {
      for (var col = 0; col < COLS; col++) {
        var i = idx(col, r);
        var v = grid[i];
        if (v === 0) continue;
        var gc = gemCol(v - 1);
        tile(c, BX + col * CELL, BY + r * CELL, CELL, gc[0], gc[1],
          (marked[i] && phase === 'collapse') ? 'flash' : 'solid');
      }
    }

    /* Falling piece, plus a landing shadow so the drop is predictable. */
    if (!over && phase === 'fall') {
      var target = piece.row;
      while (canBeAt(piece.col, target + 1)) target++;
      var g;
      for (var s = 0; s < PIECE_LEN; s++) {
        var gr = target - s;
        if (gr < 0) continue;
        g = gemCol(piece.gems[s]);
        tile(c, BX + piece.col * CELL, BY + gr * CELL, CELL, g[0], g[1], 'ghost');
      }
      for (var p = 0; p < PIECE_LEN; p++) {
        var pr = piece.row - p;
        if (pr < 0) continue;
        g = gemCol(piece.gems[p]);
        tile(c, BX + piece.col * CELL, BY + pr * CELL, CELL, g[0], g[1], 'glow');
      }
    }

    particles.draw(c);
    c.restore();

    /* Next piece, and the live chain multiplier. */
    var nx = GW - 66, ny = BY - 4;
    text(c, 'NEXT', nx, ny - 8, {
      size: 11, track: 2, color: COL.text2, align: 'center',
    });
    for (var n = 0; n < PIECE_LEN; n++) {
      var ng = gemCol(nextGems[n]);
      tile(c, nx - 16, ny + n * 32, 32, ng[0], ng[1], 'solid');
    }

    if (chain > 1 && flashT > 0) {
      c.globalAlpha = clamp(flashT / 200, 0, 1);
      text(c, chain + 'x CHAIN', GW / 2, GH / 2, {
        size: 40, weight: '700', track: 5, color: COL.a1,
        align: 'center', baseline: 'middle',
      });
      c.globalAlpha = 1;
    }
  }

  /* --------------------------------------------------------- preview --- */

  /* A small settled field with a matching run flashing on a loop. */
  var PREV = [
    [0, 1, 2, 0, 1],
    [1, 2, 0, 1, 2],
    [2, 2, 2, 0, 1],
  ];

  function preview(c, w, h, t) {
    var cols = 5;
    var s = Math.min(w / (cols + 0.6), h / 6);
    var ox = (w - cols * s) / 2;
    var oy = h - PREV.length * s - s * 0.3;
    var loop = (t % 2200) / 2200;

    for (var r = 0; r < PREV.length; r++) {
      for (var cc = 0; cc < cols; cc++) {
        var g = gemCol(PREV[r][cc]);
        /* The bottom-left run of three flashes as it "matches". */
        var isRun = (r === 2 && cc < 3);
        var mode = (isRun && loop > 0.72) ? 'flash' : 'solid';
        tile(c, ox + cc * s, oy + r * s, s, g[0], g[1], mode);
      }
    }

    /* Falling triple. */
    var fall = Math.min(1, loop / 0.66);
    var fy = lerp(-s * 3, oy - 3 * s, fall);
    for (var p = 0; p < 3; p++) {
      var pg = gemCol((p + 1) % 3);
      tile(c, ox + 3 * s, fy + p * s, s, pg[0], pg[1], 'glow');
    }
  }

  return registerGame({
    id: 'drop',
    title: 'DROP',
    tag: 'Match three, chain the cascade',
    accent: ACCENT.drop,
    hint: '◀▶ MOVE · ▼ DROP · {A} CYCLE · {X} SLAM',
    /** Attract-mode pilot: aim for the shallowest column and drop. */
    demo: function () {
      var out = {};
      if (over || phase !== 'fall') return out;
      var bestCol = 0, bestDepth = -1;
      for (var c = 0; c < COLS; c++) {
        var depth = ROWS;
        for (var r = 0; r < ROWS; r++) {
          if (grid[idx(c, r)] !== 0) { depth = r; break; }
        }
        if (depth > bestDepth) { bestDepth = depth; bestCol = c; }
      }
      if (piece.col < bestCol) out.right = true;
      else if (piece.col > bestCol) out.left = true;
      else out.alt = true;
      return out;
    },

    start: start,
    update: update,
    draw: draw,
    preview: preview,
    /* Test seam: the diagonal matcher is the easiest thing here to get
     * subtly wrong, so the harness drives it directly. */
    _test: {
      COLS: COLS, ROWS: ROWS,
      clear: function () { grid.fill(0); marked.fill(0); },
      set: function (c, r, gem) { grid[idx(c, r)] = gem + 1; },
      get: function (c, r) { return grid[idx(c, r)] - 1; },
      findMatches: findMatches,
      marked: function (c, r) { return !!marked[idx(c, r)]; },
      collapse: collapse,
      score: function () { return score; },
    },
  });
})();
