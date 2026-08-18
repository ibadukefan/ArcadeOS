/*
 * CLIMB — endless upward hopper. The camera rises with you and never comes
 * back down; fall off the bottom and it is over.
 *
 * Portrait is mandatory here in a way it is not for the other games: the whole
 * loop is "how far up can I see, and can I reach it", and a landscape panel
 * shows you almost no future at all.
 *
 * Controls: left/right to steer. Bouncing is automatic.
 */

var CLIMB = (function () {
  var LEFT = 20, RIGHT = GW - 20;
  var TOP = HUD_H + 8;
  var BOT = GH - 12;

  var HOP_R = 17;
  var MOVE = 0.40;            /* px per ms horizontal */
  var GRAVITY = 0.0018;       /* px per ms^2 */
  var BOUNCE = -0.86;         /* upward velocity on a normal platform */
  var SPRING = -1.35;
  var TERMINAL = 1.4;

  var PLAT_W = 108, PLAT_H = 16;
  var PLAT_GAP = 118;         /* vertical spacing target */

  /* 0 solid, 1 moving, 2 crumbling, 3 spring */
  var PLAT_COL = ['#5B7BF0', '#37E1C4', '#F0954E', '#F0C64E'];

  var hop = { x: GW / 2, y: 0, vx: 0, vy: 0, face: 1, squash: 0 };
  var camY = 0;               /* world y at the top of the view */
  var highest = 0;            /* best (most negative) world y reached */
  var spawnY = 0;
  var score = 0, over = false;
  var shakeT = 0;

  var plats = makePool(function () {
    return { alive: false, x: 0, y: 0, w: PLAT_W, kind: 0, t: 0, dir: 1, used: 0, seed: 0 };
  }, 26);
  var particles = makeParticles(64);

  /** World y -> screen y. Up is negative in world space. */
  function sy(worldY) { return worldY - camY; }

  function addPlatform(worldY, forceSolid) {
    var p = plats.spawn();
    if (!p) return null;
    var kind = 0;
    if (!forceSolid) {
      var roll = rnd();
      var height = Math.max(0, -worldY);
      /* Difficulty is a function of altitude, not time — a cautious player
       * and a fast one meet the same platforms at the same height. */
      var hard = clamp(height / 9000, 0, 1);
      if (roll < 0.06 + hard * 0.06) kind = 3;              /* spring */
      else if (roll < 0.20 + hard * 0.22) kind = 1;         /* moving */
      else if (roll < 0.30 + hard * 0.28) kind = 2;         /* crumbling */
    }
    p.kind = kind;
    p.w = kind === 3 ? PLAT_W * 0.62 : PLAT_W;
    p.x = rndRange(LEFT + 6, RIGHT - p.w - 6);
    p.y = worldY;
    p.t = 0;
    p.used = 0;
    p.dir = rnd() < 0.5 ? -1 : 1;
    p.seed = rnd() * 6.283;
    return p;
  }

  function start() {
    plats.clear();
    particles.clear();
    camY = 0;
    spawnY = 0;
    score = 0;
    over = false;
    shakeT = 0;

    /* A guaranteed solid platform under the player, then the field. */
    var base = addPlatform(BOT - 80, true);
    hop.x = base ? base.x + base.w / 2 : GW / 2;
    hop.y = (base ? base.y : BOT - 80) - HOP_R - 2;
    hop.vx = 0; hop.vy = BOUNCE; hop.face = 1; hop.squash = 0;
    /*
     * Altitude is measured from wherever the hopper actually starts. Seeding
     * this to 0 meant `hop.y < highest` was false until the player had climbed
     * ~889px, so the first three or four screens of a run scored nothing.
     */
    highest = hop.y;

    spawnY = BOT - 80;
    while (spawnY > -PLAT_GAP * 8) {
      spawnY -= rndRange(PLAT_GAP * 0.72, PLAT_GAP * 1.15);
      addPlatform(spawnY, false);
    }
  }

  function die() {
    if (over) return;
    over = true;
    Audio2.sfx('over');
    Input.rumble(0.8, 0.6, 300);
    Shell.gameOver(score);
  }

  function bounceOff(p) {
    hop.vy = (p.kind === 3) ? SPRING : BOUNCE;
    hop.squash = 1;
    if (p.kind === 3) {
      Audio2.sfx('powerup');
      Input.rumble(0.4, 0.3, 90);
      particles.burst(p.x + p.w / 2, p.y, 10, PLAT_COL[3], { speed: 0.22, life: 400, size: 4 });
    } else {
      Audio2.sfx('jump');
    }
    if (p.kind === 2) {
      /* Crumbling platforms give exactly one bounce. */
      p.used = 1;
      particles.burst(p.x + p.w / 2, p.y, 8, PLAT_COL[2], { speed: 0.2, life: 500, size: 4 });
    }
  }

  function update(dt) {
    particles.update(dt, 0.0012);
    if (shakeT > 0) shakeT = Math.max(0, shakeT - dt);
    if (over) return;

    if (hop.squash > 0) hop.squash = Math.max(0, hop.squash - dt / 180);

    /* Steering, with wrap-around at the walls — the classic affordance that
     * makes a narrow field feel generous. */
    var dx = (Input.down('right') ? 1 : 0) - (Input.down('left') ? 1 : 0);
    if (dx) hop.face = dx;
    hop.vx = approach(hop.vx, dx * MOVE, 18, dt);
    hop.x += hop.vx * dt;
    if (hop.x < LEFT - HOP_R) hop.x = RIGHT + HOP_R;
    if (hop.x > RIGHT + HOP_R) hop.x = LEFT - HOP_R;

    /* Vertical integration, substepped so a fast fall cannot pass through a
     * platform between frames. */
    var steps = Math.max(1, Math.min(6, Math.ceil(Math.abs(hop.vy * dt) / (PLAT_H * 0.8))));
    var sdt = dt / steps;
    for (var s = 0; s < steps; s++) {
      hop.vy = Math.min(TERMINAL, hop.vy + GRAVITY * sdt);
      var prevY = hop.y;
      hop.y += hop.vy * sdt;

      /* Only land while descending, and only from above. */
      if (hop.vy > 0) {
        plats.forEach(function (p) {
          if (p.used > 1) return;
          var footPrev = prevY + HOP_R;
          var foot = hop.y + HOP_R;
          if (footPrev <= p.y && foot >= p.y &&
            hop.x + HOP_R * 0.6 > p.x && hop.x - HOP_R * 0.6 < p.x + p.w) {
            hop.y = p.y - HOP_R;
            bounceOff(p);
          }
        });
      }
    }

    /* Crumbling platforms fall away after use. */
    plats.forEach(function (p) {
      p.t += dt;
      if (p.kind === 1) {
        p.x += p.dir * 0.11 * dt;
        if (p.x <= LEFT) { p.x = LEFT; p.dir = 1; }
        if (p.x + p.w >= RIGHT) { p.x = RIGHT - p.w; p.dir = -1; }
      }
      if (p.kind === 2 && p.used === 1) {
        p.y += 0.5 * dt;
        p.used = p.y > camY + GH + 60 ? 2 : 1;
        if (p.used === 2) p.alive = false;
      }
    });

    /* Camera only ever rises, and only once the player is above the midline. */
    var wantCam = hop.y - GH * 0.42;
    if (wantCam < camY) camY = wantCam;

    if (hop.y < highest) {
      highest = hop.y;
      score = Math.max(score, Math.floor((BOT - 80 - highest) / 10));
    }

    /* Recycle: drop anything below the view, extend the field above it. */
    plats.forEach(function (p) {
      if (p.y > camY + GH + 80) p.alive = false;
    });
    while (spawnY > camY - PLAT_GAP * 2) {
      spawnY -= rndRange(PLAT_GAP * 0.72, PLAT_GAP * 1.15);
      addPlatform(spawnY, false);
    }

    if (hop.y - HOP_R > camY + GH + 40) die();
  }

  /* ------------------------------------------------------------ draw --- */

  function drawHopper(c, x, y, r, squash) {
    var sq = 1 - squash * 0.32;
    var w = r * 2 / sq, h = r * 2 * sq;
    Render.glow(c, x, y, r * 2.8, ACCENT.climb, 0.55);
    var g = c.createLinearGradient(x, y - h / 2, x, y + h / 2);
    g.addColorStop(0, shade(ACCENT.climb, 0.55));
    g.addColorStop(1, ACCENT.climb);
    c.fillStyle = g;
    roundRect(c, x - w / 2, y - h / 2, w, h, Math.min(w, h) * 0.42);
    c.fill();
    c.strokeStyle = rgba(shade(ACCENT.climb, 0.7), 0.6);
    c.lineWidth = 1.5;
    c.stroke();

    /* Eyes, so it reads as a character rather than a blob. */
    c.fillStyle = '#07050E';
    var ex = x + hop.face * r * 0.24;
    c.beginPath(); c.arc(ex - r * 0.22, y - r * 0.12, r * 0.13, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(ex + r * 0.22, y - r * 0.12, r * 0.13, 0, Math.PI * 2); c.fill();
  }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.climb);
    gHud(ACCENT.climb, [
      { label: 'HEIGHT', value: fmtScore(score) + 'm' },
      { label: 'BEST', value: fmtScore(Scores.best('climb')) },
    ]);

    c.save();
    if (shakeT > 0) c.translate(0, Math.sin(shakeT) * 3 * (shakeT / 260));
    c.save();
    roundRect(c, 8, HUD_H - 4, GW - 16, GH - HUD_H - 4, COL.radius);
    c.clip();

    /* Altitude rungs every 500m, so progress is legible while climbing. */
    var rung = 500;
    var firstRung = Math.floor((BOT - 80 - (camY + GH)) / (rung * 10)) * rung;
    for (var m = firstRung; m < firstRung + 4000; m += rung) {
      if (m <= 0) continue;
      var wy = BOT - 80 - m * 10;
      var y = sy(wy);
      if (y < TOP - 20 || y > BOT + 20) continue;
      c.globalAlpha = 0.10;
      c.strokeStyle = COL.a1;
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(LEFT, y); c.lineTo(RIGHT, y); c.stroke();
      c.globalAlpha = 0.35;
      dataText(c, fmtScore(m) + 'm', RIGHT - 6, y - 6, {
        size: 13, align: 'right', color: COL.dim,
      });
      c.globalAlpha = 1;
    }

    plats.forEach(function (p) {
      var y = sy(p.y);
      if (y < TOP - 40 || y > BOT + 60) return;
      var col = PLAT_COL[p.kind];
      var fading = (p.kind === 2 && p.used >= 1);
      c.globalAlpha = fading ? 0.5 : 1;
      if (p.kind === 3) {
        slab(c, p.x, y, p.w, PLAT_H, col, shade(col, 0.45), 'glow');
        /* Coil marks so a spring is obvious at a glance. */
        c.strokeStyle = rgba('#07050E', 0.5);
        c.lineWidth = 2;
        for (var k = 1; k < 4; k++) {
          c.beginPath();
          c.moveTo(p.x + p.w * k / 4, y + 3);
          c.lineTo(p.x + p.w * k / 4, y + PLAT_H - 3);
          c.stroke();
        }
      } else {
        slab(c, p.x, y, p.w, PLAT_H, col, shade(col, 0.4), 'solid');
      }
      c.globalAlpha = 1;
    });

    particles.draw(c);

    if (!over) {
      var hx = hop.x, hy = sy(hop.y);
      drawHopper(c, hx, hy, HOP_R, hop.squash);
      /* Draw the wrap-around ghost so leaving one edge reads correctly. */
      if (hx < LEFT + HOP_R) drawHopper(c, hx + (RIGHT - LEFT) + HOP_R * 2, hy, HOP_R, hop.squash);
      if (hx > RIGHT - HOP_R) drawHopper(c, hx - (RIGHT - LEFT) - HOP_R * 2, hy, HOP_R, hop.squash);
    }

    c.restore();
    c.restore();
  }

  /* --------------------------------------------------------- preview --- */

  function preview(c, w, h, t) {
    var loop = (t % 1800) / 1800;
    /* Three platforms scrolling down, hopper arcing between them. */
    var pw = w * 0.34, ph = Math.max(4, h * 0.055);
    for (var i = 0; i < 4; i++) {
      var py = ((i / 4 + loop) % 1) * (h + ph) - ph;
      var px = w * (0.12 + 0.5 * Math.abs(Math.sin(i * 2.1)));
      var kind = i === 2 ? 3 : 0;
      slab(c, clamp(px, 0, w - pw), py, pw, ph,
        PLAT_COL[kind], shade(PLAT_COL[kind], 0.4), 'solid');
    }
    var bounce = Math.abs(Math.sin(loop * Math.PI * 3));
    var hr = Math.min(w, h) * 0.09;
    var hxp = w * 0.5 + Math.sin(loop * Math.PI * 2) * w * 0.18;
    var hyp = h * 0.52 - bounce * h * 0.20;
    Render.glow(c, hxp, hyp, hr * 2.8, ACCENT.climb, 0.55);
    var g = c.createLinearGradient(hxp, hyp - hr, hxp, hyp + hr);
    g.addColorStop(0, shade(ACCENT.climb, 0.55));
    g.addColorStop(1, ACCENT.climb);
    c.fillStyle = g;
    roundRect(c, hxp - hr, hyp - hr, hr * 2, hr * 2, hr * 0.84);
    c.fill();
  }

  return registerGame({
    id: 'climb',
    title: 'CLIMB',
    tag: 'The camera only goes up',
    accent: ACCENT.climb,
    hint: '◀▶ STEER · BOUNCING IS AUTOMATIC',
    /**
     * Attract-mode pilot.
     *
     * You do not climb by chasing platforms above you — you climb by landing
     * on the highest platform still BELOW you, which the arc then carries you
     * past. Targeting upward was the first bug: it steered at things it could
     * not reach and fell off in about three seconds.
     *
     * Height alone is not enough either. The highest platform below is often
     * across the screen, and the hopper cannot get there before it falls past,
     * so the choice is a trade-off between how much altitude a platform gains
     * and whether it can actually be reached. Weighing both took the pilot
     * from surviving 24 of 30 seeds to all 30.
     */
    demo: function () {
      var out = {};
      if (over) return out;
      var feet = hop.y + HOP_R;
      var span = RIGHT - LEFT;

      /* Horizontal distance, accounting for the wrap at the walls. */
      function reach(cx2) {
        var d = Math.abs(cx2 - hop.x);
        return Math.min(d, span - d);
      }

      var best = null, bestCost = Infinity;
      plats.forEach(function (p) {
        if (p.used > 1) return;
        if (p.y < feet - 4) return;              /* above us: cannot land on it */
        if (p.y > feet + 560) return;            /* too far down to bother */
        var centre = p.x + p.w / 2;
        /* Altitude is the prize; distance is the risk. */
        var cost = (p.y - feet) + reach(centre) * 1.6;
        if (p.kind === 3) cost -= 90;            /* springs are worth going for */
        if (p.kind === 2) cost += 60;            /* crumbling ones are a trap */
        if (cost < bestCost) { bestCost = cost; best = p; }
      });

      if (!best) {
        plats.forEach(function (p) {
          if (p.used > 1) return;
          if (!best || Math.abs(p.y - hop.y) < Math.abs(best.y - hop.y)) best = p;
        });
      }
      if (!best) return out;

      var want = best.x + best.w / 2;
      var dx = want - hop.x;
      /* Go the short way round if wrapping is closer. */
      if (Math.abs(dx) > span / 2) dx = -dx;
      if (dx < -8) out.left = true;
      else if (dx > 8) out.right = true;
      return out;
    },
    start: start,
    update: update,
    draw: draw,
    preview: preview,
    _test: {
      score: function () { return score; },
      hop: function () { return hop; },
      camY: function () { return camY; },
      platformCount: function () { return plats.count(); },
      /** Drop the hopper into clear air below the view to force a fall. */
      forceFall: function () {
        plats.clear();
        hop.y = camY + GH + 10;
        hop.vy = 1;
      },
      /** Teleport upward as a successful climb would. */
      lift: function (px) { hop.y -= px; hop.vy = -0.2; },
    },
  });
})();
