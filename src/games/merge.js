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

  /* Board state: exponents, 0 = empty (1 -> "2", 2 -> "4", ...). */
  var grid = [];
  var score = 0, bestTile = 0, over = false, won = false;
  var moves = 0;

  /* One animation batch per slide: sprites lerp from->to while the logical
   * grid already holds the result. p runs 0..1 over SLIDE_MS. */
  var anim = null;   /* { sprites: [{v, fr, fc, tr, tc, merged}], t } */
  var popT = 0;      /* pop timer for the cells in popCells */
  var popCells = null; /* {cellIndex: true} — spawned + freshly fused tiles */
  var pending = null;  /* direction pressed mid-slide, applied at its end */
  var particles = makeParticles(48);

  function idx(r, c) { return r * N + c; }

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
    /* BEST TILE counts what is on the board, not only what has merged —
     * a directly spawned 4 counts too. */
    if (grid[at] > bestTile) bestTile = grid[at];
    popCells = popCells || {};
    popCells[at] = true;
    popT = 140;
  }

  function start() {
    grid = [];
    for (var i = 0; i < N * N; i++) grid[i] = 0;
    score = 0; bestTile = 0; over = false; won = false; moves = 0;
    anim = null; popT = 0; popCells = null; pending = null;
    particles.clear();
    spawn();
    spawn();
  }

  /**
   * Slide one line (as indices into grid, front first). Returns the moved
   * sprites and gained score; mutates grid. Classic rules: each tile merges
   * at most once per move.
   */
  function slideLine(cells, sprites, rcOf) {
    var vals = [];
    var from = [];
    var i, v;
    for (i = 0; i < N; i++) {
      v = grid[cells[i]];
      if (v !== 0) { vals.push(v); from.push(i); }
    }
    var out = [];
    var gained = 0;
    var biggest = 0;
    var moved = false;
    var write = 0;
    for (i = 0; i < vals.length; i++) {
      if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
        var nv = vals[i] + 1;
        out.push(nv);
        gained += Math.pow(2, nv);
        if (nv > biggest) biggest = nv;
        if (nv > bestTile) bestTile = nv;
        sprites.push({ v: vals[i], f: rcOf(cells[from[i]]), t: rcOf(cells[write]), merged: true });
        sprites.push({ v: vals[i], f: rcOf(cells[from[i + 1]]), t: rcOf(cells[write]), merged: true });
        moved = true;
        i++;
      } else {
        out.push(vals[i]);
        sprites.push({ v: vals[i], f: rcOf(cells[from[i]]), t: rcOf(cells[write]), merged: false });
        if (from[i] !== write) moved = true;
      }
      write++;
    }
    for (i = 0; i < N; i++) grid[cells[i]] = i < out.length ? out[i] : 0;
    return { moved: moved, gained: gained, biggest: biggest };
  }

  /** Build the four lines for a direction, front of the slide first. */
  function linesFor(dir) {
    var lines = [];
    var r, c, line;
    for (var k = 0; k < N; k++) {
      line = [];
      for (var j = 0; j < N; j++) {
        if (dir === 'left') { r = k; c = j; }
        else if (dir === 'right') { r = k; c = N - 1 - j; }
        else if (dir === 'up') { r = j; c = k; }
        else { r = N - 1 - j; c = k; }
        line.push(idx(r, c));
      }
      lines.push(line);
    }
    return lines;
  }

  function rcOf(i) { return { r: Math.floor(i / N), c: i % N }; }

  function move(dir) {
    if (over || anim) return false;
    var sprites = [];
    var movedAny = false;
    var gained = 0;
    var biggest = 0;
    var lines = linesFor(dir);
    for (var l = 0; l < lines.length; l++) {
      var res = slideLine(lines[l], sprites, rcOf);
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
    if (!won && bestTile >= 11) {
      /* 2048 reached: celebrate, keep playing. */
      won = true;
      Audio2.sfx('clear', 4);
      Input.rumble(0.5, 0.6, 260);
      particles.burst(GW / 2, Y0 + BOARD / 2, 24, ACCENT.merge,
        { speed: 0.3, life: 640, size: 5 });
    }
    return true;
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
      if (Input.hit('left')) pending = 'left';
      else if (Input.hit('right')) pending = 'right';
      else if (Input.hit('up')) pending = 'up';
      else if (Input.hit('down')) pending = 'down';

      if (anim.t >= SLIDE_MS) {
        /* Freshly fused tiles pop on landing, together with the spawn. */
        popCells = {};
        for (var i = 0; i < anim.sprites.length; i++) {
          var sp = anim.sprites[i];
          if (sp.merged) popCells[idx(sp.t.r, sp.t.c)] = true;
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

    if (Input.hit('left')) move('left');
    else if (Input.hit('right')) move('right');
    else if (Input.hit('up')) move('up');
    else if (Input.hit('down')) move('down');
  }

  /* ------------------------------------------------------------ draw --- */

  function faceOf(v) {
    return PIECE_COL[RAMP[((v - 1) % RAMP.length + RAMP.length) % RAMP.length]];
  }

  function cellXY(r, c) {
    return {
      x: X0 + GAP + c * (CELL + GAP),
      y: Y0 + GAP + r * (CELL + GAP),
    };
  }

  function drawTile(c2, r, c, v, scale) {
    var p = cellXY(r, c);
    drawTileAt(c2, p.x, p.y, v, scale);
  }

  function drawTileAt(c2, x, y, v, scale) {
    var s = CELL * (scale || 1);
    var off = (CELL - s) / 2;
    var col = faceOf(v);
    tile(c2, x + off, y + off, s, col[0], col[1], 'solid');
    var label = String(Math.pow(2, v));
    /* Bigger numbers, smaller type. */
    var size = label.length <= 2 ? 44 : label.length === 3 ? 36 : 28;
    dataText(c2, label, x + CELL / 2, y + CELL / 2 + size * 0.36, {
      size: size * (scale || 1), align: 'center', color: COL.bgBot,
    });
  }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.merge);
    gHud(ACCENT.merge, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'BEST TILE', value: bestTile ? String(Math.pow(2, bestTile)) : '-' },
      { label: 'MOVES', value: pad(moves, 3) },
    ]);

    panel(c, X0, Y0, BOARD, BOARD, {
      fill: 'rgba(8,6,18,0.55)', stroke: rgba(ACCENT.merge, 0.35), radius: 14,
    });

    /* Empty wells. */
    var r, col;
    for (r = 0; r < N; r++) {
      for (col = 0; col < N; col++) {
        var p = cellXY(r, col);
        panel(c, p.x, p.y, CELL, CELL, {
          fill: 'rgba(140,150,255,.05)', stroke: 'rgba(140,150,255,.06)', radius: 10,
        });
      }
    }

    if (anim) {
      var t = clamp(anim.t / SLIDE_MS, 0, 1);
      /* Ease-out so the slide lands rather than stops. */
      var e = 1 - (1 - t) * (1 - t);
      for (var i = 0; i < anim.sprites.length; i++) {
        var s = anim.sprites[i];
        var f = cellXY(s.f.r, s.f.c);
        var to = cellXY(s.t.r, s.t.c);
        drawTileAt(c, lerp(f.x, to.x, e), lerp(f.y, to.y, e), s.v, 1);
      }
    } else {
      for (r = 0; r < N; r++) {
        for (col = 0; col < N; col++) {
          var v = grid[idx(r, col)];
          if (v === 0) continue;
          /* Only the spawned and freshly fused tiles pop — the rest of the
           * board holds still. */
          var pops = popT > 0 && popCells && popCells[idx(r, col)];
          drawTile(c, r, col, v, pops ? 1 - (popT / 140) * 0.18 : 1);
        }
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
      dataText(c, String(Math.pow(2, v)), x + s / 2, y + s / 2 + s * 0.13, {
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

  /** Would this direction change the board? Pure check, no mutation. */
  function wouldMove(dir) {
    var lines = linesFor(dir);
    for (var l = 0; l < lines.length; l++) {
      var seenGap = false;
      var prev = 0;
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
})();
