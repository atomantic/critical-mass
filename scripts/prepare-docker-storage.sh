#!/bin/sh
set -eu

# The production image runs as this numeric user. Keep these values numeric so
# the bind mount contract is stable even when the host has no matching name.
APP_UID=1000
APP_GID=1000
APP_OWNER="${APP_UID}:${APP_GID}"
DATA_DIR="${DATA_DIR:-data}"
LOGS_DIR="${LOGS_DIR:-logs}"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

directory_owner() {
  stat -c '%u:%g' "$1" 2>/dev/null || fail "could not inspect ownership of '$1'; this preparation script requires Linux stat"
}

ensure_directory() {
  path="$1"
  label="$2"
  mode="$3"

  if [ -L "$path" ]; then
    fail "$label path '$path' is a symlink; move it aside and retry so the bind mount target is unambiguous"
  fi

  if [ -e "$path" ]; then
    [ -d "$path" ] || fail "$label path '$path' exists but is not a directory; no files were changed"

    owner="$(directory_owner "$path")"
    [ "$owner" = "$APP_OWNER" ] || fail "$label path '$path' is owned by $owner, expected $APP_OWNER; no files were changed. Correct this directory explicitly, for example: sudo chown $APP_OWNER '$path'"
    return
  fi

  mkdir -p "$path" || fail "could not create $label directory '$path'"
  chown "$APP_OWNER" "$path" || fail "created $label directory '$path' but could not set ownership to $APP_OWNER; run this script with sudo"
  chmod "$mode" "$path" || fail "could not set permissions on new $label directory '$path'"
}

ensure_directory "$DATA_DIR" data 700
ensure_directory "$LOGS_DIR" logs 700

printf 'Docker storage is ready: data=%s logs=%s owner=%s (data/logs mode 700 for newly created directories)\n' \
  "$DATA_DIR" "$LOGS_DIR" "$APP_OWNER"
