#!/usr/bin/env bash
#
# setup-arcade.sh — take a clean Raspberry Pi OS Lite (Bookworm, 64-bit)
# install to a booting ArcadeOS cabinet in one command.
#
#   sudo ./setup-arcade.sh                 install / update
#   sudo ./setup-arcade.sh --uninstall     put the machine back
#   sudo ./setup-arcade.sh --help          everything else
#
# Design rules for this script:
#
#  * Idempotent. Every run must be safe. Config files are written whole rather
#    than appended to, edits to shared files are fenced between markers and
#    rewritten in place, and services are re-enabled rather than assumed.
#  * Never destructive without an explicit flag. It will tell you how to make
#    a data partition; it will not repartition your card because you passed
#    --readonly.
#  * Loud about what it changed, so an install can be audited afterwards.

set -Eeuo pipefail

VERSION="1.0.0"
MARKER_BEGIN="# >>> arcadeos >>>"
MARKER_END="# <<< arcadeos <<<"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/arcadeos"
DATA_DIR="/var/lib/arcadeos"
THEME_DIR="/usr/share/plymouth/themes/arcadeos"
CONF_DIR="/etc/arcadeos"
TOKEN_FILE="/etc/arcadeos/agent.token"
DATA_LABEL="ARCADEDATA"

# Whose cabinet is this? Tried in order:
#   1. sudo's caller            — the normal hand-run install
#   2. explicit ARCADE_USER     — power users and tests
#   3. the last install's conf  — recorded below on every install
#   4. the owner of this checkout — the updater runs setup as plain root with
#                                   none of the above; whoever cloned the
#                                   source is the cabinet user. Without this,
#                                   an on-cabinet update on any box whose user
#                                   is not "pi" died at the id check — after
#                                   the version pointer had already moved.
#   5. pi                       — the traditional default
ARCADE_USER="${SUDO_USER:-${ARCADE_USER:-}}"
if [[ -z "$ARCADE_USER" && -r "$CONF_DIR/update.conf" ]]; then
  ARCADE_USER="$(sed -n 's/^ARCADE_USER=//p' "$CONF_DIR/update.conf" | head -1)"
fi
if [[ -z "$ARCADE_USER" ]]; then
  _owner="$(stat -c %U "$SRC_DIR" 2>/dev/null || true)"
  [[ -n "$_owner" && "$_owner" != "root" && "$_owner" != "UNKNOWN" ]] && ARCADE_USER="$_owner"
  unset _owner
fi
ARCADE_USER="${ARCADE_USER:-pi}"

# Flags
DO_UNINSTALL=0
DO_READONLY=0
DO_UNREADONLY=0
DO_GPIO=1
DO_GPIO_OVERLAY=0
GPIO_PIN="${ARCADEOS_GPIO_PIN:-3}"
SKIP_APT=0
ROTATE="${ARCADEOS_ROTATE:-90}"
ASSUME_YES=0

# ---------------------------------------------------------------- output ---

if [[ -t 1 ]]; then
  C_OK=$'\033[38;5;79m'; C_WARN=$'\033[38;5;215m'; C_ERR=$'\033[38;5;203m'
  C_DIM=$'\033[38;5;103m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_OFF=""
fi

step()  { printf '%s==>%s %s\n' "$C_OK" "$C_OFF" "$*"; }
info()  { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
warn()  { printf '%s !! %s%s\n' "$C_WARN" "$*" "$C_OFF" >&2; }
die()   { printf '%serror:%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

trap 'die "failed on line $LINENO. Nothing further was changed."' ERR

usage() {
  cat <<EOF
ArcadeOS setup ${VERSION}

  sudo ./setup-arcade.sh [options]

Options
  --uninstall           Remove ArcadeOS: services, kiosk, splash, app files.
                        Leaves high scores in ${DATA_DIR} unless --purge.
  --purge               With --uninstall, also delete saved scores/settings.
  --readonly            Enable the read-only overlay filesystem. Requires a
                        partition labelled ${DATA_LABEL} for scores; the
                        script tells you how to make one if it is missing.
  --writable            Turn the read-only overlay back off.
  --no-gpio             Do not install the GPIO shutdown-button service.
  --gpio-pin N          BCM pin for the shutdown button (default ${GPIO_PIN}).
  --gpio-overlay        Use the kernel's dtoverlay=gpio-shutdown instead of
                        the systemd service. More robust, less configurable.
  --rotate DEG          Display rotation: 0, 90, 180, 270 (default ${ROTATE}).
  --skip-apt            Do not touch apt. For re-runs and for testing.
  --yes                 Do not prompt for confirmation.
  --help                This.

Afterwards
  systemctl status arcadeos          the kiosk itself
  journalctl -u arcadeos -f          watch it run
  sudo ./setup-arcade.sh --uninstall undo everything
EOF
}

confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  local reply
  read -r -p "    $1 [y/N] " reply || true
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ----------------------------------------------------------------- parse ---

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) DO_UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --readonly) DO_READONLY=1 ;;
    --writable) DO_UNREADONLY=1 ;;
    --no-gpio) DO_GPIO=0 ;;
    --gpio-overlay) DO_GPIO_OVERLAY=1 ;;
    --gpio-pin) GPIO_PIN="${2:?--gpio-pin needs a number}"; shift ;;
    --rotate) ROTATE="${2:?--rotate needs degrees}"; shift ;;
    --skip-apt) SKIP_APT=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done
PURGE="${PURGE:-0}"

[[ "$ROTATE" =~ ^(0|90|180|270)$ ]] || die "--rotate must be 0, 90, 180 or 270"
[[ "$GPIO_PIN" =~ ^[0-9]+$ ]] || die "--gpio-pin must be a number"
# ARCADE_USER is interpolated straight into systemd units and chown arguments.
# It comes from the environment, so pin its shape before any of that happens.
#
# Deliberately as wide as useradd allows rather than as narrow as Debian's
# default NAME_REGEX: rejecting a username the system itself accepts would
# block the whole install, and the point of this check is to keep shell and
# systemd metacharacters out — whitespace, ; & | $ ` quotes / and %, none of
# which can appear below.
[[ "$ARCADE_USER" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*[$]?$ && ${#ARCADE_USER} -le 32 ]] \
  || die "ARCADE_USER '$ARCADE_USER' is not a valid username"
[[ $EUID -eq 0 ]] || die "run with sudo"

# ------------------------------------------------------------- utilities ---

# Rewrite a marker-fenced block in a file. Idempotent by construction: the old
# block is removed whole and the new one appended, so re-running never stacks
# duplicate entries the way `>>` does.
write_block() {
  local file="$1" content="$2"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
      $0 == b { skip = 1 }
      skip != 1 { print }
      $0 == e { skip = 0 }
    ' "$file" > "$tmp"
  fi
  {
    printf '%s\n' "$MARKER_BEGIN"
    printf '%s\n' "$content"
    printf '%s\n' "$MARKER_END"
  } >> "$tmp"
  install -m 0644 "$tmp" "$file"
  rm -f "$tmp"
}

remove_block() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local tmp
  tmp="$(mktemp)"
  awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
    $0 == b { skip = 1 }
    skip != 1 { print }
    $0 == e { skip = 0 }
  ' "$file" > "$tmp"
  install -m 0644 "$tmp" "$file"
  rm -f "$tmp"
}

boot_config() {
  # Bookworm moved the boot partition. Support both so this works on images
  # of either vintage.
  if [[ -f /boot/firmware/config.txt ]]; then echo /boot/firmware/config.txt
  elif [[ -f /boot/config.txt ]]; then echo /boot/config.txt
  else echo ""; fi
}

boot_cmdline() {
  if [[ -f /boot/firmware/cmdline.txt ]]; then echo /boot/firmware/cmdline.txt
  elif [[ -f /boot/cmdline.txt ]]; then echo /boot/cmdline.txt
  else echo ""; fi
}

svc_disable() {
  local unit="$1"
  systemctl disable --now "$unit" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${unit}"
}

# --------------------------------------------------------------- install ---

# The kiosk stack is cage + seatd, and the GPIO watcher wants python3-lgpio.
# None of those exist before Debian 12. On Bullseye the install used to die
# three quarters of the way through `apt install` with nothing but
# "E: Unable to locate package cage" — true, but it does not tell you that the
# real answer is to reflash. Say so here, before anything is touched.
MIN_DEBIAN=12

check_os() {
  [[ -r /etc/os-release ]] || { warn "no /etc/os-release; skipping the OS check"; return 0; }
  # shellcheck disable=SC1091
  local ID VERSION_ID VERSION_CODENAME PRETTY_NAME
  ID="$(. /etc/os-release && printf '%s' "${ID:-}")"
  VERSION_ID="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  VERSION_CODENAME="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
  PRETTY_NAME="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")"

  case "$ID" in
    debian|raspbian) ;;
    *) warn "this expects Raspberry Pi OS; found ${PRETTY_NAME}. Continuing anyway."
       return 0 ;;
  esac

  # Testing/unstable images carry no numeric VERSION_ID. Assume new enough.
  [[ "$VERSION_ID" =~ ^[0-9]+$ ]] || return 0

  if (( VERSION_ID < MIN_DEBIAN )); then
    die "$(cat <<MSG
${PRETTY_NAME} is too old.

    ArcadeOS needs Debian 12 (bookworm) or newer: the kiosk runs on cage and
    seatd, and neither is packaged for ${VERSION_CODENAME:-this release}.

    Reflash the card with Raspberry Pi OS Lite (64-bit), then run this again.
    Nothing on this system has been changed.
MSG
)"
  fi

  if [[ "$(uname -m)" != "aarch64" && "$(uname -m)" != "x86_64" ]]; then
    die "ArcadeOS needs a 64-bit OS; this kernel is $(uname -m). Reflash with the 64-bit image."
  fi
}

# --------------------------------------------------------------- ssh ---
#
# The kiosk owns the only screen. If sshd is not running, a machine with a
# swallowed VT-switch chord has NO way in — the card comes out. Learned on a
# real cabinet, the first evening it ran. Remote access is not a convenience
# on this device; it is the only maintenance path, so the installer and every
# on-cabinet update make sure it is on.
enable_ssh() {
  if systemctl cat ssh.service >/dev/null 2>&1; then
    if systemctl is-active --quiet ssh; then
      info "ssh already running"
    else
      systemctl enable --now ssh >/dev/null 2>&1 \
        && info "ssh enabled — this cabinet is reachable even when the kiosk owns the screen" \
        || warn "could not enable ssh; the console is the only way in"
    fi
  else
    warn "openssh-server is not installed; skipping ssh enablement"
  fi
}

install_packages() {
  [[ $SKIP_APT -eq 1 ]] && { info "skipping apt (--skip-apt)"; return 0; }
  step "Updating the system and installing packages"

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get -y -qq upgrade

  # cage is the Wayland kiosk compositor; seatd gives it seat access without
  # a full login manager. The rest is Bluetooth pads, GPIO and fonts.
  local packages=(
    cage
    seatd
    chromium-browser
    plymouth
    plymouth-themes
    bluez
    python3
    python3-gpiozero
    python3-lgpio
    fonts-dejavu-core
    libgl1-mesa-dri
  )

  # chromium-browser is a transitional package on some images; fall back.
  if ! apt-cache show chromium-browser >/dev/null 2>&1; then
    packages=("${packages[@]/chromium-browser/chromium}")
  fi

  local missing=()
  for p in "${packages[@]}"; do
    dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
  done

  if ((${#missing[@]})); then
    info "installing: ${missing[*]}"
    apt-get -y -qq install "${missing[@]}"
  else
    info "all packages already present"
  fi

  systemctl enable --now seatd >/dev/null 2>&1 || true
  usermod -aG video,input,render,seat "$ARCADE_USER" 2>/dev/null || true
}

find_chromium() {
  for c in chromium-browser chromium /usr/lib/chromium/chromium; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
    [[ -x "$c" ]] && { echo "$c"; return 0; }
  done
  return 1
}

# ------------------------------------------------------------------ token ---
#
# The agent runs as root and can power the cabinet off, so it must be able to
# tell the kiosk apart from anything else on the machine. Loopback alone does
# not do that: a cross-origin POST with no custom headers is a CORS "simple
# request", so without a secret any web page in any local browser could shut
# the cabinet down, and a DNS-rebinding page could too.
#
# So: one random secret, readable only by root (the agent) and the kiosk user
# (through the page). It is generated once and reused on every re-run, because
# rotating it would leave a running agent and a cached page disagreeing.

ensure_token() {
  install -d -m 0755 "$CONF_DIR"
  if [[ -s "$TOKEN_FILE" ]]; then
    info "reusing agent token"
  else
    local tmp
    tmp="$(mktemp)"
    chmod 0600 "$tmp"
    # 32 hex characters from the kernel CSPRNG. No openssl dependency.
    od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$tmp"
    [[ -s "$tmp" ]] || { rm -f "$tmp"; die "could not read /dev/urandom"; }
    install -m 0600 -o root -g root "$tmp" "$TOKEN_FILE"
    rm -f "$tmp"
    info "generated agent token"
  fi
  AGENT_TOKEN="$(cat "$TOKEN_FILE")"
  [[ "$AGENT_TOKEN" =~ ^[0-9a-f]{16,}$ ]] || die "agent token is malformed; delete $TOKEN_FILE and re-run"
}

# Install the bundle with the token baked in above it. The build output itself
# stays a pure single file with no secret in it — the secret only exists on the
# cabinet, and only in a file the player's browser profile cannot read.
install_page() {
  ensure_token
  local tmp
  tmp="$(mktemp)"
  {
    printf '<script>window.ARCADEOS_AGENT_TOKEN=%s;</script>\n' "\"$AGENT_TOKEN\""
    cat "$SRC_DIR/dist/arcade.html"
  } > "$tmp"
  # 0640 root:$ARCADE_USER — the kiosk reads it, nothing else on the box does.
  # Stage in the destination directory and rename: rename(2) is atomic, so
  # Chromium either sees the old page or the new one, never a truncated file
  # mid-write. install(1) truncates in place, which is a renderer crash if
  # the browser reloads at the wrong moment — as it does during an update.
  install -m 0640 -o root -g "$ARCADE_USER" "$tmp" "$APP_DIR/.arcade.html.new"
  mv -f "$APP_DIR/.arcade.html.new" "$APP_DIR/arcade.html"
  rm -f "$tmp"
  info "installed arcade.html (token bound)"
}

# Record where this cabinet was installed from, so SOFTWARE UPDATE on the
# dashboard can pull the same branch later without anyone at a keyboard.
# Best effort: a cabinet installed from a tarball simply has no self-update,
# and the update screen says so instead of failing cryptically.
write_update_conf() {
  local branch remote
  if git -c "safe.directory=$SRC_DIR" -C "$SRC_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    branch="$(git -c "safe.directory=$SRC_DIR" -C "$SRC_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
    remote="$(git -c "safe.directory=$SRC_DIR" -C "$SRC_DIR" remote get-url origin 2>/dev/null || true)"
    cat > "$CONF_DIR/update.conf" <<CONF
# Written by setup-arcade.sh — where SOFTWARE UPDATE pulls from.
SRC_DIR=$SRC_DIR
GIT_BRANCH=$branch
GIT_REMOTE=$remote
ARCADE_USER=$ARCADE_USER
CONF
    chmod 0644 "$CONF_DIR/update.conf"
    info "updates will pull $branch from this checkout"
  else
    rm -f "$CONF_DIR/update.conf"
    warn "not a git checkout — on-cabinet SOFTWARE UPDATE will be unavailable"
  fi
}

install_app() {
  step "Installing ArcadeOS to ${APP_DIR}"

  # Prefer a freshly built bundle; fall back to the committed one so the Pi
  # never needs Node installed.
  if command -v node >/dev/null 2>&1 && [[ -f "$SRC_DIR/build.js" ]]; then
    info "building from source"
    ( cd "$SRC_DIR" && node build.js >/dev/null )
  fi
  [[ -f "$SRC_DIR/dist/arcade.html" ]] || die "dist/arcade.html missing — run 'npm run build' first"

  install -d -m 0755 "$APP_DIR"
  install_page
  write_update_conf
  install -d -m 0755 "$DATA_DIR"
  chown -R "$ARCADE_USER":"$ARCADE_USER" "$DATA_DIR"

  local chromium
  chromium="$(find_chromium)" || die "chromium not found; install it or drop --skip-apt"
  info "chromium: $chromium"

  # The kiosk launcher. Written as a file rather than a long ExecStart so it
  # can be read, edited and run by hand while debugging a cabinet.
  cat > "$APP_DIR/launch.sh" <<LAUNCH
#!/usr/bin/env bash
# ArcadeOS kiosk launcher. Managed by setup-arcade.sh — edits will be replaced.
set -Eeuo pipefail

CHROMIUM="${chromium}"
PROFILE="${DATA_DIR}/chromium"
PAGE="file://${APP_DIR}/arcade.html"

mkdir -p "\$PROFILE"

# Chromium flags, and why each one is here:
#   --kiosk                     no chrome, no tabs, no way out
#   --app                       no omnibox even in kiosk edge cases
#   --user-data-dir             profile on the writable data partition, so
#                               localStorage survives a read-only root
#   --autoplay-policy           WebAudio without waiting for a click; there is
#                               no pointer on a cabinet
#   --disable-pinch/--overscroll no accidental zoom from an arcade encoder
#   --ozone-platform=wayland    cage is a Wayland compositor
#   --disable-features=Translate,...  no dialogs, ever
#   --check-for-update-interval large: an offline cabinet must never nag
#
# Latency flags. The front end draws into one desynchronized canvas, and
# these keep the path from that canvas to the panel as short as the Pi allows:
#   --ignore-gpu-blocklist      the VideoCore VI is blocklisted by default,
#                               which silently drops you to software raster
#   --enable-gpu-rasterization  raster on the GPU, not the CPU
#   --enable-zero-copy          no extra texture copy on upload
#   --canvas-oop-rasterization  canvas raster off the main thread
#   --force-device-scale-factor=1  never resample a 1080x1920 panel
#
#   --enable-logging=stderr     Chromium's own GPU/crash lines land in
#                               journalctl -u arcadeos. Without this the first
#                               real cabinet was undiagnosable: 22fps and
#                               renderer crashes with an empty journal.
#   --log-level=0               ...and stderr alone printed nothing on the
#                               cabinet: GL initialisation is logged at INFO,
#                               which is below the default threshold.
#
# There is deliberately NO --use-gl here. The value this script used to pass
# (egl) was removed from Chromium years ago; an unrecognised GL backend makes
# Chromium fall back to SwiftShader — software rendering, which on a Pi 4 at
# 1080p is almost exactly the 22fps the first cabinet measured. The Raspberry
# Pi OS chromium package picks the right V3D/ANGLE path on its own.
exec "\$CHROMIUM" \\
  --enable-logging=stderr \\
  --log-level=0 \\
  --kiosk \\
  --app="\$PAGE" \\
  --user-data-dir="\$PROFILE" \\
  --ozone-platform=wayland \\
  --ignore-gpu-blocklist \\
  --enable-gpu-rasterization \\
  --enable-zero-copy \\
  --canvas-oop-rasterization \\
  --force-device-scale-factor=1 \\
  --autoplay-policy=no-user-gesture-required \\
  --disable-pinch \\
  --overscroll-history-navigation=0 \\
  --disable-features=Translate,TranslateUI,AutofillServerCommunication,OptimizationHints \\
  --disable-component-update \\
  --disable-background-networking \\
  --disable-sync \\
  --no-first-run \\
  --no-default-browser-check \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --hide-scrollbars \\
  --check-for-update-interval=31536000 \\
  --password-store=basic
LAUNCH
  chmod 0755 "$APP_DIR/launch.sh"

  install -m 0755 "$SRC_DIR/pi/arcadeos-agent.py" "$APP_DIR/arcadeos-agent.py"
  install -m 0755 "$SRC_DIR/pi/arcadeos-update.sh" "$APP_DIR/arcadeos-update.sh"
  install -m 0755 "$SRC_DIR/pi/arcadeos-gpio.py" "$APP_DIR/arcadeos-gpio.py"
  install -m 0755 "$SRC_DIR/pi/make-splash.py" "$APP_DIR/make-splash.py"
}

install_services() {
  step "Installing systemd services"

  cat > /etc/systemd/system/arcadeos.service <<UNIT
[Unit]
Description=ArcadeOS kiosk
After=systemd-user-sessions.service seatd.service arcadeos-agent.service
Wants=arcadeos-agent.service

[Service]
Type=simple
User=${ARCADE_USER}
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
Environment=XDG_RUNTIME_DIR=/run/user/%U
Environment=WLR_LIBINPUT_NO_DEVICES=1
# Rotation happens in the kernel (panel_orientation on the cmdline), not here:
# cage has no rotation flag — passing one made it exit 1 and the cabinet
# crash-looped on a black screen. Verified against cage 0.1.x, options dhm:sv.
# -s keeps Ctrl+Alt+F2 working, which is the only local way back into a
# machine whose one screen is owned by the kiosk.
Environment=ARCADEOS_ROTATE=${ROTATE}
# The first cabinet quick-exited six times per boot: cage starts before the
# HDMI connector reports connected, finds no output, and exits 0. Wait for a
# live connector (bounded — start anyway after 15s so a headless cabinet
# still comes up and keeps the agent's watchdog meaningful).
ExecStartPre=-/usr/bin/timeout 15 /bin/sh -c 'until grep -qs ^connected /sys/class/drm/card*-*/status; do sleep 0.3; done'
ExecStart=/usr/bin/cage -ds -- ${APP_DIR}/launch.sh
Restart=always
RestartSec=2
# A cabinet should come back from a crash, not sit on a black screen.
StartLimitBurst=0

[Install]
WantedBy=graphical.target
UNIT

  cat > /etc/systemd/system/arcadeos-agent.service <<UNIT
[Unit]
Description=ArcadeOS local control agent (shutdown, restart, Bluetooth pairing)
Documentation=file://${APP_DIR}/arcadeos-agent.py

[Service]
Type=simple
ExecStart=/usr/bin/python3 ${APP_DIR}/arcadeos-agent.py
Restart=always
RestartSec=2
# Binds 127.0.0.1 only and runs a fixed three-command table, but there is no
# reason to give it more of the filesystem than it needs.
ProtectHome=yes
ProtectSystem=strict
PrivateTmp=yes
NoNewPrivileges=yes
RestrictAddressFamilies=AF_INET AF_UNIX

[Install]
WantedBy=multi-user.target
UNIT

  install_watchdog

  systemctl daemon-reload
  systemctl enable arcadeos-agent.service >/dev/null
  systemctl restart arcadeos-agent.service
  systemctl set-default graphical.target >/dev/null
  systemctl enable arcadeos.service >/dev/null
  info "kiosk service enabled (starts on next boot; 'systemctl start arcadeos' to test now)"
}

# The Pi has a hardware watchdog (bcm2835_wdt). systemd will pet it while it is
# healthy and let the board reset if it is not, which covers the one failure the
# agent's frame heartbeat cannot: a kernel or systemd level hang, where nothing
# in userspace is left running to notice.
#
# Two layers, deliberately:
#   agent heartbeat  ->  frozen picture, healthy OS   ->  restart the kiosk
#   hardware watchdog ->  wedged kernel               ->  reset the board
install_watchdog() {
  step "Arming the hardware watchdog"
  if [[ ! -e /dev/watchdog ]] && ! modinfo bcm2835_wdt >/dev/null 2>&1; then
    warn "no hardware watchdog on this machine; skipping"
    return 0
  fi
  write_block /etc/systemd/system.conf "$(cat <<'CFG'
# Reset the board if systemd stops petting the watchdog for this long.
RuntimeWatchdogSec=20
# Bound how long a shutdown may hang before the watchdog forces the issue.
RebootWatchdogSec=2min
CFG
)"
  info "systemd will reset the board after 20s of a wedged kernel"
  info "kiosk-level hangs are handled by the agent's frame heartbeat"
}

install_gpio() {
  local cfg; cfg="$(boot_config)"

  if [[ $DO_GPIO_OVERLAY -eq 1 ]]; then
    step "Enabling kernel gpio-shutdown on BCM${GPIO_PIN}"
    [[ -n "$cfg" ]] || die "cannot find config.txt"
    svc_disable arcadeos-gpio.service
    write_block "$cfg" "$(cat <<CFG
# ArcadeOS: shutdown button on BCM${GPIO_PIN} to ground, handled in-kernel.
dtoverlay=gpio-shutdown,gpio_pin=${GPIO_PIN},active_low=1,gpio_pull=up
disable_splash=1
CFG
)"
    info "takes effect on reboot"
    return 0
  fi

  if [[ $DO_GPIO -eq 0 ]]; then
    info "skipping GPIO shutdown button (--no-gpio)"
    svc_disable arcadeos-gpio.service
    systemctl daemon-reload
    return 0
  fi

  step "Installing GPIO shutdown button on BCM${GPIO_PIN}"
  cat > /etc/systemd/system/arcadeos-gpio.service <<UNIT
[Unit]
Description=ArcadeOS GPIO shutdown button

[Service]
Type=simple
Environment=ARCADEOS_GPIO_PIN=${GPIO_PIN}
Environment=ARCADEOS_GPIO_HOLD=1.2
Environment=ARCADEOS_GPIO_ACTION=poweroff
ExecStart=/usr/bin/python3 ${APP_DIR}/arcadeos-gpio.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable arcadeos-gpio.service >/dev/null
  systemctl restart arcadeos-gpio.service || warn "GPIO service did not start; check 'journalctl -u arcadeos-gpio'"
  info "wire a momentary button between BCM${GPIO_PIN} and any GND pin"

  if [[ -n "$cfg" ]]; then
    write_block "$cfg" "$(cat <<'CFG'
disable_splash=1
# Full KMS driver: required for cage/Wayland and for GPU rasterisation.
dtoverlay=vc4-kms-v3d
# Two framebuffers rather than three keeps one less frame queued between
# Chromium and the panel. On a cabinet, latency beats smoothing.
max_framebuffers=2
disable_overscan=1
CFG
)"
  fi
}

install_splash() {
  step "Installing the Plymouth boot splash"

  if ! command -v plymouth-set-default-theme >/dev/null 2>&1; then
    warn "plymouth not installed; skipping the splash"
    return 0
  fi

  install -d -m 0755 "$THEME_DIR"
  install -m 0644 "$SRC_DIR/pi/plymouth/arcadeos.plymouth" "$THEME_DIR/arcadeos.plymouth"
  install -m 0644 "$SRC_DIR/pi/plymouth/arcadeos.script" "$THEME_DIR/arcadeos.script"

  # Generated at install time so the wordmark matches the panel width, and so
  # the repository carries no binary blobs.
  python3 "$SRC_DIR/pi/make-splash.py" "$THEME_DIR/arcadeos-logo.png" --width 900 >/dev/null
  info "wordmark generated at $THEME_DIR/arcadeos-logo.png"

  plymouth-set-default-theme arcadeos >/dev/null 2>&1 || warn "could not set the plymouth theme"
  if command -v update-initramfs >/dev/null 2>&1; then
    update-initramfs -u >/dev/null 2>&1 || true
  fi

}

# ------------------------------------------------------------- cmdline ---
#
# One function owns cmdline.txt. It used to be buried in install_splash, which
# meant a machine without plymouth never got any of it — including rotation,
# once rotation moved here.
configure_cmdline() {
  step "Configuring the kernel command line"
  local cmdline; cmdline="$(boot_cmdline)"
  if [[ -z "$cmdline" ]]; then
    warn "no cmdline.txt found; skipping kernel options (not a Pi boot layout?)"
    return 0
  fi

  local current; current="$(cat "$cmdline")"
  local wanted="$current"

  # Rotation. cage has no rotation option, so the panel orientation is
  # declared to the kernel and every wlroots compositor honours it. Chromium
  # still sees an upright 1080x1920 output. Both HDMI connectors are listed
  # because either port may be in use. If your picture comes out rotated the
  # wrong way, re-run with --rotate 270 (or 90) — the two are mirror cases
  # and which is "clockwise" depends on which way you physically turned the
  # monitor.
  wanted="$(sed -E 's/video=HDMI-A-[0-9]+:panel_orientation=[a-z_]+//g' <<<"$wanted")"
  local po=""
  case "$ROTATE" in
    90)  po=right_side_up ;;
    180) po=upside_down ;;
    270) po=left_side_up ;;
  esac
  if [[ -n "$po" ]]; then
    wanted="$wanted video=HDMI-A-1:panel_orientation=$po video=HDMI-A-2:panel_orientation=$po"
  fi

  #
  # usbhid.*poll=1 asks every USB input device for a report every 1ms
  # instead of at its descriptor's default interval, which for cheap arcade
  # encoders and many pads is 10ms. This is the largest single source of
  # controller latency on a Pi and it is invisible from inside the browser.
  #
  for opt in quiet splash plymouth.ignore-serial-consoles logo.nologo \
             vt.global_cursor_default=0 \
             usbhid.jspoll=1 usbhid.kbpoll=1 usbhid.mousepoll=1; do
    grep -qw -- "$opt" <<<"$wanted" || wanted="$wanted $opt"
  done
  wanted="$(tr -s ' ' <<<"$wanted" | sed 's/^ *//; s/ *$//')"

  if [[ "$wanted" != "$current" ]]; then
    # Keep the first backup: it is the only pristine copy, and a rotation
    # change on a later run must not clobber it with an already-edited file.
    [[ -f "${cmdline}.arcadeos.bak" ]] || cp -a "$cmdline" "${cmdline}.arcadeos.bak"
    printf '%s\n' "$wanted" > "$cmdline"
    info "updated $(basename "$cmdline") (backup at ${cmdline}.arcadeos.bak)"
  else
    info "$(basename "$cmdline") already configured"
  fi
}

# --------------------------------------------------- read-only overlay fs ---

data_partition() {
  blkid -L "$DATA_LABEL" 2>/dev/null || true
}

explain_data_partition() {
  cat <<EXPLAIN

    A read-only root protects the SD card from corruption, but high scores
    then have nowhere to live. ArcadeOS keeps them on a small partition
    labelled ${DATA_LABEL}, mounted at ${DATA_DIR}.

    No such partition was found, and this script will not repartition your
    card for you. To make one, with the card in another machine:

      1. Shrink the root partition, or use free space at the end of the card.
      2. Create a partition of 128MB or more.
      3. Format and label it:
             sudo mkfs.ext4 -L ${DATA_LABEL} /dev/sdXN
      4. Put the card back and re-run:
             sudo ./setup-arcade.sh --readonly

    Alternatively, run without --readonly. The cabinet works perfectly well
    on a normal writable root — you simply need to use the SHUT DOWN entry in
    settings, or the GPIO button, rather than pulling the plug.

EXPLAIN
}

enable_readonly() {
  step "Enabling the read-only overlay filesystem"

  local part; part="$(data_partition)"
  if [[ -z "$part" ]]; then
    warn "no partition labelled ${DATA_LABEL} found"
    explain_data_partition
    die "refusing to enable a read-only root with nowhere to keep high scores"
  fi
  info "data partition: $part"

  # Mount it now and on every boot. nofail so a missing card never blocks boot.
  install -d -m 0755 "$DATA_DIR"
  write_block /etc/fstab "LABEL=${DATA_LABEL}  ${DATA_DIR}  ext4  defaults,noatime,nofail  0  2"
  mountpoint -q "$DATA_DIR" || mount "$DATA_DIR" || warn "could not mount ${DATA_DIR} yet"
  chown -R "$ARCADE_USER":"$ARCADE_USER" "$DATA_DIR" 2>/dev/null || true

  if ! command -v raspi-config >/dev/null 2>&1; then
    die "raspi-config not available; cannot toggle the overlay filesystem"
  fi

  confirm "Enable the read-only overlay? The root filesystem becomes non-persistent." \
    || die "cancelled"

  raspi-config nonint enable_overlayfs
  info "overlay enabled — reboot to apply"
  warn "the root filesystem will be read-only after reboot."
  warn "run 'sudo ./setup-arcade.sh --writable' before making system changes."
}

disable_readonly() {
  step "Disabling the read-only overlay filesystem"
  command -v raspi-config >/dev/null 2>&1 || die "raspi-config not available"
  raspi-config nonint disable_overlayfs
  info "overlay disabled — reboot to apply"
}

# ------------------------------------------------------------- uninstall ---

uninstall() {
  step "Removing ArcadeOS"

  svc_disable arcadeos.service
  svc_disable arcadeos-agent.service
  svc_disable arcadeos-gpio.service
  systemctl daemon-reload
  info "services removed"

  if command -v plymouth-set-default-theme >/dev/null 2>&1; then
    plymouth-set-default-theme pix >/dev/null 2>&1 \
      || plymouth-set-default-theme --reset >/dev/null 2>&1 || true
    command -v update-initramfs >/dev/null 2>&1 && update-initramfs -u >/dev/null 2>&1 || true
  fi
  rm -rf "$THEME_DIR"
  info "splash removed"

  local cmdline; cmdline="$(boot_cmdline)"
  if [[ -n "$cmdline" && -f "${cmdline}.arcadeos.bak" ]]; then
    mv "${cmdline}.arcadeos.bak" "$cmdline"
    info "restored $(basename "$cmdline")"
  fi

  local cfg; cfg="$(boot_config)"
  [[ -n "$cfg" ]] && { remove_block "$cfg"; info "cleaned $(basename "$cfg")"; }
  remove_block /etc/fstab
  remove_block /etc/systemd/system.conf
  info "disarmed the hardware watchdog"

  # Overlay off first — otherwise these deletions evaporate on reboot.
  if command -v raspi-config >/dev/null 2>&1; then
    raspi-config nonint disable_overlayfs >/dev/null 2>&1 || true
  fi

  rm -rf "$APP_DIR"
  info "removed ${APP_DIR}"

  rm -rf "$CONF_DIR"
  info "removed ${CONF_DIR}"

  if [[ "$PURGE" -eq 1 ]]; then
    rm -rf "$DATA_DIR"
    warn "purged ${DATA_DIR} — high scores are gone"
  else
    info "kept ${DATA_DIR} (high scores). Use --purge to delete it."
  fi

  systemctl set-default multi-user.target >/dev/null 2>&1 || true

  step "Done. Reboot to return to a normal console."
}

# ------------------------------------------------------------------ main ---

main() {
  if [[ $DO_UNINSTALL -eq 1 ]]; then uninstall; exit 0; fi
  if [[ $DO_UNREADONLY -eq 1 ]]; then disable_readonly; exit 0; fi

  printf '\n%sArcadeOS %s%s — installing for user %s%s%s\n\n' \
    "$C_OK" "$VERSION" "$C_OFF" "$C_OK" "$ARCADE_USER" "$C_OFF"

  id "$ARCADE_USER" >/dev/null 2>&1 || die "user '$ARCADE_USER' does not exist (set ARCADE_USER=...)"

  check_os

  # A read-only root would silently swallow the whole install.
  if [[ -d /overlay ]] || grep -qs ' / overlay ' /proc/mounts; then
    die "the root filesystem is currently read-only. Run --writable and reboot first."
  fi

  install_packages
  enable_ssh
  install_app
  install_services
  install_gpio
  install_splash
  configure_cmdline

  [[ $DO_READONLY -eq 1 ]] && enable_readonly

  cat <<DONE

$(printf '%s==>%s' "$C_OK" "$C_OFF") Installed.

    Kiosk        systemctl status arcadeos
    Logs         journalctl -u arcadeos -f
    Agent        curl http://127.0.0.1:8127/    (should answer {"ok": true})
    Rotation     ${ROTATE} degrees
    Scores       ${DATA_DIR}/chromium
    Uninstall    sudo ./setup-arcade.sh --uninstall

    Reboot to boot straight into the cabinet:

        sudo reboot

DONE
}

main "$@"
