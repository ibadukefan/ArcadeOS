/*
 * Guarded persistence.
 *
 * localStorage works on the Pi but throws outright in sandboxed preview
 * contexts (and in Chromium when cookies are blocked for file:// origins).
 * Every access in the whole front end goes through here: one try/catch, one
 * in-memory fallback, one schema validator. A storage failure degrades to a
 * session-only cabinet — it never breaks a game.
 */

var Store = (function () {
  var NS = 'arcadeos';
  var VERSION = 1;

  /** In-memory mirror. Always authoritative during a session. */
  var mem = Object.create(null);
  /** null until probed. */
  var backend = undefined;
  var lastError = null;

  function key(name) { return NS + ':v' + VERSION + ':' + name; }

  /**
   * Probe for a usable backend exactly once. Chromium can expose
   * window.localStorage yet throw on the first read, so we round-trip a
   * canary rather than trusting the property's existence.
   */
  function be() {
    if (backend !== undefined) return backend;
    backend = null;
    try {
      var ls = (typeof window !== 'undefined') ? window.localStorage : null;
      if (ls) {
        var probe = key('__probe');
        ls.setItem(probe, '1');
        if (ls.getItem(probe) === '1') backend = ls;
        ls.removeItem(probe);
      }
    } catch (e) {
      lastError = e;
      backend = null;
    }
    return backend;
  }

  function readRaw(name) {
    var b = be();
    if (!b) return null;
    try { return b.getItem(key(name)); } catch (e) { lastError = e; return null; }
  }

  function writeRaw(name, str) {
    var b = be();
    if (!b) return false;
    try { b.setItem(key(name), str); return true; }
    catch (e) { lastError = e; return false; }
  }

  /**
   * Read and parse a record. `validate` gets the parsed value and must return
   * a well-formed value or null; anything that throws, fails to parse, or
   * fails validation falls back to `fallback`. Corrupt records are never
   * allowed to reach the rest of the app.
   */
  function get(name, fallback, validate) {
    if (name in mem) return mem[name];
    var raw = readRaw(name);
    var out = fallback;
    if (raw != null) {
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (parsed != null) {
        var checked = null;
        try { checked = validate ? validate(parsed) : parsed; }
        catch (e2) { checked = null; }
        if (checked != null) out = checked;
      }
    }
    mem[name] = out;
    return out;
  }

  function set(name, value) {
    mem[name] = value;
    var str;
    try { str = JSON.stringify(value); }
    catch (e) { lastError = e; return false; }
    return writeRaw(name, str);
  }

  function remove(name) {
    delete mem[name];
    var b = be();
    if (!b) return false;
    try { b.removeItem(key(name)); return true; }
    catch (e) { lastError = e; return false; }
  }

  return {
    get: get,
    set: set,
    remove: remove,
    /** True when writes actually survive a reboot. Surfaced in settings. */
    persistent: function () { return !!be(); },
    lastError: function () { return lastError; },
    /** Test seam: drop the memoised backend and cache. */
    _reset: function () { mem = Object.create(null); backend = undefined; lastError = null; },
    _key: key,
    VERSION: VERSION,
  };
})();

/* ------------------------------------------------------------ settings --- */

var SETTINGS_DEFAULTS = {
  volume: 0.7,
  muted: false,
  /** 'auto' | 'xbox' | 'playstation' | 'nintendo' */
  layout: 'auto',
  crt: true,
  reducedMotion: false,
  /* On-cabinet frame timer. Off by default; the only way to confirm 60fps
   * on real hardware without attaching a debugger to a kiosk. */
  showFps: false,
  /* Low-latency (desynchronized) canvas. On by default because it is the
   * biggest single latency win; a setting because a few drivers tear. */
  lowLatency: true,
};

var Settings = (function () {
  var cur = null;

  /** Coerce every field independently so one bad value cannot poison the rest. */
  function validate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var out = {};
    out.volume = (typeof raw.volume === 'number' && isFinite(raw.volume))
      ? clamp(raw.volume, 0, 1) : SETTINGS_DEFAULTS.volume;
    out.muted = raw.muted === true;
    out.layout = (raw.layout === 'xbox' || raw.layout === 'playstation' ||
      raw.layout === 'nintendo') ? raw.layout : 'auto';
    out.crt = raw.crt !== false;
    out.reducedMotion = raw.reducedMotion === true;
    out.showFps = raw.showFps === true;
    out.lowLatency = raw.lowLatency !== false;
    return out;
  }

  function all() {
    if (!cur) {
      var loaded = Store.get('settings', null, validate);
      cur = loaded || {};
      for (var k in SETTINGS_DEFAULTS) {
        if (!(k in cur)) cur[k] = SETTINGS_DEFAULTS[k];
      }
    }
    return cur;
  }

  function get(name) { return all()[name]; }

  function set(name, value) {
    var s = all();
    s[name] = value;
    Store.set('settings', s);
    if (name === 'volume' || name === 'muted') audioRefresh();
    if (name === 'lowLatency') renderRebuild();
    return value;
  }

  function reset() {
    cur = null;
    Store.remove('settings');
    audioRefresh();
    return all();
  }

  /* Audio2 and Render load after storage in the bundle; both of these are
   * only reachable post-boot. */
  function audioRefresh() {
    if (typeof Audio2 !== 'undefined' && Audio2) Audio2.refresh();
  }

  function renderRebuild() {
    if (typeof Render !== 'undefined' && Render && Render.rebuild) Render.rebuild();
  }

  return { all: all, get: get, set: set, reset: reset, _validate: validate };
})();

/* --------------------------------------------------------- high scores --- */

var TOP_N = 5;

var Scores = (function () {
  var cache = null;

  /** A name is exactly three A-Z characters. Anything else is repaired. */
  function cleanName(v) {
    var s = (typeof v === 'string' ? v : '').toUpperCase().replace(/[^A-Z]/g, '');
    while (s.length < 3) s += 'A';
    return s.slice(0, 3);
  }

  function cleanEntry(e) {
    if (!e || typeof e !== 'object') return null;
    var score = Number(e.score);
    if (!isFinite(score) || score < 0) return null;
    return {
      name: cleanName(e.name),
      score: Math.floor(score),
      at: (typeof e.at === 'number' && isFinite(e.at)) ? e.at : 0,
    };
  }

  /**
   * Validate the whole table. Partial records are dropped individually rather
   * than discarding an entire game's history — a truncated write should cost
   * you one row, not the leaderboard.
   */
  function validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var out = {};
    for (var id in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
      var list = raw[id];
      if (!Array.isArray(list)) continue;
      var clean = [];
      for (var i = 0; i < list.length; i++) {
        var e = cleanEntry(list[i]);
        if (e) clean.push(e);
      }
      clean.sort(function (a, b) { return b.score - a.score; });
      out[id] = clean.slice(0, TOP_N);
    }
    return out;
  }

  function all() {
    if (!cache) cache = Store.get('scores', {}, validate) || {};
    return cache;
  }

  function table(gameId) {
    var t = all()[gameId];
    return Array.isArray(t) ? t : [];
  }

  function best(gameId) {
    var t = table(gameId);
    return t.length ? t[0].score : 0;
  }

  /** True when `score` would earn a place in the table. */
  function qualifies(gameId, score) {
    var s = Math.floor(num(score, 0));
    if (s <= 0) return false;
    var t = table(gameId);
    if (t.length < TOP_N) return true;
    return s > t[t.length - 1].score;
  }

  /** Insert and persist. Returns the 0-based rank, or -1 if it did not place. */
  function submit(gameId, score, name, now) {
    var s = Math.floor(num(score, 0));
    if (s <= 0) return -1;
    var t = table(gameId).slice();
    t.push({ name: cleanName(name), score: s, at: num(now, 0) });
    t.sort(function (a, b) { return b.score - a.score || a.at - b.at; });
    t = t.slice(0, TOP_N);
    var data = all();
    data[gameId] = t;
    Store.set('scores', data);
    for (var i = 0; i < t.length; i++) {
      if (t[i].score === s && t[i].at === num(now, 0)) return i;
    }
    return -1;
  }

  function reset() {
    cache = {};
    Store.set('scores', {});
  }

  return {
    all: all, table: table, best: best, qualifies: qualifies,
    submit: submit, reset: reset, _validate: validate, _cleanName: cleanName,
    /** Test seam. */
    _drop: function () { cache = null; },
  };
})();
