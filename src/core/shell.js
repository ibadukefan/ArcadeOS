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
  var confirmBox = null;      /* {text, onYes, cursor} */
  var toast = null;           /* {text, life} */
  var lastPadsVersion = -1;

  var ATTRACT_AFTER = 60000;
  var attract = { game: null, timer: 0, index: 0 };

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
    prevState = state;
    state = next;
    stateT = 0;
    fade = 1;
    Input.flush();
  }

  function say(msg) { toast = { text: String(msg), life: 2600 }; }

  /* ------------------------------------------------------------- boot --- */

  function bootUpdate(dt) {
    if (stateT > 2200 || Input.hit('confirm') || Input.hit('pause')) {
      buildMenu();
      go('menu');
      Audio2.sfx('start');
    }
  }

  /* ------------------------------------------------------------- menu --- */

  function startGame(game, versus) {
    activeGame = game;
    seedRng((Date.now ? Date.now() : 0) ^ (t | 0) ^ 0x5bf03635);
    try { game.start(); }
    catch (e) { say('FAILED TO START'); go('menu'); return; }
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
      else if (e.id === 'scores') { scoresGame = 0; go('scores'); Audio2.sfx('select'); }
      else if (e.id === 'settings') { setCursor = 0; go('settings'); Audio2.sfx('select'); }
    }

    scrollY = approach(scrollY, scrollTarget, 14, dt);
  }

  /* ------------------------------------------------------------- game --- */

  function gameUpdate(dt) {
    if (Input.hit('pause')) { pauseCursor = 0; go('pause'); Audio2.sfx('back'); return; }
    if (!activeGame) { go('menu'); return; }
    try { activeGame.update(dt); }
    catch (e) {
      say('GAME ERROR — RETURNED TO MENU');
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
      { id: 'volume', label: 'VOLUME', type: 'range',
        value: Math.round(s.volume * 100) + '%' },
      { id: 'muted', label: 'MUTE', type: 'toggle', on: s.muted },
      { id: 'layout', label: 'CONTROLLER', type: 'choice',
        value: layoutLabel(s.layout) },
      { id: 'crt', label: 'CRT VEIL', type: 'toggle', on: s.crt },
      { id: 'reducedMotion', label: 'REDUCED MOTION', type: 'toggle', on: s.reducedMotion },
      { id: 'pairing', label: 'PAIR BLUETOOTH PAD', type: 'action' },
      { id: 'reset', label: 'RESET HIGH SCORES', type: 'action', danger: true },
      { id: 'restart', label: 'RESTART', type: 'action', danger: true },
      { id: 'shutdown', label: 'SHUT DOWN', type: 'action', danger: true },
      { id: 'back', label: 'BACK', type: 'action' },
    ];
  }

  function layoutLabel(v) {
    if (v === 'xbox') return 'XBOX';
    if (v === 'playstation') return 'PLAYSTATION';
    if (v === 'nintendo') return 'NINTENDO';
    return 'AUTO (' + Input.layoutOf(0).toUpperCase() + ')';
  }

  var LAYOUTS = ['auto', 'xbox', 'playstation', 'nintendo'];

  function settingsUpdate(dt) {
    if (confirmBox) { confirmUpdate(dt); return; }

    var items = settingsItems();
    var steps = Input.repCount('down') - Input.repCount('up');
    if (steps) {
      setCursor = (setCursor + steps + items.length * 8) % items.length;
      Audio2.sfx('move');
    }

    var it = items[setCursor];
    var h = Input.repCount('right') - Input.repCount('left');

    if (h && it.type === 'range') {
      var vol = clamp(Settings.get('volume') + h * 0.05, 0, 1);
      Settings.set('volume', Math.round(vol * 20) / 20);
      Audio2.sfx('move');
    } else if (h && it.type === 'choice') {
      var i = LAYOUTS.indexOf(Settings.get('layout'));
      i = (i + h + LAYOUTS.length * 8) % LAYOUTS.length;
      Settings.set('layout', LAYOUTS[i]);
      Audio2.sfx('select');
    } else if (h && it.type === 'toggle') {
      Settings.set(it.id, !Settings.get(it.id));
      Audio2.sfx('select');
    }

    if (Input.hit('confirm')) activate(it);
    if (Input.hit('back')) { go('menu'); Audio2.sfx('back'); }
  }

  function activate(it) {
    if (!it) return;
    if (it.type === 'toggle') {
      Settings.set(it.id, !Settings.get(it.id));
      Audio2.sfx('select');
      return;
    }
    if (it.type === 'choice') {
      var i = LAYOUTS.indexOf(Settings.get('layout'));
      Settings.set('layout', LAYOUTS[(i + 1) % LAYOUTS.length]);
      Audio2.sfx('select');
      return;
    }
    if (it.id === 'back') { go('menu'); Audio2.sfx('back'); return; }
    if (it.id === 'reset') {
      ask('ERASE ALL HIGH SCORES?', function () {
        Scores.reset();
        say('HIGH SCORES CLEARED');
      });
      return;
    }
    if (it.id === 'pairing') {
      System.pair();
      say('PAIRING MODE — HOLD SYNC ON THE PAD');
      return;
    }
    if (it.id === 'restart') {
      ask('RESTART THE CABINET?', function () {
        say('RESTARTING…');
        System.request('restart');
      });
      return;
    }
    if (it.id === 'shutdown') {
      ask('SHUT DOWN THE CABINET?', function () {
        say('SHUTTING DOWN — WAIT FOR THE GREEN LED TO STOP');
        System.request('shutdown');
      });
      return;
    }
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
    if (Input.hit('back') || Input.hit('confirm')) { go('menu'); Audio2.sfx('back'); }
  }

  /* --------------------------------------------------------- attract --- */

  function enterAttract() {
    attract.index = (attract.index + 1) % Math.max(1, GAMES.length);
    attract.game = GAMES[attract.index] || null;
    attract.timer = 0;
    if (attract.game) {
      seedRng(0xA77AC7 + attract.index);
      try { attract.game.start(); } catch (e) { attract.game = null; }
    }
    go('attract');
  }

  function attractUpdate(dt) {
    /* Any input at all drops straight back to the dashboard. */
    if (Input.consumeActivity()) {
      attract.game = null;
      idleT = 0;
      go('menu');
      Audio2.sfx('back');
      return;
    }
    attract.timer += dt;
    if (attract.game) {
      /* The demo plays itself; if it dies or stalls, rotate to the next. */
      try { attractDrive(dt); attract.game.update(dt); }
      catch (e) { attract.game = null; }
    }
    if (attract.timer > 14000 || !attract.game) enterAttract();
  }

  /**
   * The demo pilot. Deliberately mediocre — it exists to make the cabinet look
   * alive from across a room, not to set records.
   */
  function attractDrive(dt) {
    /* Nothing is injected into Input; games read Input directly, so the demo
     * simply lets them run on gravity and timers. Games that need no input to
     * be visually interesting (falling pieces, sweeping slabs, scrolling
     * fields) carry the loop on their own. */
  }

  /* ------------------------------------------------------------ frame --- */

  function update(dt) {
    t += dt;
    stateT += dt;
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
      case 'attract': drawAttract(c); break;
    }

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
      size: size, weight: '700', track: size * 0.19, aurora: true,
      align: 'center', baseline: 'middle',
    });
    text(c, 'OS', cx + w / 2 + size * 0.34, cy, {
      size: size * 0.42, weight: '600', track: size * 0.10,
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
    });

    var n = Input.playerCount();
    var label = n > 1 ? n + ' PLAYERS READY' : 'PRESS START TO JOIN P2';
    text(c, label, SW / 2, 232, {
      size: 15, weight: '500', track: 3, color: COL.dim, align: 'center',
    });

    /* Hairline under the header. */
    c.fillStyle = 'rgba(140,150,255,.10)';
    c.fillRect(MARGIN, HEADER_H - 42, SW - MARGIN * 2, 1);
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

    /* Preview window. */
    var pw = rect.w - 36, ph = rect.h - 132;
    var px = rect.x + 18, py = rect.y + 18;
    c.save();
    roundRect(c, px, py, pw, ph, 12);
    c.clip();
    c.fillStyle = 'rgba(8,6,18,0.45)';
    c.fillRect(px, py, pw, ph);
    c.translate(px, py);
    try { g.preview(c, pw, ph, t); }
    catch (err) { /* a broken preview must not take the dashboard down */ }
    c.restore();

    if (e.versus) {
      panel(c, rect.x + rect.w - 92, rect.y + 26, 62, 26, {
        fill: rgba(g.accent, 0.18), stroke: rgba(g.accent, 0.5), radius: 8,
      });
      text(c, '2P', rect.x + rect.w - 61, rect.y + 44, {
        size: 13, weight: '700', track: 1.5, color: COL.text, align: 'center',
      });
    }

    text(c, g.title, rect.x + 20, rect.y + rect.h - 74, {
      size: 30, weight: '700', track: 4.5,
      color: selected ? COL.text : '#CFCBEC',
    });
    text(c, g.tag, rect.x + 20, rect.y + rect.h - 40, {
      size: 16, weight: '400', track: 0.4, color: COL.text2,
    });

    var best = Scores.best(g.id);
    if (best > 0) {
      dataText(c, fmtScore(best), rect.x + rect.w - 20, rect.y + rect.h - 40, {
        size: 16, align: 'right', color: rgba(g.accent, 0.95),
      });
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
      size: 22, weight: '600', track: 3.5,
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
        size: 14, weight: '700', color: COL.text, align: 'center',
      });
      x += gw + 10;
      text(c, h.l, x, y - 4, { size: 14, weight: '500', track: 2, color: COL.dim });
      x += measure(c, h.l, 2) + 30;
    }
  }

  /* ------------------------------------------------------- game frames --- */

  function drawGameState(c, dim) {
    if (!activeGame) return;
    Render.enterGame();
    try { activeGame.draw(); }
    catch (e) { /* a draw fault must not wedge the shell */ }
    Render.enterShell();
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
    var m = drawModal(c, 'PAUSED', 620, 460);
    drawList(c, PAUSE_ITEMS, pauseCursor, m.x + 60, m.y + 130, m.w - 120, 74);
    var gl = Input.glyphs(0);
    text(c, gl.confirm + ' SELECT   ' + gl.back + ' RESUME', SW / 2, m.y + m.h - 42, {
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
    var x = MARGIN + 20, w = SW - (MARGIN + 20) * 2;
    var y0 = 250, rowH = 92;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var y = y0 + i * rowH;
      var sel = (i === setCursor);
      if (sel) {
        panel(c, x, y, w, rowH - 12, {
          fill: 'rgba(30,24,62,.72)',
          stroke: rgba(it.danger ? COL.bad : COL.a2, 0.5), lineWidth: 2,
        });
      } else {
        panel(c, x, y, w, rowH - 12, { fill: COL.card, stroke: COL.cardLine });
      }

      var cy = y + (rowH - 12) / 2 + 1;
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
      }
    }

    var y2 = y0 + items.length * rowH + 12;
    text(c, Store.persistent()
      ? 'SETTINGS AND SCORES ARE SAVED ON THIS CABINET'
      : 'STORAGE UNAVAILABLE — CHANGES LAST FOR THIS SESSION ONLY',
      SW / 2, y2 + 20, {
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
    _activeGame: function () { return activeGame; },
    _lastScore: function () { return lastScore; },
    _rows: function () { return rows; },
    _cursor: function () { return cursor; },
    _toast: function () { return toast; },
    _confirm: function () { return confirmBox; },
    _setCursor: function (i) { setCursor = i; },
    _settingsItems: settingsItems,
    _idle: function () { return idleT; },
    _forceIdle: function (ms) { idleT = ms; },
    _reset: function () {
      state = 'boot'; prevState = 'boot';
      t = 0; stateT = 0; idleT = 0; fade = 0;
      cursor.row = 0; cursor.col = 0;
      scrollY = 0; scrollTarget = 0;
      activeGame = null; lastScore = 0; lastRank = -1;
      pauseCursor = 0; overCursor = 0; scoresGame = 0; setCursor = 0;
      confirmBox = null; toast = null; lastPadsVersion = -1;
      attract.game = null; attract.timer = 0; attract.index = 0;
      buildMenu();
    },
  };
})();
