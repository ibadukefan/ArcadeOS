# ArcadeOS

A boot-to-arcade console front end for a Raspberry Pi 4 driving a monitor
mounted in portrait orientation. Power on the Pi and a few seconds later you
are at a game dashboard, fully controllable with a gamepad. No desktop, no
cursor, no keyboard.

Nine games, all natively vertical. Fully offline — the cabinet never needs a
network again after setup. The whole front end is one self-contained HTML
file with no dependencies of any kind.

```
black screen  →  ARCADE wordmark  →  dashboard
```

---

## Contents

- [Quick start](#quick-start)
- [Full Pi install](#full-pi-install)
- [Controls](#controls)
- [The games](#the-games)
- [Settings](#settings)
- [Updating and adding games](#updating-and-adding-games)
- [Adding a game](#adding-a-game)
- [Wiring arcade buttons to a USB encoder](#wiring-arcade-buttons-to-a-usb-encoder)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [How it works](#how-it-works)

---

## Quick start

You do not need a Pi to try it.

```bash
git clone <this repo>
cd ArcadeOS
npm run build          # writes dist/arcade.html
```

Then double-click `dist/arcade.html`. It opens in any modern browser, works
offline, and plays on the keyboard (arrows, Enter, Escape). Plug in a gamepad
and it will be picked up immediately.

There is nothing to install. `npm run build` is plain Node with zero
dependencies, and `dist/arcade.html` is committed to the repository, so you
can skip the build entirely if you just want to look.

---

## Full Pi install

### What you need

| | |
|---|---|
| Board | Raspberry Pi 4 Model B (2GB is enough) |
| OS | Raspberry Pi OS **Lite**, **64-bit**, **Bookworm or newer** — see below |
| Display | A 1080p monitor rotated 90° — the cabinet runs at 1080×1920 |
| Input | Any Xbox / PlayStation / Nintendo pad over USB or Bluetooth, or a USB arcade encoder |
| Storage | 4GB card or larger |

Use Raspberry Pi Imager to write **Raspberry Pi OS Lite (64-bit)**. In the
imager's settings, set a username and enable SSH — you will want it, because
once ArcadeOS is running there is no console on the screen.

**Bullseye will not work, and neither will a 32-bit image.** The kiosk runs on
`cage` and `seatd`, which are not packaged before Debian 12, and there is no
32-bit build of the stack worth having. The installer checks both before it
touches anything and tells you to reflash rather than failing halfway through
`apt`. To check an existing card:

```bash
. /etc/os-release && echo "$PRETTY_NAME"   # want bookworm or newer
uname -m                                   # want aarch64
```

### Install

SSH in, then:

```bash
sudo apt-get install -y git
git clone <this repo>
cd ArcadeOS
sudo ./setup-arcade.sh
sudo reboot
```

That is the whole install. It takes about ten minutes on a fresh card, mostly
`apt`. On reboot the Pi goes straight to the dashboard.

The script is safe to re-run — it is idempotent, and re-running is how you
update the cabinet after pulling changes.

### What it changes

| Path | Purpose |
|---|---|
| `/opt/arcadeos/` | `arcade.html`, the kiosk launcher, the helper scripts |
| `/etc/arcadeos/agent.token` | Shared secret between the page and the control agent (root only, 0600) |
| `/var/lib/arcadeos/chromium` | Chromium profile — this is where high scores live |
| `/etc/systemd/system/arcadeos.service` | The kiosk: `cage` + Chromium |
| `/etc/systemd/system/arcadeos-agent.service` | Loopback control agent (shutdown / restart / pairing) |
| `/etc/systemd/system/arcadeos-gpio.service` | GPIO shutdown button watcher |
| `/usr/share/plymouth/themes/arcadeos/` | Boot splash |
| `config.txt`, `cmdline.txt`, `fstab` | Marker-fenced blocks only, backed up before editing |

### Options

```bash
sudo ./setup-arcade.sh --help
```

| Flag | Effect |
|---|---|
| `--uninstall` | Remove everything. Keeps high scores unless you add `--purge`. |
| `--rotate 0\|90\|180\|270` | Panel rotation. Default `90`. |
| `--gpio-pin N` | BCM pin for the shutdown button. Default `3`. |
| `--gpio-overlay` | Use the kernel's `gpio-shutdown` instead of the systemd service. |
| `--no-gpio` | Skip the shutdown button entirely. |
| `--readonly` | Enable the read-only overlay filesystem (see below). |
| `--writable` | Turn the overlay back off. |
| `--skip-apt` | Do not touch apt. Useful for quick re-runs. |

### Rotation

**Vertical mode is automatic and lives in the front end.** The monitor runs
at its native resolution (the compositor picks the panel's preferred mode —
1080p, 1440p and 4K all work), and if the surface arrives landscape the front
end rotates its whole output 90° so a portrait-mounted panel reads upright and
fills the screen. No reboot, no flags.

If your panel is turned the other way, flip it on the cabinet itself:
**SETTINGS → DISPLAY → ORIENTATION** cycles AUTO PORTRAIT → / AUTO PORTRAIT ←
/ NO ROTATION (the last letterboxes upright, for a monitor standing normally
on a desk). Applies instantly.

Why in the front end: the kernel is told the panel orientation
(`panel_orientation` on the boot command line, which rotates the console and
splash), but the cage compositor on Bookworm links a wlroots too old to honour
it — a cabinet boots with a vertical console and then reverts to horizontal
the moment the kiosk starts. Observed on hardware; rotating in the renderer
is the path that cannot be taken away.

### Shutting down properly

**Yanking the power lead is the main cause of SD card corruption.** There are
three ways to shut down cleanly, and the cabinet offers all of them:

1. **SETTINGS → SHUT DOWN** on the dashboard, reachable on the d-pad alone.
2. **The GPIO button.** Wire a momentary push button between BCM pin 3 and any
   ground pin — no resistor needed, the internal pull-up is enabled. Hold it
   for about a second. The hold is deliberate: a knocked cabinet button should
   not end someone's game.
3. `sudo poweroff` over SSH.

### Read-only filesystem (optional)

For a cabinet that lives in a hallway and gets switched off at the wall, you
can make the root filesystem read-only so the card cannot be corrupted at all.

High scores then need somewhere writable to live. ArcadeOS keeps them on a
partition labelled `ARCADEDATA`, mounted at `/var/lib/arcadeos`.

**The setup script will not repartition your card.** Make the partition
yourself, with the card in another machine:

```bash
# Create a partition of 128MB or more in free space, then:
sudo mkfs.ext4 -L ARCADEDATA /dev/sdXN
```

Put the card back and run:

```bash
sudo ./setup-arcade.sh --readonly
sudo reboot
```

Afterwards, remember that system changes will not persist. Run
`sudo ./setup-arcade.sh --writable && sudo reboot` before updating anything.

---

## Controls

Every function is reachable with a **d-pad and two buttons**. Nothing —
including settings and shutdown — needs a keyboard.

### Menus

| Action | Gamepad | Keyboard |
|---|---|---|
| Move | D-pad or left stick | Arrows / WASD |
| Select | A / ✕ | Enter, Space, Z, Ctrl |
| Back | B / ○ | Escape, Backspace, X, Alt |
| Pause | Start | P, Tab, 1 |
| Join as player 2 | Start on a second pad | — |


**Hold START for one second to return to the dashboard from anywhere** — mid-game,
in a menu, on the pause screen, anywhere. A progress ring appears while you hold.
A quick tap of START keeps its usual meaning (pause in a game).

### The face-button swap

Xbox and PlayStation confirm with the **bottom** face button. Nintendo pads
confirm with the **right** one, because their A and B are physically mirrored.
ArcadeOS detects this from the controller and swaps automatically, and the
on-screen prompts always show the button that is physically in front of you —
`A`/`B` for Xbox and Nintendo, `✕`/`○` for PlayStation.

If you have an unrecognised pad and the buttons feel backwards, set
**SETTINGS → CONTROLLER** to the layout that matches your hardware.

Controllers can be plugged and unplugged at any time. The on-screen prompts
update immediately.

### Learning a game's controls

You should never have to guess. Each game's controls appear in three places,
always showing the buttons on the controller actually in your hands — a
DualSense reads `✕`, a Switch Pro reads `A`, a keyboard reads `ENTER`:

- under the game's name on the dashboard, when it is selected
- as a banner for the first few seconds of a run, which then fades
- in the pause menu, which is where a stuck player looks

---

## The games

| Game | Accent | What it is |
|---|---|---|
| **TETRIS** | violet | 10×20 well, 7-bag randomiser, ghost piece, hold, lock delay |
| **ASCENT** | teal | Vertical shoot-'em-up. Waves descend, you climb |
| **STACK** | pink | Time the drop, build the tower, keep what overlaps |
| **SNAKE** | green | A tall 19×30 field, so vertical runs are long and corners are tight |
| **BREAKOUT** | amber | A deliberately tall well — angle choice matters more than reflexes |
| **CLIMB** | blue | Endless hopper. The camera only ever goes up |
| **PULSE** | cyan | Rhythm highway. Four lanes are the four d-pad directions |
| **DROP** | red | Columns-style match-3, including diagonals, with cascades |
| **VERSUS** | purple | Head-to-head Tetris with garbage lines. Needs two pads |

### Per-game controls

Every game is playable with the d-pad plus **A**. Extra buttons are
conveniences, never requirements.

| Game | Controls |
|---|---|
| TETRIS | ◀▶ move · ▼ soft drop · ▲ rotate · **A** hard drop · **X** hold |
| ASCENT | D-pad fly · **A** fire (hold for auto) |
| STACK | **A** drop. That is the entire game |
| SNAKE | D-pad turn |
| BREAKOUT | ◀▶ paddle · **A** launch |
| CLIMB | ◀▶ steer. Bouncing is automatic |
| PULSE | ◀▼▲▶ hit the four lanes |
| DROP | ◀▶ move · ▼ soft drop · **A** cycle gems · **X** hard drop |
| VERSUS | As Tetris, per player |

### High scores

Beat a top-five score and you get the classic three-letter initials entry,
driven entirely by the d-pad: up/down changes the letter, left/right changes
the slot, **A** confirms. Tables are per game and viewable from **HIGH
SCORES** on the dashboard.

Scores and settings survive reboots. They live in Chromium's local storage
under `/var/lib/arcadeos/chromium`.

### Attract mode

Leave the dashboard alone for sixty seconds and the cabinet starts cycling
**self-playing demos** behind the wordmark, with the top scores for whatever is
on screen. Any input at all returns instantly.

The demos really play — the snake hunts food while avoiding trapping itself,
the paddle tracks the ball, the rhythm game hits its notes. Each game supplies
its own small pilot, because only the game knows where its ball is. They are
deliberately imperfect: a demo that never loses looks canned.

Demo input is excluded from the idle timer, so the cabinet cannot wake itself
up by playing.

---

## Settings

Settings is grouped into sections — AUDIO & FEEDBACK, DISPLAY, CONTROLS,
SYSTEM — and every row works with the d-pad alone. Beyond the basics it has
CONTROLLER RUMBLE (haptics have their own switch, separate from REDUCED
MOTION), SOFTWARE UPDATE, ABOUT THIS CABINET (version, build id, storage and
agent health), RESET ALL SETTINGS, and the crash log under DIAGNOSTICS.

Reachable from the dashboard with the d-pad.

| Setting | |
|---|---|
| **VOLUME** | Left/right in 5% steps |
| **MUTE** | |
| **CONTROLLER** | `AUTO`, or force Xbox / PlayStation / Nintendo button layout |
| **CRT VEIL** | The subtle scanline overlay |
| **REDUCED MOTION** | Stills the drifting aurora and disables rumble |
| **FRAME TIMER** | On-screen diagnostics: fps, mean/worst frame time, controller sample rate, audio latency, taps saved, full-screen ops |
| **LOW LATENCY VIDEO** | Desynchronized canvas. On by default; turn off only if your panel tears |
| **DIAGNOSTICS** | Storage, schema version, video mode, controllers, and any recorded faults |
| **PAIR BLUETOOTH PAD** | Opens a two-minute pairing window |
| **RESET HIGH SCORES** | Asks first |
| **RESTART** / **SHUT DOWN** | Ask first, then do it properly |

### Pairing a Bluetooth controller

1. **SETTINGS → PAIR BLUETOOTH PAD**
2. Put the controller into pairing mode:
   - **Xbox** — hold the small sync button on the top edge until the logo flashes fast
   - **PlayStation** — hold **Share** and **PS** together until the light bar flashes
   - **Switch Pro** — hold the sync button next to the USB-C port
3. Wait. The cabinet shows `CONTROLLER … READY` when it connects.

The pairing window stays open for two minutes. It will reconnect automatically
on every subsequent boot.

---

## Updating and adding games

The cabinet updates itself. **SETTINGS → SOFTWARE UPDATE → CHECK FOR UPDATES**
pulls the newest ArcadeOS from the same git branch the cabinet was installed
from, reinstalls it, and restarts the display — all from the couch, no
keyboard, no SSH. New games ship inside the same bundle, so installing an
update installs every new game at once.

How it works: the front end asks the control agent (`POST /update`, token
required); the agent launches `/opt/arcadeos/arcadeos-update.sh` as a detached
systemd unit; the script fetches the branch recorded in
`/etc/arcadeos/update.conf`, sanity-checks the new bundle, keeps the running
page as `arcade.html.prev`, re-runs the installer (`--skip-apt`), and restarts
the kiosk. Any failure restores the previous page and reports the reason on
the update screen. Progress is written to
`/var/lib/arcadeos/update-status.json`, which you can also watch over SSH:

```bash
curl -s http://127.0.0.1:8127/update/status
journalctl -u arcadeos-update -n 50 --no-pager
```

Requirements: the cabinet needs network access at the moment you press the
button (gameplay stays fully offline), and the checkout it was installed from
must be able to `git fetch` — for a **private** repository that means stored
credentials readable by root, an SSH deploy key, or making the repository
public. If none of that is set up, the screen says the update server is
unreachable and nothing is touched.

A cabinet installed from a tarball rather than a git clone has no update
source; the SOFTWARE UPDATE screen will say so. Reinstall once from a clone
to enable it.

## Adding a game

A game is one file in `src/games/` exporting an object with a fixed shape.
There is no framework, no registration boilerplate beyond one call, and no
build configuration beyond adding the filename to a list.

### 1. Write the module

```js
// src/games/mygame.js
var MYGAME = (function () {
  var score = 0;
  var x = GW / 2;

  function start() {            // reset ALL state; called on every new game
    score = 0;
    x = GW / 2;
  }

  function update(dt) {         // dt in milliseconds — never assume 16.67
    if (Input.down('left'))  x -= 0.3 * dt;
    if (Input.down('right')) x += 0.3 * dt;
    x = clamp(x, 0, GW);
    if (Input.hit('confirm')) score += 10;
    // when it's over:  Shell.gameOver(score);
  }

  function draw() {             // draw into gx, a 600x1000 portrait space
    gBackdrop(ACCENT.snake);
    gHud(ACCENT.snake, [{ label: 'SCORE', value: fmtScore(score) }]);
    tile(gx, x, 500, 40, '#46CE7A', '#8AE4AB', 'glow');
  }

  function preview(c, w, h, t) { // animated loop for the dashboard card
    tile(c, w / 2 + Math.sin(t * 0.003) * w * 0.3, h / 2, h * 0.2,
         '#46CE7A', '#8AE4AB', 'solid');
  }

  return registerGame({
    id: 'mygame',
    title: 'MY GAME',
    tag: 'One line, shown on the card',
    accent: '#46CE7A',
    start: start, update: update, draw: draw, preview: preview,
  });
})();
```

### 2. Add it to the build

```js
// build.js
const GAMES = [
  'games/tetris.js',
  ...
  'games/mygame.js',
];
```

### 3. Build and test

```bash
npm run build && npm test
```

The test suite discovers games from the registry, so yours automatically gets
the contract check, the boot → play → pause → quit walk, and 1500 randomised
input frames at varying frame rates. You do not need to write a test to get
that coverage — but do write one for any interesting rule of your own.

### House rules

- **The 600×1000 space is logical.** Never read real pixel sizes. The shell
  scales and letterboxes for you.
- **`dt` is milliseconds and it varies.** Never count frames. If you need
  auto-repeat, use `makeRepeater(delay, rate)`.
- **Use the palette.** `COL`, `ACCENT` and `PIECE_COL` in `src/core/util.js`
  are the whole design system. Do not invent a colour.
- **Use `tile()` and `slab()`.** They are what make nine games look like one
  machine.
- **Do not allocate in `update`/`draw`.** Use `makePool()` and
  `makeParticles()`. GC pauses are visible as dropped frames on a Pi.
- **No `shadowBlur`.** Use `Render.glow()`, which blits a cached sprite. There
  is a test that fails the build if `shadowBlur` reappears.
- **Playable on a d-pad and one button.** Extra buttons are conveniences.

### What is available to a game

| | |
|---|---|
| `GW`, `GH` | 600, 1000 — the logical game space |
| `gx` | The 2D context to draw into |
| `Input.down(a)` / `Input.hit(a)` / `Input.rep(a)` | Actions: `up down left right confirm back alt pause` |
| `Input.p(n)` | Per-player input, for two-player modes |
| `Input.rumble(strong, weak, ms)` | Ignored when reduced motion is on |
| `Shell.gameOver(score)` | Ends the run. Never call from `draw()` |
| `gBackdrop(accent)`, `gHud(accent, fields)` | Shared game chrome |
| `tile(ctx,x,y,size,base,top,mode)` | `solid` \| `ghost` \| `glow` \| `flash` |
| `slab(ctx,x,y,w,h,base,top,mode)` | The non-square version |
| `panel`, `text`, `dataText`, `roundRect` | Shared drawing |
| `Render.glow(ctx,x,y,size,color,alpha)` | Cached glow sprite |
| `Audio2.sfx(name)`, `Audio2.tone()`, `Audio2.noise()` | Synthesised, no samples |
| `makePool`, `makeParticles`, `makeRepeater` | |
| `rnd()`, `rndInt(a,b)`, `rndRange(a,b)`, `pick(arr)` | Seedable, so tests reproduce |
| `clamp`, `lerp`, `approach`, `num`, `fmtScore`, `pad`, `rgba`, `shade` | |

---

## Wiring arcade buttons to a USB encoder

A "zero delay" USB encoder turns real arcade buttons and a joystick into
something the Pi treats as a controller. They cost a few pounds and are the
single biggest upgrade to how a cabinet feels.

### Which mode

These encoders enumerate in one of two ways, sometimes switchable:

- **As a gamepad** — ArcadeOS treats it like any other pad. Preferred.
- **As a keyboard**, emitting arrow keys plus a scattering of letters.
  ArcadeOS accepts the common encoder mappings, so this works too.

You do not need to configure anything either way. If the buttons feel wrong in
gamepad mode, set **SETTINGS → CONTROLLER** to `XBOX`.

### Wiring

Every arcade button and every joystick microswitch has two terminals and no
polarity — you cannot wire one backwards.

```
            ┌─────────────────────────┐
            │      USB ENCODER        │
            │  UP DN LT RT  1 2 3 4   │
            └───┬──┬──┬──┬───┬─┬─┬─┬──┘
                │  │  │  │   │ │ │ │
   joystick ────┴──┴──┴──┘   │ │ │ │
   microswitches             │ │ │ │
                             │ │ │ │
   buttons ──────────────────┴─┴─┴─┘

   every switch also connects to the shared GROUND chain
```

1. Connect each joystick microswitch to `UP`, `DOWN`, `LEFT`, `RIGHT`.
2. Connect each button to a numbered input.
3. Daisy-chain the second terminal of **every** switch and button along the
   ground wire — encoders ship with a pre-made ground harness for this.
4. Plug the encoder into the Pi.

### Which buttons matter

ArcadeOS needs three inputs plus the stick:

| Encoder input | Becomes | Used for |
|---|---|---|
| Button 1 | `confirm` | Select, fire, hard drop |
| Button 2 | `back` | Cancel, back |
| Button 3 | `alt` | Hold, secondary |
| Start | `pause` | Pause, and player 2 joining |

Wire a Start button. It is how player 2 joins, and how anyone pauses.

### Two-player cabinets

Use **two encoders**. Each enumerates separately, and ArcadeOS assigns them to
player slots on its own. Player 1 is whichever appears first; the second joins
by pressing its Start button.

### A shutdown button

Wire one more momentary button between **BCM pin 3** and **any ground pin**,
directly on the Pi's GPIO header — not through the encoder. Hold it for a
second to power down cleanly. Change the pin with
`sudo ./setup-arcade.sh --gpio-pin N`.

---

## Development

```bash
npm run build      # -> dist/arcade.html
npm run build:min  # minified
npm test           # headless suite, no browser needed
npm run check      # build then test
```

### Layout

```
src/
  index.html          shell markup (one canvas)
  styles.css
  core/
    util.js           design tokens, seeded RNG, pools, repeaters
    storage.js        guarded persistence, settings, high scores
    audio.js          WebAudio synthesis
    input.js          gamepad + keyboard -> semantic actions
    render.js         logical-space canvas, tile/slab/glow/text primitives
    system.js         loopback client for shutdown/restart/pairing
    shell.js          the state machine
    boot.js           entry point and the single rAF loop
  games/              one file per game
build.js              concatenates -> dist/arcade.html
pi/                   agent, GPIO watcher, splash generator, Plymouth theme
test/                 harness + suites
setup-arcade.sh
```

### Testing

There is no browser in CI, so everything runs headlessly. The harness mocks
`document`, `window`, `navigator.getGamepads` and the canvas 2D context, then
drives the real frame loop directly with explicit `dt` values.

**The mock context asserts on every draw call.** It rejects colour strings
containing `NaN` or `undefined`, non-finite coordinates, `globalAlpha` outside
0–1, negative radii and unbalanced `save`/`restore`. This is not decoration —
it exists because of two real bugs:

- An `rgb()` string was fed back into a hex parser, producing `NaN` colour
  stops that threw inside `addColorStop`.
- A menu auto-repeat driven by frame counters scrolled at different speeds on
  60Hz and 144Hz panels.

Both classes are now caught the moment they are drawn.

Current coverage: 234 tests. Boot → dashboard → each game → pause → quit for
all nine games; 1500+ randomised frames per game with varied `dt`; controller
detection for Xbox, PlayStation, Nintendo and unknown pads; storage fresh,
populated, corrupt and unavailable; per-frame draw and full-screen-op budgets;
sub-frame input latching; and the Pi assets.

Failures reproduce: every random source is seeded.

### Debugging on the cabinet

The bundle publishes a handle for the Chromium console:

```js
ArcadeOS.Shell.state()
ArcadeOS.Scores.table('tetris')
ArcadeOS.Settings.all()
ArcadeOS.Input.players()
```

---

## Troubleshooting

**Can't reach a terminal — the kiosk owns the screen and SSH is refused**

The installer enables sshd, so on any cabinet installed (or updated) after
v1.1 this should not happen: `ssh <user>@raspberrypi.local` is always open.
On an older install where SSH was never enabled, recover with the SD card:
shut the cabinet down cleanly (SETTINGS → SYSTEM → SHUT DOWN), put the card
in any computer, and create an empty file named exactly `ssh` in the boot
partition (the FAT one, visible on Windows/Mac). On the next boot sshd starts
permanently. Ctrl+Alt+F2 on an attached keyboard also switches to a login
console on most keyboards; compact keyboards may need Fn held as well.

**`E: Unable to locate package cage` during install**

The card is running Bullseye or older. `cage`, `seatd` and `python3-lgpio` do
not exist before Debian 12, so there is nothing to install and no way to patch
around it — reflash with Raspberry Pi OS Lite (64-bit). Current installers stop
before this point with a clearer message.

**Black screen after boot**

```bash
systemctl status arcadeos
journalctl -u arcadeos -n 100 --no-pager
```

Usually the user is not in the `video`/`input` groups, or `seatd` is not
running. Re-running `sudo ./setup-arcade.sh` fixes both.

**Display is sideways, or letterboxed with black bars**

```bash
sudo ./setup-arcade.sh --rotate 270 && sudo reboot
```

The bars mean the panel is not 9:16; the front end letterboxes rather than
distorting. That is intentional.

**Controller does nothing**

Check it enumerates at all: `ls /dev/input/js*`. Bluetooth pads must be paired
first — use **SETTINGS → PAIR BLUETOOTH PAD**. If the pad works but the
buttons are swapped, set **SETTINGS → CONTROLLER** to match your hardware.

**Buttons are backwards on a Switch Pro pad**

That is what the automatic swap exists to prevent, so it means the pad was not
recognised. Set **SETTINGS → CONTROLLER → NINTENDO** and file the controller's
`id` string as an issue — `ArcadeOS.Input.players()` in the console shows it.

**No sound**

Check volume and mute in settings first. Then check the Pi is outputting to
the right device: `sudo raspi-config` → System → Audio. HDMI monitors with no
speakers are the usual answer.

**High scores are not saving**

Settings shows `STORAGE UNAVAILABLE` at the bottom when this happens. It means
Chromium could not write its profile — usually a full or read-only card:

```bash
df -h /var/lib/arcadeos
ls -la /var/lib/arcadeos/chromium
```

On a read-only install, check the data partition is mounted:
`mountpoint /var/lib/arcadeos`.

**Shutdown from the menu does nothing**

The agent is not running:

```bash
systemctl status arcadeos-agent
curl http://127.0.0.1:8127/       # should answer {"ok": true, ...}
```

If the status endpoint answers but SETTINGS still reports a failure, the page
and the agent disagree about the shared token — usually because the bundle was
copied into `/opt/arcadeos/` by hand instead of installed:

```bash
journalctl -u arcadeos-agent | grep refused    # says which check failed
head -c 60 /opt/arcadeos/arcade.html           # should start with the token script
sudo ./setup-arcade.sh                         # re-binds the page to the token
```

Deleting `/etc/arcadeos/agent.token` and re-running the installer mints a new
one; restart `arcadeos-agent` afterwards so it picks the new value up.

**GPIO button does nothing**

```bash
journalctl -u arcadeos-gpio -n 50 --no-pager
```

Confirm the button is between the configured BCM pin and **ground**, and that
you are holding it for a full second. Or switch to the kernel implementation,
which is more robust: `sudo ./setup-arcade.sh --gpio-overlay && sudo reboot`.

**The picture tears**

Turn off **SETTINGS → LOW LATENCY VIDEO**. The desynchronized canvas skips a
compositor hop, which is the single biggest latency win available, but a few
driver and panel combinations will tear without that synchronisation. The
setting takes effect immediately.

**Controller feels laggy or drops inputs**

Turn on **SETTINGS → FRAME TIMER** and read the input lines. `sample` should be
around 250/s. If `pad` is much lower, USB polling is the limit — confirm
`usbhid.jspoll=1` is in `cmdline.txt`, and prefer a wired pad or encoder over
Bluetooth, which adds its own 10ms or so and cannot be tuned away.

If inputs are dropped rather than late, check that `taps saved` is incrementing
when you tap quickly. If it never moves and presses still go missing, the
device is not reporting them at all — try another USB port, and avoid unpowered
hubs.

**Frame rate feels low**

Turn on **SETTINGS → FRAME TIMER**. If the mean is above 16.7ms, try disabling
**CRT VEIL** and enabling **REDUCED MOTION**, which are the two most expensive
optional effects. Check nothing else is competing: `top`.

**Something crashed and I want to know what**

**SETTINGS → DIAGNOSTICS.** Faults are recorded with the game and function that
threw, repeats collapse into a count, and they survive a reboot. The same lines
are relayed to the local agent, so they also appear in the journal:

```bash
journalctl -u arcadeos-agent | grep frontend
```

**The screen froze and nothing recovers it**

It should recover itself within about thirty seconds. The front end sends a
heartbeat to the agent at the end of every frame, so the beats stop the instant
frames do; the agent then restarts the kiosk. Check whether that happened:

```bash
curl http://127.0.0.1:8127/       # shows frontend state and restart count
journalctl -u arcadeos-agent | grep -E "watchdog|no frames"
```

A wedged *kernel* is a different failure, and is covered by the Pi's hardware
watchdog — systemd stops petting it and the board resets after 20 seconds.

**I upgraded and my high scores vanished**

They should not have. Scores are stored under a versioned key and migrated
forward on read; **SETTINGS → DIAGNOSTICS** shows the schema version and how
many records were migrated this session. If the count is zero and the scores
are gone, the old keys are still on disk — nothing is ever deleted by a
migration — so please file the contents of:

```bash
grep -o 'arcadeos:[^"]*' /var/lib/arcadeos/chromium/Local\ Storage/leveldb/* 2>/dev/null | sort -u
```

**I need a console back**

```bash
sudo systemctl stop arcadeos
```

or over SSH at any time. To remove ArcadeOS entirely:

```bash
sudo ./setup-arcade.sh --uninstall && sudo reboot
```

---

## Responsiveness

The cabinet is built so that a press reaches the screen as fast as the
hardware allows, and — more importantly — so that **no press is ever lost**.

### Nothing is dropped

`requestAnimationFrame` fires about 60 times a second. A button that goes down
and back up between two callbacks is invisible to it, and an arcade microswitch
contact can be well under 16ms. Measured on the original build, **every single
sub-frame tap was dropped: 0 out of 20**, on both gamepad and keyboard.

Two things fix that:

- **Controllers are sampled at 250Hz**, on a timer independent of the display,
  and every press is *latched* until a frame consumes it. A tap that is already
  over by the time the frame runs still registers.
- **Keyboard presses are latched in the event handler itself**, which is exact
  and already timestamped by the browser. An arcade encoder in keyboard mode
  needs no sampling at all.

A held button still produces exactly one `hit`, and two taps inside one frame
move a menu twice — because that is what the player did.

The **taps saved** counter in the diagnostics overlay counts presses that had
already been released by the time the frame ran. A rising number there is the
latching working, not a fault.

### Nothing arrives late

| | |
|---|---|
| **Two full-screen operations per frame** | The backdrop is one opaque blit and the scanlines and vignette are baked into one 1:1 blit. It used to be five, which was ~10.4M pixel touches at 1080×1920 before a game drew anything. |
| **Low-latency canvas** | `desynchronized` asks Chromium to skip a compositor hop. |
| **`latencyHint: 'interactive'`** | The default WebAudio buffer can put 40–80ms between a press and its sound, which reads as input lag even when the frame was on time. |
| **`usbhid.*poll=1`** | Asks every USB input device for a report every 1ms instead of its default, which for cheap encoders is often 10ms. This is the largest single source of controller latency on a Pi and is invisible from inside the browser. |
| **`max_framebuffers=2`** | One less frame queued between Chromium and the panel. |
| **GPU rasterization** | The VideoCore VI is on Chromium's blocklist by default, which silently drops you to software raster. `--ignore-gpu-blocklist` turns it back on. |

### Measuring it yourself

Turn on **SETTINGS → FRAME TIMER**. The overlay shows:

```
60.0 FPS
avg 16.7  max 16.7ms
sample 250/s
pad 250/s   audio 12ms   video low-lat
taps saved 3   fullscreen ops/f 2
```

- `sample` should be ~250/s. If it says `(rAF only)` the sampler did not start.
- `pad` is how often the browser actually hands over fresh controller data. If
  it is far below `sample`, the bottleneck is USB polling — check that
  `usbhid.jspoll=1` made it into `cmdline.txt`.
- `avg` above 16.7ms means frames are being missed; try turning off **CRT
  VEIL** and turning on **REDUCED MOTION**.

## How it works

**One canvas.** The entire front end — dashboard, cards, animated previews,
aurora, games — renders into a single `<canvas>`. A Pi 4 compositing a dozen
small canvases behind a CSS-blurred background cannot hold 60fps at 1080×1920;
one layer comfortably can. It also means there is no cursor and no DOM to
reflow.

**Two logical spaces.** Menus are laid out in 1080×1920, games in 600×1000.
Both are letterboxed onto whatever the real display is, so no code anywhere
deals with resolution or DPI.

**Glow is pre-rendered.** `shadowBlur` per tile in a hot draw loop is the
single most expensive thing you can do on a Pi. Glow comes from sprites
rasterised once and cached by colour and size. Static text is cached the same
way, which took the dashboard from 362 `fillText` calls per frame to 4.

**Time, never frames.** Every timer in the machine is milliseconds. Menu
auto-repeat is 360ms then 120ms; Tetris DAS is 170ms then 50ms; the rhythm
game accumulates song position from `dt` rather than reading the audio clock,
so it stays correct even when the audio context never starts.

**Input is sampled faster than it is drawn.** The frame loop consumes latched
presses rather than reading live button state, so the display rate sets how
often you *see* the result, never whether the press was *noticed*.

**Storage never breaks a game.** Every read and write goes through one wrapper
with a try/catch and an in-memory fallback. A corrupt record costs you one row,
not the leaderboard. Keys are versioned and migrated forward on read, and the
old key is never deleted — a bad upgrade should cost you scores at worst, never
a cabinet that will not boot.

**Two layers of hang detection.** `Restart=always` catches a crash but does
nothing for a hang, where Chromium is alive, the unit is "active", and the
picture is frozen. The front end heartbeats the agent from the frame loop, so
the beats stop when frames do and the agent restarts the kiosk. A wedged kernel
is caught underneath that by the Pi's hardware watchdog.

**Nothing leaves the machine.** No CDN, no fonts, no telemetry, no network
calls of any kind. The build fails if a URL appears in the output. The one
exception is the loopback agent on `127.0.0.1`, which exists so the settings
screen can power the cabinet down — it binds nowhere else, accepts a fixed set
of commands that take no parameters, and requires a shared secret. See
[Security](#security).

---

## Security

The cabinet has no accounts, no network services and nothing worth stealing.
The one thing worth protecting is the control agent, because it runs as root
and can power the machine off.

### Why loopback is not enough on its own

`arcadeos-agent` binds to `127.0.0.1` only. That keeps the network out. It does
**not** keep other software on the same machine out, and specifically it does
not keep web pages out:

- A cross-origin `POST` with no custom headers is a CORS *simple request*. The
  browser sends it and only withholds the *response* from the caller. Any page
  open in any browser on the cabinet could therefore have posted `/shutdown`.
- A DNS-rebinding page resolves its own hostname to `127.0.0.1` and then talks
  to the agent from what the browser considers its own origin.

Both were reproduced against a running agent before they were fixed, not
inferred from documentation.

### What the agent checks

Every request, cheapest check first:

| Check | Stops |
|---|---|
| `Host` must be a loopback name | DNS rebinding |
| `Origin` must be absent or `null` | Any real web page — the kiosk is `file://` |
| `X-ArcadeOS-Token` must match, compared in constant time | Other local software |

`GET /` — the read-only status endpoint — is exempt from the token so that
`curl http://127.0.0.1:8127/` over SSH stays the first useful debugging step.
It is still loopback-and-same-origin only.

Sending a custom header is *also* what forces the browser to preflight the
request, and a hostile page cannot forge a preflight the agent will accept.

### The token

`setup-arcade.sh` generates 128 bits from `/dev/urandom` on first install and
writes `/etc/arcadeos/agent.token` as `0600 root:root`. It then installs the
page as `/opt/arcadeos/arcade.html`, mode `0640 root:<kiosk user>`, with the
secret prepended as a one-line `<script>`. Re-running the installer reuses the
existing token — rotating it would leave a running agent and a loaded page
disagreeing.

The token never appears in `dist/arcade.html`. The build output stays a pure
single file with no secret in it; the secret only exists on a cabinet.

`sudo ./setup-arcade.sh --uninstall` removes it.

A hand-run `dist/arcade.html` has no token, and a hand-run agent with no token
file demands none — development still works, with the host and origin checks
still active.

### Untrusted input

Two places take input that is not ours:

- **Relayed log lines.** A fault message reaches `journalctl`. Control
  characters are replaced with spaces at *both* ends, because an ANSI escape
  in a log tail can paint a convincing fake root warning on an
  administrator's terminal. (This one was demonstrated, too.)
- **The stored records.** Everything read back from `localStorage` is a file
  the player can edit. Scores are bounded and floored, names are coerced to
  three letters, and the per-game table is a null-prototype object so that
  `constructor` is a missing entry rather than a function.

### What is deliberately not defended

Anything running as the kiosk user can read the token, and anyone with a
keyboard and physical access can already pull the power. The threat model is
"a web page or a stray process should not be able to switch the cabinet off",
not "resist a local attacker with a shell".

---

## Out of scope

Emulators and ROMs (Batocera already solves that), online leaderboards,
accounts, telemetry, and any runtime network dependency.

## Licence

MIT.
