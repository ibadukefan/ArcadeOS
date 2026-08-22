/*
 * 2048 — the sliding merge board. Four by four, every d-pad press slides the
 * whole board; equal tiles that collide fuse and double. The classic of every
 * offline-games collection, and a perfect fit for a d-pad.
 *
 * Controls: the d-pad, and nothing else.
 */

var MERGE = (function () {
  var N = 4;
  var CELL = 128, GAP = 10;
  var BOARD = N * CELL + (N + 1) * GAP;          /* 562 */
  var X0 = (GW - BOARD) / 2;
  var Y0 = HUD_H + 96;
  var SLIDE_MS = 110;

  /* Tile faces cycle the tetromino ramp by exponent, so the board reads as
   * the same moulded plastic as everything else on the cabinet. */
  var RAMP = ['I', 'S', 'O', 'L', 'Z', 'T', 'J'];

  /* Face labels ("2".."65536") by exponent, built once — draw() must never
   * allocate a string per tile per frame on a Pi. */
  var LABELS = (function () {
    var out = [''];
    for (var v = 1; v <= 16; v++) out[v] = String(Math.pow(2, v));
    return out;
  })();

  /* The cell indices each direction slides, front-of-slide first, precomputed
   * once — move() and the attract pilot both read these every frame, and the
   * mapping never changes. */
  var LINES = (function () {
    var dirs = ['left', 'right', 'up', 'down'];
    var all = {};
    for (var d = 0; d < dirs.length; d++) {
      var dir = dirs[d], lines = [];
      for (var k = 0; k < N; k++) {
        var line = [];
        for (var j = 0; j < N; j++) {
          var r, c;
          if (dir === 'left') { r = k; c = j; }
          else if (dir === 'right') { r = k; c = N - 1 - j; }
          else if (dir === 'up') { r = j; c = k; }
          else { r = N - 1 - j; c = k; }
          line.push(r * N + c);
        }
        lines.push(line);
      }
      all[dir] = lines;
    }
    return all;
  })();

  /* Board state: exponents, 0 = empty (1 -> "2", 2 -> "4", ...). */
  var grid = [];
  var score = 0, over = false, won = false;
  var moves = 0;

  /* One animation batch per slide: sprites lerp from->to (cell indices) while
   * the logical grid already holds the result. */
  var anim = null;   /* { sprites: [{v, f, t, merged}], t } */
  var popT = 0;      /* pop timer for the cells in popCells */
  var popCells = null; /* {cellIndex: true} — spawned + freshly fused tiles */
  var pending = null;  /* direction pressed mid-slide, applied at its end */
  var particles = makeParticles(48);

  function idx(r, c) { return r * N + c; }
  function cellX(i) { return X0 + GAP + (i % N) * (CELL + GAP); }
  function cellY(i) { return Y0 + GAP + Math.floor(i / N) * (CELL + GAP); }

  /** Largest exponent on the board — derived, never stored, so it can never
   * drift from the grid. */
  function maxTile() {
    var m = 0;
    for (var i = 0; i < N * N; i++) if (grid[i] > m) m = grid[i];
    return m;
  }

  function emptyCells() {
    var out = [];
    for (var i = 0; i < N * N; i++) if (grid[i] === 0) out.push(i);
    return out;
  }

  function spawn() {
    var empt = emptyCells();
    if (!empt.length) return;
    var at = empt[rndInt(0, empt.length - 1)];
    grid[at] = rnd() < 0.9 ? 1 : 2;
    popCells = popCells || {};
    popCells[at] = true;
    popT = 140;
  }

  function start() {
    grid = [];
    for (var i = 0; i < N * N; i++) grid[i] = 0;
    score = 0; over = false; won = false; moves = 0;
    anim = null; popT = 0; popCells = null; pending = null;
    particles.clear();
    spawn();
    spawn();
  }

  /** Which direction was pressed this frame, or null. */
  function dirHit() {
    if (Input.hit('left')) return 'left';
    if (Input.hit('right')) return 'right';
    if (Input.hit('up')) return 'up';
    if (Input.hit('down')) return 'down';
    return null;
  }

  /**
   * Slide one line (cell indices, front first). Pushes moved sprites, returns
   * whether it moved plus the score and largest exponent gained. Classic
   * rules: each tile merges at most once per move.
   */
  function slideLine(cells, sprites) {
    var vals = [], from = [];
    var i, v;
    for (i = 0; i < N; i++) {
      v = grid[cells[i]];
      if (v !== 0) { vals.push(v); from.push(i); }
    }
    var out = [];
    var gained = 0, biggest = 0, moved = false, write = 0;
    for (i = 0; i < vals.length; i++) {
      if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
        var nv = vals[i] + 1;
        out.push(nv);
        gained += Math.pow(2, nv);
        if (nv > biggest) biggest = nv;
        sprites.push({ v: vals[i], f: cells[from[i]], t: cells[write], merged: true });
        sprites.push({ v: vals[i], f: cells[from[i + 1]], t: cells[write], merged: true });
        moved = true;
        i++;
      } else {
        out.push(vals[i]);
        sprites.push({ v: vals[i], f: cells[from[i]], t: cells[write], merged: false });
        if (from[i] !== write) moved = true;
      }
      write++;
    }
    for (i = 0; i < N; i++) grid[cells[i]] = i < out.length ? out[i] : 0;
    return { moved: moved, gained: gained, biggest: biggest };
  }

  function move(dir) {
    if (over || anim) return false;
    var sprites = [];
    var movedAny = false, gained = 0, biggest = 0;
    var lines = LINES[dir];
    for (var l = 0; l < lines.length; l++) {
      var res = slideLine(lines[l], sprites);
      movedAny = movedAny || res.moved;
      gained += res.gained;
      if (res.biggest > biggest) biggest = res.biggest;
    }
    if (!movedAny) { Audio2.sfx('denied'); return false; }

    moves++;
    score += gained;
    anim = { sprites: sprites, t: 0 };
    if (gained > 0) {
      /* The sound tracks THIS move's largest fusion, so the escalation
       * still means something after a big tile exists. 64 and up earn
       * the powerup chime. */
      Audio2.sfx(biggest >= 6 ? 'powerup' : 'eat');
      Input.rumble(0.2, 0.3, 60);
    } else {
      Audio2.sfx('move');
    }
    if (!won && maxTile() >= 11) {
      /* 2048 reached: celebrate, keep playing. */
      won = true;
      Audio2.sfx('clear', 4);
      Input.rumble(0.5, 0.6, 260);
      particles.burst(GW / 2, Y0 + BOARD / 2, 24, ACCENT.merge,
        { speed: 0.3, life: 640, size: 5 });
    }
    return true;
  }

  /** Would this direction change the board? Pure check, no mutation — the
   * attract pilot uses it to look before it leaps. */
  function wouldMove(dir) {
    var lines = LINES[dir];
    for (var l = 0; l < lines.length; l++) {
      var seenGap = false, prev = 0;
      for (var j = 0; j < N; j++) {
        var v = grid[lines[l][j]];
        if (v === 0) { seenGap = true; continue; }
        if (seenGap) return true;          /* a tile can slide into a gap */
        if (prev !== 0 && prev === v) return true;  /* a pair can fuse */
        prev = v;
      }
    }
    return false;
  }

  function anyMove() {
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var v = grid[idx(r, c)];
        if (v === 0) return true;
        if (c + 1 < N && grid[idx(r, c + 1)] === v) return true;
        if (r + 1 < N && grid[idx(r + 1, c)] === v) return true;
      }
    }
    return false;
  }

  function update(dt) {
    particles.update(dt, 0.0003);
    if (popT > 0) popT = Math.max(0, popT - dt);

    if (anim) {
      anim.t += dt;
      /* A press mid-slide is a fast player, not a mistake: buffer it and
       * play it the instant the slide lands. Hit edges last one frame, so
       * without this a ~150ms left-right combo silently eats the second
       * press. */
      var buf = dirHit();
      if (buf) pending = buf;

      if (anim.t >= SLIDE_MS) {
        /* Freshly fused tiles pop on landing, together with the spawn. */
        popCells = {};
        for (var i = 0; i < anim.sprites.length; i++) {
          var sp = anim.sprites[i];
          if (sp.merged) popCells[sp.t] = true;
        }
        anim = null;
        spawn();
        if (!anyMove()) {
          pending = null;
          over = true;
          Audio2.sfx('over');
          Input.rumble(0.8, 0.6, 320);
          Shell.gameOver(score);
        } else if (pending) {
          var d = pending;
          pending = null;
          move(d);
        }
      }
      return;
    }
    if (over) return;

    var dir = dirHit();
    if (dir) move(dir);
  }

  /* ------------------------------------------------------------ draw --- */

  function faceOf(v) {
    return PIECE_COL[RAMP[((v - 1) % RAMP.length + RAMP.length) % RAMP.length]];
  }

  function drawTileAt(c2, x, y, v, scale) {
    var s = CELL * (scale || 1);
    var off = (CELL - s) / 2;
    var col = faceOf(v);
    tile(c2, x + off, y + off, s, col[0], col[1], 'solid');
    var label = LABELS[v] || String(Math.pow(2, v));
    /* Bigger numbers, smaller type. */
    var size = label.length <= 2 ? 44 : label.length === 3 ? 36 : 28;
    dataText(c2, label, x + CELL / 2, y + CELL / 2 + size * 0.36, {
      size: size * (scale || 1), align: 'center', color: COL.bgBot,
    });
  }

  function draw() {
    var c = gx;
    var best = maxTile();
    gBackdrop(ACCENT.merge);
    gHud(ACCENT.merge, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'BEST TILE', value: best ? LABELS[best] : '-' },
      { label: 'MOVES', value: pad(moves, 3) },
    ]);

    panel(c, X0, Y0, BOARD, BOARD, {
      fill: 'rgba(8,6,18,0.55)', stroke: rgba(ACCENT.merge, 0.35), radius: 14,
    });

    /* Empty wells. */
    var i;
    for (i = 0; i < N * N; i++) {
      panel(c, cellX(i), cellY(i), CELL, CELL, {
        fill: 'rgba(140,150,255,.05)', stroke: 'rgba(140,150,255,.06)', radius: 10,
      });
    }

    if (anim) {
      var tt = clamp(anim.t / SLIDE_MS, 0, 1);
      /* Ease-out so the slide lands rather than stops. */
      var e = 1 - (1 - tt) * (1 - tt);
      for (i = 0; i < anim.sprites.length; i++) {
        var s = anim.sprites[i];
        drawTileAt(c, lerp(cellX(s.f), cellX(s.t), e),
          lerp(cellY(s.f), cellY(s.t), e), s.v, 1);
      }
    } else {
      for (i = 0; i < N * N; i++) {
        var v = grid[i];
        if (v === 0) continue;
        /* Only the spawned and freshly fused tiles pop — the rest holds still. */
        var pops = popT > 0 && popCells && popCells[i];
        drawTileAt(c, cellX(i), cellY(i), v, pops ? 1 - (popT / 140) * 0.18 : 1);
      }
    }

    particles.draw(c);

    if (won) {
      text(c, '2048!', GW / 2, Y0 + BOARD + 64, {
        size: 24, weight: '700', track: 8, color: COL.a1, align: 'center',
      });
    }
  }

  /* --------------------------------------------------------- preview --- */

  function preview(c, w, h, t) {
    var n = 3;
    var s = Math.min(w, h) / (n + 1.2);
    var gap = s * 0.12;
    var ox = (w - n * (s + gap)) / 2;
    var oy = (h - n * (s + gap)) / 2;

    function cellAt(r2, c2) {
      return { x: ox + c2 * (s + gap), y: oy + r2 * (s + gap) };
    }
    function mini(x, y, v, scale) {
      var col = faceOf(v);
      var sz = s * (scale || 1);
      var off = (s - sz) / 2;
      tile(c, x + off, y + off, sz, col[0], col[1], 'solid');
      dataText(c, LABELS[v] || String(Math.pow(2, v)), x + s / 2, y + s / 2 + s * 0.13, {
        size: s * 0.34 * (scale || 1), align: 'center', color: COL.bgBot,
      });
    }

    /* Static corner tiles. */
    mini(cellAt(2, 0).x, cellAt(2, 0).y, 3, 1);
    mini(cellAt(2, 1).x, cellAt(2, 1).y, 2, 1);

    /* A "4" slides in from the right and fuses with its twin on a 2s loop. */
    var loop = (t % 2000) / 2000;
    var slide = clamp(loop / 0.4, 0, 1);
    var e = 1 - (1 - slide) * (1 - slide);
    var from = cellAt(2, 2), to = cellAt(2, 1);
    if (slide < 1) {
      mini(lerp(from.x, to.x, e), from.y, 2, 1);
    } else {
      var pop = loop < 0.55 ? 1.12 : 1;
      mini(to.x, to.y, 3, pop);
    }
  }

  return registerGame({
    id: 'merge',
    title: '2048',
    tag: 'Slide, fuse, double up',
    accent: ACCENT.merge,
    hint: '◀▶▲▼ SLIDE THE BOARD',
    /**
     * Attract-mode pilot: the classic corner strategy — keep the pile in a
     * corner by preferring down/left, only reaching for the other
     * directions when the board refuses to move.
     */
    demo: function () {
      var out = {};
      if (over || anim) return out;
      var prefs = ['down', 'left', 'right', 'up'];
      for (var i = 0; i < prefs.length; i++) {
        if (wouldMove(prefs[i])) { out[prefs[i]] = true; return out; }
      }
      return out;
    },

    start: start,
    update: update,
    draw: draw,
    preview: preview,
    _test: {
      grid: function () { return grid.slice(); },
      set: function (r, c, v) { grid[idx(r, c)] = v; },
      clear: function () { for (var i = 0; i < N * N; i++) grid[i] = 0; },
      move: move,
      score: function () { return score; },
      over: function () { return over; },
      moves: function () { return moves; },
      anyMove: anyMove,
      finishAnim: function () { if (anim) { anim.t = SLIDE_MS; update(0); } },
    },
  });
})();
