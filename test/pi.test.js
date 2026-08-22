/*
 * Pi integration tests.
 *
 * These run on the build machine, not on a Pi, so they cannot prove the
 * cabinet boots. What they gate is the class of mistake that is otherwise
 * only discovered with an SD card in your hand and a monitor on the floor:
 * a shell syntax error, a Python typo, a splash generator that emits a
 * corrupt PNG, an agent that stopped binding to loopback, or an uninstall
 * path that quietly disappeared.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SETUP = path.join(ROOT, 'setup-arcade.sh');
const PI = path.join(ROOT, 'pi');

function read(p) { return fs.readFileSync(p, 'utf8'); }

function canRun(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}

describe('setup-arcade.sh', () => {
  it('exists and is executable', () => {
    const st = fs.statSync(SETUP);
    assert.ok(st.isFile());
    assert.ok((st.mode & 0o111) !== 0, 'has the executable bit set');
  });

  it('is valid bash', () => {
    assert.doesNotThrow(() => {
      execFileSync('bash', ['-n', SETUP], { stdio: 'pipe' });
    }, 'bash -n');
  });

  it('runs --help without root and without side effects', () => {
    const out = execFileSync('bash', [SETUP, '--help'], { encoding: 'utf8' });
    assert.ok(/--uninstall/.test(out), 'documents --uninstall');
    assert.ok(/--readonly/.test(out), 'documents --readonly');
    assert.ok(/--gpio-pin/.test(out), 'documents --gpio-pin');
    assert.ok(/--rotate/.test(out), 'documents --rotate');
  });

  it('refuses an unknown option rather than guessing', () => {
    let failed = false;
    try { execFileSync('bash', [SETUP, '--not-a-flag'], { stdio: 'pipe' }); }
    catch (e) { failed = true; }
    assert.ok(failed, 'unknown flags are an error');
  });

  it('validates --rotate and --gpio-pin', () => {
    for (const args of [['--rotate', '45'], ['--gpio-pin', 'three']]) {
      let failed = false;
      try { execFileSync('bash', [SETUP, ...args], { stdio: 'pipe' }); }
      catch (e) { failed = true; }
      assert.ok(failed, `${args.join(' ')} is rejected`);
    }
  });

  it('uses set -Eeuo pipefail', () => {
    assert.ok(/set -Eeuo pipefail/.test(read(SETUP)), 'fails fast');
  });

  it('has an uninstall path that removes every unit it installs', () => {
    const s = read(SETUP);
    const installed = [...s.matchAll(/\/etc\/systemd\/system\/([a-z-]+\.service)/g)]
      .map((m) => m[1]);
    const unique = [...new Set(installed)];
    assert.ok(unique.length >= 3, `found units: ${unique.join(', ')}`);
    const uninstall = s.slice(s.indexOf('uninstall() {'));
    for (const unit of unique) {
      assert.ok(uninstall.includes(unit),
        `${unit} is removed by uninstall`);
    }
  });

  it('writes fenced blocks rather than appending to shared files', () => {
    const s = read(SETUP);
    /* Appending to config.txt or fstab on every run is the classic way a
     * setup script becomes un-rerunnable. */
    assert.ok(/write_block\(\)/.test(s) && /remove_block\(\)/.test(s));
    const appends = [...s.matchAll(/>>\s*(\/etc\/fstab|["$]?\{?cfg|\/boot)/g)];
    assert.deep(appends.map((m) => m[0]), [],
      'nothing appends directly to a shared system file');
  });

  it('never repartitions the card', () => {
    const s = read(SETUP);
    for (const danger of ['mkfs', 'sfdisk', 'parted', 'fdisk', 'dd if=']) {
      /* Naming the command inside a here-doc of instructions is fine;
       * actually invoking one is not. */
      const lines = s.split('\n').filter((l) => l.includes(danger));
      for (const l of lines) {
        assert.ok(/^\s{6,}/.test(l) || l.includes('#'),
          `'${danger}' only appears as instructions, not as a command: ${l.trim()}`);
      }
    }
  });

  it('backs up cmdline.txt before editing it', () => {
    const s = read(SETUP);
    assert.ok(/\.arcadeos\.bak/.test(s), 'keeps a backup');
    assert.ok(/mv "\$\{cmdline\}\.arcadeos\.bak" "\$cmdline"/.test(s),
      'and restores it on uninstall');
  });

  it('passes the offline-critical Chromium flags', () => {
    const s = read(SETUP);
    for (const flag of [
      '--kiosk',
      '--user-data-dir',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-networking',
      '--disable-component-update',
    ]) {
      assert.ok(s.includes(flag), `launcher passes ${flag}`);
    }
  });

  it('points the Chromium profile at the persistent data directory', () => {
    const s = read(SETUP);
    /* This is what makes high scores survive a read-only root. */
    assert.ok(/PROFILE="\$\{DATA_DIR\}\/chromium"/.test(s) ||
      /PROFILE="\/var\/lib\/arcadeos\/chromium"/.test(s),
      'profile lives on the data partition');
  });
});

describe('on-cabinet updater', () => {
  /*
   * Run the real arcadeos-update.sh against a throwaway git origin. This is
   * the path a cabinet takes when CHECK FOR UPDATES is pressed, and it broke
   * on real hardware in a way no text assertion would catch: a failed install
   * left HEAD at the new version, so the next check said "already up to
   * date" about an update that never happened.
   */
  const UPDATER = path.join(PI, 'arcadeos-update.sh');

  function sh(cwd, cmd, env) {
    return execFileSync('bash', ['-c', cmd], {
      cwd, encoding: 'utf8',
      env: Object.assign({}, process.env, env || {}),
    });
  }

  /** Build origin + cabinet checkout. setupBody is the installer at v2. */
  function fixture(setupBody) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcadeos-up-'));
    const G = '-c user.name=t -c user.email=t@t -c commit.gpgsign=false';
    sh(dir, 'git init --bare -q origin.git');
    sh(dir, `git clone -q origin.git seed 2>/dev/null`);
    const seed = path.join(dir, 'seed');
    fs.mkdirSync(path.join(seed, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'dist', 'arcade.html'), '<html>ArcadeOS v1</html>');
    fs.writeFileSync(path.join(seed, 'setup-arcade.sh'), '#!/bin/bash\nexit 0\n');
    fs.chmodSync(path.join(seed, 'setup-arcade.sh'), 0o755);
    sh(seed, `git add -A && git ${G} commit -qm v1 && git branch -M cab && git push -q origin cab`);
    const v1 = sh(seed, 'git rev-parse HEAD').trim();

    sh(dir, 'git clone -q -b cab origin.git cabinet 2>/dev/null');
    const cabinet = path.join(dir, 'cabinet');

    fs.writeFileSync(path.join(seed, 'dist', 'arcade.html'), '<html>ArcadeOS v2</html>');
    fs.writeFileSync(path.join(seed, 'setup-arcade.sh'), '#!/bin/bash\n' + setupBody + '\n');
    fs.chmodSync(path.join(seed, 'setup-arcade.sh'), 0o755);
    sh(seed, `git add -A && git ${G} commit -qm v2 && git push -q origin cab`);
    const v2 = sh(seed, 'git rev-parse HEAD').trim();

    const appDir = path.join(dir, 'opt');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'arcade.html'), 'running-page');
    const conf = path.join(dir, 'update.conf');
    fs.writeFileSync(conf, `SRC_DIR=${cabinet}\nGIT_BRANCH=cab\nARCADE_USER=cabuser\n`);
    return {
      dir, cabinet, v1, v2,
      env: {
        ARCADEOS_UPDATE_CONF: conf,
        ARCADEOS_UPDATE_STATUS: path.join(dir, 'status.json'),
        ARCADEOS_UPDATE_APP_DIR: appDir,
      },
      head: () => sh(cabinet, 'git rev-parse HEAD').trim(),
      status: () => JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')),
      run: function () {
        try { sh(dir, `bash ${UPDATER}`, this.env); return 0; }
        catch (e) { return e.status || 1; }
      },
    };
  }

  it('a failed install rolls the version pointer back, so TRY AGAIN retries', () => {
    const f = fixture('echo boom >&2; exit 1');
    assert.notEqual(f.run(), 0, 'updater must report failure');
    assert.equal(f.status().phase, 'failed');
    assert.equal(f.head(), f.v1,
      'HEAD must return to the running version — otherwise the next check says "up to date" about an update that never installed');
    /* And the retry genuinely retries: it sees the update again. */
    const again = f.run();
    assert.notEqual(again, 0, 'still failing, but it TRIED — it did not say up to date');
    assert.equal(f.status().phase, 'failed');
  });

  it('a successful install advances HEAD and hands the installer the cabinet user', () => {
    const f = fixture('echo "$ARCADE_USER" > installed-as.txt; exit 0');
    assert.equal(f.run(), 0, 'updater must succeed');
    const st = f.status();
    assert.equal(st.phase, 'done');
    assert.equal(st.updated, true);
    assert.equal(f.head(), f.v2, 'HEAD advances only on success');
    assert.equal(fs.readFileSync(path.join(f.cabinet, 'installed-as.txt'), 'utf8').trim(),
      'cabuser',
      'ARCADE_USER from update.conf must reach the installer — without it, setup guessed "pi" and died on any cabinet with a different user');
  });

  it('no update means no writes at all', () => {
    const f = fixture('exit 0');
    /* Point the cabinet at the tip first. */
    sh(f.cabinet, 'git fetch -q origin cab && git reset -q --hard origin/cab');
    assert.equal(f.run(), 0);
    assert.equal(f.status().phase, 'done');
    assert.equal(f.status().updated, false);
  });

  it('a permissions failure is named as one, not blamed on the network', () => {
    /* The second cabinet hit exactly this: root-owned wreckage in
     * .git/objects made fetch fail, the screen said "check the network",
     * the owner pinged github.com — fine — and rightly stopped trusting
     * the screen. chmod stands in for root ownership; same git error. */
    const f = fixture('exit 0');
    /* A chmod cannot simulate this under a root test runner (root ignores
     * permission bits), so shim git: fetch dies with the real error text,
     * everything else passes through. */
    const realGit = sh(f.dir, 'command -v git').trim();
    const shimDir = path.join(f.dir, 'shim');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, 'git'), [
      '#!/bin/bash',
      'for a in "$@"; do',
      '  if [ "$a" = fetch ]; then',
      '    echo "error: insufficient permission for adding an object to repository database .git/objects" >&2',
      '    exit 1',
      '  fi',
      'done',
      `exec ${JSON.stringify(realGit)} "$@"`,
    ].join('\n'));
    fs.chmodSync(path.join(shimDir, 'git'), 0o755);
    f.env.PATH = shimDir + ':' + process.env.PATH;

    assert.notEqual(f.run(), 0, 'updater must report failure');
    const st = f.status();
    assert.equal(st.phase, 'failed');
    assert.ok(/wrong owner/.test(st.error), st.error);
    assert.notOk(/network/.test(st.error), 'network is not blamed: ' + st.error);
  });

  it('heals wrong-owned files anywhere in the checkout, not just the top', () => {
    /* The old heal checked the owner of .git itself — which the user owned,
     * while root-owned objects sat deep inside .git/objects. It walked
     * straight past the damage on a real cabinet. */
    const src = read(UPDATER);
    assert.ok(/find "\$SRC_DIR" ! -user "\$ARCADE_USER" -print -quit/.test(src));
  });

  it('runs git as the cabinet user, never as root', () => {
    /* A root-run fetch writes root-owned objects into the user's checkout,
     * after which the user's own git pull is broken. Real-cabinet scar. */
    const src = read(UPDATER);
    assert.ok(/runuser -u "\$ARCADE_USER" -- git/.test(src));
    assert.ok(/id -u "\$ARCADE_USER" >\/dev\/null/.test(src),
      'guarded, so a missing user falls back instead of failing');
    assert.ok(/chown -R "\$ARCADE_USER" "\$SRC_DIR"/.test(src),
      'and checkouts already damaged by earlier root runs are healed');
  });

  it('records the cabinet user for the next update', () => {
    const src = read(SETUP);
    assert.ok(/^ARCADE_USER=\$ARCADE_USER$/m.test(src.slice(src.indexOf('write_update_conf'))),
      'update.conf carries ARCADE_USER');
    assert.ok(/stat -c %U "\$SRC_DIR"/.test(src),
      'and a cabinet installed before that field existed falls back to the checkout owner');
  });
});

describe('ssh enablement', () => {
  /*
   * A real cabinet ended the evening unreachable: the kiosk owned the screen,
   * the VT-switch chord was swallowed, and sshd had never been enabled. The
   * only remaining path was pulling the SD card. The installer (and therefore
   * every on-cabinet update, which re-runs it) must keep ssh on.
   */
  const src = read(SETUP);

  it('is enabled by the installer, before anything can go wrong', () => {
    assert.ok(/enable_ssh\(\) \{/.test(src));
    assert.ok(/systemctl enable --now ssh/.test(src));
    const main = src.slice(src.indexOf('main() {'));
    assert.ok(/enable_ssh/.test(main), 'main calls enable_ssh');
  });

  it('degrades with a warning rather than failing the install', () => {
    const fn = src.slice(src.indexOf('enable_ssh() {'), src.indexOf('install_packages() {'));
    assert.ok(/\|\| warn/.test(fn), 'a broken sshd must not block the kiosk install');
    assert.ok(/openssh-server is not installed/.test(fn));
  });
});

describe('kiosk service unit', () => {
  /*
   * The first boot on real hardware crash-looped on a black screen because
   * ExecStart passed cage a rotation flag that does not exist. cage's real
   * option set is tiny (getopt string "dhm:sv", checked against the shipped
   * binary) — pin the ExecStart to flags cage actually has, and keep rotation
   * where it now lives: panel_orientation on the kernel command line.
   */
  const src = read(SETUP);

  it('starts the kiosk through the compositor dispatcher', () => {
    assert.ok(/ExecStart=\$\{APP_DIR\}\/kiosk\.sh/.test(src),
      'the unit runs kiosk.sh, which picks cage or weston');
    /* The dispatcher must never leave the cabinet black: an unknown or
     * missing choice, or a missing compositor binary, falls to cage. */
    const start = src.indexOf('kiosk.sh" <<KIOSK');
    const kiosk = src.slice(start, src.indexOf('\nKIOSK', start));
    assert.ok(/command -v labwc/.test(kiosk), 'labwc is verified before use');
    assert.ok(/command -v weston/.test(kiosk), 'weston is verified before use');
    assert.ok(/exec \/usr\/bin\/cage/.test(kiosk), 'cage is the unconditional fallback');
    assert.ok(/exec labwc -C/.test(kiosk), 'labwc runs with a private config dir');
    assert.ok(/--shell=kiosk-shell\.so/.test(kiosk), 'weston runs its kiosk shell');
    assert.ok(/arcadeos-wl/.test(kiosk) && /sleep 0\.2/.test(kiosk),
      'chromium waits for the weston socket instead of racing it');
  });

  it('starts cage with real flags only', () => {
    const exec = src.match(/exec \/usr\/bin\/cage ([^\n]*)/);
    assert.ok(exec, 'the dispatcher execs cage');
    const flags = exec[1].split('--')[0].trim().split(/\s+/);
    for (const f of flags) {
      assert.ok(/^-[dhmsv]+$/.test(f), f + ' is not a flag cage accepts');
    }
  });

  it('keeps VT switching available for rescue', () => {
    /* Without -s there is no local way into a machine whose only screen is
     * owned by the kiosk. */
    assert.ok(/exec \/usr\/bin\/cage -\w*s\w* --/.test(src));
  });

  it('applies rotation through the kernel, for either HDMI port', () => {
    assert.ok(/video=HDMI-A-1:panel_orientation=\$po/.test(src));
    assert.ok(/video=HDMI-A-2:panel_orientation=\$po/.test(src));
    assert.ok(/90\)\s+po=right_side_up/.test(src));
    assert.ok(/270\)\s+po=left_side_up/.test(src));
    assert.ok(/180\)\s+po=upside_down/.test(src));
  });

  it('never picks a GL backend by hand', () => {
    /* The launcher used to pass --use-gl=egl. That value was removed from
     * Chromium years ago, and an unrecognised backend silently drops the
     * browser to SwiftShader: software rendering, 22fps at 1080p on a Pi 4 —
     * exactly what the first cabinet measured. Let the OS package choose. */
    assert.notOk(/--use-gl=/.test(src), 'no --use-gl flag anywhere');
  });

  it('keeps the 2D canvas raster on the GPU', () => {
    /* Measured on the cabinet: with a healthy ANGLE/V3D backend but no
     * canvas OOP raster, 20 full-surface fills took 168ms — software, on
     * the main thread. The whole front end is one big 2D canvas, so that
     * was the entire 30fps lock. Both spellings pinned: the switch and
     * the feature flag it maps to on newer builds. */
    assert.ok(/--canvas-oop-rasterization/.test(src));
    assert.ok(/--enable-features=CanvasOopRasterization/.test(src));
    assert.ok(/--enable-accelerated-2d-canvas/.test(src),
      'legacy switch kept for older Chromium builds');
  });

  it('ships stock frame pacing, with the 30fps story documented in place', () => {
    /* Every uncap variant was tried on the real cabinet and made things
     * worse: counters read 50-57fps while the glass froze (a stall class
     * whose fixes postdate this Chromium). The stable configuration is
     * stock pacing — a locked, playable 30fps — with the one-line upgrade
     * path (WaylandExternalBeginFrameSource) documented beside the flags
     * for when the repaired scheduler ships. */
    /* Anchored to flag lines (leading whitespace) so the KNOWN ISSUE
     * comment, which names the flags to warn about them, does not match. */
    assert.notOk(/^\s+--disable-gpu-vsync/m.test(src), 'no vsync uncap');
    assert.notOk(/^\s+--disable-frame-rate-limit/m.test(src), 'no frame-rate uncap');
    assert.ok(/KNOWN ISSUE/.test(src) && /WaylandExternalBeginFrameSource/.test(src),
      'the investigation and the upgrade path are recorded where the flags live');
    /* Chromium honours only the LAST --enable-features switch; a second
     * list anywhere on the line silently discards the first. */
    const launches = src.match(/--enable-features=/g) || [];
    assert.equal(launches.length, 1, 'exactly one --enable-features list');
  });

  it('evicts the login prompt from its TTY', () => {
    /* getty@tty1 and the kiosk raced for tty1 on every boot. The display
     * wait handed getty a guaranteed win, and cage then wedged in PAM
     * session setup behind it — service "active", one task, a login
     * prompt on the cabinet. Conflicts= is how every kiosk settles this. */
    assert.ok(/Conflicts=getty@tty1\.service/.test(src));
    assert.ok(/After=getty@tty1\.service/.test(src),
      'ordered after it, so the eviction settles before cage takes the VT');
  });

  it('waits for a connected display before starting cage', () => {
    /* cage exits 0 when it finds no output; the first cabinet quick-exited
     * six times per boot racing the HDMI connector. The wait is bounded and
     * tolerant (=-) so a headless cabinet still starts. */
    const pre = src.match(/ExecStartPre=([^\n]*)/);
    assert.ok(pre, 'unit has a pre-start gate');
    assert.ok(/^-/.test(pre[1].trim()), 'a timeout must not fail the start');
    assert.ok(/timeout/.test(pre[1]), 'the wait is bounded');
    assert.ok(/\/sys\/class\/drm\/card\*-\*\/status/.test(pre[1]),
      'it watches connector status, not the card device');
    assert.ok(src.indexOf('ExecStartPre=') < src.indexOf('ExecStart=${APP_DIR}/kiosk.sh'),
      'the gate precedes the kiosk');
  });

  it('captures the browser\'s own words to a file', () => {
    /* cage swallows client stdio — a benchmark under cage printed nothing,
     * and months of journals held zero Chromium lines for the same reason.
     * The 30fps investigation needs Chromium's vsync and GL decisions. */
    assert.ok(/> "\$\{DATA_DIR\}\/chromium\.log" 2>&1/.test(read(SETUP)));
  });

  it('configures the cmdline even when plymouth is missing', () => {
    /* The edit used to live inside install_splash, which returns early
     * without plymouth — rotation would silently never apply. */
    const main = src.slice(src.indexOf('main() {'));
    assert.ok(/configure_cmdline/.test(main), 'main calls configure_cmdline directly');
  });

  it('never clobbers the pristine cmdline backup on a re-run', () => {
    const fn = src.slice(src.indexOf('configure_cmdline() {'));
    assert.ok(/\[\[ -f "\$\{cmdline\}\.arcadeos\.bak" \]\] \|\| cp -a/.test(fn));
  });
});

describe('OS support check', () => {
  /*
   * A real cabinet install died three quarters of the way through apt with
   * "E: Unable to locate package cage" — accurate, and useless: the machine
   * was on Bullseye, where cage, seatd and python3-lgpio simply do not exist,
   * and the only real fix was to reflash. The check that replaced that has to
   * be exactly as wide as the package availability, so it is exercised against
   * the os-release values of every release someone might actually be on.
   */
  const src = read(SETUP);

  /** Run just check_os against a fabricated /etc/os-release. */
  function checkOs(fields) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcadeos-os-'));
    const osRelease = path.join(dir, 'os-release');
    fs.writeFileSync(osRelease, Object.keys(fields)
      .map((k) => k + '=' + JSON.stringify(fields[k])).join('\n') + '\n');

    const fn = src.slice(src.indexOf('MIN_DEBIAN=12'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    const script = [
      'set -Eeuo pipefail',
      'warn(){ echo "WARN: $*"; }',
      'die(){ echo "$*" >&2; exit 1; }',
      body,
      'check_os && echo ACCEPTED',
    ].join('\n').split('/etc/os-release').join(osRelease);

    const file = path.join(dir, 'run.sh');
    fs.writeFileSync(file, script);
    try {
      return { ok: true, out: execFileSync('bash', [file], { encoding: 'utf8' }) };
    } catch (e) {
      return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  }

  it('is called before anything is installed', () => {
    const main = src.slice(src.indexOf('main() {'));
    const checkAt = main.indexOf('check_os');
    const installAt = main.indexOf('install_packages');
    assert.ok(checkAt > 0, 'main runs the OS check');
    assert.ok(checkAt < installAt, 'and runs it before touching apt');
  });

  it('refuses Bullseye, and says to reflash rather than naming a package', () => {
    const r = checkOs({
      ID: 'raspbian', VERSION_ID: '11', VERSION_CODENAME: 'bullseye',
      PRETTY_NAME: 'Raspbian GNU/Linux 11 (bullseye)',
    });
    assert.ok(!r.ok, 'Bullseye must be refused');
    assert.ok(/too old/.test(r.out));
    assert.ok(/Reflash/.test(r.out), 'tells you the actual fix');
    assert.ok(/bullseye/.test(r.out), 'names the release it found');
    assert.ok(/Nothing on this system has been changed/.test(r.out));
  });

  it('accepts every release that has the packages', () => {
    for (const v of [
      { ID: 'debian', VERSION_ID: '12', VERSION_CODENAME: 'bookworm', PRETTY_NAME: 'Debian 12' },
      { ID: 'debian', VERSION_ID: '13', VERSION_CODENAME: 'trixie', PRETTY_NAME: 'Debian 13' },
      { ID: 'debian', VERSION_ID: '14', VERSION_CODENAME: 'forky', PRETTY_NAME: 'Debian 14' },
    ]) {
      const r = checkOs(v);
      assert.ok(r.ok, v.PRETTY_NAME + ' must be accepted: ' + r.out);
      assert.ok(/ACCEPTED/.test(r.out));
    }
  });

  it('warns but proceeds on a non-Debian distro', () => {
    /* Refusing outright would be overreach — the packages may well be there. */
    const r = checkOs({
      ID: 'ubuntu', VERSION_ID: '24.04', VERSION_CODENAME: 'noble',
      PRETTY_NAME: 'Ubuntu 24.04 LTS',
    });
    assert.ok(r.ok, 'must not block');
    assert.ok(/WARN/.test(r.out));
    assert.ok(/ACCEPTED/.test(r.out));
  });

  it('proceeds on a testing image with no numeric VERSION_ID', () => {
    const r = checkOs({ ID: 'debian', VERSION_CODENAME: 'sid', PRETTY_NAME: 'Debian sid' });
    assert.ok(r.ok, 'an unnumbered release is newer, not older: ' + r.out);
  });
});

describe('arcadeos-agent', () => {
  const src = path.join(PI, 'arcadeos-agent.py');

  it('is valid Python', () => {
    assert.doesNotThrow(() => {
      execFileSync('python3', ['-m', 'py_compile', src], { stdio: 'pipe' });
    });
  });

  it('binds loopback only', () => {
    const s = read(src);
    assert.ok(/HOST = "127\.0\.0\.1"/.test(s), 'listens on 127.0.0.1');
    assert.notOk(/0\.0\.0\.0/.test(s), 'never binds all interfaces');
  });

  it('runs a fixed command table, never request data', () => {
    const s = read(src);
    /* The single most important property of this file: nothing derived from
     * the request is ever passed to a subprocess. */
    const subprocessCalls = [...s.matchAll(/subprocess\.Popen\(\s*\[([^\]]*)\]/g)];
    assert.ok(subprocessCalls.length > 0, 'it does spawn things');
    for (const call of subprocessCalls) {
      assert.notOk(/self\.|path|command\b/.test(call[1]),
        `subprocess argv is not built from request data: ${call[1]}`);
    }
    assert.notOk(/shell\s*=\s*True/.test(s), 'never uses a shell');
  });

  it('exposes exactly the three documented commands', () => {
    const s = read(src);
    assert.ok(/"shutdown":/.test(s));
    assert.ok(/"restart":/.test(s));
    assert.ok(/command == "pair"/.test(s));
  });

  it('sends CORS headers, because the page is a file:// origin', () => {
    assert.ok(/Access-Control-Allow-Origin/.test(read(src)));
  });
});

describe('arcadeos-gpio', () => {
  const src = path.join(PI, 'arcadeos-gpio.py');

  it('is valid Python', () => {
    assert.doesNotThrow(() => {
      execFileSync('python3', ['-m', 'py_compile', src], { stdio: 'pipe' });
    });
  });

  it('requires a hold rather than firing on a knock', () => {
    const s = read(src);
    assert.ok(/ARCADEOS_GPIO_HOLD/.test(s), 'hold time is configurable');
    assert.ok(/hold_time=HOLD/.test(s), 'and is actually applied');
  });

  it('validates its action rather than running whatever it is given', () => {
    const s = read(src);
    assert.ok(/ACTION not in \("poweroff", "reboot"\)/.test(s));
  });

  it('has a fallback for images without gpiozero', () => {
    const s = read(src);
    assert.ok(/def run_gpiod/.test(s), 'libgpiod fallback exists');
  });
});

describe('boot splash', () => {
  const gen = path.join(PI, 'make-splash.py');

  it('is valid Python', () => {
    assert.doesNotThrow(() => {
      execFileSync('python3', ['-m', 'py_compile', gen], { stdio: 'pipe' });
    });
  });

  it('uses only the standard library', () => {
    const s = read(gen);
    const imports = [...s.matchAll(/^\s*(?:import|from)\s+([a-z_0-9.]+)/gm)]
      .map((m) => m[1].split('.')[0]);
    const stdlib = ['struct', 'sys', 'zlib', 'os', 'math'];
    for (const mod of imports) {
      assert.ok(stdlib.includes(mod),
        `${mod} is standard library — a Pi Lite install has no Pillow`);
    }
  });

  it('emits a valid PNG with the aurora wordmark', () => {
    const out = path.join(os.tmpdir(), 'arcadeos-splash-test.png');
    execFileSync('python3', [gen, out, '--width', '900'], { stdio: 'pipe' });
    const buf = fs.readFileSync(out);

    assert.deep([...buf.slice(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
      'PNG magic bytes');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.ok(width > 400 && width < 2000, `plausible width ${width}`);
    assert.ok(height > 80 && height < 600, `plausible height ${height}`);
    assert.equal(buf.readUInt8(24), 8, 'eight bits per channel');
    assert.equal(buf.readUInt8(25), 2, 'truecolour RGB');
    assert.ok(buf.includes(Buffer.from('IEND')), 'is terminated');
    fs.unlinkSync(out);
  });

  it('produces identical output for identical input', () => {
    const a = path.join(os.tmpdir(), 'splash-a.png');
    const b = path.join(os.tmpdir(), 'splash-b.png');
    execFileSync('python3', [gen, a, '--width', '900'], { stdio: 'pipe' });
    execFileSync('python3', [gen, b, '--width', '900'], { stdio: 'pipe' });
    assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)), 'deterministic');
    fs.unlinkSync(a); fs.unlinkSync(b);
  });

  it('ships a Plymouth theme that points at the generated logo', () => {
    const theme = read(path.join(PI, 'plymouth', 'arcadeos.plymouth'));
    const script = read(path.join(PI, 'plymouth', 'arcadeos.script'));
    assert.ok(/ModuleName=script/.test(theme));
    assert.ok(/arcadeos\.script/.test(theme));
    assert.ok(/arcadeos-logo\.png/.test(script), 'the script loads the wordmark');
  });
});

describe('shipped bundle', () => {
  it('dist/arcade.html is present and current', () => {
    /* The Pi installs the committed bundle so it never needs Node. If this
     * drifts from src/, a cabinet gets a stale build. */
    const { bundle } = require('../build.js');
    const built = bundle().html;
    const shipped = read(path.join(ROOT, 'dist', 'arcade.html'));
    assert.equal(shipped, built,
      'dist/arcade.html is out of date — run `npm run build` and commit it');
  });

  it('is a single file with no external assets', () => {
    const shipped = read(path.join(ROOT, 'dist', 'arcade.html'));
    assert.notOk(/<script[^>]+src=/.test(shipped), 'no external scripts');
    assert.notOk(/<link[^>]+href=/.test(shipped), 'no external stylesheets');
    assert.notOk(/<img[^>]+src=/.test(shipped), 'no external images');
  });
});
