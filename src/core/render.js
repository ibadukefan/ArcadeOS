/*
 * Rendering: logical-space canvas helpers and the shared drawing primitives.
 *
 * The whole front end is ONE canvas. That is a deliberate performance choice:
 * a Pi 4 compositing a dozen small card canvases behind a CSS-blurred aurora
 * cannot hold 60fps at 1080x1920, but a single layer with everything painted
 * into it comfortably can.
 *
 * Two logical spaces exist, and neither is ever measured in device pixels:
 *   shell space  1080 x 1920   menus, cards, settings
 *   game space    600 x 1000   every game, letterboxed inside shell space
 *
 * PERFORMANCE NOTES
 *  - shadowBlur is banned in hot paths. Glow comes from pre-rendered sprites
 *    on offscreen canvases, cached by colour and size. Per-tile shadowBlur is
 *    the single most expensive thing you can do in a Pi draw loop.
 *  - The aurora and vignette render into small offscreen buffers and are
 *    blitted up. Gradient fill cost scales with pixels touched, so a quarter-
 *    scale buffer is sixteen times cheaper and looks identical once blurred
 *    by the upscale.
 *  - Nothing here allocates per frame except where unavoidable.
 */

var Render = (function () {
  var canvas = null;
  var ctx = null;

  /* Device backing size. */
  var W = SW, H = SH;
  var dpr = 1;

  /* Shell-space transform. */
  var scale = 1, ox = 0, oy = 0;
  /* Game-space transform, relative to shell space. */
  var gScale = 1, gox = 0, goy = 0;

  /* Offscreen layers. */
  var plate = null, plateCtx = null;
  var aurora = null, auroraCtx = null;
  var vig = null, vigCtx = null;
  var veil = null, veilPattern = null;

  var LOWRES = 4;      /* backdrop buffers render at 1/4 linear scale */
  var auroraT = 0;

  function makeCanvas(w, h) {
    var c;
    if (typeof document !== 'undefined' && document.createElement) {
      c = document.createElement('canvas');
    } else {
      return null;
    }
    c.width = Math.max(1, Math.floor(w));
    c.height = Math.max(1, Math.floor(h));
    return c;
  }

  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d', { alpha: false });
    gx = ctx;
    sx = ctx;
    resize();
    return ctx;
  }

  function resize() {
    if (!canvas) return;
    var vw = (typeof window !== 'undefined' && window.innerWidth) || SW;
    var vh = (typeof window !== 'undefined' && window.innerHeight) || SH;
    var ratio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    /* Above 1.5 the Pi burns fill rate for pixels nobody can resolve. */
    dpr = clamp(num(ratio, 1), 1, 1.5);

    W = Math.max(1, Math.floor(vw * dpr));
    H = Math.max(1, Math.floor(vh * dpr));
    canvas.width = W;
    canvas.height = H;
    if (canvas.style) {
      canvas.style.width = vw + 'px';
      canvas.style.height = vh + 'px';
    }

    /* Shell space letterboxed into the device surface. */
    scale = Math.min(W / SW, H / SH);
    ox = (W - SW * scale) / 2;
    oy = (H - SH * scale) / 2;

    /* Game space letterboxed into shell space. */
    gScale = Math.min(SW / GW, SH / GH);
    gox = (SW - GW * gScale) / 2;
    goy = (SH - GH * gScale) / 2;

    buildLayers();
  }

  /* ------------------------------------------------------- backdrop --- */

  function buildLayers() {
    var lw = Math.max(2, Math.floor(W / LOWRES));
    var lh = Math.max(2, Math.floor(H / LOWRES));

    plate = makeCanvas(lw, lh);
    aurora = makeCanvas(lw, lh);
    vig = makeCanvas(lw, lh);
    if (!plate || !aurora || !vig) return;
    plateCtx = plate.getContext('2d');
    auroraCtx = aurora.getContext('2d');
    vigCtx = vig.getContext('2d');

    /* radial-gradient(125% 80% at 50% -10%, #1D1748, #0D0A1F 55%, #07050E) */
    if (plateCtx) {
      var cx = lw * 0.5, cy = lh * -0.10;
      var r = Math.max(lw * 1.25, lh * 0.80);
      var g = plateCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, COL.bgTop);
      g.addColorStop(0.55, COL.bgMid);
      g.addColorStop(1, COL.bgBot);
      plateCtx.fillStyle = g;
      plateCtx.fillRect(0, 0, lw, lh);
    }

    if (vigCtx) {
      vigCtx.clearRect(0, 0, lw, lh);
      var vr = Math.max(lw, lh) * 0.78;
      var vg = vigCtx.createRadialGradient(lw / 2, lh / 2, vr * 0.42, lw / 2, lh / 2, vr);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.55)');
      vigCtx.fillStyle = vg;
      vigCtx.fillRect(0, 0, lw, lh);
    }

    buildVeil();
  }

  /** Scanline veil as a 1x4 repeating pattern — one fill, no per-line loop. */
  function buildVeil() {
    veil = makeCanvas(1, 4);
    veilPattern = null;
    if (!veil) return;
    var vc = veil.getContext('2d');
    if (!vc) return;
    vc.clearRect(0, 0, 1, 4);
    vc.fillStyle = 'rgba(0,0,0,0.16)';
    vc.fillRect(0, 0, 1, 1);
    vc.fillStyle = 'rgba(0,0,0,0.06)';
    vc.fillRect(0, 1, 1, 1);
    try { veilPattern = ctx ? ctx.createPattern(veil, 'repeat') : null; }
    catch (e) { veilPattern = null; }
  }

  /**
   * Three drifting aurora blobs. Rendered as radial gradients into a quarter-
   * scale buffer — the upscale is what gives them their soft blurred edge, at
   * a fraction of the cost of a real blur filter.
   */
  var BLOBS = [
    { c: COL.a1, x: 0.22, y: 0.18, r: 0.62, sx: 0.055, sy: 0.041, px: 0.13, py: 0.09, a: 0.30 },
    { c: COL.a2, x: 0.78, y: 0.42, r: 0.70, sx: 0.037, sy: 0.063, px: 0.11, py: 0.12, a: 0.34 },
    { c: COL.a3, x: 0.42, y: 0.80, r: 0.58, sx: 0.048, sy: 0.033, px: 0.15, py: 0.07, a: 0.24 },
  ];

  function drawAurora(t, tint) {
    if (!auroraCtx || !aurora) return;
    var lw = aurora.width, lh = aurora.height;
    auroraCtx.clearRect(0, 0, lw, lh);
    var sec = t / 1000;
    for (var i = 0; i < BLOBS.length; i++) {
      var b = BLOBS[i];
      var bx = (b.x + Math.sin(sec * b.sx * 6.283 + i) * b.px) * lw;
      var by = (b.y + Math.cos(sec * b.sy * 6.283 + i * 1.7) * b.py) * lh;
      var br = b.r * Math.min(lw, lh);
      if (!isFinite(bx) || !isFinite(by) || br <= 0) continue;
      var col = (tint && i === 1) ? tint : b.c;
      var g = auroraCtx.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, rgba(col, b.a));
      g.addColorStop(0.5, rgba(col, b.a * 0.35));
      g.addColorStop(1, rgba(col, 0));
      auroraCtx.fillStyle = g;
      auroraCtx.fillRect(0, 0, lw, lh);
    }
  }

  /**
   * Paint the shared background and set up shell space. Returns the shell ctx.
   * `tint` optionally recolours the middle aurora blob to a game accent.
   */
  function beginFrame(dt, tint) {
    if (!ctx) return null;
    var reduced = false;
    try { reduced = !!Settings.get('reducedMotion'); } catch (e) { reduced = false; }
    if (!reduced) auroraT += num(dt, 16);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = COL.bgBot;
    ctx.fillRect(0, 0, W, H);

    if (plate) ctx.drawImage(plate, 0, 0, W, H);
    drawAurora(auroraT, tint);
    if (aurora) {
      ctx.globalAlpha = 1;
      ctx.drawImage(aurora, 0, 0, W, H);
    }

    /* Enter shell space. */
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    return ctx;
  }

  /** Scanlines + vignette sit on top of everything. */
  function endFrame() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;

    var crt = true;
    try { crt = Settings.get('crt') !== false; } catch (e) { crt = true; }
    if (crt && veilPattern) {
      ctx.fillStyle = veilPattern;
      ctx.fillRect(0, 0, W, H);
    }
    if (vig) ctx.drawImage(vig, 0, 0, W, H);

    /* Letterbox bars, in case the panel is not 9:16. */
    if (ox > 0.5 || oy > 0.5) {
      ctx.fillStyle = '#000';
      if (ox > 0.5) { ctx.fillRect(0, 0, ox, H); ctx.fillRect(W - ox, 0, ox, H); }
      if (oy > 0.5) { ctx.fillRect(0, 0, W, oy); ctx.fillRect(0, H - oy, W, oy); }
    }
  }

  /** Switch the active transform into 600x1000 game space. */
  function enterGame() {
    if (!ctx) return null;
    ctx.setTransform(scale * gScale, 0, 0, scale * gScale,
      ox + gox * scale, oy + goy * scale);
    return ctx;
  }

  /** Back to 1080x1920 shell space. */
  function enterShell() {
    if (!ctx) return null;
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    return ctx;
  }

  /* ----------------------------------------------------- glow cache --- */

  var glowCache = Object.create(null);
  var glowKeys = [];
  var GLOW_CAP = 96;

  /**
   * Pre-rendered radial glow sprite. This exists so that no draw loop ever
   * touches ctx.shadowBlur — the sprite is rasterised once and then blitted,
   * which is roughly two orders of magnitude cheaper per tile on a Pi 4.
   */
  function glowSprite(color, size) {
    var s = Math.max(4, Math.round(num(size, 16)));
    var key = color + '|' + s;
    var hit = glowCache[key];
    if (hit) return hit;

    var dim = s * 3;
    var c = makeCanvas(dim, dim);
    if (!c) return null;
    var g2 = c.getContext('2d');
    if (!g2) return null;
    var r = dim / 2;
    var grad = g2.createRadialGradient(r, r, s * 0.25, r, r, r);
    grad.addColorStop(0, rgba(color, 0.55));
    grad.addColorStop(0.45, rgba(color, 0.18));
    grad.addColorStop(1, rgba(color, 0));
    g2.fillStyle = grad;
    g2.fillRect(0, 0, dim, dim);

    if (glowKeys.length >= GLOW_CAP) {
      var evict = glowKeys.shift();
      delete glowCache[evict];
    }
    glowKeys.push(key);
    glowCache[key] = c;
    return c;
  }

  /** Blit a cached glow centred on (x,y). */
  function glow(c, x, y, size, color, alpha) {
    var spr = glowSprite(color, size);
    if (!spr) return;
    var a = clamp(num(alpha, 1), 0, 1);
    if (a <= 0) return;
    var dim = spr.width;
    var px = num(x, 0) - dim / 2, py = num(y, 0) - dim / 2;
    var prev = c.globalAlpha;
    c.globalAlpha = clamp(prev * a, 0, 1);
    c.drawImage(spr, px, py, dim, dim);
    c.globalAlpha = prev;
  }

  return {
    init: init,
    resize: resize,
    beginFrame: beginFrame,
    endFrame: endFrame,
    enterGame: enterGame,
    enterShell: enterShell,
    glow: glow,
    glowSprite: glowSprite,
    ctx: function () { return ctx; },
    size: function () { return { w: W, h: H, scale: scale, ox: ox, oy: oy }; },
    gameRect: function () { return { x: gox, y: goy, w: GW * gScale, h: GH * gScale, s: gScale }; },
    _clearGlow: function () { glowCache = Object.create(null); glowKeys = []; },
  };
})();

/** The context games draw into, in 600x1000 logical space. */
var gx = null;
/** The context the shell draws into, in 1080x1920 logical space. */
var sx = null;

/* ==================================================================== */
/*  Shared drawing primitives — available to every game.                */
/* ==================================================================== */

/** Rounded rectangle path. Written out rather than using ctx.roundRect so the
 *  same code runs under the headless harness. */
function roundRect(c, x, y, w, h, r) {
  var xx = num(x, 0), yy = num(y, 0);
  var ww = Math.max(0, num(w, 0)), hh = Math.max(0, num(h, 0));
  var rr = clamp(num(r, 0), 0, Math.min(ww, hh) / 2);
  c.beginPath();
  c.moveTo(xx + rr, yy);
  c.lineTo(xx + ww - rr, yy);
  c.quadraticCurveTo(xx + ww, yy, xx + ww, yy + rr);
  c.lineTo(xx + ww, yy + hh - rr);
  c.quadraticCurveTo(xx + ww, yy + hh, xx + ww - rr, yy + hh);
  c.lineTo(xx + rr, yy + hh);
  c.quadraticCurveTo(xx, yy + hh, xx, yy + hh - rr);
  c.lineTo(xx, yy + rr);
  c.quadraticCurveTo(xx, yy, xx + rr, yy);
  c.closePath();
}

/**
 * The tile primitive. Every block in every game is drawn with this, which is
 * what makes eight different titles look like one machine.
 *
 *   mode: 'solid' (default) | 'ghost' | 'glow' | 'flash'
 */
function tile(c, x, y, size, base, top, mode) {
  var s = num(size, 0);
  if (s <= 0) return;
  var px = num(x, 0), py = num(y, 0);
  var b = base || COL.a2;
  var t = top || shade(b, 0.35);
  var m = mode || 'solid';
  var inset = Math.max(0.5, s * 0.055);
  var w = s - inset * 2;
  var r = Math.max(1, s * 0.18);
  if (w <= 0) return;

  if (m === 'ghost') {
    c.globalAlpha = 0.22;
    roundRect(c, px + inset, py + inset, w, w, r);
    c.strokeStyle = b;
    c.lineWidth = Math.max(1, s * 0.07);
    c.stroke();
    c.globalAlpha = 1;
    return;
  }

  if (m === 'glow') Render.glow(c, px + s / 2, py + s / 2, s, b, 0.9);

  var g = c.createLinearGradient(px, py + inset, px, py + inset + w);
  g.addColorStop(0, t);
  g.addColorStop(1, b);
  c.fillStyle = g;
  roundRect(c, px + inset, py + inset, w, w, r);
  c.fill();

  /* Moulded edge: light along the top, shadow along the bottom. */
  c.strokeStyle = rgba(shade(t, 0.45), 0.55);
  c.lineWidth = Math.max(0.6, s * 0.045);
  roundRect(c, px + inset + s * 0.05, py + inset + s * 0.05, w - s * 0.1, w - s * 0.1, r * 0.8);
  c.stroke();

  if (m === 'flash') {
    c.globalAlpha = 0.75;
    c.fillStyle = '#FFFFFF';
    roundRect(c, px + inset, py + inset, w, w, r);
    c.fill();
    c.globalAlpha = 1;
  }
}

/**
 * Wide block, in the same moulded language as tile() but for shapes that are
 * not square — stacker slabs, breakout bricks, rhythm notes. Shares tile()'s
 * gradient and edge treatment so the machine keeps one look.
 */
function slab(c, x, y, w, h, base, top, mode) {
  var ww = num(w, 0), hh = num(h, 0);
  if (ww <= 0 || hh <= 0) return;
  var px = num(x, 0), py = num(y, 0);
  var b = base || COL.a2;
  var t = top || shade(b, 0.35);
  var r = Math.max(1, Math.min(ww, hh) * 0.22);

  if (mode === 'glow') Render.glow(c, px + ww / 2, py + hh / 2, Math.max(ww, hh) * 0.7, b, 0.75);

  var g = c.createLinearGradient(px, py, px, py + hh);
  g.addColorStop(0, t);
  g.addColorStop(1, b);
  c.fillStyle = g;
  roundRect(c, px, py, ww, hh, r);
  c.fill();

  c.strokeStyle = rgba(shade(t, 0.45), 0.5);
  c.lineWidth = Math.max(0.6, Math.min(ww, hh) * 0.06);
  roundRect(c, px + 1, py + 1, ww - 2, hh - 2, r * 0.85);
  c.stroke();

  if (mode === 'flash') {
    c.globalAlpha = 0.7;
    c.fillStyle = '#FFFFFF';
    roundRect(c, px, py, ww, hh, r);
    c.fill();
    c.globalAlpha = 1;
  }
}

/** Card / panel surface, using the design-system surface and hairline. */
function panel(c, x, y, w, h, opts) {
  var o = opts || {};
  var r = num(o.radius, COL.radius);
  roundRect(c, x, y, w, h, r);
  c.fillStyle = o.fill || COL.card;
  c.fill();
  c.strokeStyle = o.stroke || COL.cardLine;
  c.lineWidth = num(o.lineWidth, 1);
  c.stroke();
}

/**
 * Text with optional letter-spacing. Tracking is applied by drawing glyph by
 * glyph: ctx.letterSpacing exists in modern Chromium but not in the harness,
 * and headings are short enough that the loop costs nothing.
 */
function text(c, str, x, y, opts) {
  var o = opts || {};
  var s = String(str == null ? '' : str);
  var size = num(o.size, 24);
  var weight = o.weight || '600';
  var family = o.mono ? FONT_MONO : FONT_SANS;
  var track = num(o.track, 0);
  var align = o.align || 'left';

  c.font = weight + ' ' + size + 'px ' + family;
  c.textBaseline = o.baseline || 'alphabetic';

  var width = measure(c, s, track);
  var startX = num(x, 0);
  if (align === 'center') startX -= width / 2;
  else if (align === 'right') startX -= width;

  var fill = o.color || COL.text;
  if (o.aurora) {
    var g = c.createLinearGradient(startX, 0, startX + Math.max(1, width), 0);
    g.addColorStop(0, COL.a1);
    g.addColorStop(0.5, COL.a2);
    g.addColorStop(1, COL.a3);
    fill = g;
  }
  c.fillStyle = fill;
  c.textAlign = 'left';

  if (track === 0) {
    c.fillText(s, startX, num(y, 0));
  } else {
    var cx = startX;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      c.fillText(ch, cx, num(y, 0));
      cx += textWidth(c, ch) + track;
    }
  }
  return width;
}

function textWidth(c, s) {
  var m;
  try { m = c.measureText(s); } catch (e) { m = null; }
  var w = m && typeof m.width === 'number' && isFinite(m.width) ? m.width : s.length * 8;
  return w;
}

function measure(c, s, track) {
  var t = num(track, 0);
  if (t === 0) return textWidth(c, s);
  var w = 0;
  for (var i = 0; i < s.length; i++) w += textWidth(c, s.charAt(i)) + t;
  return Math.max(0, w - t);
}

/** Mono value text with tabular figures — every score in the machine. */
function dataText(c, str, x, y, opts) {
  var o = opts || {};
  return text(c, str, x, y, {
    size: num(o.size, 20), weight: o.weight || '500', mono: true,
    color: o.color || COL.data, align: o.align || 'left',
    baseline: o.baseline, track: num(o.track, 0),
  });
}

/* ------------------------------------------------------ game chrome --- */

/** Height of the HUD strip games must leave clear at the top of game space. */
var HUD_H = 92;

/**
 * Standard game backdrop: a soft accent wash plus a framed play area. Games
 * call this first in draw() so every title shares the same stage.
 */
function gBackdrop(accent) {
  var c = gx;
  if (!c) return;
  var a = accent || COL.a2;

  /* Vertical accent wash, strongest at the top where the HUD sits. */
  var g = c.createLinearGradient(0, 0, 0, GH);
  g.addColorStop(0, rgba(a, 0.13));
  g.addColorStop(0.45, rgba(a, 0.04));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, GW, GH);

  /* Play-field frame. */
  panel(c, 8, HUD_H - 4, GW - 16, GH - HUD_H - 4, {
    fill: 'rgba(10,8,22,0.42)',
    stroke: rgba(a, 0.16),
    radius: COL.radius,
  });
}

/**
 * Standard HUD strip. `fields` is an array of {label, value} rendered left to
 * right; keep it to three or fewer so it stays readable across the room.
 */
function gHud(accent, fields) {
  var c = gx;
  if (!c) return;
  var a = accent || COL.a2;
  var list = fields || [];

  panel(c, 8, 8, GW - 16, HUD_H - 24, {
    fill: 'rgba(16,12,34,0.55)',
    stroke: rgba(a, 0.18),
    radius: COL.radius,
  });

  var n = Math.max(1, list.length);
  var colW = (GW - 40) / n;
  for (var i = 0; i < list.length; i++) {
    var f = list[i] || {};
    var cx = 20 + colW * i + colW / 2;
    text(c, String(f.label == null ? '' : f.label), cx, 36, {
      size: 13, weight: '600', track: 2.4, color: COL.text2, align: 'center',
    });
    dataText(c, String(f.value == null ? '' : f.value), cx, 60, {
      size: 24, color: f.color || COL.data, align: 'center',
    });
  }
}

/* ----------------------------------------------------------- pools --- */

/**
 * Fixed-capacity object pool. Games use these for particles and bullets so
 * update()/draw() never allocate — GC pauses are visible as dropped frames on
 * a Pi 4 in a way they simply are not on a desktop.
 */
function makePool(factory, capacity) {
  var cap = Math.max(1, capacity | 0);
  var items = new Array(cap);
  for (var i = 0; i < cap; i++) { items[i] = factory(); items[i].alive = false; }
  return {
    items: items,
    capacity: cap,
    /** Returns a dead slot to reinitialise, or null when the pool is full. */
    spawn: function () {
      for (var j = 0; j < cap; j++) {
        if (!items[j].alive) { items[j].alive = true; return items[j]; }
      }
      return null;
    },
    clear: function () { for (var k = 0; k < cap; k++) items[k].alive = false; },
    forEach: function (fn) {
      for (var m = 0; m < cap; m++) if (items[m].alive) fn(items[m], m);
    },
    count: function () {
      var n = 0;
      for (var q = 0; q < cap; q++) if (items[q].alive) n++;
      return n;
    },
  };
}

/** Standard particle burst helpers, shared so debris looks alike everywhere. */
function makeParticles(capacity) {
  var pool = makePool(function () {
    return { alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 3, color: COL.a2 };
  }, capacity || 64);

  pool.burst = function (x, y, count, color, opts) {
    var o = opts || {};
    var spd = num(o.speed, 0.18);
    var spread = num(o.spread, Math.PI * 2);
    var dir = num(o.dir, 0);
    for (var i = 0; i < count; i++) {
      var p = pool.spawn();
      if (!p) return;
      var ang = dir + (rnd() - 0.5) * spread;
      var v = spd * (0.4 + rnd() * 0.9);
      p.x = num(x, 0); p.y = num(y, 0);
      p.vx = Math.cos(ang) * v;
      p.vy = Math.sin(ang) * v;
      p.max = num(o.life, 480) * (0.6 + rnd() * 0.7);
      p.life = p.max;
      p.size = num(o.size, 4) * (0.6 + rnd() * 0.8);
      p.color = color || COL.a2;
    }
  };

  pool.update = function (dt, gravity) {
    var g = num(gravity, 0.00045);
    pool.forEach(function (p) {
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; return; }
      p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    });
  };

  pool.draw = function (c) {
    pool.forEach(function (p) {
      var a = clamp(p.life / p.max, 0, 1);
      c.globalAlpha = a;
      c.fillStyle = p.color;
      var s = Math.max(0.5, p.size * a);
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    });
    c.globalAlpha = 1;
  };

  return pool;
}
