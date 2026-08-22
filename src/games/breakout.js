/*
 * BREAKOUT — a deliberately tall well.
 *
 * The portrait aspect is the design: with ~700px of clear air between the
 * brick field and the paddle, a ball spends most of its life in transit, so
 * angle choice matters far more than reaction speed. On a wide screen this
 * would be a twitch game; here it is a planning one.
 *
 * Controls: left/right to move the paddle, confirm to launch.
 */

var BREAKOUT = (function () {
  var PAD_X = 24;
  var TOP = HUD_H + 12;
  var BOT = GH - 20;
  var LEFT = PAD_X, RIGHT = GW - PAD_X;
  var FIELD_W = RIGHT - LEFT;

  var COLS = 8, ROWS = 6;
  var BRICK_W = FIELD_W / COLS;
  var BRICK_H = 26;
  var BRICK_TOP = TOP + 40;

  var PADDLE_Y = BOT - 34;
  var PADDLE_W = 108, PADDLE_H = 16;
  var PADDLE_SPEED = 0.62;

  var BALL_R = 8;
  var BASE_SPEED = 0.40;
  var MAX_SPEED = 0.86;

  /* Row colours run down the tetromino ramp so the field reads as a gradient. */
  var ROW_COL = ['Z', 'L', 'O', 'S', 'I', 'J'];

  var bricks = new Int8Array(COLS * ROWS);   /* 0 empty, else hits remaining */
  var paddle = { x: GW / 2, w: PADDLE_W, wide: 0 };
  var balls = makePool(function () {
    return { alive: false, x: 0, y: 0, vx: 0, vy: 0, stuck: true };
  }, 4);
  var drops = makePool(function () {
    return { alive: false, x: 0, y: 0, kind: 0 };
  }, 8);
  var particles = makeParticles(80);

  var score = 0, lives = 3, level = 1, remaining = 0, over = false;
  var shakeT = 0, flashT = 0;

  /* 0 = wide paddle, 1 = multi-ball, 2 = extra life */
  var DROP_COL = ['#37E1C4', '#F0C64E', '#F0645E'];

  function idx(c, r) { return r * COLS + c; }

  function buildField() {
    remaining = 0;
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        /* Higher rows take more hits as levels advance. */
        var hits = 1;
        if (level >= 2 && r === 0) hits = 2;
        if (level >= 3 && r <= 1) hits = 2;
        if (level >= 5 && r === 0) hits = 3;
        bricks[idx(c, r)] = hits;
        remaining++;
      }
    }
  }

  function resetBall() {
    balls.clear();
    var b = balls.spawn();
    if (!b) return;
    b.x = paddle.x;
    b.y = PADDLE_Y - BALL_R - 2;
    b.vx = 0; b.vy = 0;
    b.stuck = true;
  }

  function launch(b) {
    if (!b.stuck) return;
    b.stuck = false;
    var speed = BASE_SPEED + (level - 1) * 0.03;
    var ang = -Math.PI / 2 + rndRange(-0.5, 0.5);
    b.vx = Math.cos(ang) * speed;
    b.vy = Math.sin(ang) * speed;
    Audio2.sfx('bounce');
  }

  function start() {
    score = 0; lives = 3; level = 1; over = false;
    shakeT = 0; flashT = 0;
    paddle.x = GW / 2; paddle.w = PADDLE_W; paddle.wide = 0;
    drops.clear();
    particles.clear();
    buildField();
    resetBall();
  }

  function nextLevel() {
    level++;
    Audio2.sfx('powerup');
    paddle.w = PADDLE_W; paddle.wide = 0;
    drops.clear();
    buildField();
    resetBall();
  }

  function loseLife() {
    lives--;
    shakeT = 260;
    Audio2.sfx('over');
    Input.rumble(0.8, 0.6, 240);
    if (lives <= 0) {
      over = true;
      Shell.gameOver(score);
      return;
    }
    paddle.w = PADDLE_W; paddle.wide = 0;
    resetBall();
  }

  function hitBrick(c, r, b) {
    var i = idx(c, r);
    var hp = bricks[i];
    if (hp <= 0) return false;
    bricks[i] = hp - 1;
    var bx = LEFT + c * BRICK_W + BRICK_W / 2;
    var by = BRICK_TOP + r * BRICK_H + BRICK_H / 2;
    var col = PIECE_COL[ROW_COL[r % ROW_COL.length]][0];

    if (bricks[i] <= 0) {
      remaining--;
      score += 50 + (ROWS - r) * 10 + (level - 1) * 5;
      particles.burst(bx, by, 8, col, { speed: 0.24, life: 420, size: 4 });
      Audio2.sfx('hit');
      Input.rumble(0.2, 0.15, 35);
      /* One brick in twelve carries something. */
      if (rndInt(1, 12) === 1) {
        var d = drops.spawn();
        if (d) { d.x = bx; d.y = by; d.kind = rndInt(0, 2); }
      }
    } else {
      score += 10;
      particles.burst(bx, by, 3, '#FFFFFF', { speed: 0.12, life: 200, size: 3 });
      Audio2.sfx('bounce');
    }
    return true;
  }

  /**
   * Step one ball. Swept against the brick grid on each axis separately so a
   * fast ball cannot tunnel through a row — at 0.86px/ms and a 26px brick, a
   * naive position test misses on a long frame.
   */
  function stepBall(b, dt) {
    if (b.stuck) {
      b.x = paddle.x;
      b.y = PADDLE_Y - BALL_R - 2;
      return;
    }

    /* Substep so no single move exceeds half a brick. */
    var dist = Math.max(Math.abs(b.vx), Math.abs(b.vy)) * dt;
    var steps = Math.max(1, Math.min(8, Math.ceil(dist / (BRICK_H * 0.5))));
    var sdt = dt / steps;

    for (var s = 0; s < steps && b.alive; s++) {
      b.x += b.vx * sdt;
      if (b.x - BALL_R < LEFT) { b.x = LEFT + BALL_R; b.vx = Math.abs(b.vx); Audio2.sfx('bounce'); }
      if (b.x + BALL_R > RIGHT) { b.x = RIGHT - BALL_R; b.vx = -Math.abs(b.vx); Audio2.sfx('bounce'); }
      collideBricks(b, true);

      b.y += b.vy * sdt;
      if (b.y - BALL_R < TOP) { b.y = TOP + BALL_R; b.vy = Math.abs(b.vy); Audio2.sfx('bounce'); }
      collideBricks(b, false);

      /* Paddle. */
      if (b.vy > 0 &&
        b.y + BALL_R >= PADDLE_Y && b.y - BALL_R <= PADDLE_Y + PADDLE_H &&
        b.x >= paddle.x - paddle.w / 2 - BALL_R &&
        b.x <= paddle.x + paddle.w / 2 + BALL_R) {
        b.y = PADDLE_Y - BALL_R;
        /* Contact point sets the angle — the whole skill of the game. */
        var off = clamp((b.x - paddle.x) / (paddle.w / 2), -1, 1);
        var speed = Math.min(MAX_SPEED, Math.sqrt(b.vx * b.vx + b.vy * b.vy) * 1.015);
        var ang = -Math.PI / 2 + off * 1.02;
        b.vx = Math.cos(ang) * speed;
        b.vy = Math.sin(ang) * speed;
        Audio2.sfx('bounce');
        Input.rumble(0.15, 0.1, 40);
      }

      if (b.y - BALL_R > BOT) b.alive = false;
    }
  }

  function collideBricks(b, horizontal) {
    if (b.y + BALL_R < BRICK_TOP || b.y - BALL_R > BRICK_TOP + ROWS * BRICK_H) return;
    var c0 = Math.floor((b.x - BALL_R - LEFT) / BRICK_W);
    var c1 = Math.floor((b.x + BALL_R - LEFT) / BRICK_W);
    var r0 = Math.floor((b.y - BALL_R - BRICK_TOP) / BRICK_H);
    var r1 = Math.floor((b.y + BALL_R - BRICK_TOP) / BRICK_H);

    for (var r = Math.max(0, r0); r <= Math.min(ROWS - 1, r1); r++) {
      for (var c = Math.max(0, c0); c <= Math.min(COLS - 1, c1); c++) {
        if (bricks[idx(c, r)] <= 0) continue;
        if (hitBrick(c, r, b)) {
          if (horizontal) b.vx = -b.vx; else b.vy = -b.vy;
          return;
        }
      }
    }
  }

  function applyDrop(kind) {
    if (kind === 0) {
      paddle.w = Math.min(PADDLE_W * 1.8, paddle.w * 1.35);
      paddle.wide = 12000;
      Audio2.sfx('powerup');
      Input.rumble(0.35, 0.45, 110);
    } else if (kind === 1) {
      /* Split every live ball once. */
      var spawned = [];
      balls.forEach(function (b) {
        if (b.stuck) return;
        var n = balls.spawn();
        if (!n) return;
        n.x = b.x; n.y = b.y; n.stuck = false;
        var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || BASE_SPEED;
        var a = Math.atan2(b.vy, b.vx) + rndRange(0.4, 0.9);
        n.vx = Math.cos(a) * sp;
        n.vy = Math.sin(a) * sp;
        spawned.push(n);
      });
      Audio2.sfx('powerup');
      Input.rumble(0.35, 0.45, 110);
    } else {
      lives++;
      Audio2.sfx('coin');
      Input.rumble(0.2, 0.3, 80);
    }
    flashT = 200;
  }

  function update(dt) {
    particles.update(dt, 0.0004);
    if (shakeT > 0) shakeT = Math.max(0, shakeT - dt);
    if (flashT > 0) flashT = Math.max(0, flashT - dt);
    if (over) return;

    if (paddle.wide > 0) {
      paddle.wide -= dt;
      if (paddle.wide <= 0) paddle.w = PADDLE_W;
    }

    var dx = (Input.down('right') ? 1 : 0) - (Input.down('left') ? 1 : 0);
    paddle.x = clamp(paddle.x + dx * PADDLE_SPEED * dt,
      LEFT + paddle.w / 2, RIGHT - paddle.w / 2);

    if (Input.hit('confirm') || Input.hit('up')) {
      balls.forEach(function (b) { launch(b); });
    }

    balls.forEach(function (b) { stepBall(b, dt); });

    /* Power-up drops. */
    drops.forEach(function (d) {
      d.y += 0.22 * dt;
      if (d.y > BOT + 20) { d.alive = false; return; }
      if (d.y > PADDLE_Y - 12 && d.y < PADDLE_Y + PADDLE_H + 12 &&
        Math.abs(d.x - paddle.x) < paddle.w / 2 + 12) {
        d.alive = false;
        applyDrop(d.kind);
      }
    });

    if (balls.count() === 0) loseLife();
    else if (remaining <= 0) nextLevel();
  }

  /* ------------------------------------------------------------ draw --- */

  function drawField(c) {
    for (var r = 0; r < ROWS; r++) {
      var name = ROW_COL[r % ROW_COL.length];
      var col = PIECE_COL[name];
      for (var cc = 0; cc < COLS; cc++) {
        var hp = bricks[idx(cc, r)];
        if (hp <= 0) continue;
        var x = LEFT + cc * BRICK_W + 2;
        var y = BRICK_TOP + r * BRICK_H + 2;
        /* Reinforced bricks read as brighter; one hit dulls them. */
        var base = hp > 1 ? shade(col[0], 0.22) : col[0];
        slab(c, x, y, BRICK_W - 4, BRICK_H - 4, base, col[1], 'solid');
        if (hp > 1) {
          c.globalAlpha = 0.5;
          dataText(c, String(hp), x + (BRICK_W - 4) / 2, y + BRICK_H / 2 + 3, {
            size: 11, align: 'center', color: '#07050E',
          });
          c.globalAlpha = 1;
        }
      }
    }
  }

  function draw() {
    var c = gx;
    gBackdrop(ACCENT.breakout);
    gHud(ACCENT.breakout, [
      { label: 'SCORE', value: fmtScore(score) },
      { label: 'LEVEL', value: pad(level, 2) },
      { label: 'BALLS', value: String(Math.max(0, lives)), color: lives <= 1 ? COL.bad : COL.data },
    ]);

    c.save();
    if (shakeT > 0) {
      var k = shakeT / 260;
      c.translate(Math.sin(shakeT * 1.2) * 4 * k, 0);
    }
    c.save();
    roundRect(c, LEFT - 10, TOP - 6, FIELD_W + 20, BOT - TOP + 14, COL.radius);
    c.clip();

    if (flashT > 0) {
      c.globalAlpha = clamp(flashT / 200 * 0.18, 0, 1);
      c.fillStyle = ACCENT.breakout;
      c.fillRect(LEFT - 10, TOP - 6, FIELD_W + 20, BOT - TOP + 14);
      c.globalAlpha = 1;
    }

    drawField(c);
    particles.draw(c);

    drops.forEach(function (d) {
      var col = DROP_COL[d.kind];
      Render.glow(c, d.x, d.y, 26, col, 0.7);
      tile(c, d.x - 11, d.y - 11, 22, col, shade(col, 0.4), 'solid');
    });

    /* Paddle. */
    Render.glow(c, paddle.x, PADDLE_Y + PADDLE_H / 2, paddle.w * 0.8,
      ACCENT.breakout, 0.5);
    slab(c, paddle.x - paddle.w / 2, PADDLE_Y, paddle.w, PADDLE_H,
      ACCENT.breakout, shade(ACCENT.breakout, 0.45), 'solid');

    balls.forEach(function (b) {
      Render.glow(c, b.x, b.y, BALL_R * 3, '#EFEDFF', 0.7);
      c.beginPath();
      c.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
      c.fillStyle = '#EFEDFF';
      c.fill();
      if (b.stuck) {
        /* Aiming guide while the ball is held. */
        c.globalAlpha = 0.35 + Math.sin(b.x * 0.1) * 0.1;
        c.strokeStyle = ACCENT.breakout;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(b.x, b.y - BALL_R);
        c.lineTo(b.x, b.y - 60);
        c.stroke();
        c.globalAlpha = 1;
      }
    });

    c.restore();
    c.restore();
  }

  /* --------------------------------------------------------- preview --- */

  function preview(c, w, h, t) {
    var cols = 6, rowsP = 3;
    var bw = w / cols, bh = h * 0.09;
    for (var r = 0; r < rowsP; r++) {
      var col = PIECE_COL[ROW_COL[r % ROW_COL.length]];
      for (var cc = 0; cc < cols; cc++) {
        /* A couple of gaps so it reads as a game in progress. */
        if ((cc + r * 2) % 7 === 3) continue;
        slab(c, cc * bw + 2, h * 0.08 + r * bh + 1, bw - 4, bh - 2, col[0], col[1], 'solid');
      }
    }

    /* Ball tracing a long arc, paddle following it. */
    var loop = (t % 2600) / 2600;
    var bx = w * 0.5 + Math.sin(loop * Math.PI * 2) * w * 0.34;
    var arc = Math.abs(Math.sin(loop * Math.PI * 2));
    var by = h * 0.42 + (1 - arc) * h * 0.36;
    var pr = Math.max(3, Math.min(w, h) * 0.035);
    Render.glow(c, bx, by, pr * 3, '#EFEDFF', 0.7);
    c.beginPath();
    c.arc(bx, by, pr, 0, Math.PI * 2);
    c.fillStyle = '#EFEDFF';
    c.fill();

    var pw = w * 0.28;
    var px = clamp(bx - pw / 2, 0, w - pw);
    slab(c, px, h - h * 0.10, pw, h * 0.045,
      ACCENT.breakout, shade(ACCENT.breakout, 0.45), 'solid');
  }

  return registerGame({
    id: 'breakout',
    title: 'BREAKOUT',
    tag: 'A tall well makes long arcs',
    accent: ACCENT.breakout,
    hint: '◀▶ PADDLE · {A} LAUNCH',
    /** Attract-mode pilot: keep the paddle under the lowest live ball. */
    demo: function () {
      var out = {};
      if (over) return out;
      var target = null, lowest = -1;
      balls.forEach(function (b) {
        if (b.stuck) { out.confirm = true; return; }
        if (b.y > lowest) { lowest = b.y; target = b; }
      });
      if (!target) return out;
      /* Aim slightly off-centre so the ball keeps picking up angle. */
      var want = target.x + (target.vx > 0 ? -10 : 10);
      if (want < paddle.x - 6) out.left = true;
      else if (want > paddle.x + 6) out.right = true;
      return out;
    },

    start: start,
    update: update,
    draw: draw,
    preview: preview,
  });
})();
