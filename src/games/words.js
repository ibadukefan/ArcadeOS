/*
 * WORDS — the daily-word guessing game, made endless for the cabinet. Six
 * tries to guess a five-letter word: a tile turns green if the letter is
 * right and in place, amber if it is in the word elsewhere, and dim if it is
 * not in the word at all. Solve it and the next word loads and your score
 * climbs; miss six times and the run ends.
 *
 * There is no keyboard on a cabinet, so the alphabet is on screen: the d-pad
 * moves the highlight, confirm types the letter under it, back deletes, and
 * the slam button (or the ENTER key on the grid) submits a full guess.
 *
 * The word list is common five-letter English words — plain facts, embedded
 * so the cabinet never needs a network. The same list validates guesses.
 */

var WORDS = (function () {
  var LEN = 5, TRIES = 6;

  /* Common five-letter words. Split from one string to keep the source
   * compact; every entry is both a possible answer and a legal guess. */
  var LIST = ('about above abuse actor acute admit adopt adult after again ' +
    'agent agree ahead alarm album alert alike alive allow alone along alter ' +
    'among anger angle angry apart apple apply arena argue arise array aside ' +
    'asset audio audit avoid award aware badly baker bases basic basis beach ' +
    'began begin begun being below bench birth black blame blank blast blaze ' +
    'bleed blend bless blind block blood bloom board boast bonus boost booth ' +
    'bound brain brand brave bread break breed brick bride brief bring broad ' +
    'broke brown brush build built bunch burst buyer cabin cable candy cargo ' +
    'carry catch cause chain chair chalk chaos charm chart chase cheap check ' +
    'chess chest chief child chill china chose civic civil claim class clean ' +
    'clear clerk click cliff climb cloak clock close cloth cloud coach coast ' +
    'could count court cover crack craft crash crazy cream crime crisp cross ' +
    'crowd crown crude curve cycle daily dairy dance dealt death debut delay ' +
    'dense depth doubt dozen draft drain drama drank dream dress dried drink ' +
    'drive drove dying eager early earth eight elbow elder elect elite empty ' +
    'enemy enjoy enter entry equal error event every exact exist extra faith ' +
    'false fancy fatal fault favor feast fence fever fewer field fifth fifty ' +
    'fight final first flame flash fleet flesh float flood floor flour fluid ' +
    'focus force forge forth forty forum found frame fraud fresh front frost ' +
    'fruit fully funny giant given glass globe glory going grace grade grain ' +
    'grand grant grape graph grass grave great greed green greet grief grill ' +
    'gross group grown guard guess guest guide happy harsh heart heavy hedge ' +
    'hello hobby honey honor horse hotel house human humor hurry ideal image ' +
    'imply index inner input issue ivory joint judge juice knife knock known ' +
    'label labor large laser later laugh layer learn lease least leave legal ' +
    'lemon level light limit local logic loose lower loyal lucky lunar lunch ' +
    'lying magic major maker march marsh match maybe mayor meant medal media ' +
    'merit metal meter might minor minus mixed model money month moral motor ' +
    'mount mouse mouth movie music naval nerve never newly night noble noise ' +
    'north noted novel nurse ocean offer often onion order other ought paint ' +
    'panel panic paper party pasta patch pause peace pearl phase phone photo ' +
    'piano piece pilot pitch pizza place plain plane plant plate plaza point ' +
    'pound power press price pride prime print prior prize probe proof proud ' +
    'prove pulse punch pupil quest queen quick quiet quite radar radio raise ' +
    'rally range rapid ratio reach ready realm rebel refer relax reply rifle ' +
    'right rigid rival river roast robot rocky roman rough round route royal ' +
    'rugby ruler rural salad sauce scale scare scene scent scope score scout ' +
    'scrap screw sense serve seven shade shady shaft shake shall shame shape ' +
    'share sharp sheep sheet shelf shell shift shine shirt shock shoot shore ' +
    'short shown sight silly since sixth sixty skill skirt slate sleep slice ' +
    'slide slope small smart smell smile smoke snake sneak solar solid solve ' +
    'sorry sound south space spare spark speak speed spell spend spice spike ' +
    'spine split spoke sport spray squad staff stage stair stake stamp stand ' +
    'stare start state steam steel steep steer stern stick stiff still sting ' +
    'stock stone stood store storm story stove strap straw strip stuck study ' +
    'stuff style sugar suite super sweet swept swift swing sword table taken ' +
    'taste teach teeth tempo tenth theft their theme there these thick thief ' +
    'thigh thing think third those three threw throw thumb tiger tight timer ' +
    'tired title toast today token tooth topic total touch tough tower toxic ' +
    'trace track trade trail train trait tread treat trend trial tribe trick ' +
    'tried truck truly trust truth twice twist ultra uncle under union unity ' +
    'until upper upset urban usage usual valid value vapor vault verse video ' +
    'villa vinyl viral virus visit vital vivid vocal voice voter wagon waist ' +
    'waste watch water weary weave wedge weigh weird whale wheat wheel where ' +
    'which while white whole whose widen width witch woman world worry worse ' +
    'worst worth would wound wrist write wrong yield young youth zebra').split(' ');

  var LISTSET = (function () {
    var s = Object.create(null);
    for (var i = 0; i < LIST.length; i++) s[LIST[i]] = true;
    return s;
  })();

  /* On-screen keyboard: a uniform 7-wide grid so the d-pad never lands on a
   * hole. The last row carries the two action keys. */
  var KEYS = [
    ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    ['H', 'I', 'J', 'K', 'L', 'M', 'N'],
    ['O', 'P', 'Q', 'R', 'S', 'T', 'U'],
    ['V', 'W', 'X', 'Y', 'Z', 'DEL', 'ENTER'],
  ];
  var KROWS = KEYS.length, KCOLS = KEYS[0].length;
  var KPOS = (function () {
    var m = Object.create(null);
    for (var r = 0; r < KROWS; r++) {
      for (var c = 0; c < KEYS[r].length; c++) m[KEYS[r][c]] = { r: r, c: c };
    }
    return m;
  })();

  /* Tile geometry. */
  var TILE = 80, TGAP = 8;
  var BW = LEN * TILE + (LEN - 1) * TGAP;
  var BX = (GW - BW) / 2, BY = HUD_H + 24;

  var KEY = 64, KGAP = 8;
  var KW = KCOLS * KEY + (KCOLS - 1) * KGAP;
  var KX = (GW - KW) / 2;
  var KY = BY + TRIES * (TILE + TGAP) + 40;

  /* Result colours map straight onto the existing semantic tokens. */
  var GOOD = [COL.good, shade(COL.good, 0.3)];
  var WARN = [COL.warn, shade(COL.warn, 0.3)];
  var GONE = [COL.dim, shade(COL.dim, 0.3)];

  var answer = '';
  var guesses = [];          /* [{ word, states:[5] }] */
  var cur = '';              /* letters typed so far */
  var letterState = null;    /* {A: 'good'|'warn'|'gone'} for the keyboard */
  var cursor = { r: 1, c: 3 };
  var score = 0, solved = 0, over = false;
  var msg = '', msgT = 0;
  var solveT = 0, revealT = 0, shakeT = 0;
  var used = null;
  var particles = makeParticles(48);

  var dasL = makeRepeater(200, 90), dasR = makeRepeater(200, 90);
  var dasU = makeRepeater(200, 90), dasD = makeRepeater(200, 90);
  var demoBeat = 0;

  function pickWord() {
    used = used || Object.create(null);
    /* No repeats until the whole list has been seen. */
    var pool = [];
    for (var i = 0; i < LIST.length; i++) if (!used[LIST[i]]) pool.push(LIST[i]);
    if (!pool.length) { used = Object.create(null); pool = LIST.slice(); }
    var w = pool[rndInt(0, pool.length - 1)];
    used[w] = true;
    return w;
  }

  function nextWord() {
    answer = pickWord();
    guesses = [];
    cur = '';
    solveT = 0; revealT = 0;
    /* Each word is its own puzzle — the keyboard hints start clean. */
    letterState = Object.create(null);
  }

  function start() {
    score = 0; solved = 0; over = false;
    msg = ''; msgT = 0; shakeT = 0;
    used = Object.create(null);
    letterState = Object.create(null);
    cursor = { r: 1, c: 3 };
    particles.clear();
    nextWord();
  }

  /** Wordle's two-pass scoring: greens first, then ambers limited by the
   * remaining count of each letter in the answer. */
  function evaluate(guess) {
    var states = new Array(LEN);
    var remain = Object.create(null);
    var i, ch;
    for (i = 0; i < LEN; i++) {
      ch = answer.charAt(i);
      remain[ch] = (remain[ch] || 0) + 1;
    }
    for (i = 0; i < LEN; i++) {
      if (guess.charAt(i) === answer.charAt(i)) {
        states[i] = 'good';
        remain[guess.charAt(i)]--;
      }
    }
    for (i = 0; i < LEN; i++) {
      if (states[i]) continue;
      ch = guess.charAt(i);
      if (remain[ch] > 0) { states[i] = 'warn'; remain[ch]--; }
      else states[i] = 'gone';
    }
    return states;
  }

  /** A letter's keyboard colour only ever gets better -> stays at its best. */
  function rank(s) { return s === 'good' ? 3 : s === 'warn' ? 2 : 1; }
  function noteLetter(ch, s) {
    var up = ch.toUpperCase();
    if (!letterState[up] || rank(s) > rank(letterState[up])) letterState[up] = s;
  }

  function flash(text2) { msg = text2; msgT = 1200; }

  function submit() {
    if (cur.length < LEN) { flash('NOT ENOUGH LETTERS'); shakeT = 240; return; }
    var g = cur.toLowerCase();
    if (!LISTSET[g]) { flash('NOT IN WORD LIST'); shakeT = 240; return; }

    var states = evaluate(g);
    guesses.push({ word: g, states: states });
    for (var i = 0; i < LEN; i++) noteLetter(g.charAt(i), states[i]);
    cur = '';
    revealT = LEN * 90 + 120;

    if (g === answer) {
      solved++;
      /* Fewer guesses is worth more; a little bonus for a long streak. */
      score += (TRIES - guesses.length + 1) * 20 + solved * 5;
      Audio2.sfx('clear', 3);
      Input.rumble(0.4, 0.5, 200);
      particles.burst(GW / 2, BY + BW / 2, 22, ACCENT.words,
        { speed: 0.3, life: 620, size: 5 });
      solveT = 900;
    } else if (guesses.length >= TRIES) {
      over = true;
      Audio2.sfx('over');
      Input.rumble(0.85, 0.65, 340);
      flash(answer.toUpperCase());
      Shell.gameOver(score);
    } else {
      Audio2.sfx('lock');
      Input.rumble(0.2, 0.2, 55);
    }
  }

  function activate(token) {
    if (token === 'ENTER') { submit(); return; }
    if (token === 'DEL') {
      if (cur.length) { cur = cur.slice(0, -1); Audio2.sfx('back'); }
      return;
    }
    if (cur.length < LEN) { cur += token; Audio2.sfx('move'); }
    else { Audio2.sfx('denied'); }
  }

  function update(dt) {
    particles.update(dt, 0.0003);
    if (msgT > 0) msgT = Math.max(0, msgT - dt);
    if (revealT > 0) revealT = Math.max(0, revealT - dt);
    if (shakeT > 0) shakeT = Math.max(0, shakeT - dt);

    if (solveT > 0) {
      solveT -= dt;
      if (solveT <= 0) nextWord();
      return;
    }
    if (over) return;

    /* Cursor movement, wrapping so a corner is never a dead end. */
    var i;
    for (i = dasL.step(Input.down('left'), dt); i > 0; i--) cursor.c = (cursor.c + KCOLS - 1) % KCOLS;
    for (i = dasR.step(Input.down('right'), dt); i > 0; i--) cursor.c = (cursor.c + 1) % KCOLS;
    for (i = dasU.step(Input.down('up'), dt); i > 0; i--) cursor.r = (cursor.r + KROWS - 1) % KROWS;
    for (i = dasD.step(Input.down('down'), dt); i > 0; i--) cursor.r = (cursor.r + 1) % KROWS;

    if (Input.hit('confirm')) activate(KEYS[cursor.r][cursor.c]);
    if (Input.hit('back')) activate('DEL');
    if (Input.hit('alt')) submit();
  }

  /* ------------------------------------------------------------ draw --- */

  function colFor(s) { return s === 'good' ? GOOD : s === 'warn' ? WARN : GONE; }

  function drawLetterTile(c, x, y, size, ch, states) {
    if (states) {
      var col = colFor(states);
      tile(c, x, y, size, col[0], col[1], 'solid');
      if (ch) dataText(c, ch.toUpperCase(), x + size / 2, y + size / 2 + size * 0.18, {
        size: size * 0.5, align: 'center', color: COL.bgBot,
      });
    } else {
      panel(c, x, y, size, size, {
        fill: 'rgba(12,9,26,0.5)',
        stroke: ch ? rgba(ACCENT.words, 0.6) : COL.cardLine,
        radius: 10,
      });
      if (ch) dataText(c, ch.toUpperCase(), x + size / 2, y + size / 2 + size * 0.18, {
        size: size * 0.5, align: 'center', color: COL.text,
      });
    }
  }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.words);
    gHud(ACCENT.words, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'SOLVED', value: pad(solved, 3) },
      { label: 'GUESS', value: Math.min(guesses.length + 1, TRIES) + '/' + TRIES },
    ]);

    /* Guess rows. */
    var shx = shakeT > 0 ? Math.sin(shakeT * 0.9) * 4 * (shakeT / 240) : 0;
    for (var r = 0; r < TRIES; r++) {
      var y = BY + r * (TILE + TGAP);
      var row = guesses[r];
      var typing = (r === guesses.length && !over);
      for (var col = 0; col < LEN; col++) {
        var x = BX + col * (TILE + TGAP) + (typing ? shx : 0);
        if (row) {
          drawLetterTile(c, x, y, TILE, row.word.charAt(col), row.states[col]);
        } else if (typing) {
          drawLetterTile(c, x, y, TILE, cur.charAt(col) || '', null);
        } else {
          drawLetterTile(c, x, y, TILE, '', null);
        }
      }
    }

    /* Keyboard. */
    for (var kr = 0; kr < KROWS; kr++) {
      for (var kc = 0; kc < KEYS[kr].length; kc++) {
        var token = KEYS[kr][kc];
        var wide = (token === 'DEL' || token === 'ENTER');
        var kx = KX + kc * (KEY + KGAP);
        var ky = KY + kr * (KEY + KGAP);
        var st = letterState[token];
        var sel = (kr === cursor.r && kc === cursor.c);
        if (st) {
          var col2 = colFor(st);
          tile(c, kx, ky, KEY, col2[0], col2[1], sel ? 'glow' : 'solid');
        } else {
          panel(c, kx, ky, KEY, KEY, {
            fill: sel ? 'rgba(30,24,62,.85)' : 'rgba(20,16,40,.6)',
            stroke: sel ? rgba(ACCENT.words, 0.9) : COL.cardLine,
            lineWidth: sel ? 2 : 1, radius: 9,
          });
        }
        var lbl = token === 'DEL' ? '⌫' : token === 'ENTER' ? '⏎' : token;
        dataText(c, lbl, kx + KEY / 2, ky + KEY / 2 + KEY * 0.16, {
          size: wide ? KEY * 0.34 : KEY * 0.4, align: 'center',
          color: st ? COL.bgBot : (sel ? COL.text : COL.data),
        });
      }
    }

    particles.draw(c);

    if (msgT > 0) {
      c.globalAlpha = clamp(msgT / 400, 0, 1);
      text(c, msg, GW / 2, KY - 14, {
        size: 22, weight: '700', track: 3, color: over ? COL.a1 : COL.warn,
        align: 'center',
      });
      c.globalAlpha = 1;
    }
  }

  /* --------------------------------------------------------- preview --- */

  var PREV_ROWS = [
    { word: 'games', states: ['gone', 'warn', 'gone', 'good', 'gone'] },
    { word: 'plays', states: ['warn', 'gone', 'good', 'gone', 'good'] },
  ];

  function preview(c, w, h, t) {
    var cols = LEN;
    var s = Math.min(w / (cols + 0.8), h / 4.2);
    var gap = s * 0.12;
    var bw = cols * s + (cols - 1) * gap;
    var ox = (w - bw) / 2;
    var oy = h * 0.12;

    for (var r = 0; r < 3; r++) {
      var row = PREV_ROWS[r];
      for (var col = 0; col < cols; col++) {
        var x = ox + col * (s + gap);
        var y = oy + r * (s + gap);
        if (row) {
          var col2 = colFor(row.states[col]);
          tile(c, x, y, s, col2[0], col2[1], 'solid');
          dataText(c, row.word.charAt(col).toUpperCase(), x + s / 2, y + s / 2 + s * 0.18,
            { size: s * 0.5, align: 'center', color: COL.bgBot });
        } else {
          /* Third row: a cursor sweeps the empties, one lighting up. */
          var lit = (Math.floor(t / 300) % cols) === col;
          panel(c, x, y, s, s, {
            fill: 'rgba(12,9,26,0.5)',
            stroke: lit ? rgba(ACCENT.words, 0.8) : COL.cardLine,
            lineWidth: lit ? 2 : 1, radius: s * 0.14,
          });
        }
      }
    }
  }

  return registerGame({
    id: 'words',
    title: 'WORDS',
    tag: 'Six tries to crack the word',
    accent: ACCENT.words,
    hint: '✚ MOVE · {A} TYPE · {B} DELETE · {X} ENTER',
    /**
     * Attract-mode pilot: this is a demo, so it may know the answer. It walks
     * the highlight to each needed letter and types the word out, submitting
     * when the row is full — a clean solve every time. Pulsed on alternate
     * frames so every press is a fresh edge the input layer will latch.
     */
    demo: function () {
      var out = {};
      if (over || solveT > 0) return out;
      demoBeat++;
      if (demoBeat % 2 === 0) return out;   /* release frame */

      if (cur.length >= LEN) { out.alt = true; return out; }   /* submit */
      var want = answer.charAt(cur.length).toUpperCase();
      var target = KPOS[want];
      if (!target) { out.alt = true; return out; }
      if (cursor.r !== target.r) { out[cursor.r < target.r ? 'down' : 'up'] = true; return out; }
      if (cursor.c !== target.c) { out[cursor.c < target.c ? 'right' : 'left'] = true; return out; }
      out.confirm = true;   /* on the letter — type it */
      return out;
    },

    start: start,
    update: update,
    draw: draw,
    preview: preview,
    _test: {
      answer: function () { return answer; },
      setAnswer: function (w) { answer = w; },
      guesses: function () { return guesses; },
      cur: function () { return cur; },
      type: function (w) { for (var i = 0; i < w.length; i++) activate(w.charAt(i).toUpperCase()); },
      submit: submit,
      evaluate: evaluate,
      score: function () { return score; },
      solved: function () { return solved; },
      over: function () { return over; },
      lastMsg: function () { return msg; },
      letterState: function () { return letterState; },
    },
  });
})();
