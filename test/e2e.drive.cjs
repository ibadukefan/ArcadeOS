/*
 * ArcadeOS E2E playability driver.
 *
 * Loads dist/arcade.html in real Chromium, then for every registered game:
 * positions the dashboard cursor (test seam), launches/plays/pauses/quits via
 * REAL keyboard events so the full input pipeline is exercised, screenshots
 * along the way, and collects page errors + recorded faults.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'arcade.html');
const OUT = process.env.E2E_SHOTS_DIR
  || path.join(require('os').tmpdir(), 'arcadeos-e2e-shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Per-game input scripts: [key, holdMs, gapMs] repeated for `seconds`. */
const PLAYS = {
  breakout: { keys: ['ArrowLeft', 'ArrowRight'], hold: 260, secs: 6 },
  climb:    { keys: ['ArrowLeft', 'ArrowRight', 'Enter'], hold: 180, secs: 6 },
  pulse:    { keys: ['Enter'], hold: 60, gap: 420, secs: 6 },
  drop:     { keys: ['ArrowLeft', 'ArrowRight'], hold: 220, secs: 6 },
  tetris:   { keys: ['ArrowLeft', 'Enter', 'ArrowRight', 'ArrowDown'], hold: 90, secs: 6 },
  snake:    { keys: ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'], hold: 60, gap: 500, secs: 6 },
  ascent:   { keys: ['ArrowLeft', 'ArrowRight'], hold: 300, secs: 6 },
  runner:   { keys: ['Enter'], hold: 70, gap: 600, secs: 6 },
  invade:   { keys: ['ArrowLeft', 'Enter', 'ArrowRight', 'Enter'], hold: 120, secs: 6 },
  merge:    { keys: ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'], hold: 60, gap: 350, secs: 6 },
  flap:     { keys: ['Enter'], hold: 60, gap: 450, secs: 6 },
  mines:    { keys: ['ArrowRight', 'Enter', 'ArrowDown', 'Enter'], hold: 70, gap: 200, secs: 5 },
  words:    null, // scripted separately: real solve via grid navigation
};

async function main() {
  const browser = await chromium.launch({
    args: ['--force-device-scale-factor=1'],
  });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('ERR_CONNECTION_REFUSED')) errors.push('console: ' + m.text());
  });

  await page.goto(PAGE);
  await page.waitForFunction(() => window.ArcadeOS && window.ArcadeOS.Shell, null, { timeout: 15000 });
  // Wait for the dashboard (boot splash may run first).
  await page.waitForFunction(() => window.ArcadeOS.Shell.state() === 'menu', null, { timeout: 20000 });
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, '00-dashboard.png') });

  const games = await page.evaluate(() => window.ArcadeOS.GAMES.map((g) => g.id));
  console.log('games:', games.join(' '));

  const report = [];

  for (const id of games) {
    const before = errors.length;
    const r = { id, ok: true, notes: [] };
    try {
      // Position the cursor deterministically, then launch with a REAL key.
      const found = await page.evaluate((gid) => window.ArcadeOS.Shell._select(gid), id);
      if (!found) throw new Error('not on dashboard');
      await sleep(400);
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (gid) => window.ArcadeOS.Shell.state() === 'game'
          && window.ArcadeOS.Shell._activeGame()
          && window.ArcadeOS.Shell._activeGame().id === gid,
        id, { timeout: 5000 });
      await sleep(600);
      await page.screenshot({ path: path.join(OUT, `${id}-1-start.png`) });

      if (id === 'words') {
        await playWords(page, r);
      } else {
        const s = PLAYS[id] || { keys: ['Enter'], hold: 80, secs: 4 };
        const until = Date.now() + s.secs * 1000;
        let k = 0;
        while (Date.now() < until) {
          const key = s.keys[k++ % s.keys.length];
          await page.keyboard.down(key);
          await sleep(s.hold || 100);
          await page.keyboard.up(key);
          await sleep(s.gap || 60);
          const st = await page.evaluate(() => window.ArcadeOS.Shell.state());
          if (st !== 'game') break; // died into game-over/initials
        }
      }
      await page.screenshot({ path: path.join(OUT, `${id}-2-play.png`) });

      // Where did we end up?
      let st = await page.evaluate(() => window.ArcadeOS.Shell.state());
      r.notes.push('state after play: ' + st);

      if (st === 'game') {
        // Real pause → QUIT TO MENU (RESUME, RESTART, QUIT).
        await page.keyboard.press('KeyP');
        await sleep(300);
        await page.keyboard.press('ArrowDown');
        await sleep(150);
        await page.keyboard.press('ArrowDown');
        await sleep(150);
        await page.keyboard.press('Enter');
      } else {
        // Game over / initials: back out until dashboard.
        for (let i = 0; i < 6; i++) {
          st = await page.evaluate(() => window.ArcadeOS.Shell.state());
          if (st === 'menu') break;
          await page.keyboard.press('Escape');
          await sleep(300);
        }
      }
      await page.waitForFunction(() => window.ArcadeOS.Shell.state() === 'menu', null, { timeout: 6000 });
    } catch (e) {
      r.ok = false;
      r.notes.push('FAIL: ' + e.message);
      await page.screenshot({ path: path.join(OUT, `${id}-9-fail.png`) }).catch(() => {});
      // Try to recover to the dashboard for the next game.
      await page.evaluate(() => {
        try { window.ArcadeOS.Shell._go('menu'); } catch (e2) {}
      });
      await sleep(400);
    }
    const newErrs = errors.slice(before);
    if (newErrs.length) { r.ok = false; r.notes.push(...newErrs); }
    report.push(r);
    console.log((r.ok ? 'PASS' : 'FAIL'), id, r.notes.join(' | '));
  }

  // Recorded faults + settings screen sanity shot.
  const faults = await page.evaluate(() => {
    try { return window.ArcadeOS.Faults.all().slice(0, 10); } catch (e) { return ['unreadable: ' + e.message]; }
  });
  console.log('faults:', JSON.stringify(faults));

  await page.evaluate(() => window.ArcadeOS.Shell._go('settings'));
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'zz-settings.png') });

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ report, faults, errors }, null, 2));
  await browser.close();
  const bad = report.filter((r) => !r.ok);
  console.log(bad.length ? 'E2E FAILURES: ' + bad.map((b) => b.id).join(', ') : 'E2E all games passed');
}

/* WORDS: read the answer, then really type it — arrows to each letter on the
 * on-screen grid, Enter to type it, Shift to submit. */
async function playWords(page, r) {
  const info = await page.evaluate(() => {
    const g = window.ArcadeOS.gameById('words');
    return { answer: g._test.answer(), cur: g._test.cur() };
  });
  r.notes.push('answer: ' + info.answer);
  const KEYS = [
    ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    ['H', 'I', 'J', 'K', 'L', 'M', 'N'],
    ['O', 'P', 'Q', 'R', 'S', 'T', 'U'],
    ['V', 'W', 'X', 'Y', 'Z', 'DEL', 'ENTER'],
  ];
  const pos = {};
  KEYS.forEach((row, ri) => row.forEach((k, ci) => { pos[k] = { r: ri, c: ci }; }));
  let cur = { r: 1, c: 3 }; // start position (K)

  for (const chRaw of info.answer.toUpperCase()) {
    const t = pos[chRaw];
    while (cur.r !== t.r) {
      await page.keyboard.press(cur.r < t.r ? 'ArrowDown' : 'ArrowUp');
      cur.r += cur.r < t.r ? 1 : -1;
      await sleep(90);
    }
    while (cur.c !== t.c) {
      await page.keyboard.press(cur.c < t.c ? 'ArrowRight' : 'ArrowLeft');
      cur.c += cur.c < t.c ? 1 : -1;
      await sleep(90);
    }
    await page.keyboard.press('Enter');
    await sleep(140);
  }
  await page.screenshot({ path: path.join(OUT, 'words-1b-typed.png') });
  await page.keyboard.press('Shift'); // alt = submit
  await sleep(600);
  const after = await page.evaluate(() => {
    const g = window.ArcadeOS.gameById('words');
    return { solved: g._test.solved(), score: g._test.score(), msg: g._test.lastMsg(), cur: g._test.cur(), guesses: g._test.guesses().length };
  });
  r.notes.push('after submit: ' + JSON.stringify(after));
  if (after.solved !== 1) { r.ok = false; r.notes.push('typed the answer but it did not solve'); }
  await sleep(1200); // solve animation → next word
}

main().catch((e) => { console.error(e); process.exit(1); });
