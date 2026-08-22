/*
 * ARTSCAPE — the silent screensaver: a rotating gallery of three generative
 * pieces, each holding the screen for a while before dipping to black and
 * giving way to the next. No text, no UI — something worth walking past.
 *
 *   SILK         a flow field: hundreds of glowing ribbons advected through
 *                a slowly-breathing vector field, trails accumulating on a
 *                persistent buffer so the whole screen becomes woven light.
 *   MURMURATION  a starling flock at dusk — the boids rules (separation,
 *                alignment, cohesion) chasing a wandering attractor, so the
 *                flock sweeps and folds the way the real birds do.
 *   BLOOM        a phyllotaxis spiral — florets placed by the golden angle,
 *                blooming outward, breathing, slowly turning.
 *
 * The first cut was a single static synthwave grid; on the cabinet it read
 * as an empty purple room. The fix was not a better grid — it was motion
 * with structure: fields, flocks and growth are the three classic sources
 * of "alive" in generative art, so the gallery ships one of each.
 *
 * Everything is deterministic (a hash, not Math.random), invents no colours
 * (palette from COL/ACCENT only), and stays inside the canvas-2D budget the
 * Pi can pay at full resolution: the expensive scene (SILK) is one fade and
 * one blit per frame plus short line segments.
 */

var Artscape = (function () {
  var SCENE_MS = 80000;        /* each piece holds for 80s */
  var FADE_MS = 1400;          /* dip to black between pieces */

  /* Aurora ramp as rgb triples for smooth cross-fades. */
  var RAMP = [hexRgb(COL.a1), hexRgb(COL.a3), hexRgb(COL.a2)];
  var TEXT_RGB = hexRgb(COL.text);

  function mixa(a, b, k, alpha) {
    return 'rgba(' +
      Math.round(a[0] + (b[0] - a[0]) * k) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * k) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * k) + ',' + alpha + ')';
  }

  /** Ramp colour at phase p (0..1 wraps), as an rgba() string. */
  function ramp(p, alpha) {
    var n = RAMP.length;
    var f = ((p % 1) + 1) % 1 * n;
    var i = Math.floor(f);
    return mixa(RAMP[i % n], RAMP[(i + 1) % n], f - i, alpha);
  }

  /* Deterministic hash → 0..1. Stable art, no RNG stream consumed. */
  function hash(i) {
    var x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  /* Offscreen buffer for trail accumulation; null where unavailable and the
   * scene falls back to trail-free drawing. */
  function makeBuffer(w, h) {
    try {
      if (typeof document === 'undefined' || !document.createElement) return null;
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var cx2 = cv.getContext('2d');
      if (!cx2) return null;
      return { canvas: cv, ctx: cx2 };
    } catch (e) { return null; }
  }

  /* ================================================================ SILK
   *
   * The vector field is layered sinusoids — cheaper than Perlin and just as
   * smooth at this scale — drifting slowly so the weave never repeats. Each
   * particle draws only its last step; the buffer remembers the rest and a
   * translucent background fill each frame lets old light sink away.
   */
  var SILK_N = 430;
  var silk = null;             /* {buf, px[], py[], hue[], spd[]} */
  var silkLast = 0;

  function silkField(x, y, t) {
    return 2.6 * Math.sin(x * 0.0021 + t * 0.000041)
      + 2.2 * Math.cos(y * 0.0017 - t * 0.000033)
      + 1.3 * Math.sin((x + y) * 0.0009 + t * 0.000021);
  }

  function silkInit() {
    silk = { buf: makeBuffer(SW, SH), px: [], py: [], hue: [], spd: [] };
    for (var i = 0; i < SILK_N; i++) {
      silk.px.push(hash(i) * SW);
      silk.py.push(hash(i + 9000) * SH);
      silk.hue.push(hash(i + 500));
      silk.spd.push(1.4 + hash(i + 700) * 1.8);
    }
    if (silk.buf) {
      silk.buf.ctx.fillStyle = COL.bgBot;
      silk.buf.ctx.fillRect(0, 0, SW, SH);
    }
  }

  function silkDraw(c, t) {
    if (!silk) silkInit();
    var steps = clamp(Math.round((t - silkLast) / 16.7), 1, 4);
    silkLast = t;

    var target = silk.buf ? silk.buf.ctx : c;
    if (!silk.buf) {
      c.fillStyle = COL.bgBot;
      c.fillRect(0, 0, SW, SH);
    } else {
      /* The fade IS the art: too fast and the ribbons look like worms, too
       * slow and the screen silts up. 0.028 leaves ~3s of afterglow. */
      target.fillStyle = 'rgba(7,5,14,0.028)';
      target.fillRect(0, 0, SW, SH);
    }

    target.lineWidth = 2.1;
    target.lineCap = 'round';
    var drift = t * 0.00001;
    for (var i = 0; i < SILK_N; i++) {
      var x = silk.px[i], y = silk.py[i];
      target.strokeStyle = ramp(silk.hue[i] + drift, 0.75);
      target.beginPath();
      target.moveTo(x, y);
      for (var s = 0; s < steps; s++) {
        var a = silkField(x, y, t);
        x += Math.cos(a) * silk.spd[i];
        y += Math.sin(a) * silk.spd[i];
        target.lineTo(x, y);
      }
      target.stroke();
      /* Recycle ribbons that leave, plus a slow trickle of rebirths so the
       * weave keeps finding new regions of the field. */
      if (x < -8 || x > SW + 8 || y < -8 || y > SH + 8 || hash(i + t) < 0.002) {
        x = hash(i + Math.floor(t)) * SW;
        y = hash(i + Math.floor(t) + 9000) * SH;
      }
      silk.px[i] = x; silk.py[i] = y;
    }

    if (silk.buf) c.drawImage(silk.buf.canvas, 0, 0);

    /* A soft focal glow where the field currently converges. */
    var gx2 = SW / 2 + Math.sin(t * 0.000047) * SW * 0.3;
    var gy2 = SH / 2 + Math.cos(t * 0.000031) * SH * 0.3;
    var g = c.createRadialGradient(gx2, gy2, 0, gx2, gy2, SW * 0.5);
    g.addColorStop(0, ramp(drift, 0.12));
    g.addColorStop(1, 'rgba(7,5,14,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, SW, SH);
  }

  /* ========================================================= MURMURATION
   *
   * Reynolds' three rules plus a wandering attractor. The attractor is what
   * makes it read as a murmuration rather than a screensaver of gnats: the
   * flock is always going somewhere, and the somewhere keeps moving.
   */
  var FLOCK_N = 220;
  var flock = null;            /* {bx,by,vx,vy per bird} */
  var flockLast = 0;
  var NEIGH = 130, NEIGH2 = NEIGH * NEIGH;

  function flockInit() {
    flock = { bx: [], by: [], vx: [], vy: [] };
    for (var i = 0; i < FLOCK_N; i++) {
      flock.bx.push(SW * 0.5 + (hash(i) - 0.5) * 700);
      flock.by.push(SH * 0.45 + (hash(i + 3000) - 0.5) * 700);
      var a = hash(i + 6000) * Math.PI * 2;
      flock.vx.push(Math.cos(a) * 2);
      flock.vy.push(Math.sin(a) * 2);
    }
  }

  function flockDraw(c, t) {
    if (!flock) flockInit();
    var dt = clamp(t - flockLast, 0, 64) / 16.7;
    flockLast = t;

    /* Dusk: a vertical gradient, a low moon, a scatter of stars. */
    var sky = c.createLinearGradient(0, 0, 0, SH);
    sky.addColorStop(0, COL.bgBot);
    sky.addColorStop(0.62, COL.bgMid);
    sky.addColorStop(1, COL.bgBot);
    c.fillStyle = sky;
    c.fillRect(0, 0, SW, SH);

    var mx = SW * 0.72, my = SH * 0.7, mr = SW * 0.16;
    var moon = c.createRadialGradient(mx, my, mr * 0.2, mx, my, mr);
    moon.addColorStop(0, mixa(TEXT_RGB, TEXT_RGB, 0, 0.9));
    moon.addColorStop(0.5, ramp(0.15 + t * 0.00001, 0.25));
    moon.addColorStop(1, 'rgba(7,5,14,0)');
    c.fillStyle = moon;
    c.beginPath();
    c.arc(mx, my, mr, 0, Math.PI * 2);
    c.fill();

    for (var st2 = 0; st2 < 95; st2++) {
      var tw = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 0.0016 + st2 * 2.1));
      c.globalAlpha = tw * 0.7;
      c.fillStyle = st2 % 6 === 0 ? ramp(hash(st2), 0.9) : COL.text;
      c.fillRect(hash(st2) * SW, hash(st2 + 400) * SH, 1.6, 1.6);
    }
    c.globalAlpha = 1;

    /* A second flock, far away: too small to resolve wings, on its own
     * sweep — the depth cue that sells the sky as deep. */
    var fx2 = SW * 0.5 + Math.sin(t * 0.000059 + 3.1) * SW * 0.36;
    var fy2 = SH * 0.28 + Math.sin(t * 0.000083 + 0.6) * SH * 0.2;
    c.fillStyle = mixa(TEXT_RGB, TEXT_RGB, 0, 0.35);
    for (var fb = 0; fb < 70; fb++) {
      var wob = t * 0.0006 + fb;
      c.fillRect(
        fx2 + (hash(fb + 1200) - 0.5) * 340 + Math.sin(wob) * 12,
        fy2 + (hash(fb + 1500) - 0.5) * 240 + Math.cos(wob * 1.3) * 9,
        2, 2);
    }

    /* The attractor: a slow lissajous sweep of the whole screen. */
    var ax = SW * 0.5 + Math.sin(t * 0.000141) * SW * 0.34;
    var ay = SH * 0.42 + Math.sin(t * 0.000097 + 1.7) * SH * 0.30;

    var i, j;
    for (i = 0; i < FLOCK_N; i++) {
      var px = flock.bx[i], py = flock.by[i];
      var cx2 = 0, cy2 = 0, avx = 0, avy = 0, sx2 = 0, sy2 = 0, n = 0;
      /* O(N²) over 150 birds is ~22k distance checks — cheaper than the
       * bookkeeping of a spatial grid at this population. */
      for (j = 0; j < FLOCK_N; j++) {
        if (j === i) continue;
        var dx = flock.bx[j] - px, dy = flock.by[j] - py;
        var d2 = dx * dx + dy * dy;
        if (d2 > NEIGH2) continue;
        n++;
        cx2 += flock.bx[j]; cy2 += flock.by[j];
        avx += flock.vx[j]; avy += flock.vy[j];
        if (d2 < 38 * 38 && d2 > 0.01) { sx2 -= dx / d2; sy2 -= dy / d2; }
      }
      var fx = (ax - px) * 0.00038, fy = (ay - py) * 0.00038;
      if (n) {
        fx += (cx2 / n - px) * 0.0008 + (avx / n - flock.vx[i]) * 0.05 + sx2 * 14;
        fy += (cy2 / n - py) * 0.0008 + (avy / n - flock.vy[i]) * 0.05 + sy2 * 14;
      }
      /* A whisper of individuality keeps the flock from crystallising. */
      fx += (hash(i + Math.floor(t * 0.001)) - 0.5) * 0.09;
      fy += (hash(i * 3 + Math.floor(t * 0.001)) - 0.5) * 0.09;
      var vx = flock.vx[i] + fx * dt, vy = flock.vy[i] + fy * dt;
      var sp = Math.sqrt(vx * vx + vy * vy) || 0.001;
      /* Starlings cannot hover and cannot teleport. */
      var want = clamp(sp, 2.3, 5.2);
      vx = vx / sp * want; vy = vy / sp * want;
      flock.vx[i] = vx; flock.vy[i] = vy;
      flock.bx[i] = px + vx * dt;
      flock.by[i] = py + vy * dt;
    }

    /* Draw darts oriented along velocity; a handful catch the moonlight. */
    for (i = 0; i < FLOCK_N; i++) {
      var bvx = flock.vx[i], bvy = flock.vy[i];
      var bsp = Math.sqrt(bvx * bvx + bvy * bvy) || 1;
      var ux = bvx / bsp, uy = bvy / bsp;
      var bx2 = flock.bx[i], by3 = flock.by[i];
      var s2 = 3.4 + hash(i + 40) * 2.4;
      c.fillStyle = i % 9 === 0 ? ramp(hash(i) + t * 0.00001, 0.9)
        : mixa(TEXT_RGB, TEXT_RGB, 0, 0.45 + hash(i + 80) * 0.35);
      c.beginPath();
      c.moveTo(bx2 + ux * s2, by3 + uy * s2);
      c.lineTo(bx2 - ux * s2 * 0.6 - uy * s2 * 0.45, by3 - uy * s2 * 0.6 + ux * s2 * 0.45);
      c.lineTo(bx2 - ux * s2 * 0.6 + uy * s2 * 0.45, by3 - uy * s2 * 0.6 - ux * s2 * 0.45);
      c.closePath();
      c.fill();
    }
  }

  /* =============================================================== BLOOM
   *
   * Vogel's phyllotaxis: floret k sits at angle k·137.5°, radius ∝ √k — the
   * sunflower's own packing. The bloom breathes, turns, and florets ripple
   * outward in waves of colour.
   */
  var BLOOM_N = 560;
  var GOLDEN = Math.PI * (3 - Math.sqrt(5));

  function bloomDraw(c, t) {
    var bg = c.createRadialGradient(SW / 2, SH / 2, 0, SW / 2, SH / 2, SH * 0.62);
    bg.addColorStop(0, COL.bgMid);
    bg.addColorStop(1, COL.bgBot);
    c.fillStyle = bg;
    c.fillRect(0, 0, SW, SH);

    for (var st2 = 0; st2 < 40; st2++) {
      c.globalAlpha = 0.2 + 0.5 * (0.5 + 0.5 * Math.sin(t * 0.0014 + st2 * 3.3));
      c.fillStyle = COL.text;
      c.fillRect(hash(st2 + 77) * SW, hash(st2 + 991) * SH, 1.5, 1.5);
    }
    c.globalAlpha = 1;

    var cx2 = SW / 2, cy2 = SH / 2;
    var rot = t * 0.000035;
    var breathe = 1 + Math.sin(t * 0.00042) * 0.045;
    var spread = Math.min(SW, SH) * 0.0195 * breathe;

    for (var k = BLOOM_N - 1; k >= 1; k--) {
      var th = k * GOLDEN + rot;
      var r = spread * Math.sqrt(k);
      var x = cx2 + Math.cos(th) * r;
      var y = cy2 + Math.sin(th) * r * 1.06;
      /* Colour and size ripple outward from the centre. */
      var wave = 0.5 + 0.5 * Math.sin(t * 0.0011 - Math.sqrt(k) * 0.55);
      var sz = (2.2 + 5.2 * (k / BLOOM_N)) * (0.72 + wave * 0.5);
      c.fillStyle = ramp(k / BLOOM_N * 0.66 + t * 0.000012, 0.28 + wave * 0.6);
      c.beginPath();
      c.arc(x, y, sz, 0, Math.PI * 2);
      c.fill();
    }

    var glow = c.createRadialGradient(cx2, cy2, 0, cx2, cy2, spread * 7);
    glow.addColorStop(0, ramp(t * 0.000012, 0.5));
    glow.addColorStop(1, 'rgba(7,5,14,0)');
    c.fillStyle = glow;
    c.fillRect(0, 0, SW, SH);
  }

  /* ============================================================ gallery */

  var SCENES = [silkDraw, flockDraw, bloomDraw];

  function draw(c, t) {
    if (!c) return;
    var tt = num(t, 0);
    var idx = Math.floor(tt / SCENE_MS) % SCENES.length;
    var phase = tt % SCENE_MS;

    SCENES[idx](c, tt);

    /* Vignette: every piece sits in the same soft dark frame. */
    var vg = c.createRadialGradient(SW / 2, SH * 0.5, SH * 0.3, SW / 2, SH * 0.5, SH * 0.74);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(5,4,10,0.6)');
    c.fillStyle = vg;
    c.fillRect(0, 0, SW, SH);

    /* Dip to black at both ends of a scene's slot. */
    var edge = Math.min(phase, SCENE_MS - phase);
    if (edge < FADE_MS) {
      c.globalAlpha = clamp(1 - edge / FADE_MS, 0, 1);
      c.fillStyle = COL.bgBot;
      c.fillRect(0, 0, SW, SH);
      c.globalAlpha = 1;
    }
  }

  return {
    draw: draw,
    /** Test seams: scene count and a way to reset accumulated state. */
    _scenes: SCENES.length,
    _sceneMs: SCENE_MS,
    _reset: function () { silk = null; flock = null; silkLast = 0; flockLast = 0; },
  };
})();
