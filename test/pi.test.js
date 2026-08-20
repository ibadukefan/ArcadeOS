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
