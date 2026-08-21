/*
 * ASCENT — vertical shoot-'em-up. The screen scrolls down past you as you
 * climb; waves descend to meet you.
 *
 * Everything that moves lives in a fixed pool. update() and draw() perform no
 * allocation at all, which is what keeps frame times flat on a Pi 4 instead of
 * sawtoothing around GC pauses.
 *
 * Controls: d-pad to fly, confirm to fire (hold for auto), pause to pause.
 */

var ASCENT = (function () {
  var PAD = 16;
  var TOP = HUD_H + 8;
  var BOT = GH - 16;
  var LEFT = PAD, RIGHT = GW - PAD;

  var SHIP_R = 15;
  var SPEED = 0.42;         /* px per ms */
  var FIRE_MS = 155;
  var BULLET_SPD = 0.92;

  var ship = { x: GW / 2, y: BOT - 90, inv: 0 };
  var lives = 3, score = 0, wave = 1, over = false;
  var fireTimer = 0, spawnTimer = 0, waveTimer = 0;
  var shakeT = 0;

  var bullets = makePool(function () {
    return { alive: false, x: 0, y: 0, vy: 0, vx: 0 };
  }, 48);

  var foes = makePool(function () {
    return { alive: false, x: 0, y: 0, vx: 0, vy: 0, hp: 1, kind: 0, t: 0, r: 16, seed: 0 };
  }, 36);

  var stars = makePool(function () {
    return { alive: false, x: 0, y: 0, v: 0, s: 1 };
  }, 60);

  var particles = makeParticles(96);

  var KINDS = [
    /* 0 drifter: sine weave, 1hp  */ { hp: 1, r: 17, vy: 0.10, score: 100, col: '#F0645E' },
    /* 1 diver:   straight, fast   */ { hp: 1, r: 14, vy: 0.26, score: 150, col: '#F0C64E' },
    /* 2 tank:    slow, 3hp        */ { hp: 3, r: 24, vy: 0.06, score: 400, col: '#A46BF0' },
  ];

  function seedStars() {
    stars.clear();
    for (var i = 0; i < stars.capacity; i++) {
      var s = stars.spawn();
      if (!s) break;
      s.x = rndRange(LEFT, RIGHT);
      s.y = rndRange(TOP, BOT);
      s.v = rndRange(0.04, 0.20);
      s.s = s.v > 0.14 ? 2 : 1;
    }
  }

  function start() {
    ship.x = GW / 2; ship.y = BOT - 90; ship.inv = 0;
    lives = 3; score = 0; wave = 1; over = false;
    fireTimer = 0; spawnTimer = 600; waveTimer = 0; shakeT = 0;
    bullets.clear();
    foes.clear();
    particles.clear();
    seedStars();
  }

  function fire() {
    var b = bullets.spawn();
    if (!b) return;
    b.x = ship.x; b.y = ship.y - SHIP_R - 2;
    b.vy = -BULLET_SPD; b.vx = 0;
    Audio2.tone({ freq: 900, freq2: 1400, dur: 0.045, type: 'square', gain: 0.06 });
  }

  function spawnFoe() {
    var f = foes.spawn();
    if (!f) return;
    /* Tanks only appear from wave 3; divers from wave 2. */
    var maxKind = wave >= 3 ? 3 : wave >= 2 ? 2 : 1;
    var k = rndInt(0, maxKind - 1);
    var def = KINDS[k];
    f.kind = k;
    f.hp = def.hp;
    f.r = def.r;
    f.x = rndRange(LEFT + def.r, RIGHT - def.r);
    f.y = TOP - def.r - 10;
    f.vy = def.vy * (1 + (wave - 1) * 0.10);
    f.vx = (k === 0) ? rndRange(-0.06, 0.06) : 0;
    f.t = 0;
    f.seed = rnd() * 6.283;
  }

  function killFoe(f) {
    var def = KINDS[f.kind];
    f.alive = false;
    score += def.score;
    particles.burst(f.x, f.y, 12, def.col, { speed: 0.28, life: 460, size: 5 });
    Audio2.sfx('hit');
    Input.rumble(0.15, 0.2, 40);
  }

  function hitShip() {
    if (ship.inv > 0 || over) return;
    lives--;
    ship.inv = 1600;
    shakeT = 260;
    particles.burst(ship.x, ship.y, 22, ACCENT.ascent, { speed: 0.36, life: 620, size: 6 });
    Audio2.sfx('over');
    Input.rumble(0.9, 0.7, 260);
    if (lives <= 0) {
      over = true;
      Shell.gameOver(score);
    }
  }

  function update(dt) {
    particles.update(dt, 0.0002);
    if (shakeT > 0) shakeT = Math.max(0, shakeT - dt);

    /* Starfield runs even after death so the screen never freezes. */
    stars.forEach(function (s) {
      s.y += s.v * dt;
      if (s.y > BOT) { s.y = TOP; s.x = rndRange(LEFT, RIGHT); }
    });

    if (over) return;

    if (ship.inv > 0) ship.inv = Math.max(0, ship.inv - dt);

    /* Flight. */
    var dx = (Input.down('right') ? 1 : 0) - (Input.down('left') ? 1 : 0);
    var dy = (Input.down('down') ? 1 : 0) - (Input.down('up') ? 1 : 0);
    if (dx && dy) { dx *= 0.7071; dy *= 0.7071; }
    ship.x = clamp(ship.x + dx * SPEED * dt, LEFT + SHIP_R, RIGHT - SHIP_R);
    ship.y = clamp(ship.y + dy * SPEED * dt, TOP + SHIP_R + 40, BOT - SHIP_R);

    /* Firing. */
    fireTimer -= dt;
    if (Input.down('confirm') && fireTimer <= 0) {
      fire();
      fireTimer = FIRE_MS;
    }

    /* Wave pacing. */
    waveTimer += dt;
    if (waveTimer > 18000) {
      waveTimer = 0; wave++;
      Audio2.sfx('powerup');
      Input.rumble(0.3, 0.3, 90);
    }
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnFoe();
      spawnTimer = Math.max(260, 900 - wave * 55) * rndRange(0.7, 1.3);
    }

    /* Bullets. */
    bullets.forEach(function (b) {
      b.y += b.vy * dt;
      b.x += b.vx * dt;
      if (b.y < TOP - 20 || b.y > BOT + 20) b.alive = false;
    });

    /* Foes, and bullet/ship collisions. */
    foes.forEach(function (f) {
      f.t += dt;
      f.y += f.vy * dt;
      if (f.kind === 0) {
        f.x += Math.sin(f.t * 0.0022 + f.seed) * 0.13 * dt * 0.5 + f.vx * dt;
        f.x = clamp(f.x, LEFT + f.r, RIGHT - f.r);
      }
      if (f.y > BOT + f.r) { f.alive = false; return; }

      bullets.forEach(function (b) {
        if (!b.alive || !f.alive) return;
        var ddx = b.x - f.x, ddy = b.y - f.y;
        if (ddx * ddx + ddy * ddy < f.r * f.r) {
          b.alive = false;
          f.hp--;
          if (f.hp <= 0) killFoe(f);
          else particles.burst(b.x, b.y, 3, '#FFFFFF', { speed: 0.14, life: 200, size: 3 });
        }
      });

      if (!f.alive) return;
      var sdx = ship.x - f.x, sdy = ship.y - f.y;
      var rr = f.r + SHIP_R * 0.75;
      if (sdx * sdx + sdy * sdy < rr * rr) {
        f.alive = false;
        particles.burst(f.x, f.y, 10, KINDS[f.kind].col, { speed: 0.3, life: 400, size: 5 });
        hitShip();
      }
    });
  }

  /* ------------------------------------------------------------ draw --- */

  function drawShip(c, x, y, r, accent, thrust) {
    c.beginPath();
    c.moveTo(x, y - r);
    c.lineTo(x + r * 0.78, y + r * 0.82);
    c.lineTo(x, y + r * 0.44);
    c.lineTo(x - r * 0.78, y + r * 0.82);
    c.closePath();
    var g = c.createLinearGradient(x, y - r, x, y + r);
    g.addColorStop(0, shade(accent, 0.5));
    g.addColorStop(1, accent);
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = rgba(shade(accent, 0.6), 0.7);
    c.lineWidth = 1.5;
    c.stroke();
    if (thrust) {
      c.globalAlpha = 0.8;
      c.fillStyle = '#F0C64E';
      c.beginPath();
      c.moveTo(x - r * 0.26, y + r * 0.6);
      c.lineTo(x, y + r * (0.9 + thrust * 0.7));
      c.lineTo(x + r * 0.26, y + r * 0.6);
      c.closePath();
      c.fill();
      c.globalAlpha = 1;
    }
  }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.ascent);
    gHud(ACCENT.ascent, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'WAVE', value: pad(wave, 2) },
      { label: 'SHIPS', value: String(Math.max(0, lives)), color: lives <= 1 ? COL.bad : COL.data },
    ]);

    c.save();
    if (shakeT > 0) {
      var k = shakeT / 260;
      c.translate(Math.sin(shakeT * 1.1) * 5 * k, Math.cos(shakeT * 0.9) * 4 * k);
    }

    /* Clip so debris never escapes the play frame. */
    c.save();
    roundRect(c, PAD - 8, TOP - 8, GW - (PAD - 8) * 2, BOT - TOP + 16, COL.radius);
    c.clip();

    stars.forEach(function (s) {
      c.globalAlpha = s.s === 2 ? 0.55 : 0.28;
      c.fillStyle = s.s === 2 ? COL.a1 : COL.text2;
      c.fillRect(s.x, s.y, s.s, s.s * 2);
    });
    c.globalAlpha = 1;

    bullets.forEach(function (b) {
      Render.glow(c, b.x, b.y, 10, ACCENT.ascent, 0.7);
      c.fillStyle = '#EFEDFF';
      c.fillRect(b.x - 1.5, b.y - 8, 3, 12);
    });

    foes.forEach(function (f) {
      var def = KINDS[f.kind];
      Render.glow(c, f.x, f.y, f.r * 1.6, def.col, 0.5);
      if (f.kind === 2) {
        tile(c, f.x - f.r, f.y - f.r, f.r * 2, def.col, shade(def.col, 0.35), 'solid');
        c.fillStyle = rgba('#07050E', 0.6);
        c.fillRect(f.x - f.r * 0.5, f.y - 3, f.r * (f.hp / 3), 6);
      } else {
        drawShip(c, f.x, f.y + f.r, f.r, def.col, 0);
      }
    });

    particles.draw(c);

    if (!over) {
      var blink = ship.inv > 0 && (Math.floor(ship.inv / 90) % 2 === 0);
      if (!blink) {
        Render.glow(c, ship.x, ship.y, SHIP_R * 2.6, ACCENT.ascent, 0.6);
        drawShip(c, ship.x, ship.y, SHIP_R, ACCENT.ascent,
          Input.down('up') ? 1 : 0.45);
      }
    }

    c.restore();
    c.restore();
  }

  /* --------------------------------------------------------- preview --- */

  function preview(c, w, h, t) {
    var cx = w / 2 + Math.sin(t * 0.0016) * w * 0.22;
    var sy = h * 0.74;
    var r = Math.min(w, h) * 0.11;

    /* two descending foes on staggered loops */
    for (var i = 0; i < 2; i++) {
      var ph = ((t * 0.00035) + i * 0.5) % 1;
      var fx = w * (0.3 + i * 0.4);
      var fy = lerp(-r, h * 0.62, ph);
      var col = KINDS[i].col;
      Render.glow(c, fx, fy, r * 1.6, col, 0.5);
      drawShip(c, fx, fy + r, r * 0.8, col, 0);
    }

    /* bullet stream */
    for (var b = 0; b < 3; b++) {
      var by = sy - r - ((t * 0.35 + b * 46) % (h * 0.62));
      c.globalAlpha = 0.9;
      c.fillStyle = '#EFEDFF';
      c.fillRect(cx - 1.5, by, 3, 10);
    }
    c.globalAlpha = 1;

    Render.glow(c, cx, sy, r * 2.4, ACCENT.ascent, 0.6);
    drawShip(c, cx, sy, r, ACCENT.ascent, 0.6 + Math.sin(t * 0.02) * 0.25);
  }

  return registerGame({
    id: 'ascent',
    title: 'ASCENT',
    tag: 'Fly the gauntlet, climb the waves',
    accent: ACCENT.ascent,
    hint: 'D-PAD FLY · {A} FIRE',
    /** Attract-mode pilot: line up on the nearest foe, sidestep close ones. */
    demo: function () {
      var out = { confirm: true };
      if (over) return out;
      var target = null, bestY = -1e9;
      var threat = null;
      foes.forEach(function (f) {
        if (f.y > bestY) { bestY = f.y; target = f; }
        /* Anything nearly on top of us takes priority. */
        if (f.y > ship.y - 190 && Math.abs(f.x - ship.x) < 46) threat = f;
      });
      if (threat) {
        if (threat.x > ship.x) out.left = true; else out.right = true;
        return out;
      }
      if (target) {
        if (target.x < ship.x - 8) out.left = true;
        else if (target.x > ship.x + 8) out.right = true;
      }
      return out;
    },

    start: start,
    update: update,
    draw: draw,
    preview: preview,
  });
})();
