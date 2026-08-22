/*
 * Shared constants, design tokens and small helpers.
 *
 * Everything downstream reads its colours from COL / ACCENT — no module is
 * allowed to invent one. Keeping the palette in a single frozen object is what
 * stops the front end drifting as games get added.
 */

/** Game logical space. Games never see real pixels. */
var GW = 600;
var GH = 1000;

/** Shell logical space — a 1080x1920 portrait panel. */
var SW = 1080;
var SH = 1920;

/** Design tokens. Do not add colours here without a design decision. */
var COL = {
  /* Backdrop stops for the radial gradient. */
  bgTop: '#1D1748',
  bgMid: '#0D0A1F',
  bgBot: '#07050E',

  /* Aurora ramp — wordmark, headings, selection glow. */
  a1: '#37E1C4',
  a2: '#8B7BF0',
  a3: '#F06CC9',

  /* Card surface + hairline border. */
  card: 'rgba(22,18,46,.52)',
  cardLine: 'rgba(140,150,255,.10)',
  radius: 16,

  /* Type. */
  text: '#EFEDFF',
  text2: '#8A85BC',
  dim: '#6E6AA0',
  data: '#B9B4E8',

  /* Semantic. */
  warn: '#F0954E',
  bad: '#F0645E',
  good: '#46CE7A',
};

/** Per-game accent colours. */
var ACCENT = {
  tetris: '#8B7BF0',
  ascent: '#37E1C4',
  stack: '#F06CC9',
  snake: '#46CE7A',
  breakout: '#F0C64E',
  climb: '#5B7BF0',
  pulse: '#34D3E0',
  drop: '#F0645E',
  versus: '#A46BF0',
  /* New games reuse existing palette stops — no colour is ever invented. */
  merge: '#F0C64E',   /* breakout's gold */
  flap: '#34D3E0',    /* pulse's cyan */
  words: '#37E1C4',   /* aurora teal */
  mines: '#5B7BF0',   /* climb's blue */
};

/**
 * Tetromino colours, each as [base, top]. The lighter top stop is what gives
 * every tile its moulded look through tile().
 */
var PIECE_COL = {
  I: ['#34D3E0', '#7FE9F2'],
  O: ['#F0C64E', '#F7DE93'],
  T: ['#A46BF0', '#C9A5F7'],
  S: ['#46CE7A', '#8AE4AB'],
  Z: ['#F0645E', '#F79E9A'],
  J: ['#5B7BF0', '#94ABF7'],
  L: ['#F0954E', '#F7BC8E'],
};

var FONT_SANS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "DejaVu Sans", Arial, sans-serif';
var FONT_MONO =
  'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

/* ---------------------------------------------------------------- math --- */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

/** Frame-rate independent exponential approach. `rate` is per-second. */
function approach(cur, target, rate, dt) {
  var k = 1 - Math.exp(-rate * (dt / 1000));
  return cur + (target - cur) * k;
}

/** Guard against a NaN leaking into a coordinate and poisoning a draw call. */
function num(v, fallback) {
  return typeof v === 'number' && isFinite(v) ? v : (fallback || 0);
}

/**
 * Parse #rgb / #rrggbb into [r,g,b].
 *
 * Returns null for anything else. Callers MUST handle null rather than
 * assuming a shape — feeding an `rgb()` string back into a hex parser is
 * exactly the bug that produced NaN colour stops and threw inside
 * addColorStop, so this never guesses.
 */
function hexRgb(hex) {
  if (typeof hex !== 'string') return null;
  var s = hex.trim();
  if (s.charAt(0) !== '#') return null;
  if (s.length === 4) {
    var r = parseInt(s.charAt(1) + s.charAt(1), 16);
    var g = parseInt(s.charAt(2) + s.charAt(2), 16);
    var b = parseInt(s.charAt(3) + s.charAt(3), 16);
    return isFinite(r + g + b) ? [r, g, b] : null;
  }
  if (s.length === 7) {
    var rr = parseInt(s.slice(1, 3), 16);
    var gg = parseInt(s.slice(3, 5), 16);
    var bb = parseInt(s.slice(5, 7), 16);
    return isFinite(rr + gg + bb) ? [rr, gg, bb] : null;
  }
  return null;
}

/**
 * Last-resort colour. rgba()/shade() return this rather than undefined when
 * handed something unusable, because the alternative is an `undefined`
 * reaching ctx.fillStyle — which paints nothing and silently blanks whatever
 * was being drawn. In-palette so a bug degrades quietly instead of screaming.
 */
var FALLBACK_COL = '#8B7BF0';

/**
 * Colour with alpha. Accepts hex or an existing rgb()/rgba() string; a
 * non-hex string is passed through untouched rather than mangled, and a
 * non-string never escapes as one.
 */
function rgba(color, alpha) {
  var c = hexRgb(color);
  var a = clamp(num(alpha, 1), 0, 1);
  if (!c) return (typeof color === 'string' && color) ? color : FALLBACK_COL;
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
}

/** Blend towards white (t>0) or black (t<0). Returns a hex string. */
function shade(color, t) {
  var c = hexRgb(color);
  if (!c) return (typeof color === 'string' && color) ? color : FALLBACK_COL;
  var to = t >= 0 ? 255 : 0;
  var k = Math.abs(clamp(num(t, 0), -1, 1));
  var out = '#';
  for (var i = 0; i < 3; i++) {
    var v = Math.round(lerp(c[i], to, k));
    out += ('0' + clamp(v, 0, 255).toString(16)).slice(-2);
  }
  return out;
}

/* ------------------------------------------------------------- random --- */

/**
 * Seedable PRNG (mulberry32). The whole front end draws from this so a failing
 * test can be replayed exactly from its seed.
 */
function makeRng(seed) {
  var a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

var _rng = makeRng(0x9E3779B9);

/** Reseed the global stream. Tests call this; production seeds from the clock. */
function seedRng(seed) { _rng = makeRng(seed); }

function rnd() { return _rng(); }
function rndRange(lo, hi) { return lo + _rng() * (hi - lo); }
function rndInt(lo, hi) { return Math.floor(lo + _rng() * (hi - lo + 1)); }
function pick(arr) { return arr[Math.floor(_rng() * arr.length) % arr.length]; }

/* ------------------------------------------------------------ formats --- */

/** Score formatting with thin separators, always tabular width. */
function fmtScore(n) {
  var v = Math.max(0, Math.floor(num(n, 0)));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pad(n, width) {
  var s = String(Math.floor(num(n, 0)));
  while (s.length < width) s = '0' + s;
  return s;
}

/* ---------------------------------------------------------- repeater --- */

/**
 * Time-based auto-repeat, for games that need their own DAS timings rather
 * than the shell's menu cadence (Tetris wants ~170/50ms, a menu wants
 * 360/120ms). Millisecond driven, never frame counted, so it behaves
 * identically at 30, 60 or 144Hz.
 */
function makeRepeater(delay, rate) {
  var d = num(delay, 360);
  var r = num(rate, 120);
  var timer = 0;
  var wasDown = false;
  return {
    /** Returns how many steps to take this frame (0, 1 or more). */
    step: function (isDown, dt) {
      var ms = num(dt, 16);
      if (!isDown) { timer = 0; wasDown = false; return 0; }
      if (!wasDown) { wasDown = true; timer = d; return 1; }
      timer -= ms;
      var n = 0;
      while (timer <= 0 && n < 8) { n++; timer += r; }
      if (n >= 8) timer = r;
      return n;
    },
    reset: function () { timer = 0; wasDown = false; },
  };
}

/* ----------------------------------------------------------- registry --- */

/**
 * Game registry. Each game module pushes its object here at load time; the
 * shell reads GAMES to build the dashboard. Order here is dashboard order.
 */
var GAMES = [];

/** Games playable head-to-head only; hidden from the normal dashboard. */
var VERSUS_GAMES = [];

function registerGame(game) {
  GAMES.push(game);
  return game;
}

function registerVersus(game) {
  VERSUS_GAMES.push(game);
  return game;
}

function gameById(id) {
  for (var i = 0; i < GAMES.length; i++) if (GAMES[i].id === id) return GAMES[i];
  for (var j = 0; j < VERSUS_GAMES.length; j++) if (VERSUS_GAMES[j].id === id) return VERSUS_GAMES[j];
  return null;
}
