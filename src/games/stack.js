/*
 * STACK — the tower builder. A slab sweeps across the top of the tower; drop
 * it, and whatever hangs over the edge is sheared off. Miss entirely and the
 * tower is done.
 *
 * Portrait is the whole point: the tower grows straight up the panel and the
 * camera pans down to follow it.
 *
 * Controls: confirm to drop. That is the entire game.
 */

var STACK = (function () {
  var ROW_H = 34;
  var CUR_Y = 470;            /* the sweeping slab sits here, always */
  var LEFT = 40, RIGHT = GW - 40;
  var START_W = 300;
  var VISIBLE = Math.ceil((GH - HUD_H) / ROW_H) + 2;

  /* Palette cycles through the tetromino stops so the tower reads as a ramp. */
  var RAMP = ['I', 'S', 'O', 'L', 'Z', 'T', 'J'];

  var rows = [];              /* [{x, w, k}] bottom-first */
  var cur = { x: 0, w: START_W, dir: 1, speed: 0.26, k: 0 };
  var offset = 0;             /* camera easing after a placement */
  var score = 0, streak = 0, best = 0, over = false;
  var flashRow = -1, flashT = 0;
  var shards = makePool(function () {
    return { alive: false, x: 0, y: 0, w: 0, vx: 0, vy: 0, life: 0, max: 1, k: 0 };
  }, 16);
  var particles = makeParticles(48);

  function colOf(k) {
    var name = RAMP[((k % RAMP.length) + RAMP.length) % RAMP.length];
    return PIECE_COL[name];
  }

  function speedFor(n) {
    return Math.min(0.62, 0.26 + n * 0.011);
  }

  function start() {
    rows.length = 0;
    rows.push({ x: (GW - START_W) / 2, w: START_W, k: 0 });
    cur.w = START_W;
    cur.k = 1;
    cur.dir = 1;
    cur.speed = speedFor(0);
    cur.x = LEFT;
    offset = 0;
    score = 0; streak = 0; over = false;
    flashRow = -1; flashT = 0;
    shards.clear();
    particles.clear();
  }

  function rowY(i) {
    /* Row i sits one row below the sweeping slab for each row above it. */
    return CUR_Y + (rows.length - i) * ROW_H + offset;
  }

  function place() {
    if (over) return;
    var below = rows[rows.length - 1];
    var l = Math.max(cur.x, below.x);
    var r = Math.min(cur.x + cur.w, below.x + below.w);
    var w = r - l;

    if (w <= 0) {
      over = true;
      Audio2.sfx('over');
      Input.rumble(0.9, 0.7, 300);
      /* The whole slab falls away. */
      shed(cur.x, cur.w, cur.k, 0);
      Shell.gameOver(score);
      return;
    }

    var perfect = Math.abs(cur.x - below.x) <= 2.5 && Math.abs(cur.w - w) <= 2.5;
    if (perfect) {
      streak++;
      /* Reward a clean stack by giving a little width back. */
      w = Math.min(below.w + 6, START_W);
      l = below.x - (w - below.w) / 2;
      score += 10 + streak * 5;
      Audio2.sfx('powerup');
      Input.rumble(0.25, 0.5, 90);
      particles.burst(l + w / 2, CUR_Y + ROW_H / 2, 14, COL.a1,
        { speed: 0.24, life: 480, size: 4 });
    } else {
      streak = 0;
      score += 10;
      Audio2.sfx('lock');
      Input.rumble(0.3, 0.2, 60);
      /* Shear the overhang and let it tumble. */
      if (cur.x < l) shed(cur.x, l - cur.x, cur.k, -1);
      if (cur.x + cur.w > r) shed(r, cur.x + cur.w - r, cur.k, 1);
    }

    rows.push({ x: l, w: w, k: cur.k });
    if (rows.length > 400) rows.shift();
    flashRow = rows.length - 1;
    flashT = 160;

    cur.k++;
    cur.w = w;
    cur.speed = speedFor(rows.length);
    cur.dir = (rnd() < 0.5) ? 1 : -1;
    cur.x = cur.dir > 0 ? LEFT : RIGHT - cur.w;
    offset = -ROW_H;
    if (score > best) best = score;
  }

  function shed(x, w, k, dir) {
    var s = shards.spawn();
    if (!s) return;
    s.x = x; s.y = CUR_Y; s.w = w; s.k = k;
    s.vx = dir * 0.12;
    s.vy = -0.05;
    s.max = 900; s.life = 900;
  }

  function update(dt) {
    particles.update(dt, 0.0004);
    offset = approach(offset, 0, 12, dt);
    if (flashT > 0) flashT = Math.max(0, flashT - dt);

    shards.forEach(function (s) {
      s.life -= dt;
      if (s.life <= 0) { s.alive = false; return; }
      s.vy += 0.0022 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    });

    if (over) return;

    /* Sweep, bouncing off the walls. */
    cur.x += cur.dir * cur.speed * dt;
    if (cur.x <= LEFT) { cur.x = LEFT; cur.dir = 1; }
    if (cur.x + cur.w >= RIGHT) { cur.x = RIGHT - cur.w; cur.dir = -1; }

    if (Input.hit('confirm') || Input.hit('down')) place();
  }

  /* ------------------------------------------------------------ draw --- */

  function drawSlabRow(c, x, y, w, k, mode) {
    var col = colOf(k);
    slab(c, x, y, w, ROW_H - 3, col[0], col[1], mode);
  }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.stack);
    gHud(ACCENT.stack, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'HEIGHT', value: pad(rows.length - 1, 3) },
      { label: 'STREAK', value: pad(streak, 2), color: streak > 0 ? COL.a1 : COL.data },
    ]);

    c.save();
    roundRect(c, 8, HUD_H - 4, GW - 16, GH - HUD_H - 4, COL.radius);
    c.clip();

    /* Only the rows that can actually be seen. */
    var first = Math.max(0, rows.length - VISIBLE);
    for (var i = first; i < rows.length; i++) {
      var r = rows[i];
      var y = rowY(i);
      if (y > GH + ROW_H || y < HUD_H - ROW_H * 2) continue;
      drawSlabRow(c, r.x, y, r.w, r.k, (i === flashRow && flashT > 0) ? 'flash' : 'solid');
    }

    shards.forEach(function (s) {
      var a = clamp(s.life / s.max, 0, 1);
      c.globalAlpha = a;
      drawSlabRow(c, s.x, s.y, s.w, s.k, 'solid');
      c.globalAlpha = 1;
    });

    particles.draw(c);

    if (!over) {
      drawSlabRow(c, cur.x, CUR_Y + offset, cur.w, cur.k, 'glow');
      /* Drop guide down to the tower. */
      c.globalAlpha = 0.16;
      c.strokeStyle = ACCENT.stack;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(cur.x + cur.w / 2, CUR_Y + ROW_H);
      c.lineTo(cur.x + cur.w / 2, rowY(rows.length - 1));
      c.stroke();
      c.globalAlpha = 1;
    }

    c.restore();
  }

  /* --------------------------------------------------------- preview --- */

  function preview(c, w, h, t) {
    var rh = h / 7;
    var baseW = w * 0.62;
    /* four settled rows, each slightly narrower */
    for (var i = 0; i < 4; i++) {
      var rw = baseW - i * w * 0.06;
      var col = colOf(i);
      slab(c, (w - rw) / 2 + Math.sin(i * 1.3) * w * 0.03, h - (i + 1) * rh, rw, rh - 3,
        col[0], col[1], 'solid');
    }
    /* sweeping slab on a 2s ping-pong */
    var ph = (t % 2000) / 2000;
    var tri = ph < 0.5 ? ph * 2 : (1 - ph) * 2;
    var sw = baseW - 4 * w * 0.06;
    var sx2 = lerp(w * 0.06, w - sw - w * 0.06, tri);
    var scol = colOf(4);
    slab(c, sx2, h - 5.6 * rh, sw, rh - 3, scol[0], scol[1], 'glow');
  }

  return registerGame({
    id: 'stack',
    title: 'STACK',
    tag: 'Time the drop, build the tower',
    accent: ACCENT.stack,
    hint: '{A} DROP THE SLAB',
    /** Attract-mode pilot: drop when the slab lines up with the row below. */
    demo: function () {
      var out = {};
      if (over || !rows.length) return out;
      var below = rows[rows.length - 1];
      var slabMid = cur.x + cur.w / 2;
      var belowMid = below.x + below.w / 2;
      /* A little slack so it shaves the tower rather than playing perfectly. */
      if (Math.abs(slabMid - belowMid) < 6) out.confirm = true;
      return out;
    },

    start: start,
    update: update,
    draw: draw,
    preview: preview,
  });
})();
