/*
 * FLAP — the one-button flier. Gravity never stops; every press beats the
 * wings once. Thread the gaps between the towers and don't touch anything.
 * The staple of every offline-games collection, tuned arcade-fair: the first
 * gaps are generous and the squeeze comes on slowly.
 *
 * Controls: confirm (or up) to flap. That is the whole game.
 */

var FLAP = (function () {
  var BIRD_X = 170;
  var R = 16;                 /* bird radius */
  var GRAV = 0.0022;          /* px/ms^2 */
  var IMPULSE = -0.72;        /* px/ms on flap */
  var VMAX = 0.95;            /* terminal fall */
  var TOWER_W = 92;
  var SPACING = 400;          /* px between tower pairs */
  var TOP = HUD_H + 6, BOT = GH - 14;

  var y = 0, vy = 0;
  var ready = true;           /* hover until the first flap */
  var towers = [];            /* [{x, gapY, gapH, passed}] scrolling left */
  var dist = 0;
  var score = 0, over = false;
  var wobble = 0;
  var particles = makeParticles(48);

  function gapFor(n) {
    /* Generous early, tightening to a floor. */
    return Math.max(210, 300 - n * 6);
  }

  function speed() {
    return Math.min(0.34, 0.24 + score * 0.004);
  }

  function pushTower(x) {
    var gapH = gapFor(towers.length + score);
    var margin = 90;
    var gy = rndInt(TOP + margin + gapH / 2, BOT - margin - gapH / 2);
    towers.push({ x: x, gapY: gy, gapH: gapH, passed: false });
  }

  function start() {
    y = (TOP + BOT) / 2;
    vy = 0;
    ready = true;
    towers.length = 0;
    dist = 0;
    score = 0; over = false; wobble = 0;
    particles.clear();
    /* First pair well away, then the regular cadence. */
    pushTower(GW + 260);
    pushTower(GW + 260 + SPACING);
    pushTower(GW + 260 + SPACING * 2);
  }

  function flap() {
    if (over) return;
    ready = false;
    vy = IMPULSE;
    wobble = 160;
    Audio2.sfx('select');
    Input.rumble(0.12, 0.2, 30);
  }

  function die() {
    if (over) return;
    over = true;
    Audio2.sfx('over');
    Input.rumble(0.85, 0.65, 340);
    particles.burst(BIRD_X, y, 20, ACCENT.flap, { speed: 0.32, life: 560, size: 5 });
    Shell.gameOver(score);
  }

  function update(dt) {
    particles.update(dt, 0.0004);
    if (wobble > 0) wobble = Math.max(0, wobble - dt);
    if (over) return;

    if (Input.hit('confirm') || Input.hit('up')) flap();

    if (ready) {
      /* Gentle hover until the player commits. */
      y = (TOP + BOT) / 2 + Math.sin(dist * 0.02) * 14;
      dist += dt * 0.2;
      return;
    }

    vy = Math.min(VMAX, vy + GRAV * dt);
    y += vy * dt;

    /* The frame is part of the course. */
    if (y - R <= TOP || y + R >= BOT) { die(); return; }

    var v = speed() * dt;
    for (var i = 0; i < towers.length; i++) {
      var tw = towers[i];
      tw.x -= v;

      if (!tw.passed && tw.x + TOWER_W < BIRD_X - R) {
        tw.passed = true;
        score++;
        Audio2.sfx('clear', 1);
        Input.rumble(0.15, 0.25, 45);
      }

      /* Collision: bird circle vs the two tower rectangles. */
      if (tw.x < BIRD_X + R && tw.x + TOWER_W > BIRD_X - R) {
        var gapTop = tw.gapY - tw.gapH / 2;
        var gapBot = tw.gapY + tw.gapH / 2;
        if (y - R < gapTop || y + R > gapBot) { die(); return; }
      }
    }

    /* Recycle: keep three pairs in flight. */
    if (towers.length && towers[0].x + TOWER_W < -40) {
      towers.shift();
      pushTower(towers[towers.length - 1].x + SPACING);
    }
  }

  /* ------------------------------------------------------------ draw --- */

  function drawTowerPair(c, tw) {
    var gapTop = tw.gapY - tw.gapH / 2;
    var gapBot = tw.gapY + tw.gapH / 2;
    var col = PIECE_COL.I;
    slab(c, tw.x, TOP, TOWER_W, gapTop - TOP, col[0], col[1], 'solid');
    slab(c, tw.x, gapBot, TOWER_W, BOT - gapBot, col[0], col[1], 'solid');
    /* Lips on the gap, like pipe caps. */
    var lip = 10;
    slab(c, tw.x - 6, gapTop - lip, TOWER_W + 12, lip, col[0], col[1], 'solid');
    slab(c, tw.x - 6, gapBot, TOWER_W + 12, lip, col[0], col[1], 'solid');
  }

  function drawBird(c, bx, by, radius, t) {
    Render.glow(c, bx, by, radius * 3.4, ACCENT.flap, 0.5);
    c.fillStyle = ACCENT.flap;
    c.beginPath();
    c.arc(bx, by, radius, 0, Math.PI * 2);
    c.fill();
    /* Wing: a flick that follows the flap. */
    var k = wobble > 0 ? wobble / 160 : 0;
    c.fillStyle = COL.text;
    c.beginPath();
    c.ellipse(bx - radius * 0.2, by + radius * (0.1 - k * 0.5),
      radius * 0.62, radius * 0.34, -k * 0.9, 0, Math.PI * 2);
    c.fill();
    /* Eye. */
    c.fillStyle = COL.bgBot;
    c.beginPath();
    c.arc(bx + radius * 0.45, by - radius * 0.28, radius * 0.16, 0, Math.PI * 2);
    c.fill();
  }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.flap);
    gHud(ACCENT.flap, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'GAP', value: pad(Math.round(gapFor(score)), 3) },
      { label: 'SPEED', value: (speed() * 100).toFixed(0) },
    ]);

    for (var i = 0; i < towers.length; i++) drawTowerPair(c, towers[i]);
    particles.draw(c);

    if (!over) drawBird(c, BIRD_X, y, R, 0);

    if (ready) {
      text(c, 'PRESS TO FLAP', GW / 2, GH * 0.72, {
        size: 22, weight: '600', track: 6, color: COL.text2, align: 'center',
      });
    }
  }

  /* --------------------------------------------------------- preview --- */

  function preview(c, w, h, t) {
    var col = PIECE_COL.I;
    /* Two tower pairs drifting left on a loop. */
    var span = w * 0.55;
    var scroll = (t % 2600) / 2600 * span;
    for (var i = 0; i < 3; i++) {
      var x = w * 0.35 + i * span - scroll;
      if (x < -w * 0.2 || x > w * 1.1) continue;
      var gy = h * (0.38 + 0.2 * Math.sin(i * 2.1));
      var gh2 = h * 0.34;
      var tw = w * 0.13;
      slab(c, x, 0, tw, gy - gh2 / 2, col[0], col[1], 'solid');
      slab(c, x, gy + gh2 / 2, tw, h - (gy + gh2 / 2), col[0], col[1], 'solid');
    }
    /* Bobbing bird. */
    var by = h * 0.45 + Math.sin(t * 0.004) * h * 0.08;
    drawBird(c, w * 0.22, by, Math.min(w, h) * 0.07, t);
  }

  return registerGame({
    id: 'flap',
    title: 'FLAP',
    tag: 'One button, thread the towers',
    accent: ACCENT.flap,
    hint: '{A} FLAP',
    /**
     * Attract-mode pilot: aim for the centre of the next gap — flap when
     * falling below it. The margin keeps it away from the lips.
     */
    demo: function () {
      var out = {};
      if (over) return out;
      if (ready) { out.confirm = true; return out; }
      var target = (TOP + BOT) / 2;
      for (var i = 0; i < towers.length; i++) {
        if (towers[i].x + TOWER_W > BIRD_X - R) { target = towers[i].gapY; break; }
      }
      if (y > target + 6 && vy > -0.1) out.confirm = true;
      return out;
    },

    start: start,
    update: update,
    draw: draw,
    preview: preview,
    _test: {
      y: function () { return y; },
      vy: function () { return vy; },
      score: function () { return score; },
      over: function () { return over; },
      towers: function () { return towers; },
      ready: function () { return ready; },
    },
  });
})();
