/*
 * Headless harness: a mock DOM, a mock canvas 2D context, and a mock gamepad
 * API, wired up so the real bundle runs unmodified in Node.
 *
 * THE MOCK CONTEXT ASSERTS ON EVERY DRAW CALL. That is the entire point of it.
 * Two shipped bugs were caught by exactly these checks:
 *
 *   1. An rgb() string was fed back into a hex parser, producing "#NaNNaNNaN"
 *      colour stops that threw inside addColorStop at runtime. Rejecting any
 *      colour containing NaN/undefined catches that class of bug the moment
 *      it is drawn, not when a user reaches the screen that draws it.
 *   2. A menu auto-repeat driven by frame counters scrolled at different
 *      speeds on 60Hz and 144Hz panels. Varying dt across frames and asserting
 *      on step counts catches that.
 *
 * A violation throws immediately with the offending value, so the failing
 * draw call is the top of the stack trace.
 */
'use strict';

const vm = require('vm');
const path = require('path');
const { bundleJs } = require('../build.js');

/* ------------------------------------------------------------- asserts --- */

class DrawViolation extends Error {}

function isBadColorString(v) {
  if (typeof v !== 'string') return false;
  return /nan|undefined|null/i.test(v);
}

/** Colours may be strings or gradient/pattern objects; both are validated. */
function checkColor(where, v) {
  if (v == null) {
    throw new DrawViolation(`${where}: colour is ${v}`);
  }
  if (typeof v === 'string') {
    if (isBadColorString(v)) {
      throw new DrawViolation(`${where}: invalid colour string ${JSON.stringify(v)}`);
    }
    return;
  }
  if (typeof v === 'object' && (v.__gradient || v.__pattern)) return;
  throw new DrawViolation(`${where}: unusable fill/stroke value ${String(v)}`);
}

function checkFinite(where, ...vals) {
  for (const v of vals) {
    if (typeof v !== 'number' || !isFinite(v)) {
      throw new DrawViolation(`${where}: non-finite coordinate ${String(v)}`);
    }
  }
}

/* ------------------------------------------------------- mock context --- */

class MockGradient {
  constructor(where) {
    this.__gradient = true;
    this.stops = [];
    this.where = where;
  }
  addColorStop(offset, color) {
    if (typeof offset !== 'number' || !isFinite(offset) || offset < 0 || offset > 1) {
      throw new DrawViolation(`addColorStop: offset out of range: ${String(offset)}`);
    }
    /* The real addColorStop throws a SyntaxError on an unparseable colour.
     * Reproduce that here so the harness fails where the browser would. */
    if (typeof color !== 'string' || isBadColorString(color)) {
      throw new DrawViolation(`addColorStop: invalid colour ${JSON.stringify(color)}`);
    }
    this.stops.push([offset, color]);
  }
}

class MockContext {
  constructor(canvas, stats) {
    this.canvas = canvas;
    this.stats = stats;
    this._fillStyle = '#000000';
    this._strokeStyle = '#000000';
    this._globalAlpha = 1;
    this.lineWidth = 1;
    this.font = '10px sans-serif';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.shadowBlur = 0;
    this.shadowColor = 'transparent';
    this.globalCompositeOperation = 'source-over';
    this.letterSpacing = '0px';
    this._stack = [];
    this._depth = 0;
  }

  get fillStyle() { return this._fillStyle; }
  set fillStyle(v) { checkColor('fillStyle', v); this._fillStyle = v; }

  get strokeStyle() { return this._strokeStyle; }
  set strokeStyle(v) { checkColor('strokeStyle', v); this._strokeStyle = v; }

  get globalAlpha() { return this._globalAlpha; }
  set globalAlpha(v) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1) {
      throw new DrawViolation(`globalAlpha out of range: ${String(v)}`);
    }
    this._globalAlpha = v;
  }

  save() {
    this._depth++;
    this._stack.push({
      fillStyle: this._fillStyle, strokeStyle: this._strokeStyle,
      globalAlpha: this._globalAlpha, lineWidth: this.lineWidth, font: this.font,
    });
    if (this._depth > 64) throw new DrawViolation('save() depth exceeded 64 — unbalanced save/restore');
  }

  restore() {
    this._depth--;
    if (this._depth < 0) throw new DrawViolation('restore() without matching save()');
    const s = this._stack.pop();
    if (s) {
      this._fillStyle = s.fillStyle; this._strokeStyle = s.strokeStyle;
      this._globalAlpha = s.globalAlpha; this.lineWidth = s.lineWidth; this.font = s.font;
    }
  }

  setTransform(a, b, c, d, e, f) { checkFinite('setTransform', a, b, c, d, e, f); }
  transform(a, b, c, d, e, f) { checkFinite('transform', a, b, c, d, e, f); }
  translate(x, y) { checkFinite('translate', x, y); }
  scale(x, y) {
    checkFinite('scale', x, y);
    if (x === 0 || y === 0) throw new DrawViolation('scale by zero collapses the transform');
  }
  rotate(a) { checkFinite('rotate', a); }
  resetTransform() {}

  beginPath() { this._pathOps = 0; }
  closePath() {}
  moveTo(x, y) { checkFinite('moveTo', x, y); }
  lineTo(x, y) { checkFinite('lineTo', x, y); }
  quadraticCurveTo(a, b, c, d) { checkFinite('quadraticCurveTo', a, b, c, d); }
  bezierCurveTo(a, b, c, d, e, f) { checkFinite('bezierCurveTo', a, b, c, d, e, f); }
  arc(x, y, r, s, e) {
    checkFinite('arc', x, y, r, s, e);
    if (r < 0) throw new DrawViolation(`arc: negative radius ${r}`);
  }
  arcTo(a, b, c, d, r) { checkFinite('arcTo', a, b, c, d, r); }
  rect(x, y, w, h) { checkFinite('rect', x, y, w, h); }
  ellipse(x, y, rx, ry, rot, s, e) { checkFinite('ellipse', x, y, rx, ry, rot, s, e); }
  clip() {}

  fill() { checkColor('fill', this._fillStyle); this.stats.fills++; }
  stroke() {
    checkColor('stroke', this._strokeStyle);
    if (typeof this.lineWidth !== 'number' || !isFinite(this.lineWidth) || this.lineWidth < 0) {
      throw new DrawViolation(`stroke: invalid lineWidth ${String(this.lineWidth)}`);
    }
    this.stats.strokes++;
  }
  fillRect(x, y, w, h) {
    checkFinite('fillRect', x, y, w, h);
    checkColor('fillRect', this._fillStyle);
    this.stats.fills++;
  }
  strokeRect(x, y, w, h) {
    checkFinite('strokeRect', x, y, w, h);
    checkColor('strokeRect', this._strokeStyle);
    this.stats.strokes++;
  }
  clearRect(x, y, w, h) { checkFinite('clearRect', x, y, w, h); }

  fillText(s, x, y) {
    checkFinite('fillText', x, y);
    checkColor('fillText', this._fillStyle);
    if (typeof s !== 'string') throw new DrawViolation(`fillText: non-string ${String(s)}`);
    if (/NaN|undefined/.test(s)) {
      throw new DrawViolation(`fillText: text contains NaN/undefined: ${JSON.stringify(s)}`);
    }
    this.stats.texts++;
  }
  strokeText(s, x, y) { this.fillText(s, x, y); }

  measureText(s) {
    const str = String(s == null ? '' : s);
    /* Deterministic, roughly proportional to the current font size. */
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
    const size = m ? parseFloat(m[1]) : 10;
    return { width: str.length * size * 0.55 };
  }

  createLinearGradient(x0, y0, x1, y1) {
    checkFinite('createLinearGradient', x0, y0, x1, y1);
    return new MockGradient('linear');
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    checkFinite('createRadialGradient', x0, y0, r0, x1, y1, r1);
    if (r0 < 0 || r1 < 0) throw new DrawViolation('createRadialGradient: negative radius');
    return new MockGradient('radial');
  }
  createPattern() { return { __pattern: true }; }

  drawImage(img, ...rest) {
    if (!img) throw new DrawViolation('drawImage: null image');
    checkFinite('drawImage', ...rest);
    /* Chromium throws IndexSizeError on a zero-dimension source. */
    if (img.width === 0 || img.height === 0) {
      throw new DrawViolation('drawImage: zero-dimension source canvas');
    }
    this.stats.images++;
  }

  getImageData(x, y, w, h) {
    checkFinite('getImageData', x, y, w, h);
    return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
  }
  putImageData() {}
}

/* -------------------------------------------------------- mock canvas --- */

class MockCanvas {
  constructor(stats) {
    this.width = 300;
    this.height = 150;
    this.style = {};
    this.id = '';
    this.parentNode = null;
    /** Whatever attributes the app requested, for the low-latency tests. */
    this.contextAttrs = null;
    this._ctx = new MockContext(this, stats);
  }
  getContext(type, attrs) {
    if (attrs) this.contextAttrs = attrs;
    return this._ctx;
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

/* -------------------------------------------------------- environment --- */

/**
 * Build a sandbox with a mock DOM, canvas, gamepad API and rAF.
 *
 * opts:
 *   width, height     viewport size (default 1080x1920)
 *   storage           'ok' | 'throwing' | 'absent' | Map-like seed object
 *   gamepads          array of mock gamepad objects
 */
function makeEnv(opts = {}) {
  const stats = { fills: 0, strokes: 0, texts: 0, images: 0, frames: 0 };
  const canvases = [];

  function newCanvas() {
    const c = new MockCanvas(stats);
    canvases.push(c);
    return c;
  }

  let screen = newCanvas();
  /* Minimal parent so Render.rebuild() can swap the canvas element the way
   * it does in a real DOM. */
  const parent = {
    replaceChild(fresh, old) {
      fresh.parentNode = parent;
      old.parentNode = null;
      screen = fresh;
    },
  };
  screen.parentNode = parent;
  screen.id = 'screen';

  const document = {
    readyState: 'complete',
    getElementById: (id) => (id === 'screen' ? screen : null),
    createElement: (tag) => {
      if (String(tag).toLowerCase() === 'canvas') {
        const c = newCanvas();
        c.parentNode = parent;
        return c;
      }
      return { style: {}, addEventListener() {}, appendChild() {} };
    },
    addEventListener() {},
    removeEventListener() {},
    body: { appendChild() {}, style: {} },
  };

  /* --- localStorage variants ---------------------------------------- */
  let localStorage;
  if (opts.storage === 'absent') {
    localStorage = undefined;
  } else if (opts.storage === 'throwing') {
    localStorage = {
      getItem() { throw new Error('SecurityError: storage is disabled'); },
      setItem() { throw new Error('SecurityError: storage is disabled'); },
      removeItem() { throw new Error('SecurityError: storage is disabled'); },
    };
  } else {
    const map = new Map();
    if (opts.storage && typeof opts.storage === 'object') {
      for (const [k, v] of Object.entries(opts.storage)) map.set(k, v);
    }
    localStorage = {
      _map: map,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
      clear: () => map.clear(),
    };
  }

  /* --- gamepads ------------------------------------------------------ */
  let gamepads = opts.gamepads || [];

  const listeners = {};
  const window = {
    innerWidth: opts.width || 1080,
    innerHeight: opts.height || 1920,
    devicePixelRatio: opts.dpr || 1,
    localStorage,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    /* No AudioContext: exercises the silent-degradation path by default. */
    AudioContext: opts.audio ? function FakeAudioContext(options) {
      sandbox.__audioLatencyHint = options && options.latencyHint;
      this.baseLatency = 0.005;
      this.outputLatency = 0.010;
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = {};
      this.createGain = () => ({ gain: { value: 0, setValueAtTime() {}, setTargetAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} });
      this.createOscillator = () => ({ type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, detune: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} });
      this.createBiquadFilter = () => ({ type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, Q: { value: 1 }, connect() {} });
      this.createBufferSource = () => ({ buffer: null, connect() {}, start() {}, stop() {} });
      this.createBuffer = (ch, len) => ({ getChannelData: () => new Float32Array(len) });
      this.resume = () => {};
    } : undefined,
  };

  const navigator = {
    userAgent: 'ArcadeOS-Harness',
    getGamepads: () => gamepads,
  };

  /* rAF is never actually pumped — the harness calls Loop.tick directly so
   * frame timing is fully under test control. */
  let rafSeq = 1;
  const sandbox = {
    window, document, navigator, localStorage,
    requestAnimationFrame: () => rafSeq++,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    /* The input sampler runs on an interval. Tests that start it must stop
     * it; timers are unref'd so a leak cannot hold the process open. */
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      if (h && h.unref) h.unref();
      return h;
    },
    clearInterval: (h) => clearInterval(h),
    console,
    Math, JSON, Date, Object, Array, String, Number, Boolean, Error,
    Int8Array, Int16Array, Uint8Array, Uint8ClampedArray, Int32Array,
    Uint16Array, Uint32Array, Float32Array, Float64Array,
    isFinite, isNaN, parseInt, parseFloat, encodeURIComponent,
    fetch: opts.fetch,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  const code = bundleJs();
  vm.runInContext(code, sandbox, { filename: 'dist/arcade.bundle.js' });

  /*
   * boot() starts the 250Hz input sampler. Leave it running and every test
   * environment would keep a live timer firing between assertions, making the
   * suite nondeterministic and slow. Tests drive Input.sample() explicitly
   * instead; pass {sampling: true} to exercise the timer itself.
   */
  if (!opts.sampling && sandbox.ArcadeOS && sandbox.ArcadeOS.Input) {
    sandbox.ArcadeOS.Input.stopSampling();
  }

  return {
    sandbox,
    stats,
    canvases,
    get screen() { return screen; },
    listeners,
    fireKey(code2, isDown) {
      const type = isDown ? 'keydown' : 'keyup';
      (listeners[type] || []).forEach((fn) => fn({ code: code2, preventDefault() {} }));
    },
    setGamepads(list) { gamepads = list; },
    getStorage() { return localStorage; },
    /** The bundle is an IIFE; boot.js publishes this handle to reach inside. */
    api() { return sandbox.ArcadeOS; },
    g(name) { return sandbox.ArcadeOS ? sandbox.ArcadeOS[name] : undefined; },
    /** Advance one logical frame with an explicit dt. */
    tick(dt) { sandbox.ArcadeOS.Loop.tick(dt); stats.frames++; },
    /**
     * Poll input only, without running the shell.
     *
     * Input-layer tests need this: the shell consumes edges (Input.flush() on
     * every state transition), so asserting on Input.hit() after a full tick
     * measures the shell, not the input layer.
     */
    pollOnly(dt) { sandbox.ArcadeOS.Input.poll(dt); },
  };
}

/* ---------------------------------------------------------- gamepads --- */

/** Build a standard-mapping mock gamepad. */
function makePad(id, opts = {}) {
  const buttons = new Array(17).fill(null).map(() => ({ pressed: false, value: 0 }));
  const axes = [0, 0, 0, 0];
  return {
    id,
    index: opts.index || 0,
    connected: true,
    mapping: 'standard',
    buttons,
    axes,
    vibrationActuator: opts.rumble ? { playEffect: () => Promise.resolve() } : undefined,
    press(i) { buttons[i].pressed = true; buttons[i].value = 1; return this; },
    release(i) { buttons[i].pressed = false; buttons[i].value = 0; return this; },
    setAxis(i, v) { axes[i] = v; return this; },
    releaseAll() { buttons.forEach((b) => { b.pressed = false; b.value = 0; }); axes.fill(0); return this; },
  };
}

const PAD_IDS = {
  xbox: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)',
  playstation: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
  nintendo: 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)',
  nintendoName: 'Nintendo Switch Pro Controller',
  unknown: 'USB Encoder (STANDARD GAMEPAD Vendor: 0e8f Product: 0003)',
};

module.exports = { makeEnv, makePad, PAD_IDS, DrawViolation, MockContext, MockCanvas };
