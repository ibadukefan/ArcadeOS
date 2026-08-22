/*
 * The shell: boot, dashboard, game, pause, game over, high scores, settings,
 * initials entry and attract mode.
 *
 * One state machine, one draw tree, one input consumer. Games know nothing
 * about any of it beyond Shell.gameOver().
 *
 * Every screen is navigable with a d-pad and two buttons. There is no path
 * through this front end that needs a keyboard — including shutting the
 * cabinet down.
 */

var Shell = (function () {

  /* ------------------------------------------------------------ layout --- */

  var MARGIN = 40;
  var GAP = 20;
  var CARD_W = (SW - MARGIN * 2 - GAP) / 2;   /* 490 */
  var CARD_H = 330;
  var ACTION_H = 108;
  var HEADER_H = 322;
  var FOOTER_Y = SH - 94;
  var VIEW_TOP = HEADER_H;
  var VIEW_BOT = FOOTER_Y - 24;

  /* ------------------------------------------------------------- state --- */

  var state = 'boot';
  var prevState = 'boot';
  var t = 0;                  /* ms since boot */
  var stateT = 0;             /* ms in current state */
  var idleT = 0;              /* ms since last input, for attract mode */
  var fade = 0;               /* 0..1 cross-fade on state change */

  var cursor = { row: 0, col: 0 };
  var scrollY = 0, scrollTarget = 0;
  var rows = [];

  var activeGame = null;
  var lastScore = 0;
  var lastRank = -1;

  var pauseCursor = 0;
  var overCursor = 0;
  var scoresGame = 0;
  var setCursor = 0;
  var setScroll = 0, setScrollT = 0;
  /*
   * Where BACK goes. Screens push where they came from, so DIAGNOSTICS opened
   * from SETTINGS returns to SETTINGS, and a future screen opened from
   * somewhere else returns there — no hardcoded return targets.
   */
  var navStack = [];
  /*
   * Hold-to-home. START taps keep their local meaning (pause in game, resume
   * in pause); holding it for HOME_HOLD_MS from anywhere returns to the
   * dashboard. This is the one navigation rule that works in every state, so
   * a player can never be stranded.
   */
  var HOME_HOLD_MS = 900;
  var homeHold = 0, homeArmed = true;
  /* Software update screen state. The agent does the work; this reflects it. */
  var upd = { phase: 'idle', cursor: 0, poll: 0, status: null, error: '' };
  /* About screen: last agent status reply, null until asked. */
  var aboutAgent = null;
  var confirmBox = null;      /* {text, onYes, cursor} */
  var toast = null;           /* {text, life} */
  var lastPadsVersion = -1;

  /* Rolling frame-time window for the on-cabinet timer. Fixed-size and
   * written in place — a perf overlay that allocates every frame would be
   * measuring itself. */
  var FT_N = 60;
  var frameTimes = new Array(FT_N);
  for (var ftI = 0; ftI < FT_N; ftI++) frameTimes[ftI] = 16.667;
  var frameAt = 0;
  var worstFrame = 0;
  var frameOps = 0;
  var lastOps = 0;

  var ATTRACT_AFTER = 60000;
  var attract = { game: null, timer: 0, index: 0, art: false };

  var initials = { chars: [0, 0, 0], pos: 0, gameId: '', score: 0 };

  var ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /* --------------------------------------------------------- menu model --- */

  function buildMenu() {
    rows = [];
    for (var i = 0; i < GAMES.length; i += 2) {
      var row = [{ kind: 'game', game: GAMES[i], h: CARD_H }];
      if (GAMES[i + 1]) row.push({ kind: 'game', game: GAMES[i + 1], h: CARD_H });
      rows.push(row);
    }
    if (VERSUS_GAMES.length) {
      var vrow = [];
      for (var v = 0; v < VERSUS_GAMES.length && v < 2; v++) {
        vrow.push({ kind: 'game', game: VERSUS_GAMES[v], h: CARD_H, versus: true });
      }
      rows.push(vrow);
    }
    rows.push([
      { kind: 'action', id: 'scores', label: 'HIGH SCORES', icon: '★', h: ACTION_H },
      { kind: 'action', id: 'settings', label: 'SETTINGS', icon: '⚙', h: ACTION_H },
    ]);
  }

  /** Absolute y of a row inside the scrolling content. */
  function rowY(index) {
    var y = 0;
    for (var i = 0; i < index && i < rows.length; i++) y += rows[i][0].h + GAP;
    return y;
  }

  function contentHeight() {
    if (!rows.length) return 0;
    return rowY(rows.length - 1) + rows[rows.length - 1][0].h;
  }

  function entryRect(r, c) {
    var row = rows[r];
    if (!row) return null;
    var e = row[c];
    if (!e) return null;
    return {
      x: MARGIN + c * (CARD_W + GAP),
      y: VIEW_TOP + rowY(r) - scrollY,
      w: CARD_W,
      h: e.h,
    };
  }

  function currentEntry() {
    var row = rows[cursor.row];
    if (!row) return null;
    return row[Math.min(cursor.col, row.length - 1)] || null;
  }

  /** Keep the selected row inside the viewport, easing rather than jumping. */
  function ensureVisible() {
    var top = rowY(cursor.row);
    var h = rows[cursor.row] ? rows[cursor.row][0].h : CARD_H;
    var viewH = VIEW_BOT - VIEW_TOP;
    var maxScroll = Math.max(0, contentHeight() - viewH);
    if (top < scrollTarget) scrollTarget = top;
    else if (top + h > scrollTarget + viewH) scrollTarget = top + h - viewH;
    scrollTarget = clamp(scrollTarget, 0, maxScroll);
  }

  /* ------------------------------------------------------ transitions --- */

  function go(next) {
    /* Leaving attract by any route hands input back to the player. */
    if (state === 'attract' && next !== 'attract') Input.setDemo(null);
    prevState = state;
    state = next;
    stateT = 0;
    fade = 1;
    Input.flush();
  }

  function navPush(next) { navStack.push(state); go(next); }

  function navBack() { go(navStack.length ? navStack.pop() : 'menu'); }

  /** The one exit that always works. Clears everything modal on the way out. */
  function goHome() {
    if (state === 'attract') leaveAttract();
    activeGame = null;
    confirmBox = null;
    navStack.length = 0;
    go('menu');
    Audio2.sfx('back');
    say('DASHBOARD');
  }

  /**
   * Track the START hold. Runs every frame in every state except boot, ahead
   * of the per-state handlers, so nothing can swallow it.
   */
  function homeUpdate(dt) {
    if (state === 'boot') { homeHold = 0; homeArmed = true; return; }
    if (Input.down('pause')) {
      if (!homeArmed) return;
      homeHold += dt;
      if (homeHold >= HOME_HOLD_MS) {
        homeArmed = false;
        homeHold = 0;
        if (state !== 'menu') goHome();
      }
    } else {
      homeHold = 0;
      homeArmed = true;
    }
  }

  function say(msg) { toast = { text: String(msg), life: 2600 }; }

  /**
   * Substitute {A}/{B}/{X} in a game's hint with the glyphs of the controller
   * actually in the player's hands, so a DualSense reads "✕ SLAM" and a Switch
   * Pro reads "A SLAM" — matching the button they are about to press.
   */
  function formatHint(hint, playerIndex) {
    var g = Input.glyphs(playerIndex || 0);
    return String(hint == null ? '' : hint)
      .replace(/\{A\}/g, g.confirm)
      .replace(/\{B\}/g, g.back)
      .replace(/\{X\}/g, g.alt);
  }

  /**
   * Record a fault so it outlives its toast. Draw and preview faults fire once
   * per frame while broken, so Faults.record() collapses repeats into a count
   * rather than letting one bad game evict the whole history.
   */
  function fault(err, where) {
    try { Faults.record(err, where, Date.now ? Date.now() : t); }
    catch (e) { /* the error reporter must never be the thing that throws */ }
  }

  /* ------------------------------------------------------------- boot --- */

  function bootUpdate(dt) {
    if (stateT > 2200 || Input.hit('confirm') || Input.hit('pause')) {
      buildMenu();
      go('menu');
      Audio2.sfx('start');
    }
  }

  /* ------------------------------------------------------------- menu --- */

  /**
   * Seed for the next run. Normally the clock, so two cabinets do not play the
   * same piece sequence — but pinnable, because a test that cannot reproduce
   * its own failure is not much of a test.
   */
  var forcedSeed = null;

  function startGame(game, versus, seed) {
    activeGame = game;
    var s = (seed !== undefined && seed !== null) ? seed
      : (forcedSeed !== null ? forcedSeed
        : ((Date.now ? Date.now() : 0) ^ (t | 0) ^ 0x5bf03635));
    seedRng(s);
    try { game.start(); }
    catch (e) {
      fault(e, game.id + '.start');
      say('FAILED TO START — SEE SETTINGS');
      go('menu');
      return;
    }
    go('game');
    Audio2.sfx('start');
  }

  function menuUpdate(dt) {
    var moved = false;
    var stepsV = Input.repCount('down') - Input.repCount('up');
    var stepsH = Input.repCount('right') - Input.repCount('left');

    if (stepsV) {
      cursor.row = clamp(cursor.row + stepsV, 0, rows.length - 1);
      var row = rows[cursor.row];
      cursor.col = clamp(cursor.col, 0, row.length - 1);
      moved = true;
    }
    if (stepsH) {
      var r2 = rows[cursor.row];
      var nc = cursor.col + stepsH;
      if (nc >= 0 && nc < r2.length) { cursor.col = nc; moved = true; }
    }
    if (moved) { Audio2.sfx('move'); ensureVisible(); }

    if (Input.hit('confirm')) {
      var e = currentEntry();
      if (!e) return;
      if (e.kind === 'game') startGame(e.game, e.versus);
      else if (e.id === 'scores') { scoresGame = 0; navPush('scores'); Audio2.sfx('select'); }
      else if (e.id === 'settings') {
        setCursor = 0; setScroll = 0; setScrollT = 0;
        navPush('settings'); Audio2.sfx('select');
      }
    }

    scrollY = approach(scrollY, scrollTarget, 14, dt);
  }

  /* ------------------------------------------------------------- game --- */

  function gameUpdate(dt) {
    if (Input.hit('pause')) { pauseCursor = 0; go('pause'); Audio2.sfx('back'); return; }
    if (!activeGame) { go('menu'); return; }
    try { activeGame.update(dt); }
    catch (e) {
      fault(e, activeGame.id + '.update');
      say('GAME ERROR — SEE SETTINGS');
      activeGame = null;
      go('menu');
    }
  }

  var PAUSE_ITEMS = ['RESUME', 'RESTART', 'QUIT TO MENU'];

  function pauseUpdate(dt) {
    var steps = Input.repCount('down') - Input.repCount('up');
    if (steps) {
      pauseCursor = (pauseCursor + steps + PAUSE_ITEMS.length * 4) % PAUSE_ITEMS.length;
      Audio2.sfx('move');
    }
    if (Input.hit('back') || Input.hit('pause')) { go('game'); Audio2.sfx('back'); return; }
    if (Input.hit('confirm')) {
      Audio2.sfx('select');
      if (pauseCursor === 0) go('game');
      else if (pauseCursor === 1) { activeGame.start(); go('game'); }
      else { activeGame = null; go('menu'); }
    }
  }

  /* -------------------------------------------------------- game over --- */

  /** Called by games. Never call this from inside draw(). */
  function gameOver(score) {
    /*
     * A demo dying in attract mode must not drag the cabinet onto a game-over
     * card — nobody is there to dismiss it. Rotate to the next demo instead,
     * and never record an attract score.
     */
    if (state === 'attract') {
      attract.timer = 99999;
      return;
    }
    lastScore = Math.max(0, Math.floor(num(score, 0)));
    var id = activeGame ? activeGame.id : '';
    lastRank = -1;
    if (id && Scores.qualifies(id, lastScore)) {
      initials.chars = [0, 0, 0];
      initials.pos = 0;
      initials.gameId = id;
      initials.score = lastScore;
      go('initials');
      Audio2.sfx('highscore');
    } else {
      overCursor = 0;
      go('over');
    }
  }

  var OVER_ITEMS = ['PLAY AGAIN', 'QUIT TO MENU'];

  function overUpdate(dt) {
    /* A short lock-out so a button held at death does not skip the screen. */
    if (stateT < 500) return;
    var steps = Input.repCount('down') - Input.repCount('up');
    if (steps) {
      overCursor = (overCursor + steps + OVER_ITEMS.length * 4) % OVER_ITEMS.length;
      Audio2.sfx('move');
    }
    if (Input.hit('confirm')) {
      Audio2.sfx('select');
      if (overCursor === 0 && activeGame) { activeGame.start(); go('game'); }
      else { activeGame = null; go('menu'); }
    } else if (Input.hit('back')) {
      activeGame = null;
      go('menu');
      Audio2.sfx('back');
    }
  }

  /* --------------------------------------------------- initials entry --- */

  function initialsUpdate(dt) {
    if (stateT < 320) return;
    var v = Input.repCount('up') - Input.repCount('down');
    if (v) {
      initials.chars[initials.pos] =
        (initials.chars[initials.pos] + v + ALPHA.length * 8) % ALPHA.length;
      Audio2.sfx('move');
    }
    var h = Input.repCount('right') - Input.repCount('left');
    if (h) {
      initials.pos = clamp(initials.pos + h, 0, 2);
      Audio2.sfx('move');
    }
    if (Input.hit('confirm')) {
      if (initials.pos < 2) { initials.pos++; Audio2.sfx('select'); }
      else { commitInitials(); }
    }
    if (Input.hit('back')) {
      if (initials.pos > 0) { initials.pos--; Audio2.sfx('back'); }
      else commitInitials();
    }
  }

  function commitInitials() {
    var name = ALPHA.charAt(initials.chars[0]) + ALPHA.charAt(initials.chars[1]) +
      ALPHA.charAt(initials.chars[2]);
    lastRank = Scores.submit(initials.gameId, initials.score, name,
      Date.now ? Date.now() : t);
    Audio2.sfx('coin');
    overCursor = 0;
    go('over');
  }

  /* -------------------------------------------------------- settings --- */

  /**
   * Settings rows. Each is a small descriptor rather than bespoke code so the
   * screen stays uniform and every row is reachable with left/right/confirm.
   */
  function settingsItems() {
    var s = Settings.all();
    return [
      { type: 'header', label: 'AUDIO & FEEDBACK' },
      { id: 'volume', label: 'VOLUME', type: 'range',
        value: Math.round(s.volume * 100) + '%' },
      { id: 'muted', label: 'MUTE', type: 'toggle', on: s.muted },
      { id: 'rumble', label: 'CONTROLLER RUMBLE', type: 'toggle', on: s.rumble },
      { type: 'header', label: 'DISPLAY' },
      { id: 'crt', label: 'CRT VEIL', type: 'toggle', on: s.crt },
      { id: 'reducedMotion', label: 'REDUCED MOTION', type: 'toggle', on: s.reducedMotion },
      { id: 'showFps', label: 'FRAME TIMER', type: 'toggle', on: s.showFps },
      { id: 'lowLatency', label: 'LOW LATENCY VIDEO', type: 'toggle', on: s.lowLatency },
      { id: 'orientation', label: 'ORIENTATION', type: 'choice',
        value: orientationLabel(s.orientation) },
      { id: 'attract', label: 'WHEN IDLE', type: 'choice',
        value: attractLabel(s.attract) },
      { type: 'header', label: 'CONTROLS' },
      { id: 'layout', label: 'CONTROLLER', type: 'choice',
        value: layoutLabel(s.layout) },
      { id: 'pairing', label: 'PAIR BLUETOOTH PAD', type: 'action' },
      { type: 'header', label: 'SYSTEM' },
      { id: 'update', label: 'SOFTWARE UPDATE', type: 'action', value: 'V' + VERSION_STR },
      { id: 'about', label: 'ABOUT THIS CABINET', type: 'action' },
      { id: 'faults', label: 'DIAGNOSTICS', type: 'action',
        value: Faults.count() ? Faults.count() + ' FAULT' + (Faults.count() === 1 ? '' : 'S') : 'NONE',
        warn: Faults.count() > 0 },
      { id: 'reset', label: 'RESET HIGH SCORES', type: 'action', danger: true },
      { id: 'resetSettings', label: 'RESET ALL SETTINGS', type: 'action', danger: true },
      { id: 'restart', label: 'RESTART', type: 'action', danger: true },
      { id: 'shutdown', label: 'SHUT DOWN', type: 'action', danger: true },
      { id: 'back', label: 'BACK', type: 'action' },
    ];
  }

  var VERSION_STR = '1.0.0';

  function buildId() {
    try {
      var b = (typeof window !== 'undefined') && window.ARCADEOS_BUILD;
      return typeof b === 'string' ? b : 'DEV';
    } catch (e) { return 'DEV'; }
  }

  /* Row layout for the settings list: headers are shorter than rows, and the
   * list is taller than the screen now, so it scrolls like the dashboard. */
  /* SET_BOT leaves room BELOW the list for the storage note and then the
   * footer legend. The list clips at SET_BOT+20, the note sits at
   * FOOTER_Y-52 and the legend at FOOTER_Y: three bands that must never
   * touch — the note once printed straight through the legend, and a second
   * cut printed it through the list's last row instead. */
  var SET_ROW_H = 84, SET_HEADER_H = 56, SET_TOP = 250, SET_BOT = SH - 190;

  function settingsLayout(items) {
    var ys = [], y = 0;
    for (var i = 0; i < items.length; i++) {
      ys.push(y);
      y += items[i].type === 'header' ? SET_HEADER_H : SET_ROW_H;
    }
    return { ys: ys, total: y };
  }

  function settingsEnsureVisible(items) {
    var lay = settingsLayout(items);
    var viewH = SET_BOT - SET_TOP;
    var top = lay.ys[setCursor];
    var h = items[setCursor].type === 'header' ? SET_HEADER_H : SET_ROW_H;
    if (top < setScrollT) setScrollT = top;
    else if (top + h > setScrollT + viewH) setScrollT = top + h - viewH;
    setScrollT = clamp(setScrollT, 0, Math.max(0, lay.total - viewH));
  }

  function layoutLabel(v) {
    if (v === 'xbox') return 'XBOX';
    if (v === 'playstation') return 'PLAYSTATION';
    if (v === 'nintendo') return 'NINTENDO';
    return 'AUTO (' + Input.layoutOf(0).toUpperCase() + ')';
  }

  var LAYOUTS = ['auto', 'xbox', 'playstation', 'nintendo'];

  /* Every multi-value settings row, keyed by id, so the cycle logic is one
   * function instead of one hardcoded special case per row. */
  var ORIENTATIONS = ['auto', 'auto-left', 'off'];
  var ATTRACTS = ['art', 'demos'];
  var CHOICES = { layout: LAYOUTS, orientation: ORIENTATIONS, attract: ATTRACTS };

  function cycleChoice(id, dir) {
    var list = CHOICES[id];
    if (!list) return;
    var i = list.indexOf(Settings.get(id));
    Settings.set(id, list[(i + dir + list.length * 8) % list.length]);
    Audio2.sfx('select');
  }

  function orientationLabel(v) {
    if (v === 'auto-left') return 'AUTO PORTRAIT \u2190';
    if (v === 'off') return 'NO ROTATION';
    return 'AUTO PORTRAIT \u2192';
  }

  function attractLabel(v) {
    return v === 'demos' ? 'GAME DEMOS' : 'ART';
  }

  function settingsUpdate(dt) {
    if (confirmBox) { confirmUpdate(dt); return; }

    var items = settingsItems();
    /* Never rest on a header — they are labels, not rows. */
    while (items[setCursor] && items[setCursor].type === 'header') {
      setCursor = (setCursor + 1) % items.length;
    }
    var steps = Input.repCount('down') - Input.repCount('up');
    if (steps) {
      var dir = steps > 0 ? 1 : -1;
      for (var m = Math.abs(steps); m > 0; m--) {
        do { setCursor = (setCursor + dir + items.length) % items.length; }
        while (items[setCursor].type === 'header');
      }
      Audio2.sfx('move');
      settingsEnsureVisible(items);
    }
    setScroll = approach(setScroll, setScrollT, 14, dt);

    var it = items[setCursor];
    var h = Input.repCount('right') - Input.repCount('left');

    if (h && it.type === 'range') {
      var vol = clamp(Settings.get('volume') + h * 0.05, 0, 1);
      Settings.set('volume', Math.round(vol * 20) / 20);
      Audio2.sfx('move');
    } else if (h && it.type === 'choice') {
      cycleChoice(it.id, h > 0 ? 1 : -1);
    } else if (h && it.type === 'toggle') {
      Settings.set(it.id, !Settings.get(it.id));
      Audio2.sfx('select');
    }

    if (Input.hit('confirm')) activate(it);
    if (Input.hit('back')) { navBack(); Audio2.sfx('back'); }
  }

  function activate(it) {
    if (!it) return;
    if (it.type === 'toggle') {
      Settings.set(it.id, !Settings.get(it.id));
      Audio2.sfx('select');
      return;
    }
    if (it.type === 'choice') {
      cycleChoice(it.id, 1);
      return;
    }
    if (it.id === 'back') { navBack(); Audio2.sfx('back'); return; }
    if (it.id === 'faults') { navPush('faults'); Audio2.sfx('select'); return; }
    if (it.id === 'update') { updOpen(); return; }
    if (it.id === 'about') { aboutOpen(); return; }
    if (it.id === 'resetSettings') {
      ask('RESET ALL SETTINGS TO DEFAULTS?', function () {
        Settings.reset();
        say('SETTINGS RESTORED TO DEFAULTS');
      });
      return;
    }
    if (it.id === 'reset') {
      ask('ERASE ALL HIGH SCORES?', function () {
        Scores.reset();
        say('HIGH SCORES CLEARED');
      });
      return;
    }
    if (it.id === 'pairing') {
      System.pair(powerResult('PAIRING'));
      say('PAIRING MODE — HOLD SYNC ON THE PAD');
      return;
    }
    if (it.id === 'restart') {
      ask('RESTART THE CABINET?', function () {
        say('RESTARTING…');
        System.request('restart', powerResult('RESTART'));
      });
      return;
    }
    if (it.id === 'shutdown') {
      ask('SHUT DOWN THE CABINET?', function () {
        say('SHUTTING DOWN — WAIT FOR THE GREEN LED TO STOP');
        System.request('shutdown', powerResult('SHUTDOWN'));
      });
      return;
    }
  }

  /**
   * A cabinet command that fails must SAY so. "RESTARTING…" followed by
   * nothing — because the agent was down, or refused the token — looked
   * exactly like success on a real cabinet, and the owner sat waiting for a
   * reboot that was never coming.
   */
  function powerResult(what) {
    return function (ok, detail) {
      if (ok) return;   /* success narrates itself: the machine acts */
      say(what + ' FAILED (' + String(detail || 'no agent').toUpperCase() +
        ') — CHECK SYSTEM ▸ ABOUT');
    };
  }

  function ask(text, onYes) {
    confirmBox = { text: text, onYes: onYes, cursor: 1 };
    Audio2.sfx('select');
    Input.flush();
  }

  function confirmUpdate(dt) {
    var h = Input.repCount('right') - Input.repCount('left');
    if (h) { confirmBox.cursor = confirmBox.cursor ? 0 : 1; Audio2.sfx('move'); }
    if (Input.hit('confirm')) {
      var yes = confirmBox.cursor === 0;
      var fn = confirmBox.onYes;
      confirmBox = null;
      Audio2.sfx(yes ? 'select' : 'back');
      if (yes && fn) fn();
    } else if (Input.hit('back')) {
      confirmBox = null;
      Audio2.sfx('back');
    }
  }

  /* --------------------------------------------------------- faults --- */

  function faultsUpdate(dt) {
    if (confirmBox) { confirmUpdate(dt); return; }
    if (Input.hit('back')) { navBack(); Audio2.sfx('back'); return; }
    if (Input.hit('confirm') && Faults.count()) {
      ask('CLEAR THE FAULT LOG?', function () {
        Faults.clear();
        say('FAULT LOG CLEARED');
      });
    }
  }

  /** Renderer strings can be paragraphs ("ANGLE (Broadcom, V3D 4.2, …)");
   * keep the interesting head and make it fit the row. */
  function gpuLabel() {
    var s = String(Render.gpuInfo()).toUpperCase();
    return s.length > 44 ? s.slice(0, 43) + '…' : s;
  }

  /** e.g. "1920×1080 · ROT 90° · SCALE 1.00" */
  function resLabel() {
    var s = Render.size();
    return s.dw + '×' + s.dh +
      (s.rot ? ' · ROT ' + s.rot + '°' : ' · NO ROT') +
      ' · SCALE ' + s.scale.toFixed(2);
  }

  function drawFaults(c) {
    wordmark(c, SW / 2, 110, 54);
    text(c, 'DIAGNOSTICS', SW / 2, 178, {
      size: 20, weight: '600', track: 7, color: COL.text2, align: 'center',
      cache: true,
    });

    var list = Faults.all();
    var x = MARGIN + 20, w = SW - (MARGIN + 20) * 2;

    /* Build state first: this is the screen someone reads over SSH's shoulder. */
    var lines = [
      ['STORAGE', Store.persistent() ? 'PERSISTENT' : 'SESSION ONLY',
        Store.persistent() ? COL.good : COL.warn],
      ['SCHEMA', 'v' + Store.VERSION +
        (Store.migrated() ? '  (' + Store.migrated() + ' MIGRATED)' : ''), COL.data],
      ['VIDEO', Render.lowLatency() ? 'LOW LATENCY' : 'NORMAL', COL.data],
      /* The 22fps tell: SwiftShader here means Chromium is software
       * rendering and the launch flags need fixing, not the games. */
      ['GPU', gpuLabel(), Render.gpuIsSoftware() ? COL.bad : COL.good],
      /* What surface the browser actually handed us, and what we did with
       * it — ends the "what shape is it really in" photo forensics. */
      ['RESOLUTION', resLabel(), COL.data],
      ['CONTROLLERS', String(Input.padCount()) + ' PAD' +
        (Input.padCount() === 1 ? '' : 'S') + ', ' +
        Input.kindOf(0).toUpperCase(), COL.data],
      ['INPUT SAMPLING', Input.diagnostics().sampling
        ? Input.diagnostics().intervalMs + 'ms' : 'FRAME ONLY',
        Input.diagnostics().sampling ? COL.good : COL.warn],
    ];
    var y = 240;
    for (var i = 0; i < lines.length; i++) {
      panel(c, x, y, w, 56, { fill: COL.card, stroke: COL.cardLine });
      text(c, lines[i][0], x + 24, y + 34, {
        size: 16, weight: '500', track: 2, color: COL.text2,
      });
      dataText(c, lines[i][1], x + w - 24, y + 34, {
        size: 17, align: 'right', color: lines[i][2],
      });
      y += 64;
    }

    y += 30;
    text(c, list.length ? 'RECENT FAULTS' : 'NO FAULTS RECORDED', x + 24, y, {
      size: 15, weight: '600', track: 3,
      color: list.length ? COL.bad : COL.good,
    });
    y += 18;

    for (var f = 0; f < list.length && f < 6; f++) {
      var e = list[f];
      panel(c, x, y, w, 74, {
        fill: 'rgba(240,100,94,.08)', stroke: rgba(COL.bad, 0.28),
      });
      text(c, e.where || 'shell', x + 20, y + 28, {
        size: 15, weight: '700', track: 1.5, color: COL.warn,
      });
      if (e.n > 1) {
        dataText(c, 'x' + e.n, x + w - 20, y + 28, {
          size: 15, align: 'right', color: COL.bad,
        });
      }
      /* Truncate rather than wrap: the point is recognising it, not reading it. */
      var msg = e.msg.length > 58 ? e.msg.slice(0, 57) + '…' : e.msg;
      text(c, msg, x + 20, y + 54, {
        size: 14, weight: '400', color: COL.text2, mono: true,
      });
      y += 82;
    }

    var gl = Input.glyphs(0);
    drawFooter(c, list.length
      ? [{ g: gl.confirm, l: 'CLEAR' }, { g: gl.back, l: 'BACK' }]
      : [{ g: gl.back, l: 'BACK' }]);

    if (confirmBox) drawConfirm(c);
  }

  /* ---------------------------------------------------------- scores --- */

  function scoresUpdate(dt) {
    var steps = Input.repCount('right') - Input.repCount('left');
    if (steps) {
      scoresGame = (scoresGame + steps + GAMES.length * 8) % GAMES.length;
      Audio2.sfx('move');
    }
    var v = Input.repCount('down') - Input.repCount('up');
    if (v) {
      scoresGame = (scoresGame + v + GAMES.length * 8) % GAMES.length;
      Audio2.sfx('move');
    }
    if (Input.hit('back') || Input.hit('confirm')) { navBack(); Audio2.sfx('back'); }
  }

  /* --------------------------------------------------------- attract --- */

  function enterAttract() {
    Input.setDemo(null);
    attract.timer = 0;
    var mode = 'art';
    try { mode = Settings.get('attract') || 'art'; } catch (e) { mode = 'art'; }
    if (mode === 'art') {
      /* The silent art piece: no game, no cycling — it just runs. */
      attract.art = true;
      attract.game = null;
      go('attract');
      return;
    }
    attract.art = false;
    attract.index = (attract.index + 1) % Math.max(1, GAMES.length);
    attract.game = GAMES[attract.index] || null;
    if (attract.game) {
      seedRng(0xA77AC7 + attract.index);
      try { attract.game.start(); } catch (e) { attract.game = null; }
    }
    go('attract');
  }

  function attractUpdate(dt) {
    /* Any real input at all drops straight back to the dashboard. The demo's
     * own presses are excluded from activity, so this cannot self-trigger. */
    if (Input.consumeActivity()) {
      leaveAttract();
      go('menu');
      Audio2.sfx('back');
      return;
    }
    attract.timer += dt;
    /* The art piece has nothing to simulate and never cycles — it just runs
     * until a real button press drops back to the dashboard. */
    if (attract.art) return;
    if (attract.game) {
      try { attract.game.update(dt); }
      catch (e) { fault(e, attract.game.id + '.update'); attract.game = null; }
    }
    /* Drive the NEXT frame. Input.poll runs before Shell.update, so the map
     * set here is consumed one frame later — invisible, and it keeps the
     * demo reading its own freshly-updated state. */
    attractDrive();
    if (attract.timer > 14000 || !attract.game) enterAttract();
  }

  /**
   * The demo pilot.
   *
   * Each game supplies its own tiny policy via an optional demo() method,
   * because only the game knows where its ball or its food is. Games without
   * one simply run on gravity, which is what every game did before — SNAKE
   * died in 2.8 seconds and PULSE in 8.5, then sat as a frozen board for the
   * rest of the slot, which reads as a crashed cabinet from across a room.
   *
   * Deliberately mediocre policies: a demo that never loses looks canned.
   */
  function attractDrive() {
    var map = null;
    if (attract.game && typeof attract.game.demo === 'function') {
      try { map = attract.game.demo(); }
      catch (e) { fault(e, attract.game.id + '.demo'); map = null; }
    }
    Input.setDemo(map);
  }

  /** Hand input back to the player and stop driving. */
  function leaveAttract() {
    Input.setDemo(null);
    attract.game = null;
    idleT = 0;
  }

  /* ------------------------------------------------- software update --- */

  /*
   * The update screen is a thin window onto work the agent does. Pressing
   * CHECK FOR UPDATES POSTs /update; the agent launches the updater script as
   * a detached unit and this screen polls GET /update/status once a second to
   * render whatever the script reports. If the update replaces the bundle,
   * the script restarts the kiosk and this page simply gets reloaded — the
   * screen never needs to orchestrate anything itself.
   */
  function updOpen() {
    upd.phase = 'idle';
    upd.cursor = 0;
    upd.poll = 0;
    upd.status = null;
    upd.error = '';
    navPush('update');
    Audio2.sfx('select');
  }

  function updStart() {
    upd.phase = 'starting';
    upd.status = null;
    upd.error = '';
    System.request('update', function (ok, detail) {
      if (upd.phase !== 'starting') return;   /* screen was left meanwhile */
      if (ok) { upd.phase = 'running'; upd.poll = 800; return; }
      upd.phase = 'error';
      upd.error = (detail === 'no fetch')
        ? 'UPDATES NEED THE INSTALLED CABINET BUILD'
        : 'CANNOT REACH THE UPDATE AGENT';
    });
  }

  function updateScreenUpdate(dt) {
    if (upd.phase === 'starting' || upd.phase === 'running') {
      upd.poll += dt;
      if (upd.phase === 'running' && upd.poll >= 1000) {
        upd.poll = 0;
        System.updateStatus(function (ok, st) {
          if (!ok || !st || upd.phase !== 'running') return;
          upd.status = st;
          if (st.error) { upd.phase = 'error'; upd.error = String(st.error).toUpperCase(); }
          else if (st.done) { upd.phase = 'done'; upd.cursor = 0; Audio2.sfx(st.updated ? 'powerup' : 'select'); }
        });
      }
      /* BACK leaves the screen; the update keeps running on the agent side. */
      if (Input.hit('back')) { navBack(); Audio2.sfx('back'); }
      return;
    }

    /* idle / error / done: a small vertical menu. */
    var items = updItems();
    var steps = Input.repCount('down') - Input.repCount('up');
    if (steps) {
      upd.cursor = (upd.cursor + steps + items.length * 8) % items.length;
      Audio2.sfx('move');
    }
    if (Input.hit('confirm')) {
      var it = items[upd.cursor];
      if (it === 'CHECK FOR UPDATES' || it === 'TRY AGAIN') { updStart(); Audio2.sfx('select'); }
      else { navBack(); Audio2.sfx('back'); }
    }
    if (Input.hit('back')) { navBack(); Audio2.sfx('back'); }
  }

  function updItems() {
    if (upd.phase === 'error') return ['TRY AGAIN', 'BACK'];
    if (upd.phase === 'done') return ['BACK'];
    return ['CHECK FOR UPDATES', 'BACK'];
  }

  /* ------------------------------------------------------------ about --- */

  function aboutOpen() {
    aboutAgent = null;
    /* Best-effort: a dev build without fetch just shows NOT AVAILABLE. */
    if (System.status) {
      System.status(function (ok, st) { aboutAgent = ok && st ? st : { ok: false }; });
    }
    navPush('about');
    Audio2.sfx('select');
  }

  function aboutUpdate(dt) {
    if (Input.hit('back') || Input.hit('confirm')) { navBack(); Audio2.sfx('back'); }
  }

  /* ------------------------------------------------------------ frame --- */

  function update(dt) {
    t += dt;
    stateT += dt;
    frameTimes[frameAt] = dt;
    frameAt = (frameAt + 1) % FT_N;
    if (dt > worstFrame) worstFrame = dt;
    /* Delta, not a reset: the counter is monotonic so tests can sample it
     * over a window without the shell clearing it underneath them. */
    var opsNow = Render.fullScreenOps();
    frameOps = opsNow - lastOps;
    lastOps = opsNow;
    if (fade > 0) fade = Math.max(0, fade - dt / 260);

    if (toast) {
      toast.life -= dt;
      if (toast.life <= 0) toast = null;
    }

    /* Hot-plug: the legends re-read glyphs every frame, so all that is needed
     * here is to tell the player something changed. */
    var pv = Input.padsVersion();
    if (pv !== lastPadsVersion) {
      /* -1 means "first frame": adopt whatever is plugged in at boot without
       * announcing it. Every change after that is worth telling the player. */
      if (lastPadsVersion !== -1) {
        var n = Input.padCount();
        say(n > 0 ? 'CONTROLLER ' + Input.kindOf(0).toUpperCase() + ' READY'
          : 'CONTROLLER DISCONNECTED');
      }
      lastPadsVersion = pv;
    }

    homeUpdate(dt);

    /* Idle tracking for attract mode: only the dashboard idles. */
    if (state === 'menu') {
      if (Input.consumeActivity()) idleT = 0;
      else idleT += dt;
      if (idleT > ATTRACT_AFTER) { idleT = 0; enterAttract(); }
    } else if (state !== 'attract') {
      idleT = 0;
      Input.consumeActivity();
    }

    switch (state) {
      case 'boot': bootUpdate(dt); break;
      case 'menu': menuUpdate(dt); break;
      case 'game': gameUpdate(dt); break;
      case 'pause': pauseUpdate(dt); break;
      case 'over': overUpdate(dt); break;
      case 'initials': initialsUpdate(dt); break;
      case 'settings': settingsUpdate(dt); break;
      case 'scores': scoresUpdate(dt); break;
      case 'faults': faultsUpdate(dt); break;
      case 'update': updateScreenUpdate(dt); break;
      case 'about': aboutUpdate(dt); break;
      case 'attract': attractUpdate(dt); break;
    }
  }

  function accentOfState() {
    if ((state === 'game' || state === 'pause' || state === 'over' ||
      state === 'initials') && activeGame) return activeGame.accent;
    if (state === 'attract' && attract.game) return attract.game.accent;
    var e = currentEntry();
    if (state === 'menu' && e && e.kind === 'game') return e.game.accent;
    return null;
  }

  function draw(dt) {
    var c = Render.beginFrame(dt, accentOfState());
    if (!c) return;

    switch (state) {
      case 'boot': drawBoot(c); break;
      case 'menu': drawMenu(c); break;
      case 'game': drawGameState(c, false); break;
      case 'pause': drawGameState(c, false); drawPause(c); break;
      case 'over': drawGameState(c, true); drawOver(c); break;
      case 'initials': drawGameState(c, true); drawInitials(c); break;
      case 'settings': drawSettings(c); break;
      case 'scores': drawScores(c); break;
      case 'faults': drawFaults(c); break;
      case 'update': drawUpdate(c); break;
      case 'about': drawAbout(c); break;
      case 'attract': drawAttract(c); break;
    }

    drawFrameTimer(c);
    drawHomeHold(c);
    drawToast(c);

    if (fade > 0) {
      Render.enterShell();
      c.globalAlpha = clamp(fade * 0.85, 0, 1);
      c.fillStyle = '#07050E';
      c.fillRect(0, 0, SW, SH);
      c.globalAlpha = 1;
    }

    Render.endFrame();
  }

  /* ------------------------------------------------------------ chrome --- */

  function wordmark(c, cx, cy, size) {
    var w = text(c, 'ARCADE', cx, cy, {
      size: size, weight: '700', track: size * 0.19, aurora: true, cache: true,
      align: 'center', baseline: 'middle',
    });
    text(c, 'OS', cx + w / 2 + size * 0.34, cy, {
      size: size * 0.42, weight: '600', track: size * 0.10, cache: true,
      color: COL.dim, align: 'left', baseline: 'middle',
    });
  }

  function drawBoot(c) {
    var p = clamp(stateT / 1400, 0, 1);
    var ease = 1 - Math.pow(1 - p, 3);
    c.globalAlpha = clamp(ease, 0, 1);
    wordmark(c, SW / 2, SH / 2 - 40, 96);
    c.globalAlpha = clamp((stateT - 900) / 500, 0, 1);
    text(c, 'INSERT NOTHING · PRESS START', SW / 2, SH / 2 + 60, {
      size: 22, weight: '500', track: 5, color: COL.text2, align: 'center',
    });
    c.globalAlpha = 1;

    /* Loading rule that fills as the boot completes. */
    var bw = 420, bx = (SW - bw) / 2, by = SH / 2 + 130;
    c.fillStyle = 'rgba(140,150,255,.10)';
    c.fillRect(bx, by, bw, 3);
    var g = c.createLinearGradient(bx, 0, bx + bw, 0);
    g.addColorStop(0, COL.a1); g.addColorStop(0.5, COL.a2); g.addColorStop(1, COL.a3);
    c.fillStyle = g;
    c.fillRect(bx, by, bw * clamp(stateT / 2200, 0, 1), 3);
  }

  function drawHeader(c) {
    wordmark(c, SW / 2, 120, 68);
    text(c, 'SELECT A GAME', SW / 2, 196, {
      size: 18, weight: '500', track: 6, color: COL.text2, align: 'center',
      cache: true,
    });

    var n = Input.playerCount();
    var label = n > 1 ? n + ' PLAYERS READY' : 'PRESS START TO JOIN P2';
    text(c, label, SW / 2, 232, {
      size: 15, weight: '500', track: 3, color: COL.dim, align: 'center',
      cache: true,
    });

    /* Hairline under the header. */
    c.fillStyle = 'rgba(140,150,255,.10)';
    c.fillRect(MARGIN, HEADER_H - 42, SW - MARGIN * 2, 1);
  }

  /* Offscreen preview buffers for unselected cards, refreshed at 10Hz. */
  var PREVIEW_HZ_MS = 100;
  var previewBufs = Object.create(null);

  function previewCache(g, pw, ph) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    var buf = previewBufs[g.id];
    var w = Math.max(1, Math.round(pw)), h = Math.max(1, Math.round(ph));
    if (!buf || buf.canvas.width !== w || buf.canvas.height !== h) {
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      buf = previewBufs[g.id] = { canvas: cv, at: -1e9 };
    }
    if (t - buf.at >= PREVIEW_HZ_MS) {
      buf.at = t;
      var bc = buf.canvas.getContext('2d');
      if (bc) {
        bc.setTransform(1, 0, 0, 1, 0, 0);
        bc.clearRect(0, 0, w, h);
        bc.fillStyle = 'rgba(8,6,18,0.45)';
        bc.fillRect(0, 0, w, h);
        try { g.preview(bc, w, h, t); }
        catch (err) { fault(err, g.id + '.preview'); }
      }
    }
    return buf.canvas;
  }

  function drawCard(c, e, rect, selected) {
    var g = e.game;
    var pulse = selected ? 0.5 + Math.sin(t * 0.004) * 0.18 : 0;

    if (selected) {
      Render.glow(c, rect.x + rect.w / 2, rect.y + rect.h / 2,
        Math.max(rect.w, rect.h) * 0.75, g.accent, 0.55 + pulse * 0.3);
    }

    panel(c, rect.x, rect.y, rect.w, rect.h, {
      fill: selected ? 'rgba(30,24,62,.66)' : COL.card,
      stroke: selected ? rgba(g.accent, 0.55) : COL.cardLine,
      lineWidth: selected ? 2 : 1,
    });

    /* Preview window. The selected card animates live; the rest redraw
     * from a small cache at 10Hz. Five extra live previews per frame were
     * pure decoration costing real milliseconds of the 16.7ms budget. */
    var pw = rect.w - 36, ph = rect.h - 132;
    var px = rect.x + 18, py = rect.y + 18;
    c.save();
    roundRect(c, px, py, pw, ph, 12);
    c.clip();
    if (selected) {
      c.fillStyle = 'rgba(8,6,18,0.45)';
      c.fillRect(px, py, pw, ph);
      c.translate(px, py);
      try { g.preview(c, pw, ph, t); }
      catch (err) { fault(err, g.id + '.preview'); }
    } else {
      var cached = previewCache(g, pw, ph);
      if (cached) c.drawImage(cached, px, py, pw, ph);
    }
    c.restore();

    if (e.versus) {
      panel(c, rect.x + rect.w - 92, rect.y + 26, 62, 26, {
        fill: rgba(g.accent, 0.18), stroke: rgba(g.accent, 0.5), radius: 8,
      });
      text(c, '2P', rect.x + rect.w - 61, rect.y + 44, {
        size: 13, weight: '700', track: 1.5, color: COL.text, align: 'center',
      });
    }

    /* Titles and tags never change; rasterise once, blit thereafter. */
    text(c, g.title, rect.x + 20, rect.y + rect.h - 74, {
      size: 30, weight: '700', track: 4.5, cache: true,
      color: selected ? COL.text : '#CFCBEC',
    });
    text(c, g.tag, rect.x + 20, rect.y + rect.h - 40, {
      size: 16, weight: '400', track: 0.4, color: COL.text2, cache: true,
    });

    var best = Scores.best(g.id);
    if (best > 0) {
      dataText(c, fmtScore(best), rect.x + rect.w - 20, rect.y + rect.h - 40, {
        size: 16, align: 'right', color: rgba(g.accent, 0.95),
      });
    }

    /* Controls, on the selected card only — teaching without clutter. */
    if (selected && g.hint) {
      var hy = rect.y + rect.h - 14;
      c.globalAlpha = 0.9;
      text(c, formatHint(g.hint), rect.x + 20, hy, {
        size: 13, weight: '500', track: 1.2, color: rgba(g.accent, 0.85),
      });
      c.globalAlpha = 1;
    }
  }

  function drawAction(c, e, rect, selected) {
    if (selected) {
      Render.glow(c, rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w * 0.6, COL.a2, 0.5);
    }
    panel(c, rect.x, rect.y, rect.w, rect.h, {
      fill: selected ? 'rgba(30,24,62,.66)' : COL.card,
      stroke: selected ? rgba(COL.a2, 0.5) : COL.cardLine,
      lineWidth: selected ? 2 : 1,
    });
    text(c, e.icon, rect.x + 30, rect.y + rect.h / 2 + 1, {
      size: 26, weight: '600', color: selected ? COL.a1 : COL.text2,
      baseline: 'middle',
    });
    text(c, e.label, rect.x + 74, rect.y + rect.h / 2 + 1, {
      size: 22, weight: '600', track: 3.5, cache: true,
      color: selected ? COL.text : COL.text2, baseline: 'middle',
    });
  }

  function drawMenu(c) {
    drawHeader(c);

    c.save();
    c.beginPath();
    c.rect(0, VIEW_TOP - 6, SW, VIEW_BOT - VIEW_TOP + 12);
    c.clip();

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      for (var col = 0; col < row.length; col++) {
        var rect = entryRect(r, col);
        if (!rect) continue;
        if (rect.y > VIEW_BOT + 40 || rect.y + rect.h < VIEW_TOP - 40) continue;
        var sel = (r === cursor.row && col === Math.min(cursor.col, row.length - 1));
        if (row[col].kind === 'game') drawCard(c, row[col], rect, sel);
        else drawAction(c, row[col], rect, sel);
      }
    }
    c.restore();

    drawScrollbar(c);
    drawFooter(c, [
      { g: 'D-PAD', l: 'MOVE' },
      { g: Input.glyphs(0).confirm, l: 'PLAY' },
      { g: 'START', l: 'JOIN' },
    ]);
  }

  function drawScrollbar(c) {
    var viewH = VIEW_BOT - VIEW_TOP;
    var total = contentHeight();
    if (total <= viewH + 1) return;
    var trackH = viewH;
    var thumbH = Math.max(48, trackH * (viewH / total));
    var maxScroll = total - viewH;
    var p = maxScroll > 0 ? clamp(scrollY / maxScroll, 0, 1) : 0;
    var x = SW - 18;
    c.fillStyle = 'rgba(140,150,255,.08)';
    c.fillRect(x, VIEW_TOP, 3, trackH);
    c.fillStyle = rgba(COL.a2, 0.55);
    c.fillRect(x, VIEW_TOP + (trackH - thumbH) * p, 3, thumbH);
  }

  /**
   * Footer legend. Rebuilt from Input.glyphs() on every frame, which is why a
   * controller swapped mid-session shows the right buttons immediately.
   */
  function drawFooter(c, hints) {
    c.fillStyle = 'rgba(140,150,255,.10)';
    c.fillRect(MARGIN, FOOTER_Y - 26, SW - MARGIN * 2, 1);

    var total = 0, i;
    for (i = 0; i < hints.length; i++) {
      total += 46 + measure(c, hints[i].g, 0) + measure(c, hints[i].l, 2) + 54;
    }
    var x = (SW - total) / 2;
    var y = FOOTER_Y + 16;
    for (i = 0; i < hints.length; i++) {
      var h = hints[i];
      c.font = '600 15px ' + FONT_SANS;
      var gw = Math.max(34, measure(c, h.g, 0) + 22);
      panel(c, x, y - 20, gw, 30, {
        fill: 'rgba(30,24,62,.7)', stroke: 'rgba(140,150,255,.18)', radius: 9,
      });
      text(c, h.g, x + gw / 2, y - 4, {
        size: 14, weight: '700', color: COL.text, align: 'center', cache: true,
      });
      x += gw + 10;
      text(c, h.l, x, y - 4, {
        size: 14, weight: '500', track: 2, color: COL.dim, cache: true,
      });
      x += measure(c, h.l, 2) + 30;
    }
  }

  /* ------------------------------------------------------- game frames --- */

  /** How long the controls banner stays up after a game starts. */
  var HINT_MS = 3200;

  function drawGameState(c, dim) {
    if (!activeGame) return;
    Render.enterGame();
    try { activeGame.draw(); }
    catch (e) { fault(e, activeGame.id + '.draw'); }
    Render.enterShell();

    /*
     * Controls banner for the first few seconds of a run. Someone walks up to
     * a cabinet cold; they should not have to guess, and they should not have
     * to look at it once they know.
     */
    if (!dim && state === 'game' && activeGame.hint && stateT < HINT_MS) {
      var a = stateT < HINT_MS - 600 ? 1 : (HINT_MS - stateT) / 600;
      c.globalAlpha = clamp(a, 0, 1);
      var label = formatHint(activeGame.hint);
      c.font = '500 20px ' + FONT_SANS;
      var w = measure(c, label, 1.6) + 56;
      var bx = (SW - w) / 2;
      panel(c, bx, SH - 150, w, 52, {
        fill: 'rgba(7,5,14,.82)', stroke: rgba(activeGame.accent, 0.35), radius: 14,
      });
      text(c, label, SW / 2, SH - 124, {
        size: 20, weight: '500', track: 1.6, color: COL.text,
        align: 'center', baseline: 'middle',
      });
      c.globalAlpha = 1;
    }
    if (dim) {
      c.fillStyle = 'rgba(7,5,14,0.72)';
      c.fillRect(0, 0, SW, SH);
    }
  }

  function drawModal(c, title, w, h) {
    var x = (SW - w) / 2, y = (SH - h) / 2;
    c.fillStyle = 'rgba(7,5,14,0.66)';
    c.fillRect(0, 0, SW, SH);
    panel(c, x, y, w, h, {
      fill: 'rgba(22,18,46,.94)', stroke: 'rgba(140,150,255,.20)', radius: 22,
    });
    if (title) {
      text(c, title, SW / 2, y + 66, {
        size: 30, weight: '700', track: 6, aurora: true, align: 'center',
      });
    }
    return { x: x, y: y, w: w, h: h };
  }

  function drawList(c, items, selected, x, y, w, rowH) {
    for (var i = 0; i < items.length; i++) {
      var iy = y + i * rowH;
      var sel = (i === selected);
      if (sel) {
        panel(c, x, iy, w, rowH - 8, {
          fill: 'rgba(139,123,240,.16)', stroke: rgba(COL.a2, 0.45), radius: 12,
        });
      }
      text(c, items[i], x + w / 2, iy + (rowH - 8) / 2 + 1, {
        size: 22, weight: sel ? '700' : '500', track: 4,
        color: sel ? COL.text : COL.text2, align: 'center', baseline: 'middle',
      });
    }
  }

  function drawPause(c) {
    var m = drawModal(c, 'PAUSED', 620, 500);
    drawList(c, PAUSE_ITEMS, pauseCursor, m.x + 60, m.y + 130, m.w - 120, 74);

    /* Pause is where a stuck player looks, so put the controls here. */
    if (activeGame && activeGame.hint) {
      c.fillStyle = 'rgba(140,150,255,.10)';
      c.fillRect(m.x + 60, m.y + m.h - 96, m.w - 120, 1);
      text(c, formatHint(activeGame.hint), SW / 2, m.y + m.h - 70, {
        size: 14, weight: '500', track: 1.2,
        color: rgba(activeGame.accent, 0.9), align: 'center',
      });
    }

    var gl = Input.glyphs(0);
    text(c, gl.confirm + ' SELECT   ' + gl.back + ' RESUME', SW / 2, m.y + m.h - 38, {
      size: 15, weight: '500', track: 2.5, color: COL.dim, align: 'center',
    });
  }

  function drawOver(c) {
    var m = drawModal(c, 'GAME OVER', 660, 560);
    var id = activeGame ? activeGame.id : '';

    dataText(c, fmtScore(lastScore), SW / 2, m.y + 168, {
      size: 62, align: 'center', color: COL.text,
    });
    text(c, 'SCORE', SW / 2, m.y + 202, {
      size: 14, weight: '600', track: 5, color: COL.text2, align: 'center',
    });

    if (lastRank >= 0) {
      text(c, 'NEW HIGH SCORE — RANK ' + (lastRank + 1), SW / 2, m.y + 248, {
        size: 18, weight: '700', track: 3, color: COL.a1, align: 'center',
      });
    } else {
      var b = Scores.best(id);
      dataText(c, 'BEST  ' + fmtScore(b), SW / 2, m.y + 248, {
        size: 18, align: 'center', color: COL.dim,
      });
    }

    drawList(c, OVER_ITEMS, overCursor, m.x + 60, m.y + 300, m.w - 120, 74);
    var gl = Input.glyphs(0);
    text(c, gl.confirm + ' SELECT   ' + gl.back + ' MENU', SW / 2, m.y + m.h - 42, {
      size: 15, weight: '500', track: 2.5, color: COL.dim, align: 'center',
    });
  }

  function drawInitials(c) {
    var m = drawModal(c, 'NEW HIGH SCORE', 660, 520);
    dataText(c, fmtScore(initials.score), SW / 2, m.y + 150, {
      size: 44, align: 'center', color: COL.a1,
    });
    text(c, 'ENTER YOUR INITIALS', SW / 2, m.y + 196, {
      size: 15, weight: '500', track: 4, color: COL.text2, align: 'center',
    });

    var slotW = 96, gap = 26;
    var totalW = slotW * 3 + gap * 2;
    var sx0 = (SW - totalW) / 2;
    for (var i = 0; i < 3; i++) {
      var x = sx0 + i * (slotW + gap);
      var y = m.y + 236;
      var active = (i === initials.pos);
      if (active) Render.glow(c, x + slotW / 2, y + 58, 120, COL.a2, 0.55);
      panel(c, x, y, slotW, 116, {
        fill: active ? 'rgba(30,24,62,.85)' : 'rgba(16,12,34,.6)',
        stroke: active ? rgba(COL.a2, 0.7) : COL.cardLine,
        lineWidth: active ? 2 : 1,
      });
      text(c, ALPHA.charAt(initials.chars[i]), x + slotW / 2, y + 58, {
        size: 56, weight: '700', color: active ? COL.text : COL.text2,
        align: 'center', baseline: 'middle',
      });
      if (active) {
        /* Up/down arrows make the interaction obvious without instructions. */
        var bob = Math.sin(t * 0.006) * 3;
        text(c, '▲', x + slotW / 2, y - 14 - bob, {
          size: 16, color: COL.a1, align: 'center', baseline: 'middle',
        });
        text(c, '▼', x + slotW / 2, y + 130 + bob, {
          size: 16, color: COL.a1, align: 'center', baseline: 'middle',
        });
      }
    }

    var gl = Input.glyphs(0);
    text(c, '▲▼ LETTER   ◀▶ SLOT   ' + gl.confirm + ' OK', SW / 2, m.y + m.h - 42, {
      size: 15, weight: '500', track: 2.5, color: COL.dim, align: 'center',
    });
  }

  /* ------------------------------------------------------ settings UI --- */

  function drawSettings(c) {
    wordmark(c, SW / 2, 110, 54);
    text(c, 'SETTINGS', SW / 2, 178, {
      size: 20, weight: '600', track: 7, color: COL.text2, align: 'center',
    });

    var items = settingsItems();
    var lay = settingsLayout(items);
    var x = MARGIN + 20, w = SW - (MARGIN + 20) * 2;

    c.save();
    c.beginPath();
    c.rect(0, SET_TOP - 10, SW, (SET_BOT - SET_TOP) + 20);
    c.clip();

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var y = SET_TOP + lay.ys[i] - setScroll;
      var rh = it.type === 'header' ? SET_HEADER_H : SET_ROW_H;
      if (y + rh < SET_TOP - 20 || y > SET_BOT + 20) continue;

      if (it.type === 'header') {
        text(c, it.label, x + 6, y + rh - 18, {
          size: 15, weight: '700', track: 6, color: rgba(COL.a2, 0.75),
        });
        c.strokeStyle = rgba(COL.a2, 0.22);
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x + 6, y + rh - 8);
        c.lineTo(x + w - 6, y + rh - 8);
        c.stroke();
        continue;
      }

      var sel = (i === setCursor);
      if (sel) {
        panel(c, x, y, w, rh - 12, {
          fill: 'rgba(30,24,62,.72)',
          stroke: rgba(it.danger ? COL.bad : COL.a2, 0.5), lineWidth: 2,
        });
      } else {
        panel(c, x, y, w, rh - 12, { fill: COL.card, stroke: COL.cardLine });
      }

      var cy = y + (rh - 12) / 2 + 1;
      text(c, it.label, x + 26, cy, {
        size: 21, weight: sel ? '700' : '500', track: 3,
        color: it.danger ? (sel ? COL.bad : rgba(COL.bad, 0.75)) : (sel ? COL.text : COL.text2),
        baseline: 'middle',
      });

      if (it.type === 'toggle') {
        drawToggle(c, x + w - 110, cy, it.on, sel);
      } else if (it.type === 'range') {
        drawSlider(c, x + w - 260, cy, 180, Settings.get('volume'), sel);
        dataText(c, it.value, x + w - 26, cy, {
          size: 18, align: 'right', baseline: 'middle',
          color: sel ? COL.data : COL.dim,
        });
      } else if (it.type === 'choice') {
        text(c, '◀', x + w - 240, cy, { size: 16, color: sel ? COL.a1 : COL.dim, baseline: 'middle' });
        text(c, it.value, x + w - 130, cy, {
          size: 17, weight: '600', track: 2, color: sel ? COL.data : COL.dim,
          align: 'center', baseline: 'middle',
        });
        text(c, '▶', x + w - 34, cy, { size: 16, color: sel ? COL.a1 : COL.dim, align: 'right', baseline: 'middle' });
      } else if (it.value) {
        dataText(c, it.value, x + w - 26, cy, {
          size: 16, align: 'right', baseline: 'middle',
          color: it.warn ? COL.warn : (sel ? COL.data : COL.dim),
        });
      }
    }
    c.restore();

    text(c, Store.persistent()
      ? 'SETTINGS AND SCORES ARE SAVED ON THIS CABINET'
      : 'STORAGE UNAVAILABLE — CHANGES LAST FOR THIS SESSION ONLY',
      SW / 2, FOOTER_Y - 52, {
        size: 14, weight: '500', track: 2,
        color: Store.persistent() ? COL.dim : COL.warn, align: 'center',
      });

    var gl = Input.glyphs(0);
    drawFooter(c, [
      { g: 'D-PAD', l: 'ADJUST' },
      { g: gl.confirm, l: 'SELECT' },
      { g: gl.back, l: 'BACK' },
    ]);

    if (confirmBox) drawConfirm(c);
  }

  function drawToggle(c, x, cy, on, sel) {
    var w = 64, h = 30;
    var y = cy - h / 2;
    roundRect(c, x, y, w, h, h / 2);
    c.fillStyle = on ? rgba(COL.a1, 0.30) : 'rgba(110,106,160,.18)';
    c.fill();
    c.strokeStyle = on ? rgba(COL.a1, 0.7) : COL.cardLine;
    c.lineWidth = 1;
    c.stroke();
    var kx = on ? x + w - h / 2 : x + h / 2;
    c.beginPath();
    c.arc(kx, cy, h / 2 - 4, 0, Math.PI * 2);
    c.fillStyle = on ? COL.a1 : COL.dim;
    c.fill();
    if (sel) Render.glow(c, x + w / 2, cy, 70, on ? COL.a1 : COL.a2, 0.35);
  }

  function drawSlider(c, x, cy, w, v, sel) {
    var val = clamp(num(v, 0), 0, 1);
    c.fillStyle = 'rgba(110,106,160,.22)';
    c.fillRect(x, cy - 2, w, 4);
    var g = c.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, COL.a1); g.addColorStop(1, COL.a2);
    c.fillStyle = g;
    c.fillRect(x, cy - 2, w * val, 4);
    c.beginPath();
    c.arc(x + w * val, cy, sel ? 9 : 7, 0, Math.PI * 2);
    c.fillStyle = COL.text;
    c.fill();
  }

  function drawConfirm(c) {
    var m = drawModal(c, null, 640, 300);
    text(c, confirmBox.text, SW / 2, m.y + 90, {
      size: 24, weight: '600', track: 2, color: COL.text, align: 'center',
    });
    var opts = ['YES', 'CANCEL'];
    var bw = 220, gap = 30;
    var x0 = (SW - (bw * 2 + gap)) / 2;
    for (var i = 0; i < 2; i++) {
      var x = x0 + i * (bw + gap);
      var sel = (confirmBox.cursor === i);
      var danger = (i === 0);
      panel(c, x, m.y + 150, bw, 64, {
        fill: sel ? (danger ? rgba(COL.bad, 0.22) : 'rgba(30,24,62,.85)') : COL.card,
        stroke: sel ? (danger ? rgba(COL.bad, 0.7) : rgba(COL.a2, 0.5)) : COL.cardLine,
        lineWidth: sel ? 2 : 1,
      });
      text(c, opts[i], x + bw / 2, m.y + 150 + 34, {
        size: 20, weight: '700', track: 3,
        color: sel ? (danger ? COL.bad : COL.text) : COL.text2,
        align: 'center', baseline: 'middle',
      });
    }
  }

  /* -------------------------------------------------------- scores UI --- */

  function drawScores(c) {
    wordmark(c, SW / 2, 110, 54);
    text(c, 'HIGH SCORES', SW / 2, 178, {
      size: 20, weight: '600', track: 7, color: COL.text2, align: 'center',
    });

    var g = GAMES[scoresGame] || GAMES[0];
    if (!g) return;

    /* Game selector. */
    var selY = 246;
    text(c, '◀', MARGIN + 30, selY, { size: 26, color: COL.a1, baseline: 'middle' });
    text(c, g.title, SW / 2, selY, {
      size: 40, weight: '700', track: 6, color: COL.text,
      align: 'center', baseline: 'middle',
    });
    text(c, '▶', SW - MARGIN - 30, selY, {
      size: 26, color: COL.a1, align: 'right', baseline: 'middle',
    });
    text(c, (scoresGame + 1) + ' / ' + GAMES.length, SW / 2, selY + 40, {
      size: 14, weight: '500', track: 3, color: COL.dim, align: 'center',
    });

    var table = Scores.table(g.id);
    var x = MARGIN + 40, w = SW - (MARGIN + 40) * 2;
    var y0 = 340, rowH = 96;

    for (var i = 0; i < TOP_N; i++) {
      var e = table[i];
      var y = y0 + i * rowH;
      panel(c, x, y, w, rowH - 14, {
        fill: e ? 'rgba(22,18,46,.62)' : 'rgba(22,18,46,.30)',
        stroke: (i === 0 && e) ? rgba(g.accent, 0.45) : COL.cardLine,
      });
      var cy = y + (rowH - 14) / 2 + 1;

      dataText(c, String(i + 1), x + 34, cy, {
        size: 26, align: 'center', baseline: 'middle',
        color: i === 0 ? g.accent : COL.dim,
      });
      text(c, e ? e.name : '- - -', x + 110, cy, {
        size: 30, weight: '700', track: 8, baseline: 'middle',
        color: e ? COL.text : COL.dim, mono: true,
      });
      dataText(c, e ? fmtScore(e.score) : '—', x + w - 30, cy, {
        size: 28, align: 'right', baseline: 'middle',
        color: e ? (i === 0 ? g.accent : COL.data) : COL.dim,
      });
    }

    var gl = Input.glyphs(0);
    drawFooter(c, [
      { g: 'D-PAD', l: 'GAME' },
      { g: gl.back, l: 'BACK' },
    ]);
  }

  /* ------------------------------------------------------- attract UI --- */

  function drawAttract(c) {
    if (attract.art) {
      /* Edge-to-edge, no text, no chrome — just the art. */
      Render.enterShell();
      Artscape.draw(sx, t);
      return;
    }
    if (attract.game) {
      Render.enterGame();
      try { attract.game.draw(); }
      catch (e) { /* ignore */ }
      Render.enterShell();
      c.fillStyle = 'rgba(7,5,14,0.55)';
      c.fillRect(0, 0, SW, SH);
    }

    var pulse = 0.55 + Math.sin(t * 0.0022) * 0.45;
    c.globalAlpha = clamp(0.55 + pulse * 0.45, 0, 1);
    wordmark(c, SW / 2, SH * 0.36, 84);
    c.globalAlpha = 1;

    if (attract.game) {
      text(c, attract.game.title, SW / 2, SH * 0.36 + 96, {
        size: 24, weight: '600', track: 8,
        color: rgba(attract.game.accent, 0.9), align: 'center',
      });
      text(c, attract.game.tag, SW / 2, SH * 0.36 + 136, {
        size: 17, weight: '400', color: COL.text2, align: 'center',
      });
    }

    c.globalAlpha = clamp(0.35 + Math.sin(t * 0.004) * 0.35, 0, 1);
    text(c, 'PRESS ANY BUTTON', SW / 2, SH * 0.78, {
      size: 26, weight: '600', track: 8, color: COL.text, align: 'center',
    });
    c.globalAlpha = 1;

    /* Top-five ticker for the game on screen. */
    if (attract.game) {
      var tbl = Scores.table(attract.game.id);
      for (var i = 0; i < tbl.length && i < 3; i++) {
        dataText(c, (i + 1) + '.  ' + tbl[i].name + '   ' + fmtScore(tbl[i].score),
          SW / 2, SH * 0.85 + i * 34, { size: 18, align: 'center', color: COL.dim });
      }
    }
  }

  /* ----------------------------------------------------- frame timer --- */

  /**
   * On-cabinet frame timer. This exists because the 60fps target has to be
   * verifiable on the actual Pi, in the actual kiosk, with no debugger
   * attached and no keyboard plugged in. Shows the mean, the worst frame in
   * the last window, and a bar that turns amber past 16.7ms.
   */
  function drawFrameTimer(c) {
    var on = false;
    try { on = !!Settings.get('showFps'); } catch (e) { on = false; }
    if (!on) return;
    Render.enterShell();

    var sum = 0, worst = 0;
    for (var i = 0; i < FT_N; i++) {
      sum += frameTimes[i];
      if (frameTimes[i] > worst) worst = frameTimes[i];
    }
    var mean = sum / FT_N;
    var fps = mean > 0 ? 1000 / mean : 0;
    var bad = mean > 17.5;

    panel(c, 16, SH - 330, 480, 144, {
      fill: 'rgba(7,5,14,.88)', stroke: bad ? rgba(COL.warn, 0.6) : COL.cardLine,
      radius: 10,
    });
    dataText(c, fps.toFixed(1) + ' FPS', 32, SH - 302, {
      size: 20, color: bad ? COL.warn : COL.a1,
    });
    /* cpu = time spent inside our frame callback. Near the avg: the JS (or
     * a software canvas rasterising inside our draw calls) is the cost.
     * Near zero with a slow avg: the pipeline below us is the cost. */
    var lp = Loop.perf();
    dataText(c, 'avg ' + mean.toFixed(1) + '  max ' + worst.toFixed(1) +
      '  cpu ' + lp.cpuMean.toFixed(1) +
      ' (u' + lp.updMean.toFixed(1) + ' d' + lp.drwMean.toFixed(1) + ')',
      32, SH - 280, { size: 14, color: COL.dim });

    /*
     * The input half. These are the numbers that answer "does the controller
     * feel right", which frame time alone cannot:
     *
     *   sample   how often we read the pads (should be ~250/s)
     *   pad      how often the browser actually gives us fresh pad data
     *   saved    presses that had already been released by the time the frame
     *            ran — every one of these was silently dropped before
     *            latching existed, so a rising number here is the feature
     *            working, not a fault
     */
    var d = Input.diagnostics();
    var elapsed = Math.max(1, t) / 1000;
    dataText(c, 'sample ' + Math.round(d.samples / elapsed) + '/s' +
      (d.sampling ? '' : ' (rAF only)'), 32, SH - 254, {
      size: 14, color: d.sampling ? COL.dim : COL.warn,
    });
    dataText(c, 'pad ' + Math.round(d.padUpdates / elapsed) + '/s' +
      '   audio ' + Audio2.latencyMs().toFixed(0) + 'ms' +
      '   video ' + (Render.lowLatency() ? 'low-lat' : 'normal'),
      32, SH - 232, { size: 14, color: COL.dim });
    dataText(c, 'taps saved ' + d.tapsSaved +
      '   fullscreen ops/f ' + (frameOps || 2), 32, SH - 210, {
      size: 14, color: d.tapsSaved > 0 ? COL.a1 : COL.dim,
    });

    /* A 16.7ms reference line, so "over budget" is visible not calculated. */
    var bx = 340, bw = 140, by = SH - 312;
    c.fillStyle = 'rgba(110,106,160,.22)';
    c.fillRect(bx, by, bw, 26);
    for (var k = 0; k < FT_N; k++) {
      var ft = frameTimes[(frameAt + k) % FT_N];
      var hgt = clamp(ft / 33.4, 0, 1) * 26;
      c.fillStyle = ft > 17.5 ? COL.warn : COL.a1;
      c.fillRect(bx + k * (bw / FT_N), by + 26 - hgt, Math.max(1, bw / FT_N - 0.5), hgt);
    }
    c.globalAlpha = 0.6;
    c.fillStyle = COL.text2;
    c.fillRect(bx, by + 26 - (16.667 / 33.4) * 26, bw, 1);
    c.globalAlpha = 1;
  }

  /* -------------------------------------------------- update + about --- */

  function drawUpdate(c) {
    wordmark(c, SW / 2, 110, 54);
    text(c, 'SOFTWARE UPDATE', SW / 2, 178, {
      size: 20, weight: '600', track: 7, color: COL.text2, align: 'center',
    });

    var x = MARGIN + 20, w = SW - (MARGIN + 20) * 2;
    panel(c, x, 260, w, 190, { fill: COL.card, stroke: COL.cardLine });
    text(c, 'INSTALLED VERSION', x + 30, 310, { size: 15, weight: '600', track: 4, color: COL.dim });
    dataText(c, 'V' + VERSION_STR + '  ·  BUILD ' + buildId().toUpperCase(), x + 30, 360, {
      size: 26, color: COL.text,
    });
    text(c, 'UPDATES INSTALL NEW GAMES AND FIXES TOGETHER', x + 30, 412, {
      size: 14, weight: '500', track: 2, color: COL.dim,
    });

    var midY = 560;
    if (upd.phase === 'starting' || upd.phase === 'running') {
      var st = upd.status;
      var msg = upd.phase === 'starting' ? 'CONTACTING THE UPDATE AGENT'
        : (st && st.msg ? String(st.msg).toUpperCase() : 'CHECKING');
      var dots = '';
      for (var d = 0; d < 1 + ((t / 400) | 0) % 3; d++) dots += '.';
      text(c, msg + dots, SW / 2, midY, {
        size: 24, weight: '600', track: 3, color: COL.a1, align: 'center',
      });
      if (st && st.phase) {
        text(c, String(st.phase).toUpperCase(), SW / 2, midY + 56, {
          size: 15, weight: '500', track: 4, color: COL.dim, align: 'center',
        });
      }
      text(c, 'THE CABINET RESTARTS BY ITSELF IF AN UPDATE IS INSTALLED',
        SW / 2, midY + 130, { size: 14, track: 2, color: COL.dim, align: 'center' });
      text(c, formatHint('{B} LEAVE — THE UPDATE KEEPS RUNNING'), SW / 2, SH - 90, {
        size: 15, weight: '500', track: 2, color: COL.dim, align: 'center',
      });
      return;
    }

    if (upd.phase === 'error') {
      text(c, upd.error || 'UPDATE FAILED', SW / 2, midY, {
        size: 22, weight: '700', track: 2, color: COL.bad, align: 'center',
      });
    } else if (upd.phase === 'done') {
      var stt = upd.status || {};
      text(c, stt.updated ? 'UPDATE INSTALLED — RESTARTING THE CABINET'
        : 'YOU ARE UP TO DATE', SW / 2, midY, {
        size: 24, weight: '700', track: 2, color: stt.updated ? COL.good : COL.text, align: 'center',
      });
      if (stt.from && stt.to && stt.updated) {
        dataText(c, String(stt.from).slice(0, 8) + '  →  ' + String(stt.to).slice(0, 8),
          SW / 2, midY + 60, { size: 18, align: 'center', color: COL.data });
      }
    }

    var items = updItems();
    drawList(c, items, upd.cursor, MARGIN + 80, midY + 150, SW - (MARGIN + 80) * 2, 74);
  }

  function drawAbout(c) {
    wordmark(c, SW / 2, 110, 54);
    text(c, 'ABOUT THIS CABINET', SW / 2, 178, {
      size: 20, weight: '600', track: 7, color: COL.text2, align: 'center',
    });

    var rowsA = [
      ['VERSION', 'V' + VERSION_STR],
      ['BUILD', buildId().toUpperCase()],
      ['GAMES', String(GAMES.length + VERSUS_GAMES.length)],
      ['STORAGE', Store.persistent() ? 'SAVED ON THIS CABINET' : 'SESSION ONLY'],
      ['CONTROLLER', Input.padCount()
        ? Input.kindOf(0).toUpperCase() + ' (' + Input.layoutOf(0).toUpperCase() + ' LAYOUT)'
        : 'NONE DETECTED'],
      ['UPDATE AGENT', aboutAgent === null ? 'CHECKING…'
        : (aboutAgent.ok ? 'RUNNING' : 'NOT AVAILABLE')],
      ['KIOSK WATCHDOG', aboutAgent && aboutAgent.ok
        ? (aboutAgent.frontend === 'alive' ? 'ARMED' : 'WAITING FOR FIRST FRAME')
        : '—'],
      ['FAULTS RECORDED', String(Faults.count())],
      ['SESSION', Math.floor(t / 60000) + ' MIN'],
    ];

    var x = MARGIN + 20, w = SW - (MARGIN + 20) * 2;
    var y0 = 270, rh = 96;
    for (var i = 0; i < rowsA.length; i++) {
      var y = y0 + i * rh;
      panel(c, x, y, w, rh - 14, { fill: COL.card, stroke: COL.cardLine });
      text(c, rowsA[i][0], x + 28, y + (rh - 14) / 2, {
        size: 16, weight: '600', track: 4, color: COL.dim, baseline: 'middle',
      });
      dataText(c, rowsA[i][1], x + w - 28, y + (rh - 14) / 2, {
        size: 19, align: 'right', color: COL.text, baseline: 'middle',
      });
    }

    text(c, formatHint('{B} BACK'), SW / 2, SH - 90, {
      size: 15, weight: '500', track: 2, color: COL.dim, align: 'center',
    });
  }

  /**
   * Progress ring while START is held. Appears only after a beat so a normal
   * tap never flashes it, and only where going home means anything.
   */
  function drawHomeHold(c) {
    if (state === 'boot' || state === 'menu') return;
    if (!homeArmed || homeHold < 220) return;
    var p = clamp((homeHold - 220) / (HOME_HOLD_MS - 220), 0, 1);
    var cx = SW / 2, cy = 120, r = 44;
    Render.enterShell();
    c.globalAlpha = 0.92;
    c.fillStyle = 'rgba(7,5,14,.78)';
    c.beginPath();
    c.arc(cx, cy, r + 16, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = rgba(COL.a2, 0.35);
    c.lineWidth = 6;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = COL.a1;
    c.beginPath();
    c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    c.stroke();
    text(c, 'HOME', cx, cy, {
      size: 15, weight: '700', track: 3, color: COL.text, align: 'center', baseline: 'middle',
    });
    c.globalAlpha = 1;
  }

  /* ----------------------------------------------------------- toast --- */

  function drawToast(c) {
    if (!toast) return;
    Render.enterShell();
    var a = clamp(Math.min(toast.life / 400, 1), 0, 1);
    c.font = '600 17px ' + FONT_SANS;
    var w = measure(c, toast.text, 2) + 56;
    var x = (SW - w) / 2, y = 40;
    c.globalAlpha = a;
    panel(c, x, y, w, 52, {
      fill: 'rgba(30,24,62,.94)', stroke: rgba(COL.a1, 0.4), radius: 14,
    });
    text(c, toast.text, SW / 2, y + 27, {
      size: 17, weight: '600', track: 2, color: COL.text,
      align: 'center', baseline: 'middle',
    });
    c.globalAlpha = 1;
  }

  /* ------------------------------------------------------------- API --- */

  return {
    update: update,
    draw: draw,
    gameOver: gameOver,
    buildMenu: buildMenu,
    state: function () { return state; },
    /** Test seams — the harness drives these to walk the state machine. */
    _go: go,
    _select: function (id) {
      for (var r = 0; r < rows.length; r++) {
        for (var c2 = 0; c2 < rows[r].length; c2++) {
          var e = rows[r][c2];
          if (e.kind === 'game' && e.game.id === id) {
            cursor.row = r; cursor.col = c2; ensureVisible();
            return true;
          }
        }
      }
      return false;
    },
    _startGame: startGame,
    /** Pin the seed every future run uses. null restores clock seeding. */
    _seedRuns: function (seed) { forcedSeed = seed; },
    _activeGame: function () { return activeGame; },
    _lastScore: function () { return lastScore; },
    _rows: function () { return rows; },
    _cursor: function () { return cursor; },
    _toast: function () { return toast; },
    _confirm: function () { return confirmBox; },
    _setCursor: function (i) { setCursor = i; },
    _settingsCursor: function () { return setCursor; },
    _navStack: function () { return navStack.slice(); },
    _upd: function () { return upd; },
    _homeHoldMs: HOME_HOLD_MS,
    _settingsItems: settingsItems,
    _formatHint: formatHint,
    _idle: function () { return idleT; },
    _frameStats: function () {
      var sum = 0, worst = 0;
      for (var i = 0; i < FT_N; i++) {
        sum += frameTimes[i];
        if (frameTimes[i] > worst) worst = frameTimes[i];
      }
      return { mean: sum / FT_N, worst: worst, sessionWorst: worstFrame };
    },
    _forceIdle: function (ms) { idleT = ms; },
    _reset: function () {
      state = 'boot'; prevState = 'boot';
      t = 0; stateT = 0; idleT = 0; fade = 0;
      cursor.row = 0; cursor.col = 0;
      scrollY = 0; scrollTarget = 0;
      activeGame = null; lastScore = 0; lastRank = -1;
      pauseCursor = 0; overCursor = 0; scoresGame = 0; setCursor = 0;
      confirmBox = null; toast = null; lastPadsVersion = -1;
      navStack.length = 0; homeHold = 0; homeArmed = true;
      setScroll = 0; setScrollT = 0;
      upd.phase = 'idle'; upd.cursor = 0; upd.poll = 0; upd.status = null; upd.error = '';
      aboutAgent = null;
      attract.game = null; attract.timer = 0; attract.index = 0;
      Input.setDemo(null);
      buildMenu();
    },
  };
})();
