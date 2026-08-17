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
/*
 * Stick deadzone, as a Schmitt trigger rather than a single threshold.
 *
 * A worn analog stick rests off-centre and jitters. With one threshold at
 * 0.4, a stick resting at ~0.4 crosses it constantly, and because presses are
 * latched at 250Hz every crossing becomes a menu step: measured at 120 phantom
 * steps per second from a stick nobody was touching. Requiring 0.5 to engage
 * and holding until it falls back below 0.35 makes that physically impossible
 * while keeping the feel of the original 0.4.
 */
var DEADZONE_ON = 0.5;
var DEADZONE_OFF = 0.35;
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
      padStamp: -1,
      /** Schmitt-trigger state for the four stick directions. */
      axis: { up: false, down: false, left: false, right: false },
      kind: 'keyboard',
      active: false,
      /** Physical state as of the most recent sample. */
      live: Object.create(null),
      /** Presses latched since the last frame consumed them. See LATCHING. */
      edge: Object.create(null),
      /** Live state at the previous sample, for transition detection. */
      sampled: Object.create(null),

      down: Object.create(null),
      prev: Object.create(null),
      hit: Object.create(null),
      reps: Object.create(null),
      timer: Object.create(null),
    };
    for (var i = 0; i < ACTIONS.length; i++) {
      var a = ACTIONS[i];
      s.live[a] = false; s.edge[a] = 0; s.sampled[a] = false;
      s.down[a] = false; s.prev[a] = false; s.hit[a] = false;
      s.reps[a] = 0; s.timer[a] = 0;
    }
    return s;
  }

  var players = [];
  /* NB: not `p` — that is the name of the per-player accessor below, and a
   * `var p` loop counter would hoist over the function declaration and
   * silently replace it with a number. */
  for (var slotInit = 0; slotInit < MAX_PLAYERS; slotInit++) players.push(newSlot());
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

  /**
   * One stick direction, with hysteresis. `held` is the previous state for
   * this direction, so engaging and releasing use different thresholds.
   */
  function stick(held, magnitude) {
    return held ? magnitude > DEADZONE_OFF : magnitude > DEADZONE_ON;
  }

  /** Fill `out` with the raw action state for one gamepad. */
  function readPad(gp, layout, out, held) {
    var f = faceMap(layout);
    var ax = axis(gp, 0), ay = axis(gp, 1);
    /* The d-pad is digital and needs no deadzone; only the stick does. */
    held.up = stick(held.up, -ay);
    held.down = stick(held.down, ay);
    held.left = stick(held.left, -ax);
    held.right = stick(held.right, ax);
    out.up = btn(gp, 12) || held.up;
    out.down = btn(gp, 13) || held.down;
    out.left = btn(gp, 14) || held.left;
    out.right = btn(gp, 15) || held.right;
    out.confirm = btn(gp, f.confirm);
    out.back = btn(gp, f.back) || btn(gp, 8);
    out.alt = btn(gp, 2) || btn(gp, 3) || btn(gp, 4) || btn(gp, 5);
    out.pause = btn(gp, 9);
    return out;
  }

  /* Two reusable scratch maps: nothing in the sample path allocates. */
  var scratch = Object.create(null);
  var padScratch = Object.create(null);

  /* Diagnostics, surfaced by the on-cabinet overlay. */
  var sampleCount = 0;
  var padUpdates = 0;
  var tapsSaved = 0;
  var sampleTimer = 0;

  /**
   * Advance edge/repeat bookkeeping for one slot from its freshly-computed
   * `down` map. dt is in milliseconds.
   */
  function step(slot, dt) {
    for (var i = 0; i < ACTIONS.length; i++) {
      var a = ACTIONS[i];
      var isDown = !!slot.live[a];
      var wasDown = !!slot.prev[a];
      /* A press latched at ANY point since the last frame counts, even if the
       * button is already back up by now. */
      var presses = slot.edge[a] | 0;

      slot.down[a] = isDown;
      slot.hit[a] = presses > 0;
      slot.reps[a] = 0;

      if (presses > 0) {
        /* Two taps inside one frame move a menu twice — that is what the
         * player did, so that is what happens. */
        slot.reps[a] = presses > 4 ? 4 : presses;
        slot.timer[a] = REPEAT_DELAY;
        activity = true;
        if (!isDown) tapsSaved++;
      } else if (isDown && wasDown) {
        slot.timer[a] -= dt;
        /* Cap the catch-up so a long stall cannot fire a hundred steps. */
        var guard = 0;
        while (slot.timer[a] <= 0 && guard < 8) {
          slot.reps[a]++;
          slot.timer[a] += REPEAT_RATE;
          guard++;
        }
        if (guard >= 8) slot.timer[a] = REPEAT_RATE;
      } else if (!isDown) {
        slot.timer[a] = 0;
      }

      slot.prev[a] = isDown;
      slot.edge[a] = 0;
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
        players[i].axis.up = players[i].axis.down = false;
        players[i].axis.left = players[i].axis.right = false;
        players[i].kind = 'keyboard';
        /* Slot 0 stays alive on the keyboard; higher slots drop out. */
        if (i > 0) players[i].active = false;
        joinVersion++;
      }
    }
    delete pending[padIndex];
  }

  /**
   * Read every device once and latch any new presses.
   *
   * This is deliberately separate from poll(): it runs on a fast timer as
   * well as once per frame, because a display-rate poll physically cannot see
   * a button that goes down and back up between two frames. An arcade
   * microswitch contact can be well under 16ms, and a dropped press feels far
   * worse than a late one.
   */
  function sample(checkHotplug) {
    var list = pads();
    sampleCount++;

    /* --- hot-plug: rebuild the signature and reconcile slots ----------
     *
     * Only on frame polls, never on the fast timer. Building the signature
     * concatenates a string per connected pad, and doing that 250 times a
     * second to notice something that happens once a week is pure garbage.
     * Sixty checks a second is far more than enough to feel instant.
     */
    if (checkHotplug) hotplug(list);

    /* --- per-slot live state, latching every 0->1 transition ---------- */
    for (var pi = 0; pi < MAX_PLAYERS; pi++) {
      var slot = players[pi];
      var a, act;

      for (a = 0; a < ACTIONS.length; a++) scratch[ACTIONS[a]] = false;

      if (slot.active) {
        /* Keyboard drives player 1 only. Its edges are latched in the
         * keydown handler, which is earlier and exact; this only tracks the
         * held state. */
        if (pi === 0) {
          for (var code in keys) {
            if (!keys[code]) continue;
            act = KEYMAP[code];
            if (act) scratch[act] = true;
          }
        }

        if (slot.padIndex !== -1) {
          var g = list[slot.padIndex];
          if (g && g.connected) {
            readPad(g, layoutOf(slot), padScratch, slot.axis);
            for (var b = 0; b < ACTIONS.length; b++) {
              if (padScratch[ACTIONS[b]]) scratch[ACTIONS[b]] = true;
            }
            /* gamepad.timestamp only advances when the snapshot changes, so
             * it measures how fast the browser is really giving us data. */
            if (g.timestamp !== slot.padStamp) {
              slot.padStamp = g.timestamp;
              padUpdates++;
            }
          }
        }
      }

      for (a = 0; a < ACTIONS.length; a++) {
        act = ACTIONS[a];
        var now = !!scratch[act];
        /* Pad-driven edges only. Keyboard edges are latched on the event so
         * that a tap between samples is never lost. */
        if (now && !slot.sampled[act] && !(pi === 0 && keyboardHolds(act))) {
          slot.edge[act]++;
        }
        slot.sampled[act] = now;
        slot.live[act] = now;
      }
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
  }

  /** Reconcile connected pads against player slots. Frame-rate, not sample-rate. */
  function hotplug(list) {
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
  }

  /** True when a currently-held key maps to this action on player 1. */
  function keyboardHolds(action) {
    for (var code in keys) {
      if (keys[code] && KEYMAP[code] === action) return true;
    }
    return false;
  }

  /**
   * Consume one frame's worth of input. Called exactly once per frame by the
   * loop, before any update(). Samples once more first so the frame acts on
   * the freshest possible state.
   */
  function poll(dt) {
    var d = clamp(num(dt, 16), 0, 250);
    sample(true);

    for (var pi = 0; pi < MAX_PLAYERS; pi++) step(players[pi], d);

    /* --- aggregate --------------------------------------------------- */
    for (var ai = 0; ai < ACTIONS.length; ai++) {
      var act2 = ACTIONS[ai];
      var on = false, edges = 0;
      for (var q = 0; q < MAX_PLAYERS; q++) {
        if (!players[q].active) continue;
        if (players[q].live[act2]) on = true;
        /* players[] already had step() run, so read the hit it produced. */
        if (players[q].hit[act2]) edges += players[q].reps[act2];
      }
      any.live[act2] = on;
      any.edge[act2] = edges;
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
        all[i].edge[act] = 0;
        all[i].prev[act] = all[i].live[act];
        all[i].down[act] = all[i].live[act];
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
      var act = KEYMAP[code];
      if (act) {
        /*
         * Latch the press here rather than waiting for the next sample. A
         * key event is exact and already timestamped by the browser, so a
         * tap shorter than a frame — or shorter than a sample interval —
         * still registers. e.repeat is ignored: auto-repeat is ours to do.
         */
        if (!keys[code] && !e.repeat) {
          if (!keyboardHolds(act)) players[0].edge[act]++;
          keys[code] = true;
          players[0].live[act] = true;
          players[0].sampled[act] = true;
          activity = true;
        }
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

  /* ------------------------------------------------------- sampling --- */

  /*
   * Sample faster than the display refreshes.
   *
   * requestAnimationFrame fires at ~60Hz, and a button pressed and released
   * between two callbacks is invisible to it. Chromium updates its gamepad
   * snapshot on its own thread well above 60Hz, so sampling on a short timer
   * catches those transitions and latches them for the next frame to consume.
   *
   * SAMPLE_MS is a floor on how briefly a press can be held and still count.
   * 4ms is comfortably shorter than any human tap or switch bounce, and the
   * work per sample is a handful of array reads.
   */
  var SAMPLE_MS = 4;

  function startSampling() {
    if (sampleTimer || typeof setInterval !== 'function') return;
    sampleTimer = setInterval(function () {
      try { sample(); } catch (e) { /* never let the sampler die */ }
    }, SAMPLE_MS);
  }

  function stopSampling() {
    if (sampleTimer && typeof clearInterval === 'function') clearInterval(sampleTimer);
    sampleTimer = 0;
  }

  return {
    poll: poll,
    sample: sample,
    startSampling: startSampling,
    stopSampling: stopSampling,
    SAMPLE_MS: SAMPLE_MS,
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
    /**
     * Input health, for the on-cabinet overlay. `tapsSaved` counts presses
     * that were already released by the time the frame ran — every one of
     * those would have been silently dropped before latching existed.
     */
    diagnostics: function () {
      return {
        samples: sampleCount,
        padUpdates: padUpdates,
        tapsSaved: tapsSaved,
        sampling: !!sampleTimer,
        intervalMs: SAMPLE_MS,
      };
    },
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
      sampleCount = 0; padUpdates = 0; tapsSaved = 0;
    },
  };
})();
