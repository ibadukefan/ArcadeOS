/*
 * SNAKE — a tall 19x30 field, which changes the game: vertical runs are long
 * and horizontal ones are tight, so the classic spiral strategy has to adapt.
 *
 * Direction changes are queued rather than applied immediately. At 60ms per
 * step a player can easily press two directions inside one tick, and dropping
 * the second one is the difference between "responsive" and "it ate my input".
 *
 * Controls: d-pad to turn.
 */

var SNAKE = (function () {
  var COLS = 19, ROWS = 30, CELL = 28;
  var X0 = Math.round((GW - COLS * CELL) / 2);
  var Y0 = HUD_H + 24;

  var DIRS = {
    up: { x: 0, y: -1 }, down: { x: 0, y: 1 },
    left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
  };

  /* Body is a ring buffer of cell indices — no shift/unshift churn per tick. */
  var body = new Int16Array(COLS * ROWS);
  var head = 0, tail = 0, length = 0;
  var occupied = new Uint8Array(COLS * ROWS);

  var dir = DIRS.up, queued = [];
  var food = -1, gold = -1, goldTimer = 0;
  var stepMs = 140, acc = 0;
  /* Bumped once per grid step. The attract pilot keys its cache off this so
   * four flood fills run seven times a second, not sixty. */
  var stepSeq = 0;
  var demoSeq = -1, demoOut = {};
  var score = 0, eaten = 0, over = false;
  var eatFlash = 0;
  var particles = makeParticles(48);

  function idx(x, y) { return y * COLS + x; }
  function cx(i) { return i % COLS; }
  function cy(i) { return (i / COLS) | 0; }

  function push(i) {
    body[head] = i;
    head = (head + 1) % body.length;
    occupied[i] = 1;
    length++;
  }

  function pop() {
    var i = body[tail];
    tail = (tail + 1) % body.length;
    occupied[i] = 0;
    length--;
    return i;
  }

  function headCell() { return body[(head - 1 + body.length) % body.length]; }

  function placeFood(exclude) {
    /* Reservoir pick over free cells: uniform, and never loops forever when
     * the board is nearly full. */
    var chosen = -1, seen = 0;
    for (var i = 0; i < COLS * ROWS; i++) {
      if (occupied[i] || i === exclude) continue;
      seen++;
      if (rndInt(1, seen) === 1) chosen = i;
    }
    return chosen;
  }

  function start() {
    head = 0; tail = 0; length = 0;
    occupied = new Uint8Array(COLS * ROWS);
    queued.length = 0;
    dir = DIRS.up;
    var sx2 = (COLS >> 1), sy2 = (ROWS >> 1) + 4;
    push(idx(sx2, sy2 + 2));
    push(idx(sx2, sy2 + 1));
    push(idx(sx2, sy2));
    food = placeFood(-1);
    gold = -1; goldTimer = 9000;
    stepMs = 140; acc = 0;
    stepSeq = 0; demoSeq = -1; demoOut = {};
    score = 0; eaten = 0; over = false;
    eatFlash = 0;
    particles.clear();
  }

  function turn(name) {
    var d = DIRS[name];
    if (!d) return;
    /* Compare against the last queued direction, not the current one, so two
     * quick turns in a row both land. */
    var ref = queued.length ? queued[queued.length - 1] : dir;
    if (d.x === -ref.x && d.y === -ref.y) return;   /* no 180s */
    if (d.x === ref.x && d.y === ref.y) return;     /* no duplicates */
    if (queued.length < 2) queued.push(d);
  }

  /**
   * How many cells are reachable from `from`, capped so it stays cheap. Used
   * only by the attract pilot, to avoid sealing itself into a pocket.
   */
  var reachSeen = new Uint8Array(COLS * ROWS);
  var reachQueue = new Int16Array(COLS * ROWS);
  /* Hoisted: these were array literals inside the innermost loop, which meant
   * two allocations per neighbour per cell per fill. */
  var NX = [0, 0, -1, 1];
  var NY = [-1, 1, 0, 0];
  function freeSpaceFrom(from) {
    reachSeen.fill(0);
    var head2 = 0, tail2 = 0, count = 0;
    reachQueue[head2++] = from;
    reachSeen[from] = 1;
    var CAP = COLS * ROWS;
    while (tail2 < head2 && count < CAP) {
      var i = reachQueue[tail2++];
      count++;
      var x = cx(i), y = cy(i);
      for (var d = 0; d < 4; d++) {
        var nx = x + NX[d];
        var ny = y + NY[d];
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        var ni = idx(nx, ny);
        if (reachSeen[ni] || occupied[ni]) continue;
        reachSeen[ni] = 1;
        reachQueue[head2++] = ni;
      }
    }
    return count;
  }

  function die() {
    if (over) return;
    over = true;
    var h = headCell();
    particles.burst(X0 + cx(h) * CELL + CELL / 2, Y0 + cy(h) * CELL + CELL / 2,
      18, ACCENT.snake, { speed: 0.3, life: 600, size: 5 });
    Audio2.sfx('over');
    Input.rumble(0.8, 0.6, 320);
    Shell.gameOver(score);
  }

  function step() {
    stepSeq++;
    if (queued.length) dir = queued.shift();

    var h = headCell();
    var nx = cx(h) + dir.x;
    var ny = cy(h) + dir.y;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) { die(); return; }

    var ni = idx(nx, ny);
    var tailCell = body[tail];
    /* Moving into the tail cell is legal — it vacates on this same tick. */
    if (occupied[ni] && !(ni === tailCell && ni !== food && ni !== gold)) { die(); return; }

    var ate = (ni === food), ateGold = (ni === gold);
    if (!ate && !ateGold) pop();

    push(ni);

    if (ate) {
      eaten++;
      score += 10 + Math.floor(eaten / 5) * 5;
      food = placeFood(ni);
      stepMs = Math.max(60, 140 - eaten * 2.2);
      eatFlash = 140;
      Audio2.sfx('eat');
      particles.burst(X0 + nx * CELL + CELL / 2, Y0 + ny * CELL + CELL / 2,
        8, ACCENT.snake, { speed: 0.2, life: 340, size: 4 });
      if (food < 0) { die(); return; }   /* board full: a perfect game */
    } else if (ateGold) {
      score += 100;
      gold = -1;
      goldTimer = 12000;
      eatFlash = 220;
      Audio2.sfx('powerup');
      Input.rumble(0.4, 0.5, 120);
      particles.burst(X0 + nx * CELL + CELL / 2, Y0 + ny * CELL + CELL / 2,
        16, '#F0C64E', { speed: 0.28, life: 520, size: 5 });
    }
  }

  function update(dt) {
    particles.update(dt, 0.0003);
    if (eatFlash > 0) eatFlash = Math.max(0, eatFlash - dt);
    if (over) return;

    if (Input.hit('up')) turn('up');
    if (Input.hit('down')) turn('down');
    if (Input.hit('left')) turn('left');
    if (Input.hit('right')) turn('right');

    /* Golden apple: appears for a while, then leaves. */
    goldTimer -= dt;
    if (goldTimer <= 0) {
      if (gold >= 0) { gold = -1; goldTimer = 10000; }
      else { gold = placeFood(food); goldTimer = 5000; }
    }

    acc += dt;
    var guard = 0;
    while (acc >= stepMs && !over && guard < 6) {
      acc -= stepMs;
      guard++;
      step();
    }
    if (guard >= 6) acc = 0;
  }

  /* ------------------------------------------------------------ draw --- */

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.snake);
    gHud(ACCENT.snake, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'LENGTH', value: pad(length, 3) },
      { label: 'SPEED', value: pad(Math.round(1000 / stepMs), 2) },
    ]);

    /* Field. */
    panel(c, X0 - 8, Y0 - 8, COLS * CELL + 16, ROWS * CELL + 16, {
      fill: 'rgba(8,6,18,0.5)', stroke: rgba(ACCENT.snake, 0.20), radius: 12,
    });

    c.globalAlpha = 0.045;
    c.strokeStyle = COL.a1;
    c.lineWidth = 1;
    var i;
    for (i = 1; i < COLS; i++) {
      c.beginPath(); c.moveTo(X0 + i * CELL, Y0); c.lineTo(X0 + i * CELL, Y0 + ROWS * CELL); c.stroke();
    }
    for (i = 1; i < ROWS; i++) {
      c.beginPath(); c.moveTo(X0, Y0 + i * CELL); c.lineTo(X0 + COLS * CELL, Y0 + i * CELL); c.stroke();
    }
    c.globalAlpha = 1;

    /* Food. */
    if (food >= 0) {
      var fx = X0 + cx(food) * CELL, fy = Y0 + cy(food) * CELL;
      Render.glow(c, fx + CELL / 2, fy + CELL / 2, CELL * 1.4, '#F0645E', 0.75);
      tile(c, fx, fy, CELL, '#F0645E', '#F79E9A', 'solid');
    }
    if (gold >= 0) {
      var gxp = X0 + cx(gold) * CELL, gyp = Y0 + cy(gold) * CELL;
      var pulse = 0.6 + Math.sin(goldTimer * 0.006) * 0.3;
      Render.glow(c, gxp + CELL / 2, gyp + CELL / 2, CELL * 1.8, '#F0C64E', pulse);
      tile(c, gxp, gyp, CELL, '#F0C64E', '#F7DE93', 'solid');
    }

    /* Body, tail-to-head so the head paints last. */
    var n = length;
    for (var k = 0; k < n; k++) {
      var ci = body[(tail + k) % body.length];
      var isHead = (k === n - 1);
      var f = n > 1 ? k / (n - 1) : 1;
      var base = isHead ? shade(ACCENT.snake, 0.30) : ACCENT.snake;
      var top = isHead ? shade(ACCENT.snake, 0.62) : shade(ACCENT.snake, 0.20 + f * 0.20);
      var px = X0 + cx(ci) * CELL, py = Y0 + cy(ci) * CELL;
      if (isHead) Render.glow(c, px + CELL / 2, py + CELL / 2, CELL * 1.6, ACCENT.snake, 0.7);
      tile(c, px, py, CELL, base, top, (isHead && eatFlash > 0) ? 'flash' : 'solid');
    }

    particles.draw(c);
  }

  /* --------------------------------------------------------- preview --- */

  /* A short looping path drawn as a snake crawling around the card. */
  var PATH = [
    [1, 4], [1, 3], [1, 2], [2, 2], [3, 2], [3, 3], [3, 4], [4, 4],
    [5, 4], [5, 3], [5, 2], [5, 1],
  ];

  function preview(c, w, h, t) {
    var cols = 7, rows2 = 6;
    var s = Math.min(w / cols, h / rows2) * 0.86;
    var ox = (w - cols * s) / 2, oy = (h - rows2 * s) / 2;
    var lenS = 5;
    var headI = Math.floor((t * 0.006) % PATH.length);

    /* apple two steps ahead of the head */
    var ai = (headI + 3) % PATH.length;
    var ax = ox + PATH[ai][0] * s, ay = oy + PATH[ai][1] * s;
    Render.glow(c, ax + s / 2, ay + s / 2, s * 1.4, '#F0645E', 0.7);
    tile(c, ax, ay, s, '#F0645E', '#F79E9A', 'solid');

    for (var k = 0; k < lenS; k++) {
      var pi = (headI - (lenS - 1 - k) + PATH.length * 2) % PATH.length;
      var px = ox + PATH[pi][0] * s, py = oy + PATH[pi][1] * s;
      var isHead = (k === lenS - 1);
      if (isHead) Render.glow(c, px + s / 2, py + s / 2, s * 1.5, ACCENT.snake, 0.7);
      tile(c, px, py, s,
        isHead ? shade(ACCENT.snake, 0.3) : ACCENT.snake,
        shade(ACCENT.snake, isHead ? 0.6 : 0.25), 'solid');
    }
  }

  return registerGame({
    id: 'snake',
    title: 'SNAKE',
    tag: 'Long field, tight corners',
    accent: ACCENT.snake,
    hint: 'D-PAD TURN',
    /**
     * Attract-mode pilot.
     *
     * Survival first, food second. A purely greedy walk toward the apple
     * looks fine for a few seconds and then corners itself — it died on one
     * seed in eight at exactly the 2.8s mark, the same time the game used to
     * die with no input at all.
     *
     * So every legal move is scored by how much open space it leaves (a flood
     * fill from the new head), and the apple only breaks ties. That is enough
     * to keep it alive indefinitely without looking like a solver.
     */
    demo: function () {
      /*
       * The board only changes when the snake steps, roughly every 140ms, but
       * this is asked for a direction every frame. Four flood fills at 60Hz
       * measured 35us per call — the most expensive thing in attract mode by
       * a factor of twenty. Same answer, recomputed only when it can differ.
       */
      if (demoSeq === stepSeq) return demoOut;
      demoSeq = stepSeq;
      var out = demoOut = {};
      if (over) return out;
      var h = headCell();
      var hx = cx(h), hy = cy(h);
      var target = food >= 0 ? food : gold;
      var tx = target >= 0 ? cx(target) : hx;
      var ty = target >= 0 ? cy(target) : hy;

      var names = ['up', 'down', 'left', 'right'];
      var bestName = null, bestSpace = -1, bestDist = 1e9;

      for (var i = 0; i < names.length; i++) {
        var d = DIRS[names[i]];
        if (d.x === -dir.x && d.y === -dir.y) continue;   /* no reversing */
        var nx = hx + d.x, ny = hy + d.y;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        var ni = idx(nx, ny);
        if (occupied[ni] && ni !== body[tail]) continue;

        var space = freeSpaceFrom(ni);
        var dist = Math.abs(nx - tx) + Math.abs(ny - ty);
        /* Prefer room to move; among equally roomy moves, head for the food.
         * The tolerance keeps it from dithering over one-cell differences. */
        if (space > bestSpace + 2 ||
            (space > bestSpace - 3 && dist < bestDist)) {
          if (space > bestSpace) bestSpace = space;
          bestDist = dist;
          bestName = names[i];
        }
      }

      if (bestName) out[bestName] = true;
      return out;
    },
    start: start,
    update: update,
    draw: draw,
    preview: preview,
  });
})();
