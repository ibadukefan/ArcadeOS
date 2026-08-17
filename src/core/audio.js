/*
 * WebAudio synthesis. No samples, no files, no network.
 *
 * Everything the cabinet makes noise with is generated from oscillators and
 * a single shared noise buffer. The context is created lazily and resumed on
 * first input, because Chromium suspends it until a gesture even in kiosk
 * mode unless --autoplay-policy is set (the setup script sets it; this is the
 * belt to that pair of braces).
 *
 * Every entry point is wrapped so that a missing or broken AudioContext
 * degrades to silence rather than throwing into a game loop.
 */

var Audio2 = (function () {
  var ctx = null;
  var master = null;
  var available = true;
  /** Voice budget — a Pi 4 will happily grind if a game spams tones. */
  var voices = 0;
  var VOICE_CAP = 16;
  var noiseBuf = null;

  function ensure() {
    if (ctx || !available) return ctx;
    try {
      var AC = (typeof window !== 'undefined') &&
        (window.AudioContext || window.webkitAudioContext);
      if (!AC) { available = false; return null; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = level();
      master.connect(ctx.destination);
    } catch (e) {
      available = false;
      ctx = null;
      master = null;
    }
    return ctx;
  }

  function level() {
    try {
      var s = Settings.all();
      return s.muted ? 0 : clamp(num(s.volume, 0.7), 0, 1);
    } catch (e) { return 0.7; }
  }

  /** Re-read volume/mute from settings. Called whenever either changes. */
  function refresh() {
    if (!master || !ctx) return;
    try { master.gain.setTargetAtTime(level(), ctx.currentTime, 0.02); }
    catch (e) { /* ignore */ }
  }

  /** Called on the first real input event; Chromium requires a gesture. */
  function unlock() {
    var c = ensure();
    if (!c) return;
    try { if (c.state === 'suspended') c.resume(); } catch (e) { /* ignore */ }
  }

  function now() {
    var c = ensure();
    return c ? c.currentTime : 0;
  }

  function claimVoice(dur) {
    if (voices >= VOICE_CAP) return false;
    voices++;
    var ms = Math.max(20, num(dur, 0.1) * 1000 + 60);
    if (typeof setTimeout === 'function') setTimeout(release, ms);
    else voices--;
    return true;
  }

  function release() { if (voices > 0) voices--; }

  /**
   * One synth voice: oscillator -> gain envelope -> master.
   * opts: {freq, freq2, dur, type, gain, attack, when, detune}
   */
  function tone(opts) {
    var c = ensure();
    if (!c || !master) return;
    var o = opts || {};
    var dur = clamp(num(o.dur, 0.12), 0.01, 4);
    if (!claimVoice(dur)) return;
    try {
      var t0 = c.currentTime + Math.max(0, num(o.when, 0));
      var osc = c.createOscillator();
      var g = c.createGain();
      var f0 = clamp(num(o.freq, 440), 20, 12000);
      var f1 = clamp(num(o.freq2, f0), 20, 12000);
      osc.type = o.type || 'square';
      osc.frequency.setValueAtTime(f0, t0);
      if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      if (o.detune) osc.detune.setValueAtTime(clamp(num(o.detune, 0), -1200, 1200), t0);

      var peak = clamp(num(o.gain, 0.18), 0, 1);
      var atk = clamp(num(o.attack, 0.005), 0.001, dur * 0.9);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      osc.connect(g); g.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (e) { release(); }
  }

  /** Shared 1s white-noise buffer; built once, played as a source. */
  function noiseBuffer(c) {
    if (noiseBuf) return noiseBuf;
    try {
      var len = Math.floor(c.sampleRate * 1);
      noiseBuf = c.createBuffer(1, len, c.sampleRate);
      var d = noiseBuf.getChannelData(0);
      /* Deterministic fill — no reliance on Math.random anywhere. */
      var r = makeRng(0xC0FFEE);
      for (var i = 0; i < len; i++) d[i] = r() * 2 - 1;
    } catch (e) { noiseBuf = null; }
    return noiseBuf;
  }

  /** Filtered noise burst: impacts, explosions, line clears. */
  function noise(opts) {
    var c = ensure();
    if (!c || !master) return;
    var o = opts || {};
    var dur = clamp(num(o.dur, 0.14), 0.01, 3);
    if (!claimVoice(dur)) return;
    try {
      var buf = noiseBuffer(c);
      if (!buf) { release(); return; }
      var t0 = c.currentTime + Math.max(0, num(o.when, 0));
      var src = c.createBufferSource();
      src.buffer = buf;
      var flt = c.createBiquadFilter();
      flt.type = o.filter || 'bandpass';
      var f0 = clamp(num(o.freq, 1200), 40, 14000);
      var f1 = clamp(num(o.freq2, f0), 40, 14000);
      flt.frequency.setValueAtTime(f0, t0);
      if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      flt.Q.value = clamp(num(o.q, 1), 0.1, 20);

      var g = c.createGain();
      var peak = clamp(num(o.gain, 0.16), 0, 1);
      g.gain.setValueAtTime(Math.max(0.0002, peak), t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      src.connect(flt); flt.connect(g); g.connect(master);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    } catch (e) { release(); }
  }

  /* ------------------------------------------------------------- sfx --- */

  /**
   * Named effects. Games call these rather than building tones inline, so the
   * cabinet has one consistent voice across every title.
   */
  var SFX = {
    move: function () { tone({ freq: 320, dur: 0.04, type: 'square', gain: 0.07 }); },
    select: function () { tone({ freq: 520, freq2: 720, dur: 0.08, type: 'square', gain: 0.10 }); },
    back: function () { tone({ freq: 420, freq2: 260, dur: 0.09, type: 'square', gain: 0.09 }); },
    denied: function () { tone({ freq: 180, freq2: 120, dur: 0.14, type: 'sawtooth', gain: 0.10 }); },
    rotate: function () { tone({ freq: 640, dur: 0.045, type: 'triangle', gain: 0.09 }); },
    lock: function () { tone({ freq: 190, freq2: 120, dur: 0.07, type: 'square', gain: 0.10 }); },
    drop: function () { noise({ freq: 900, freq2: 200, dur: 0.10, gain: 0.13, q: 0.8 }); },
    clear: function (n) {
      var lines = clamp(num(n, 1), 1, 4);
      for (var i = 0; i < lines; i++) {
        tone({ freq: 440 * Math.pow(1.26, i), freq2: 880 * Math.pow(1.26, i),
          dur: 0.16, type: 'triangle', gain: 0.13, when: i * 0.05 });
      }
      noise({ freq: 2200, freq2: 400, dur: 0.20, gain: 0.10 });
    },
    coin: function () {
      tone({ freq: 988, dur: 0.06, type: 'square', gain: 0.11 });
      tone({ freq: 1319, dur: 0.14, type: 'square', gain: 0.11, when: 0.06 });
    },
    hit: function () { noise({ freq: 1800, freq2: 600, dur: 0.06, gain: 0.12, q: 1.5 }); },
    bounce: function () { tone({ freq: 700, freq2: 900, dur: 0.035, type: 'square', gain: 0.08 }); },
    eat: function () { tone({ freq: 600, freq2: 1000, dur: 0.07, type: 'triangle', gain: 0.11 }); },
    jump: function () { tone({ freq: 380, freq2: 720, dur: 0.09, type: 'triangle', gain: 0.10 }); },
    land: function () { tone({ freq: 200, freq2: 140, dur: 0.05, type: 'sine', gain: 0.09 }); },
    powerup: function () {
      for (var i = 0; i < 4; i++) {
        tone({ freq: 523 * Math.pow(1.19, i), dur: 0.08, type: 'square', gain: 0.09, when: i * 0.045 });
      }
    },
    over: function () {
      var seq = [523, 392, 311, 262];
      for (var i = 0; i < seq.length; i++) {
        tone({ freq: seq[i], dur: 0.30, type: 'triangle', gain: 0.13, when: i * 0.16 });
      }
    },
    highscore: function () {
      var seq = [523, 659, 784, 1047, 784, 1047];
      for (var i = 0; i < seq.length; i++) {
        tone({ freq: seq[i], dur: 0.18, type: 'square', gain: 0.11, when: i * 0.11 });
      }
    },
    start: function () {
      tone({ freq: 330, freq2: 660, dur: 0.18, type: 'triangle', gain: 0.13 });
      tone({ freq: 660, freq2: 990, dur: 0.22, type: 'square', gain: 0.08, when: 0.10 });
    },
  };

  function sfx(name, arg) {
    var fn = SFX[name];
    if (!fn) return;
    try { fn(arg); } catch (e) { /* never let a sound break a frame */ }
  }

  return {
    unlock: unlock,
    refresh: refresh,
    tone: tone,
    noise: noise,
    sfx: sfx,
    now: now,
    /** Exposed for the rhythm game, which needs sample-accurate scheduling. */
    ctx: function () { return ensure(); },
    available: function () { return available && !!ensure(); },
    _reset: function () { ctx = null; master = null; available = true; voices = 0; noiseBuf = null; },
  };
})();
