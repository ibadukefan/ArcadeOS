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

  /*
   * SCHEMA VERSION AND MIGRATION
   *
   * Keys are namespaced `arcadeos:v<N>:<name>`. A version number that nothing
   * ever migrates is decorative — bumping it would silently orphan every high
   * score on every cabinet in the field. So the bump and the migration ship
   * together, and the path is exercised rather than theoretical.
   *
   * To add v(N+1): raise VERSION and add MIGRATIONS[N+1], a function taking
   * the parsed v(N) value of a record and returning the v(N+1) shape. Reads
   * walk backwards to the newest stored version, apply the chain forward, and
   * write the result at the current version. Old keys are left alone so a
   * downgrade still finds its data.
   */
  var VERSION = 2;

  var MIGRATIONS = {
    /*
     * 1 -> 2: no shape change. Both records were already validated field by
     * field on read, so v1 data is v2 data. This exists so the machinery is
     * live and covered rather than waiting for the first real change.
     */
    2: function (name, value) { return value; },
  };

  /** In-memory mirror. Always authoritative during a session. */
  var mem = Object.create(null);
  /** null until probed. */
  var backend = undefined;
  var lastError = null;
  var migrated = 0;
  /*
   * A backend that answers the boot-time canary can still refuse every write
   * later — a full card, or a quota the profile grew into. Settings said
   * "SAVED ON THIS CABINET" the whole time while nothing was being saved. So
   * track what writes actually do, not what the probe once did.
   */
  var writesFailing = false;

  function key(name, version) {
    return NS + ':v' + (version === undefined ? VERSION : version) + ':' + name;
  }

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

  function readRaw(name, version) {
    var b = be();
    if (!b) return null;
    try { return b.getItem(key(name, version)); }
    catch (e) { lastError = e; return null; }
  }

  /**
   * Find a record, migrating it forward if it was written by an older build.
   * Returns the parsed value, or null.
   *
   * A migration that throws is treated as "no usable data" rather than being
   * allowed to propagate — a bad upgrade should cost you your high scores at
   * worst, never a cabinet that will not boot.
   */
  function readMigrated(name) {
    var raw = readRaw(name);
    if (raw != null) return parse(raw);

    for (var v = VERSION - 1; v >= 1; v--) {
      var old = readRaw(name, v);
      if (old == null) continue;
      var value = parse(old);
      if (value == null) continue;
      try {
        for (var step = v + 1; step <= VERSION; step++) {
          var fn = MIGRATIONS[step];
          if (fn) value = fn(name, value);
          if (value == null) break;
        }
      } catch (e) {
        lastError = e;
        return null;
      }
      if (value == null) continue;
      migrated++;
      /* Write forward so the walk only happens once. */
      try { writeRaw(name, JSON.stringify(value)); } catch (e2) { lastError = e2; }
      return value;
    }
    return null;
  }

  function parse(raw) {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function writeRaw(name, str) {
    var b = be();
    if (!b) return false;
    try {
      b.setItem(key(name), str);
      writesFailing = false;
      return true;
    } catch (e) {
      lastError = e;
      writesFailing = true;
      return false;
    }
  }

  /**
   * Read and parse a record. `validate` gets the parsed value and must return
   * a well-formed value or null; anything that throws, fails to parse, or
   * fails validation falls back to `fallback`. Corrupt records are never
   * allowed to reach the rest of the app.
   */
  function get(name, fallback, validate) {
    if (name in mem) return mem[name];
    var parsed = readMigrated(name);
    var out = fallback;
    if (parsed != null) {
      var checked = null;
      try { checked = validate ? validate(parsed) : parsed; }
      catch (e2) { checked = null; }
      if (checked != null) out = checked;
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
    persistent: function () { return !!be() && !writesFailing; },
    lastError: function () { return lastError; },
    /** How many records were upgraded from an older schema this session. */
    migrated: function () { return migrated; },
    _reset: function () {
      mem = Object.create(null); backend = undefined; lastError = null; migrated = 0;
      writesFailing = false;
    },
    _key: key,
    _migrations: MIGRATIONS,
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
  /* 'auto' | 'auto-left' | 'off'. When the surface is landscape, auto rotates
   * the whole picture 90 degrees clockwise so a physically portrait-mounted
   * panel reads upright and full-screen; auto-left for panels turned the
   * other way; off letterboxes upright (a desk monitor lying normally). */
  orientation: 'auto',
  /* Gamepad haptics. Separate from reducedMotion: rumble is touch, not
   * motion, and someone sensitive to screen shake may still want it. */
  rumble: true,
  /* What plays when the cabinet sits idle. 'art' is a silent full-screen
   * generative piece (the default — it is the prettier thing to walk past);
   * 'demos' self-plays each game in turn. */
  attract: 'art',
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
    out.orientation = (raw.orientation === 'auto-left' || raw.orientation === 'off')
      ? raw.orientation : 'auto';
    out.rumble = raw.rumble !== false;
    out.attract = (raw.attract === 'demos') ? 'demos' : 'art';
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
    if (name === 'orientation') renderResize();
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

  function renderResize() {
    if (typeof Render !== 'undefined' && Render && Render.resize) Render.resize();
  }

  return { all: all, get: get, set: set, reset: reset, _validate: validate };
})();

/* ------------------------------------------------------------- faults --- */

/*
 * Crash log.
 *
 * A cabinet has no keyboard and no console. Before this, a game fault showed a
 * toast for 2.6 seconds and then existed nowhere at all — a reproducible crash
 * was undiagnosable without pulling the SD card. Faults now persist (so the
 * settings screen can show them) and are relayed to the local agent (so they
 * land in journald and `journalctl -u arcadeos-agent` tells the story).
 */
var Faults = (function () {
  var MAX = 10;
  var cache = null;
  /* Bound the relay: a game throwing every frame must not flood the journal. */
  var lastRelay = 0;
  var RELAY_GAP = 10000;

  function validate(raw) {
    if (!Array.isArray(raw)) return null;
    var out = [];
    for (var i = 0; i < raw.length && out.length < MAX; i++) {
      var e = raw[i];
      if (!e || typeof e !== 'object') continue;
      out.push({
        msg: String(e.msg == null ? '' : e.msg).slice(0, 200),
        where: String(e.where == null ? '' : e.where).slice(0, 40),
        at: (typeof e.at === 'number' && isFinite(e.at)) ? e.at : 0,
        n: (typeof e.n === 'number' && isFinite(e.n)) ? Math.max(1, Math.floor(e.n)) : 1,
      });
    }
    return out;
  }

  function all() {
    if (!cache) cache = Store.get('faults', [], validate) || [];
    return cache;
  }

  /**
   * Record a fault. Repeats of the same message in the same place bump a
   * counter rather than pushing a new row, so one broken game cannot evict
   * the history of everything else.
   */
  function record(err, where, now) {
    var msg = '';
    try {
      msg = (err && err.message) ? String(err.message) : String(err);
    } catch (e) { msg = 'unknown error'; }
    msg = msg.slice(0, 200);
    var w = String(where || '').slice(0, 40);
    var t = num(now, 0);

    var list = all();
    if (list.length && list[0].msg === msg && list[0].where === w) {
      list[0].n++;
      list[0].at = t;
    } else {
      list.unshift({ msg: msg, where: w, at: t, n: 1 });
      while (list.length > MAX) list.pop();
    }
    Store.set('faults', list);

    /* Relay to the agent so it reaches the journal, rate limited. */
    if (t - lastRelay > RELAY_GAP || lastRelay === 0) {
      lastRelay = t;
      if (typeof System !== 'undefined' && System && System.log) {
        System.log('fault in ' + (w || 'shell') + ': ' + msg);
      }
    }
    return list[0];
  }

  return {
    all: all,
    record: record,
    latest: function () { var l = all(); return l.length ? l[0] : null; },
    count: function () { return all().length; },
    clear: function () { cache = []; Store.set('faults', []); },
    _validate: validate,
    _drop: function () { cache = null; lastRelay = 0; },
    MAX: MAX,
  };
})();

/* --------------------------------------------------------- high scores --- */

var TOP_N = 5;

var Scores = (function () {
  /*
   * No game here can score a billion; a crafted or corrupted record can. An
   * unbounded number renders as "1e+308" and paints 300 characters across the
   * scores screen, so bound it where the display does — nine digits.
   */
  var MAX_SCORE = 999999999;
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
      score: Math.min(Math.floor(score), MAX_SCORE),
      at: (typeof e.at === 'number' && isFinite(e.at)) ? e.at : 0,
    };
  }

  /**
   * Validate the whole table. Partial records are dropped individually rather
   * than discarding an entire game's history — a truncated write should cost
   * you one row, not the leaderboard.
   *
   * The map has a null prototype: game ids come out of a file the player can
   * edit, and `{}["constructor"]` is a function, not a missing entry. With no
   * prototype every lookup answers about the data and nothing else.
   */
  function validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var out = Object.create(null);
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
    if (!cache) cache = Store.get('scores', Object.create(null), validate) || Object.create(null);
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
    var s = Math.min(Math.floor(num(score, 0)), MAX_SCORE);
    if (s <= 0) return false;
    var t = table(gameId);
    if (t.length < TOP_N) return true;
    return s > t[t.length - 1].score;
  }

  /** Insert and persist. Returns the 0-based rank, or -1 if it did not place. */
  function submit(gameId, score, name, now) {
    var s = Math.min(Math.floor(num(score, 0)), MAX_SCORE);
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
    cache = Object.create(null);
    Store.set('scores', {});
  }

  return {
    all: all, table: table, best: best, qualifies: qualifies,
    submit: submit, reset: reset, _validate: validate, _cleanName: cleanName,
    MAX_SCORE: MAX_SCORE,
    /** Test seam. */
    _drop: function () { cache = null; },
  };
})();
