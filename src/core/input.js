/*
 * Input: gamepads and keyboards collapsed into eight semantic actions.
 *
 *   up  down  left  right  confirm  back  alt  pause
 *
 * Nothing above this layer ever asks "which button" — it asks "which action".
 * That is what lets an Xbox pad, a DualSense, a Switch Pro controller and a
 * USB arcade encoder wired as an arrow-key keyboard all drive the same shell.
 *
 * THE FACE-BUTTON SWAP
 * --------------------
 * Xbox and PlayStation confirm with the BOTTOM face button (index 0).
 * Nintendo confirms with the RIGHT one (index 1) because their A/B are
 * physically mirrored. Both end up displaying "A" for confirm — the label is
 * the same, the index is not. Getting this wrong makes a Switch Pro pad feel
 * broken in a way users cannot articulate. Do not "simplify" it away.
 *
 * Auto-repeat is measured in milliseconds, never in frames: 360ms to the
 * first repeat, then one every 120ms. Total steps over a given wall-clock
 * span are identical whether the display runs at 30, 60 or 144Hz.
 */

var ACTIONS = ['up', 'down', 'left', 'right', 'confirm', 'back', 'alt', 'pause'];

var REPEAT_DELAY = 360;
var REPEAT_RATE = 120;
var DEADZONE = 0.4;
var MAX_PLAYERS = 4;

var Input = (function () {

  /* ------------------------------------------------------ keyboard --- */

  /**
   * Generous mapping. USB arcade encoders in keyboard mode emit arrows plus
   * some scattering of Z/X/C, Ctrl, Alt, Space and Enter depending on the
   * board, so we accept all of the common ones rather than making the user
   * reflash their encoder.
   */
  var KEYMAP = {
    ArrowUp: 'up', KeyW: 'up', Numpad8: 'up',
    ArrowDown: 'down', KeyS: 'down', Numpad2: 'down',
    ArrowLeft: 'left', KeyA: 'left', Numpad4: 'left',
    ArrowRight: 'right', KeyD: 'right', Numpad6: 'right',
    Enter: 'confirm', NumpadEnter: 'confirm', Space: 'confirm',
    KeyZ: 'confirm', ControlLeft: 'confirm', ControlRight: 'confirm',
    Escape: 'back', Backspace: 'back', KeyX: 'back',
    AltLeft: 'back', AltRight: 'back',
    KeyC: 'alt', ShiftLeft: 'alt', ShiftRight: 'alt',
    KeyP: 'pause', Tab: 'pause', Digit1: 'pause',
  };

  var keys = Object.create(null);
  /** Set on any key/button transition; drives attract-mode wake-up. */
  var activity = false;

  /* -------------------------------------------------------- players --- */

  function newSlot() {
    var s = {
      padIndex: -1,
      padId: '',
      kind: 'keyboard',
      active: false,
      down: Object.create(null),
      prev: Object.create(null),
      hit: Object.create(null),
      reps: Object.create(null),
      timer: Object.create(null),
    };
    for (var i = 0; i < ACTIONS.length; i++) {
      var a = ACTIONS[i];
      s.down[a] = false; s.prev[a] = false; s.hit[a] = false;
      s.reps[a] = 0; s.timer[a] = 0;
    }
    return s;
  }

  var players = [];
  for (var p = 0; p < MAX_PLAYERS; p++) players.push(newSlot());
  /* Player 1 always exists: keyboard is the floor. */
  players[0].active = true;

  /** Aggregate of every active player — what menus and 1P games read. */
  var any = newSlot();

  /** Pads seen but not yet assigned to a slot; watched for a Start press. */
  var pending = Object.create(null);

  var padSignature = '';
  var padsVersion = 0;
  var joinVersion = 0;

  /* ------------------------------------------------------ detection --- */

  /**
   * Identify a pad from its id string. Chromium formats ids as
   * "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)",
   * so both the human name and the USB vendor id are fair game.
   */
  function detect(id) {
    var s = String(id || '').toLowerCase();
    if (/nintendo|pro controller|switch|joy-con|joycon|057e/.test(s)) return 'nintendo';
    if (/dualsense|dualshock|playstation|054c|sony/.test(s)) return 'playstation';
    if (/xbox|xinput|x-box|045e/.test(s)) return 'xbox';
    return 'unknown';
  }

  /**
   * Effective layout for a slot: the settings override wins over detection so
   * an unrecognised pad can still be corrected by the user without a keyboard.
   */
  function layoutOf(slot) {
    var override = 'auto';
    try { override = Settings.get('layout'); } catch (e) { override = 'auto'; }
    if (override && override !== 'auto') return override;
    if (!slot || slot.kind === 'keyboard' || slot.kind === 'unknown') return 'xbox';
    return slot.kind;
  }

  /** Face indices for confirm/back. This is the swap. */
  function faceMap(layout) {
    return layout === 'nintendo'
      ? { confirm: 1, back: 0 }
      : { confirm: 0, back: 1 };
  }

  /**
   * On-screen glyphs. Always describes the physical controller in front of
   * the player, never the button index underneath.
   */
  function glyphsFor(layout, kind) {
    if (layout === 'playstation') return { confirm: '✕', back: '○', alt: '□' };
    if (layout === 'nintendo') return { confirm: 'A', back: 'B', alt: 'Y' };
    if (kind === 'keyboard') return { confirm: 'ENTER', back: 'ESC', alt: 'SHIFT' };
    return { confirm: 'A', back: 'B', alt: 'X' };
  }

  function glyphs(playerIndex) {
    var slot = players[playerIndex || 0] || players[0];
    return glyphsFor(layoutOf(slot), slot.kind);
  }

  /* ----------------------------------------------------------- poll --- */

  function pads() {
    try {
      var g = (typeof navigator !== 'undefined' && navigator.getGamepads)
        ? navigator.getGamepads() : null;
      return g || [];
    } catch (e) { return []; }
  }

  function btn(gp, i) {
    var b = gp.buttons && gp.buttons[i];
    if (!b) return false;
    return typeof b === 'object' ? !!b.pressed : b > 0.5;
  }

  function axis(gp, i) {
    var v = gp.axes && gp.axes[i];
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
  }

  /** Fill `out` with the raw action state for one gamepad. */
  function readPad(gp, layout, out) {
    var f = faceMap(layout);
    var ax = axis(gp, 0), ay = axis(gp, 1);
    out.up = btn(gp, 12) || ay < -DEADZONE;
    out.down = btn(gp, 13) || ay > DEADZONE;
    out.left = btn(gp, 14) || ax < -DEADZONE;
    out.right = btn(gp, 15) || ax > DEADZONE;
    out.confirm = btn(gp, f.confirm);
    out.back = btn(gp, f.back) || btn(gp, 8);
    out.alt = btn(gp, 2) || btn(gp, 3) || btn(gp, 4) || btn(gp, 5);
    out.pause = btn(gp, 9);
    return out;
  }

  var scratch = Object.create(null);

  /**
   * Advance edge/repeat bookkeeping for one slot from its freshly-computed
   * `down` map. dt is in milliseconds.
   */
  function step(slot, dt) {
    for (var i = 0; i < ACTIONS.length; i++) {
      var a = ACTIONS[i];
      var isDown = !!slot.down[a];
      var wasDown = !!slot.prev[a];
      slot.hit[a] = isDown && !wasDown;
      slot.reps[a] = 0;

      if (isDown && !wasDown) {
        slot.reps[a] = 1;
        slot.timer[a] = REPEAT_DELAY;
        activity = true;
      } else if (isDown) {
        slot.timer[a] -= dt;
        /* Cap the catch-up so a long stall cannot fire a hundred steps. */
        var guard = 0;
        while (slot.timer[a] <= 0 && guard < 8) {
          slot.reps[a]++;
          slot.timer[a] += REPEAT_RATE;
          guard++;
        }
        if (guard >= 8) slot.timer[a] = REPEAT_RATE;
      } else {
        slot.timer[a] = 0;
      }
      slot.prev[a] = isDown;
    }
  }

  /** Assign a connected-but-unassigned pad to the lowest free slot. */
  function assign(padIndex, id) {
    for (var i = 0; i < MAX_PLAYERS; i++) {
      /* Slot 0 starts keyboard-active but padless; a real pad may claim it. */
      if (players[i].padIndex !== -1) continue;
      players[i].padIndex = padIndex;
      players[i].padId = id;
      players[i].kind = detect(id);
      players[i].active = true;
      delete pending[padIndex];
      joinVersion++;
      return i;
    }
    return -1;
  }

  function releasePad(padIndex) {
    for (var i = 0; i < MAX_PLAYERS; i++) {
      if (players[i].padIndex === padIndex) {
        players[i].padIndex = -1;
        players[i].padId = '';
        players[i].kind = 'keyboard';
        /* Slot 0 stays alive on the keyboard; higher slots drop out. */
        if (i > 0) players[i].active = false;
        joinVersion++;
      }
    }
    delete pending[padIndex];
  }

  /**
   * Poll every device and recompute all action state. Called exactly once per
   * frame by the shell, before any update().
   */
  function poll(dt) {
    var d = clamp(num(dt, 16), 0, 250);
    var list = pads();

    /* --- hot-plug: rebuild the signature and reconcile slots ---------- */
    var sig = '';
    var seen = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var gp = list[i];
      if (!gp || !gp.connected) continue;
      seen[i] = true;
      sig += i + ':' + (gp.id || '') + '|';
    }
    if (sig !== padSignature) {
      padSignature = sig;
      padsVersion++;
      /*
       * Drop slots whose pad vanished — or whose pad was swapped for a
       * different one at the same index. Chromium reuses index 0 when you
       * unplug an Xbox pad and plug in a Switch pad, so comparing presence
       * alone would leave the slot claiming the old layout and glyphs.
       */
      for (var s = 0; s < MAX_PLAYERS; s++) {
        var pidx = players[s].padIndex;
        if (pidx === -1) continue;
        var still = seen[pidx] && list[pidx] && (list[pidx].id || '') === players[s].padId;
        if (!still) releasePad(pidx);
      }
      for (var k in pending) {
        if (!seen[k]) delete pending[k];
      }
      /* A newly-seen pad claims slot 0 if nothing holds it yet. */
      for (var j = 0; j < list.length; j++) {
        if (!seen[j]) continue;
        if (isAssigned(j) || pending[j]) continue;
        if (players[0].padIndex === -1) assign(j, list[j].id);
        else pending[j] = true;
      }
    }

    /* --- per-slot action state --------------------------------------- */
    for (var pi = 0; pi < MAX_PLAYERS; pi++) {
      var slot = players[pi];
      for (var a = 0; a < ACTIONS.length; a++) slot.down[ACTIONS[a]] = false;
      if (!slot.active) { step(slot, d); continue; }

      /* Keyboard drives player 1 only. */
      if (pi === 0) {
        for (var code in keys) {
          if (!keys[code]) continue;
          var act = KEYMAP[code];
          if (act) slot.down[act] = true;
        }
      }

      if (slot.padIndex !== -1) {
        var g = list[slot.padIndex];
        if (g && g.connected) {
          readPad(g, layoutOf(slot), scratch);
          for (var b = 0; b < ACTIONS.length; b++) {
            if (scratch[ACTIONS[b]]) slot.down[ACTIONS[b]] = true;
          }
        }
      }
      step(slot, d);
    }

    /* --- unassigned pads: watch only for a Start press to join -------- */
    for (var pk in pending) {
      var idx = +pk;
      var pg = list[idx];
      if (!pg || !pg.connected) continue;
      if (btn(pg, 9) || btn(pg, 0)) {
        assign(idx, pg.id);
        activity = true;
        Audio2.sfx('coin');
      }
    }

    /* --- aggregate --------------------------------------------------- */
    for (var ai = 0; ai < ACTIONS.length; ai++) {
      var act2 = ACTIONS[ai];
      var on = false;
      for (var q = 0; q < MAX_PLAYERS; q++) {
        if (players[q].active && players[q].down[act2]) { on = true; break; }
      }
      any.down[act2] = on;
    }
    step(any, d);
  }

  function isAssigned(padIndex) {
    for (var i = 0; i < MAX_PLAYERS; i++) if (players[i].padIndex === padIndex) return true;
    return false;
  }

  /* --------------------------------------------------------- queries --- */

  function slotOf(playerIndex) {
    if (playerIndex === undefined || playerIndex === null) return any;
    return players[playerIndex] || any;
  }

  function down(action, playerIndex) { return !!slotOf(playerIndex).down[action]; }
  function hit(action, playerIndex) { return !!slotOf(playerIndex).hit[action]; }
  function rep(action, playerIndex) { return slotOf(playerIndex).reps[action] > 0; }
  function repCount(action, playerIndex) { return slotOf(playerIndex).reps[action] | 0; }

  /** Per-player accessor, for versus modes. */
  function p(index) {
    return {
      down: function (a) { return down(a, index); },
      hit: function (a) { return hit(a, index); },
      rep: function (a) { return rep(a, index); },
      repCount: function (a) { return repCount(a, index); },
      active: function () { return !!players[index] && players[index].active; },
      glyphs: function () { return glyphs(index); },
    };
  }

  /**
   * Swallow the current frame's edges. Called on every state transition so the
   * button that opened a screen does not immediately act inside it.
   */
  function flush() {
    var all = players.concat([any]);
    for (var i = 0; i < all.length; i++) {
      for (var a = 0; a < ACTIONS.length; a++) {
        var act = ACTIONS[a];
        all[i].hit[act] = false;
        all[i].reps[act] = 0;
        all[i].prev[act] = all[i].down[act];
        all[i].timer[act] = REPEAT_DELAY;
      }
    }
  }

  /** True if anything was pressed since the last call. Wakes attract mode. */
  function consumeActivity() {
    var a = activity;
    activity = false;
    return a;
  }

  /* ---------------------------------------------------------- rumble --- */

  function rumble(strong, weak, ms, playerIndex) {
    var slot = players[playerIndex || 0];
    if (!slot || slot.padIndex === -1) return;
    try {
      if (Settings.get('reducedMotion')) return;
      var gp = pads()[slot.padIndex];
      if (!gp) return;
      var act = gp.vibrationActuator || gp.hapticActuators && gp.hapticActuators[0];
      if (!act || !act.playEffect) return;
      act.playEffect('dual-rumble', {
        startDelay: 0,
        duration: clamp(num(ms, 120), 0, 2000),
        strongMagnitude: clamp(num(strong, 0.5), 0, 1),
        weakMagnitude: clamp(num(weak, 0.5), 0, 1),
      });
    } catch (e) { /* pads without haptics are the common case */ }
  }

  /* ------------------------------------------------------------ init --- */

  function attach(target) {
    var t = target || (typeof window !== 'undefined' ? window : null);
    if (!t || !t.addEventListener) return;
    t.addEventListener('keydown', function (e) {
      var code = e.code || e.key;
      if (KEYMAP[code]) {
        if (!keys[code]) activity = true;
        keys[code] = true;
        if (e.preventDefault) e.preventDefault();
      }
      Audio2.unlock();
    }, false);
    t.addEventListener('keyup', function (e) {
      var code = e.code || e.key;
      if (KEYMAP[code]) {
        keys[code] = false;
        if (e.preventDefault) e.preventDefault();
      }
    }, false);
    /* Losing focus while a key is held would otherwise stick it down. */
    t.addEventListener('blur', function () { keys = Object.create(null); }, false);
    t.addEventListener('gamepadconnected', function () { Audio2.unlock(); }, false);
  }

  return {
    poll: poll,
    attach: attach,
    down: down,
    hit: hit,
    rep: rep,
    repCount: repCount,
    p: p,
    flush: flush,
    glyphs: glyphs,
    rumble: rumble,
    consumeActivity: consumeActivity,
    detect: detect,
    /** Bumps whenever the set of connected pads changes — legends re-read it. */
    padsVersion: function () { return padsVersion; },
    /** Bumps whenever a player joins or drops. */
    joinVersion: function () { return joinVersion; },
    players: function () { return players; },
    playerCount: function () {
      var n = 0;
      for (var i = 0; i < MAX_PLAYERS; i++) if (players[i].active) n++;
      return n;
    },
    padCount: function () {
      var n = 0;
      for (var i = 0; i < MAX_PLAYERS; i++) if (players[i].padIndex !== -1) n++;
      return n;
    },
    /** Human-readable layout of a slot, for the settings screen. */
    layoutOf: function (i) { return layoutOf(players[i || 0]); },
    kindOf: function (i) { return (players[i || 0] || players[0]).kind; },
    _faceMap: faceMap,
    _glyphsFor: glyphsFor,
    _keymap: KEYMAP,
    _key: function (code, isDown) { keys[code] = !!isDown; if (isDown) activity = true; },
    _reset: function () {
      keys = Object.create(null);
      players.length = 0;
      for (var i = 0; i < MAX_PLAYERS; i++) players.push(newSlot());
      players[0].active = true;
      any = newSlot();
      pending = Object.create(null);
      padSignature = ''; padsVersion = 0; joinVersion = 0; activity = false;
    },
  };
})();
