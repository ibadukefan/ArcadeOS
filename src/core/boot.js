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

  /*
   * How much of each frame is OUR work. Frame-to-frame time alone cannot
   * distinguish "the JS is slow" from "the pipeline is slow" — the first
   * cabinet sat at a steady 30ms/frame and this is the number that says
   * which side of the canvas the problem is on. Software canvas raster
   * happens synchronously inside the draw calls, so it shows up here;
   * a GPU-rastered frame leaves this near zero.
   */
  var CPU_N = 60;
  var cpuTimes = new Array(CPU_N);
  for (var ci = 0; ci < CPU_N; ci++) cpuTimes[ci] = 0;
  var cpuAt = 0;
  var dtTimes = new Array(CPU_N);
  for (var di = 0; di < CPU_N; di++) dtTimes[di] = 16.667;
  var dtAt = 0;

  function nowMs() {
    try {
      if (typeof performance !== 'undefined' && performance.now) return performance.now();
    } catch (e) { /* fall through */ }
    return Date.now ? Date.now() : 0;
  }

  function frame(now) {
    if (!running) return;
    var t = num(now, last + 16);
    var dt = last === 0 ? 16 : clamp(t - last, 0, MAX_DT);
    last = t;
    var t0 = nowMs();
    tick(dt);
    cpuTimes[cpuAt] = nowMs() - t0;
    cpuAt = (cpuAt + 1) % CPU_N;
    dtTimes[dtAt] = dt;
    dtAt = (dtAt + 1) % CPU_N;
    rafId = requestAnimationFrame(frame);
  }

  /** Mean/worst over the last second or so, for the overlay and the relay. */
  function perf() {
    var cpuSum = 0, cpuWorst = 0, dtSum = 0, updSum = 0, drwSum = 0;
    for (var i = 0; i < CPU_N; i++) {
      cpuSum += cpuTimes[i];
      if (cpuTimes[i] > cpuWorst) cpuWorst = cpuTimes[i];
      dtSum += dtTimes[i];
      updSum += updTimes[i];
      drwSum += drwTimes[i];
    }
    var dtMean = dtSum / CPU_N;
    return {
      cpuMean: cpuSum / CPU_N,
      cpuWorst: cpuWorst,
      updMean: updSum / CPU_N,
      drwMean: drwSum / CPU_N,
      fps: dtMean > 0 ? 1000 / dtMean : 0,
    };
  }

  /** One logical frame. Exposed so the harness can drive it directly. */
  var clock = 0;

  /* The update/draw split of each frame's cpu time. 12ms of "cpu" says the
   * page is the cost; only the split says whether it is game logic or the
   * paint path — and they get slimmed in completely different ways. */
  var updTimes = new Array(CPU_N);
  for (var ui = 0; ui < CPU_N; ui++) updTimes[ui] = 0;
  var drwTimes = new Array(CPU_N);
  for (var wi = 0; wi < CPU_N; wi++) drwTimes[wi] = 0;
  var splitAt = 0;

  function tick(dt) {
    clock += num(dt, 16);
    var t0 = nowMs();
    Input.poll(dt);
    Shell.update(dt);
    var t1 = nowMs();
    Shell.draw(dt);
    updTimes[splitAt] = t1 - t0;
    drwTimes[splitAt] = nowMs() - t1;
    splitAt = (splitAt + 1) % CPU_N;
    /* Last thing in the frame: proof that a whole frame completed. */
    System.heartbeat(clock);
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

  return {
    start: start, stop: stop, tick: tick, perf: perf,
    running: function () { return running; },
  };
})();

/*
 * Remote eyes. Chromium's stderr never reached the kiosk unit's journal on
 * the real cabinet, so the front end reports through the agent instead:
 *   journalctl -u arcadeos-agent | grep frontend
 * One line shortly after boot (GPU, geometry), then a heartbeat-style perf
 * line every minute. Armed only where fetch exists — a cabinet — so the
 * test harness never leaks a timer.
 */
/**
 * One-shot canvas raster benchmark. Our per-frame cpu number cannot see
 * where 2D canvas raster actually happens: paint commands are recorded on
 * the main thread and rastered later on Chromium's raster threads — in
 * software, invisibly, if canvas acceleration is off. The cabinet sat at a
 * hard 30fps with only 6ms of visible cpu; this measures the invisible
 * part. Twenty full-surface fills forced to completion: GPU raster lands
 * well under ~15ms, software takes several times that.
 */
var benchRan = false;
var benchMs = -1;
function canvasBench() {
  if (benchRan) return benchMs;
  benchRan = true;
  try {
    if (typeof document === 'undefined' || !document.createElement) return benchMs;
    var s = Render.size();
    var cv = document.createElement('canvas');
    cv.width = Math.max(64, Math.min(s.dw || 1280, 2048));
    cv.height = Math.max(64, Math.min(s.dh || 720, 2048));
    var x = cv.getContext('2d');
    if (!x || typeof x.fillRect !== 'function' ||
        typeof x.getImageData !== 'function') return benchMs;
    var now = (typeof performance !== 'undefined' && performance.now)
      ? function () { return performance.now(); }
      : function () { return Date.now ? Date.now() : 0; };
    var t0 = now();
    for (var i = 0; i < 20; i++) {
      x.fillStyle = (i & 1) ? '#123456' : '#654321';
      x.fillRect(0, 0, cv.width, cv.height);
    }
    x.getImageData(0, 0, 1, 1); /* forces every queued fill to raster */
    benchMs = now() - t0;
  } catch (e) { /* a probe must never hurt the cabinet */ }
  return benchMs;
}

function armDiagRelay() {
  if (typeof fetch !== 'function') return;
  var t0 = Date.now ? Date.now() : 0;

  function line() {
    var s = Render.size();
    var p = Loop.perf();
    var up = t0 && Date.now ? Math.round((Date.now() - t0) / 1000) : 0;
    var bench = canvasBench();
    return 'diag up=' + up + 's gpu="' + Render.gpuInfo() + '"' +
      ' dev=' + s.dw + 'x' + s.dh + ' rot=' + s.rot +
      ' scale=' + s.scale.toFixed(3) +
      ' state=' + Shell.state() +
      ' fps=' + p.fps.toFixed(1) +
      ' cpu=' + p.cpuMean.toFixed(1) + 'ms' +
      ' upd=' + p.updMean.toFixed(1) + ' drw=' + p.drwMean.toFixed(1) +
      (bench >= 0 ? ' raster20=' + Math.round(bench) + 'ms' : '') +
      ' video=' + (Render.lowLatency() ? 'low-lat' : 'normal');
  }

  function report() {
    try { System.log(line()); } catch (e) { /* diagnostics stay harmless */ }
  }

  /* First line once real frames exist, then a minute-ly heartbeat. Nothing
   * fires during a test's lifetime, so fetch-counting tests stay exact; the
   * console (and tests) can force a line with ArcadeOS._diag(). */
  if (typeof setTimeout === 'function') setTimeout(report, 12000);
  if (typeof setInterval === 'function') setInterval(report, 60000);
  if (typeof globalThis !== 'undefined' && globalThis.ArcadeOS) {
    globalThis.ArcadeOS._diag = report;
  }
}

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
  armDiagRelay();
}

/*
 * Debug handle. The bundle is an IIFE, so without this there is no way to poke
 * at the machine from a console on the Pi — or from the headless harness,
 * which drives these exact objects rather than a parallel copy of them.
 */
if (typeof globalThis !== 'undefined') {
  globalThis.ArcadeOS = {
    Shell: Shell, Input: Input, Audio2: Audio2, Render: Render, Loop: Loop,
    Store: Store, Settings: Settings, Scores: Scores, Faults: Faults,
    System: System,
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
