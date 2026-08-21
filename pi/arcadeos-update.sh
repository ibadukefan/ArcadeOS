#!/usr/bin/env bash
#
# arcadeos-update — pull the newest ArcadeOS and reinstall it, reporting every
# step to a status file the front end watches.
#
# Launched by arcadeos-agent (POST /update) as a detached systemd unit, so it
# outlives the agent restart it causes near the end. Never run by hand unless
# debugging — but it is safe to: every step is idempotent and any failure
# rolls the page back to the copy that was running before.
#
# Where the update comes from: the git checkout this cabinet was installed
# from, recorded by setup-arcade.sh in /etc/arcadeos/update.conf. New games
# ship inside the same bundle, so "update" and "new games" are one operation.

set -Eeuo pipefail

# Overridable for the test harness only — a real cabinet never sets these.
CONF="${ARCADEOS_UPDATE_CONF:-/etc/arcadeos/update.conf}"
STATUS="${ARCADEOS_UPDATE_STATUS:-/var/lib/arcadeos/update-status.json}"
APP_DIR="${ARCADEOS_UPDATE_APP_DIR:-/opt/arcadeos}"
PAGE="$APP_DIR/arcade.html"

# ------------------------------------------------------------------ status ---

json_escape() {
  # Good enough for the strings we emit: quotes, backslashes, control chars.
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

FROM_SHA=""
TO_SHA=""

status() {
  # status <phase> <msg> <done 0|1> <updated 0|1> [error]
  local tmp
  tmp="$(mktemp)"
  printf '{"phase":"%s","msg":"%s","done":%s,"updated":%s,"error":"%s","from":"%s","to":"%s"}\n' \
    "$(json_escape "$1")" "$(json_escape "$2")" \
    "$([[ "$3" == 1 ]] && echo true || echo false)" \
    "$([[ "$4" == 1 ]] && echo true || echo false)" \
    "$(json_escape "${5:-}")" \
    "$(json_escape "$FROM_SHA")" "$(json_escape "$TO_SHA")" > "$tmp"
  mkdir -p "$(dirname "$STATUS")"
  install -m 0644 "$tmp" "$STATUS"
  rm -f "$tmp"
}

fail() {
  status "failed" "$1" 1 0 "$1"
  # Roll the page back if this run had already replaced it.
  if [[ -f "$PAGE.prev" && "${PAGE_REPLACED:-0}" == 1 ]]; then
    cp -f "$PAGE.prev" "$PAGE" || true
  fi
  # Roll the CHECKOUT back too. Without this, a failed install left HEAD at
  # the new version, so the next check compared HEAD to origin and announced
  # "already up to date" about an update that never installed. The version
  # pointer must never be ahead of what is actually running.
  if [[ "${GIT_MOVED:-0}" == 1 && -n "${FROM_FULL:-}" ]]; then
    "${GIT[@]}" reset --hard --quiet "$FROM_FULL" 2>/dev/null || true
    status "failed" "$1 (previous version restored — TRY AGAIN will retry the update)" 1 0 "$1"
  fi
  exit 1
}

trap 'fail "update stopped unexpectedly at line $LINENO"' ERR

# ------------------------------------------------------------------- config ---

status "checking" "reading cabinet configuration" 0 0

[[ -r "$CONF" ]] || fail "no update configuration — reinstall once with setup-arcade.sh"
# shellcheck disable=SC1090
source "$CONF"
[[ -n "${SRC_DIR:-}" ]] || fail "update configuration is missing SRC_DIR"
# The installer re-run below is an executed child, not a subshell: a sourced
# variable does not reach it unless exported. Without this, setup fell back
# to guessing the cabinet user.
[[ -n "${ARCADE_USER:-}" ]] && export ARCADE_USER
[[ -d "$SRC_DIR/.git" ]] || fail "the install source at $SRC_DIR is not a git checkout"
BRANCH="${GIT_BRANCH:-main}"

# Git must run AS THE CABINET USER, not root. This unit is root, and a root
# `git fetch` writes root-owned objects into the user's checkout — after
# which the user's own `git pull` fails with "insufficient permission for
# adding an object". Happened on a real cabinet. runuser only when we are
# root and the user actually exists (the test fixtures use a fake name).
GIT=(git -c "safe.directory=$SRC_DIR" -C "$SRC_DIR")
if [[ "$(id -u)" == 0 && -n "${ARCADE_USER:-}" ]] && id -u "$ARCADE_USER" >/dev/null 2>&1; then
  # Self-heal checkouts already damaged by earlier root-run updates.
  if [[ "$(stat -c %U "$SRC_DIR/.git" 2>/dev/null)" != "$ARCADE_USER" ]]; then
    chown -R "$ARCADE_USER" "$SRC_DIR" 2>/dev/null || true
  fi
  GIT=(runuser -u "$ARCADE_USER" -- git -c "safe.directory=$SRC_DIR" -C "$SRC_DIR")
fi

# ------------------------------------------------------------------- fetch ---

status "checking" "contacting the update server" 0 0

FROM_SHA="$("${GIT[@]}" rev-parse --short=8 HEAD 2>/dev/null || echo unknown)"
FROM_FULL="$("${GIT[@]}" rev-parse HEAD 2>/dev/null || echo "")"

"${GIT[@]}" fetch --quiet origin "$BRANCH" \
  || fail "could not reach the update server — check the network"

TO_SHA="$("${GIT[@]}" rev-parse --short=8 "origin/$BRANCH" 2>/dev/null || echo unknown)"

if [[ "$FROM_SHA" == "$TO_SHA" ]]; then
  status "done" "already up to date" 1 0
  exit 0
fi

# ------------------------------------------------------------------ install ---

status "downloading" "downloading version $TO_SHA" 0 0
GIT_MOVED=1
"${GIT[@]}" reset --hard --quiet "origin/$BRANCH" \
  || fail "could not apply the downloaded update"

# The bundle must at least look like ArcadeOS before it replaces anything.
[[ -s "$SRC_DIR/dist/arcade.html" ]] || fail "the update is missing its game bundle"
grep -q "ArcadeOS" "$SRC_DIR/dist/arcade.html" || fail "the update bundle looks corrupt"
[[ -x "$SRC_DIR/setup-arcade.sh" ]] || fail "the update is missing its installer"

status "installing" "installing $FROM_SHA → $TO_SHA" 0 0

# Keep the running page for rollback before the installer replaces it.
if [[ -f "$PAGE" ]]; then
  cp -f "$PAGE" "$PAGE.prev"
fi
PAGE_REPLACED=1

# The installer is idempotent and re-binds the agent token into the new page.
# --skip-apt keeps this to seconds; --yes because nobody is holding a keyboard.
# Run from its own directory: the unit's cwd is nowhere useful.
( cd "$SRC_DIR" && ./setup-arcade.sh --skip-apt --yes ) \
  || fail "the installer reported an error"

status "restarting" "update installed — restarting the cabinet display" 0 1

# Final report BEFORE the kiosk restart kills the page that is polling us.
status "done" "updated to $TO_SHA" 1 1

systemctl restart arcadeos.service 2>/dev/null || true

exit 0
