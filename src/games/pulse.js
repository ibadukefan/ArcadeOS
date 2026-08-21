/*
 * PULSE — rhythm highway. Four lanes descend to a judgement line; the lanes
 * are the four d-pad directions, so the whole game is playable on the pad
 * with nothing else.
 *
 * The chart and the track come from the SAME pattern data, generated
 * procedurally from a seed at load time. Nothing external is loaded, and the
 * notes you see are by construction the notes you hear.
 *
 * TIMING
 * ------
 * Song position is accumulated from dt, not read from the audio clock. That
 * matters for two reasons: the cabinet must still be playable if the audio
 * context never starts (Chromium's autoplay policy, a muted cabinet, a
 * headless test), and a WebAudio clock that drifts or stalls would otherwise
 * desynchronise the chart from the visuals. Audio is scheduled *against* the
 * song position with a look-ahead window, so sound follows the chart rather
 * than the other way round.
 */

var PULSE = (function () {
  var LANES = 4;
  var LANE_ACTION = ['left', 'down', 'up', 'right'];
  var LANE_GLYPH = ['◀', '▼', '▲', '▶'];
  var LANE_COL = ['#34D3E0', '#46CE7A', '#F0C64E', '#F06CC9'];

  var MARGIN = 40;
  var HIGHWAY_W = GW - MARGIN * 2;
  var LANE_W = HIGHWAY_W / LANES;
  var TOP = HUD_H + 8;
  var HIT_Y = GH - 150;
  var NOTE_H = 22;

  /** How long a note is visible before it reaches the line. */
  var LEAD_MS = 1500;

  var BPM = 128;
  var STEP_MS = 60000 / BPM / 4;     /* one sixteenth */
  var BARS = 32;
  var STEPS = BARS * 16;
  var SONG_MS = STEPS * STEP_MS;
  var OUTRO_MS = 2500;

  /* Judgement windows, in ms either side of the note. */
  var W_PERFECT = 45, W_GREAT = 85, W_GOOD = 130;
  var JUDGE_NAME = ['PERFECT', 'GREAT', 'GOOD', 'MISS'];
  var JUDGE_COL = ['#37E1C4', '#8B7BF0', '#F0C64E', '#F0645E'];
  var JUDGE_SCORE = [300, 200, 100, 0];

  /* A pentatonic-ish scale keeps procedurally chosen notes consonant. */
  var SCALE = [0, 3, 5, 7, 10, 12, 15, 17];
  var ROOT = 55;                      /* A1 */

  /** The chart: {step, lane, pitch}. Built once, replayed every game. */
  var chart = [];
  var notes = [];                     /* live copy with per-run judged state */

  var songT = 0;
  var score = 0, combo = 0, maxCombo = 0, health = 100;
  var counts = [0, 0, 0, 0];
  var over = false, finished = false;
  var laneFlash = [0, 0, 0, 0];
  var judgeText = { name: '', col: COL.text, life: 0 };
  var scheduled = 0;                  /* index of the next note to sonify */
  var audioAnchor = -1;
  var particles = makeParticles(72);

  function midiHz(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  /**
   * Build the chart. Density rises through the song and the lane walk is
   * biased to stay near the previous lane, which is what makes a generated
   * pattern feel authored rather than random.
   */
  function buildChart() {
    /* Fixed seed: every cabinet plays the same track, so scores compare. */
    var r = makeRng(0x50BEA7);
    chart.length = 0;
    var lane = 1;
    var scaleIdx = 0;

    for (var s = 0; s < STEPS; s++) {
      var bar = Math.floor(s / 16);
      var inBar = s % 16;
      var progress = s / STEPS;

      /* Every song needs a runway: the first bar is empty, the second sparse. */
      if (bar === 0) continue;

      var onBeat = (inBar % 4 === 0);
      var offBeat = (inBar % 2 === 0);
      var density = 0.18 + progress * 0.34;

      var place = false;
      if (onBeat) place = true;                       /* the pulse itself */
      else if (offBeat) place = r() < density + 0.18;
      else place = r() < density * 0.55;

      /* Breathe: drop a bar every eight so it is not relentless. */
      if (bar % 8 === 7 && inBar >= 8) place = onBeat && r() < 0.5;
      if (!place) continue;

      /* Lane walk. */
      var move = r();
      if (move < 0.42) { /* stay */ }
      else if (move < 0.78) lane += (r() < 0.5 ? -1 : 1);
      else lane += (r() < 0.5 ? -2 : 2);
      lane = ((lane % LANES) + LANES) % LANES;

      scaleIdx += (r() < 0.5 ? -1 : 1) * (r() < 0.7 ? 1 : 2);
      scaleIdx = ((scaleIdx % SCALE.length) + SCALE.length) % SCALE.length;

      chart.push({
        step: s,
        time: s * STEP_MS,
        lane: lane,
        pitch: ROOT + 24 + SCALE[scaleIdx],
        bass: ROOT + SCALE[scaleIdx % 5],
        accent: onBeat,
      });
    }
  }

  buildChart();

  function start() {
    notes.length = 0;
    for (var i = 0; i < chart.length; i++) {
      var c = chart[i];
      notes.push({ time: c.time, lane: c.lane, pitch: c.pitch, bass: c.bass,
        accent: c.accent, judged: -1, hitT: 0 });
    }
    songT = -1800;                    /* count-in before the first bar */
    score = 0; combo = 0; maxCombo = 0; health = 100;
    counts[0] = counts[1] = counts[2] = counts[3] = 0;
    over = false; finished = false;
    laneFlash[0] = laneFlash[1] = laneFlash[2] = laneFlash[3] = 0;
    judgeText.life = 0;
    scheduled = 0;
    audioAnchor = -1;
    particles.clear();
  }

  /**
   * Sonify everything inside the look-ahead window. The audio clock is only
   * ever used as a scheduling base — never as the source of song position.
   */
  function scheduleAudio() {
    var ctx = Audio2.ctx();
    if (!ctx) { scheduled = notes.length; return; }
    var LOOKAHEAD = 220;
    if (audioAnchor < 0) audioAnchor = ctx.currentTime - songT / 1000;

    while (scheduled < notes.length && notes[scheduled].time < songT + LOOKAHEAD) {
      var n = notes[scheduled];
      var when = audioAnchor + n.time / 1000 - ctx.currentTime;
      if (when >= 0) {
        Audio2.tone({ freq: midiHz(n.pitch), dur: n.accent ? 0.16 : 0.10,
          type: 'square', gain: n.accent ? 0.075 : 0.05, when: when });
        if (n.accent) {
          Audio2.tone({ freq: midiHz(n.bass), dur: 0.22, type: 'triangle',
            gain: 0.085, when: when });
        }
      }
      scheduled++;
    }
  }

  function judge(delta) {
    var a = Math.abs(delta);
    if (a <= W_PERFECT) return 0;
    if (a <= W_GREAT) return 1;
    if (a <= W_GOOD) return 2;
    return 3;
  }

  function applyJudgement(n, j) {
    n.judged = j;
    n.hitT = 260;
    counts[j]++;
    if (j === 3) {
      combo = 0;
      health = Math.max(0, health - 7);
      Audio2.sfx('denied');
      Input.rumble(0.5, 0.3, 90);
    } else {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
      health = Math.min(100, health + 1.6);
      /* Combo multiplier caps at 4x so a long run is rewarded without
       * making the first minute irrelevant. */
      var mult = 1 + Math.min(3, Math.floor(combo / 12));
      score += JUDGE_SCORE[j] * mult;
      Audio2.sfx('note', j);
      if (combo > 0 && combo % 25 === 0) {
        Audio2.sfx('powerup');
        Input.rumble(0.3, 0.4, 110);
      }
      laneFlash[n.lane] = 220;
      particles.burst(laneX(n.lane) + LANE_W / 2, HIT_Y, j === 0 ? 12 : 6,
        LANE_COL[n.lane], { speed: 0.22, life: 380, size: 4 });
      if (j === 0) Input.rumble(0.2, 0.15, 40);
    }
    judgeText.name = JUDGE_NAME[j];
    judgeText.col = JUDGE_COL[j];
    judgeText.life = 420;

    if (health <= 0 && !over) {
      over = true;
      Audio2.sfx('over');
      Input.rumble(0.9, 0.7, 300);
      Shell.gameOver(score);
    }
  }

  function laneX(i) { return MARGIN + i * LANE_W; }

  function tryHit(lane) {
    laneFlash[lane] = Math.max(laneFlash[lane], 120);
    var best = null, bestD = 1e9;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.judged >= 0 || n.lane !== lane) continue;
      var d = n.time - songT;
      if (d > W_GOOD + 60) break;             /* chart is time-ordered */
      if (Math.abs(d) < Math.abs(bestD)) { best = n; bestD = d; }
    }
    if (!best || Math.abs(bestD) > W_GOOD) {
      Audio2.tone({ freq: 160, dur: 0.05, type: 'square', gain: 0.04 });
      return;
    }
    applyJudgement(best, judge(bestD));
  }

  function update(dt) {
    particles.update(dt, 0.0004);
    for (var i = 0; i < LANES; i++) {
      if (laneFlash[i] > 0) laneFlash[i] = Math.max(0, laneFlash[i] - dt);
    }
    if (judgeText.life > 0) judgeText.life = Math.max(0, judgeText.life - dt);
    /* Judged notes fade out; decayed here so draw() stays free of state. */
    for (var h = 0; h < notes.length; h++) {
      if (notes[h].hitT > 0) notes[h].hitT = Math.max(0, notes[h].hitT - dt);
    }
    if (over) return;

    songT += dt;
    scheduleAudio();

    for (i = 0; i < LANES; i++) {
      if (Input.hit(LANE_ACTION[i])) tryHit(i);
    }

    /* Anything that has fallen past the window is a miss. */
    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.judged >= 0) continue;
      if (songT - n.time > W_GOOD) applyJudgement(n, 3);
      else if (n.time - songT > W_GOOD) break;
    }

    if (!finished && songT > SONG_MS + OUTRO_MS) {
      finished = true;
      over = true;
      /* Clearing the track is worth a completion bonus scaled by accuracy. */
      var hits = counts[0] + counts[1] + counts[2];
      var total = Math.max(1, hits + counts[3]);
      score += Math.floor(2000 * (hits / total));
      Audio2.sfx('highscore');
      Shell.gameOver(score);
    }
  }

  /* ------------------------------------------------------------ draw --- */

  function accuracy() {
    var total = counts[0] + counts[1] + counts[2] + counts[3];
    if (!total) return 100;
    return (counts[0] * 100 + counts[1] * 80 + counts[2] * 50) / total;
  }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.pulse);
    gHud(ACCENT.pulse, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'COMBO', value: pad(combo, 3), color: combo >= 12 ? COL.a1 : COL.data },
      { label: 'ACC', value: accuracy().toFixed(1) + '%' },
    ]);

    c.save();
    roundRect(c, MARGIN - 10, TOP - 4, HIGHWAY_W + 20, GH - TOP - 12, COL.radius);
    c.clip();

    /* Highway. */
    var g = c.createLinearGradient(0, TOP, 0, GH);
    g.addColorStop(0, 'rgba(8,6,18,0.10)');
    g.addColorStop(1, 'rgba(8,6,18,0.55)');
    c.fillStyle = g;
    c.fillRect(MARGIN, TOP, HIGHWAY_W, GH - TOP);

    var i;
    for (i = 0; i <= LANES; i++) {
      c.globalAlpha = 0.12;
      c.strokeStyle = COL.a1;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(laneX(i), TOP);
      c.lineTo(laneX(i), GH - 20);
      c.stroke();
      c.globalAlpha = 1;
    }

    /* Beat rulers scrolling with the song give the highway a sense of speed. */
    var firstBeat = Math.floor((songT - 200) / (STEP_MS * 4)) * (STEP_MS * 4);
    for (var b = 0; b < 10; b++) {
      var bt = firstBeat + b * STEP_MS * 4;
      var y = HIT_Y - ((bt - songT) / LEAD_MS) * (HIT_Y - TOP);
      if (y < TOP || y > HIT_Y + 4) continue;
      c.globalAlpha = 0.10;
      c.strokeStyle = COL.text2;
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(MARGIN, y); c.lineTo(MARGIN + HIGHWAY_W, y); c.stroke();
      c.globalAlpha = 1;
    }

    /* Lane receptors. */
    for (i = 0; i < LANES; i++) {
      var x = laneX(i);
      var flash = laneFlash[i] / 220;
      if (flash > 0) {
        c.globalAlpha = clamp(flash * 0.30, 0, 1);
        c.fillStyle = LANE_COL[i];
        c.fillRect(x, TOP, LANE_W, HIT_Y - TOP);
        c.globalAlpha = 1;
        Render.glow(c, x + LANE_W / 2, HIT_Y, LANE_W * 1.3, LANE_COL[i],
          clamp(flash, 0, 1));
      }
      panel(c, x + 6, HIT_Y - NOTE_H / 2 - 4, LANE_W - 12, NOTE_H + 8, {
        fill: flash > 0 ? rgba(LANE_COL[i], 0.28) : 'rgba(16,12,34,0.6)',
        stroke: rgba(LANE_COL[i], 0.4 + flash * 0.5),
        lineWidth: 2, radius: 10,
      });
      text(c, LANE_GLYPH[i], x + LANE_W / 2, HIT_Y + 1, {
        size: 18, color: flash > 0 ? COL.text : rgba(LANE_COL[i], 0.8),
        align: 'center', baseline: 'middle',
      });
    }

    /* Notes. */
    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      var d = n.time - songT;
      if (d > LEAD_MS) break;
      if (n.judged >= 0 && n.hitT <= 0) continue;
      if (d < -400) continue;

      var y = HIT_Y - (d / LEAD_MS) * (HIT_Y - TOP);
      if (!isFinite(y)) continue;
      var nx = laneX(n.lane) + 8;
      var nw = LANE_W - 16;
      var col = LANE_COL[n.lane];

      if (n.judged >= 0) {
        /* Judged notes pop and fade rather than vanishing. */
        var a = clamp(n.hitT / 260, 0, 1);
        c.globalAlpha = a;
        var grow = (1 - a) * 10;
        slab(c, nx - grow, HIT_Y - NOTE_H / 2 - grow / 2, nw + grow * 2,
          NOTE_H + grow, col, shade(col, 0.5), 'solid');
        c.globalAlpha = 1;
        continue;
      }

      slab(c, nx, y - NOTE_H / 2, nw, NOTE_H, col, shade(col, 0.45),
        n.accent ? 'glow' : 'solid');
    }

    particles.draw(c);
    c.restore();

    /* Judgement banner. */
    if (judgeText.life > 0) {
      var ja = clamp(judgeText.life / 420, 0, 1);
      c.globalAlpha = ja;
      text(c, judgeText.name, GW / 2, HIT_Y - 90, {
        size: 30, weight: '700', track: 6, color: judgeText.col,
        align: 'center', baseline: 'middle',
      });
      if (combo > 2) {
        dataText(c, combo + 'x', GW / 2, HIT_Y - 52, {
          size: 22, align: 'center', color: COL.text2, baseline: 'middle',
        });
      }
      c.globalAlpha = 1;
    }

    /* Health bar along the bottom. */
    var hw = GW - MARGIN * 2;
    c.fillStyle = 'rgba(110,106,160,.22)';
    c.fillRect(MARGIN, GH - 34, hw, 8);
    var hg = c.createLinearGradient(MARGIN, 0, MARGIN + hw, 0);
    hg.addColorStop(0, health < 30 ? COL.bad : COL.a1);
    hg.addColorStop(1, health < 30 ? COL.warn : COL.a2);
    c.fillStyle = hg;
    c.fillRect(MARGIN, GH - 34, hw * clamp(health / 100, 0, 1), 8);

    /* Count-in. */
    if (songT < 0) {
      var beats = Math.ceil(-songT / (STEP_MS * 4));
      text(c, String(Math.max(1, beats)), GW / 2, GH / 2, {
        size: 96, weight: '700', color: rgba(ACCENT.pulse, 0.8),
        align: 'center', baseline: 'middle',
      });
    }
  }

  /* --------------------------------------------------------- preview --- */

  function preview(c, w, h, t) {
    var lw = w / LANES;
    var hitY = h * 0.82;
    var i;
    for (i = 0; i <= LANES; i++) {
      c.globalAlpha = 0.14;
      c.strokeStyle = COL.a1;
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(i * lw, 0); c.lineTo(i * lw, h); c.stroke();
      c.globalAlpha = 1;
    }

    var nh = Math.max(4, h * 0.075);
    /* Replay the real chart's opening so the card shows the actual game. */
    for (i = 0; i < 14 && i < chart.length; i++) {
      var n = chart[i];
      var span = 2400;
      var phase = ((t + i * 40) % span) / span;
      var y = phase * (hitY + nh) - nh;
      var col = LANE_COL[n.lane];
      slab(c, n.lane * lw + 3, y, lw - 6, nh, col, shade(col, 0.45), 'solid');
    }

    for (i = 0; i < LANES; i++) {
      var flash = (Math.floor(t / 240) % LANES === i) ? 1 : 0;
      var col2 = LANE_COL[i];
      if (flash) Render.glow(c, i * lw + lw / 2, hitY, lw * 1.2, col2, 0.8);
      panel(c, i * lw + 3, hitY - nh / 2, lw - 6, nh, {
        fill: flash ? rgba(col2, 0.3) : 'rgba(16,12,34,0.6)',
        stroke: rgba(col2, 0.5), lineWidth: 2, radius: 6,
      });
    }
  }

  return registerGame({
    id: 'pulse',
    title: 'PULSE',
    tag: 'Four lanes, one d-pad',
    accent: ACCENT.pulse,
    hint: '◀▼▲▶ HIT THE FOUR LANES',
    /**
     * Attract-mode pilot: press a lane when its next note is inside the
     * perfect window. Deliberately not frame-perfect on every note — a demo
     * that never misses looks canned.
     */
    demo: function () {
      var out = {};
      if (over) return out;
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        if (n.judged >= 0) continue;
        var d = n.time - songT;
        if (d > 60) break;
        if (d > -30) out[LANE_ACTION[n.lane]] = true;
      }
      return out;
    },

    start: start,
    update: update,
    draw: draw,
    preview: preview,
    /* Test seam: chart generation must be deterministic and judgement
     * windows must not drift with frame pacing. */
    _test: {
      chart: function () { return chart; },
      notes: function () { return notes; },
      songT: function () { return songT; },
      setSongT: function (v) { songT = v; },
      counts: function () { return counts; },
      score: function () { return score; },
      health: function () { return health; },
      combo: function () { return combo; },
      laneAction: LANE_ACTION,
      STEP_MS: STEP_MS,
      SONG_MS: SONG_MS,
      W_GOOD: W_GOOD,
    },
  });
})();
