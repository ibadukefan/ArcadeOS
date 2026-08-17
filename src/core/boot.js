/*
 * Entry point and the single requestAnimationFrame loop.
 *
 * One loop drives everything: poll input, update the shell, draw the shell.
 * Games never register their own rAF callbacks, which is what keeps timing
 * consistent and makes the whole front end drivable frame-by-frame from the
 * headless test harness.
 */

var Loop = (function () {
  var last = 0;
  var running = false;
  var rafId = 0;

  /* Frame time is clamped rather than trusted. A Chromium tab that has been
   * throttled (or a harness stepping in big jumps) would otherwise hand a
   * game a 4-second dt and teleport everything through a wall. */
  var MAX_DT = 50;

  function frame(now) {
    if (!running) return;
    var t = num(now, last + 16);
    var dt = last === 0 ? 16 : clamp(t - last, 0, MAX_DT);
    last = t;
    tick(dt);
    rafId = requestAnimationFrame(frame);
  }

  /** One logical frame. Exposed so the harness can drive it directly. */
  function tick(dt) {
    Input.poll(dt);
    Shell.update(dt);
    Shell.draw(dt);
  }

  function start() {
    if (running) return;
    running = true;
    last = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = 0;
  }

  return { start: start, stop: stop, tick: tick, running: function () { return running; } };
})();

function boot() {
  var canvas = document.getElementById('screen');
  if (!canvas) return;

  Render.init(canvas);
  Input.attach(window);
  /* Sample controllers faster than the display refreshes, so a tap shorter
   * than a frame is latched rather than lost. */
  Input.startSampling();

  /* Seed from the clock so two cabinets do not play the same piece sequence,
   * while tests can still pin it with seedRng(). */
  seedRng((Date.now ? Date.now() : 1) & 0x7fffffff);

  Shell.buildMenu();

  if (window.addEventListener) {
    window.addEventListener('resize', function () { Render.resize(); }, false);
    /* Chromium fires this on rotation and on HDMI mode changes. */
    if (window.matchMedia) {
      try {
        var mq = window.matchMedia('(orientation: portrait)');
        if (mq.addEventListener) mq.addEventListener('change', function () { Render.resize(); });
      } catch (e) { /* ignore */ }
    }
    /* Any first interaction unlocks audio. */
    window.addEventListener('pointerdown', function () { Audio2.unlock(); }, false);
  }

  Loop.start();
}

/*
 * Debug handle. The bundle is an IIFE, so without this there is no way to poke
 * at the machine from a console on the Pi — or from the headless harness,
 * which drives these exact objects rather than a parallel copy of them.
 */
if (typeof globalThis !== 'undefined') {
  globalThis.ArcadeOS = {
    Shell: Shell, Input: Input, Audio2: Audio2, Render: Render, Loop: Loop,
    Store: Store, Settings: Settings, Scores: Scores, System: System,
    GAMES: GAMES, VERSUS_GAMES: VERSUS_GAMES, gameById: gameById,
    seedRng: seedRng, rnd: rnd, boot: boot,
    COL: COL, ACCENT: ACCENT, ACTIONS: ACTIONS,
    makeRepeater: makeRepeater, hexRgb: hexRgb, rgba: rgba, shade: shade,
    fmtScore: fmtScore, TOP_N: TOP_N,
    version: '1.0.0',
  };
}

/* The bundle is injected at the end of <body>, so the DOM is already parsed;
 * the readyState check is belt and braces for anyone opening src/ directly. */
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, false);
  } else {
    boot();
  }
}
