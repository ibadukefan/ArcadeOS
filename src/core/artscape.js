/*
 * ARTSCAPE — the silent screensaver. A synthwave arcade dreamscape: a neon
 * grid running to a striped horizon sun under a field of stars, everything
 * drifting and the colour slowly cycling the aurora ramp. No text, no UI —
 * just something worth walking past. Drawn edge to edge in shell space.
 *
 * Pure function of time, so it needs no state and never allocates per frame
 * beyond the gradients the canvas itself makes. Palette comes from COL; it
 * invents nothing.
 */

var Artscape = (function () {
  /* Aurora ramp as parsed rgb triples, so the colour can cross-fade smoothly
   * rather than snapping between the three stops. */
  var RAMP = [hexRgb(COL.a1), hexRgb(COL.a3), hexRgb(COL.a2)];

  function mix(a, b, k) {
    return 'rgb(' +
      Math.round(a[0] + (b[0] - a[0]) * k) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * k) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * k) + ')';
  }
  function mixa(a, b, k, alpha) {
    return 'rgba(' +
      Math.round(a[0] + (b[0] - a[0]) * k) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * k) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * k) + ',' + alpha + ')';
  }

  /** The ramp colour at phase p (0..1 around the loop). */
  function hue(p) {
    var n = RAMP.length;
    var f = ((p % 1) + 1) % 1 * n;
    var i = Math.floor(f);
    return { a: RAMP[i % n], b: RAMP[(i + 1) % n], k: f - i };
  }

  /* Deterministic star field — a cheap hash, so positions are stable frame to
   * frame with no stored array and no RNG. */
  function starAt(i, span) {
    var x = Math.sin(i * 12.9898) * 43758.5453;
    var y = Math.sin(i * 78.233) * 12543.987;
    return {
      x: (x - Math.floor(x)) * span,
      y: (y - Math.floor(y)),
    };
  }

  function draw(c, t) {
    if (!c) return;
    var W = SW, H = SH;
    var horizon = H * 0.52;
    var p = (t * 0.00004);            /* slow colour drift */
    var h = hue(p);

    /* --- Sky: deep vertical gradient, faintly tinted by the current hue. -- */
    var sky = c.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, COL.bgBot);
    sky.addColorStop(0.7, COL.bgMid);
    sky.addColorStop(1, mixa(h.a, h.b, h.k, 0.22));
    c.fillStyle = sky;
    c.fillRect(0, 0, W, horizon);

    /* --- Stars: a static field, each twinkling on its own slow cycle. ------ */
    for (var s = 0; s < 90; s++) {
      var st = starAt(s, W);
      var sy = st.y * horizon * 0.92;
      var tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.002 + s * 1.7));
      var sz = 1 + (s % 3 === 0 ? 1.4 : 0);
      c.globalAlpha = tw * 0.9;
      c.fillStyle = s % 5 === 0 ? mix(h.a, h.b, h.k) : COL.text;
      c.fillRect(st.x, sy, sz, sz);
    }
    c.globalAlpha = 1;

    /* --- The sun: a glowing orb on the horizon, cut by rising bands. ------- */
    var cx = W / 2, cy = horizon - H * 0.02;
    var R = W * 0.30;
    var g = c.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    g.addColorStop(0, mixa(h.a, h.b, h.k, 0.98));
    g.addColorStop(0.55, mixa(h.b, h.a, h.k, 0.6));
    g.addColorStop(1, mixa(h.b, h.a, h.k, 0.0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.fill();
    /* Bands: background-coloured slats across the lower half, widening down,
     * the classic outrun sun. */
    c.fillStyle = COL.bgMid;
    for (var b = 0; b < 7; b++) {
      var by = cy + R * 0.16 + b * (R * 0.11);
      var bh = 4 + b * 2.4;
      if (by > cy + R) break;
      c.fillRect(cx - R, by, R * 2, bh);
    }

    /* --- The grid floor: perspective lines to the vanishing point. -------- */
    c.save();
    c.beginPath();
    c.rect(0, horizon, W, H - horizon);
    c.clip();

    /* Ground wash. */
    var gr = c.createLinearGradient(0, horizon, 0, H);
    gr.addColorStop(0, mixa(h.a, h.b, h.k, 0.10));
    gr.addColorStop(1, COL.bgBot);
    c.fillStyle = gr;
    c.fillRect(0, horizon, W, H - horizon);

    var line = mixa(h.a, h.b, h.k, 0.5);
    c.strokeStyle = line;
    c.lineWidth = 1.5;

    /* Verticals fan out from the vanishing point to the bottom edge. */
    var i;
    for (i = -10; i <= 10; i++) {
      c.beginPath();
      c.moveTo(cx, horizon);
      c.lineTo(cx + i * (W * 0.16), H);
      c.stroke();
    }

    /* Horizontals: denser toward the horizon, scrolling toward the viewer. */
    var scroll = (t * 0.00022) % 1;
    for (i = 1; i <= 14; i++) {
      var f = (i + scroll) / 14;
      var y = horizon + (H - horizon) * f * f;
      c.globalAlpha = clamp(f * 1.2, 0, 1);
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(W, y);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.restore();

    /* Horizon glow line. */
    c.globalAlpha = 0.9;
    c.strokeStyle = mix(h.a, h.b, h.k);
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, horizon);
    c.lineTo(W, horizon);
    c.stroke();
    c.globalAlpha = 1;

    /* --- Vignette: pull the eye to the centre. ---------------------------- */
    var vg = c.createRadialGradient(W / 2, H * 0.5, H * 0.25, W / 2, H * 0.5, H * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(5,4,10,0.66)');
    c.fillStyle = vg;
    c.fillRect(0, 0, W, H);
  }

  return { draw: draw };
})();
