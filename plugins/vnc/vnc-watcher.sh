#!/bin/sh
# VNC watcher: detects Camoufox's dynamically-assigned Xvfb display and attaches
# x11vnc + noVNC to it. Handles browser restarts (re-attaches on display change).
#
# Called by the VNC plugin via child_process.spawn. Not meant to run standalone.
#
# Env vars (set by the plugin):
#   VNC_PASSWORD    If set, x11vnc requires this password
#   VIEW_ONLY       "1" for view-only mode
#   VNC_PORT        VNC port (default: 5900)
#   NOVNC_PORT      noVNC websocket port (default: 6080)
#
# The watcher exits when the server that started it exits (checked every loop),
# and on exit stops the x11vnc and websockify it started, so nothing keeps the
# ports bound or delays a service stop.

set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=vnc-watcher-lib.sh
. "$SCRIPT_DIR/vnc-watcher-lib.sh"

VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_RESOLUTION="${VNC_RESOLUTION:-1920x1080x24}"
VNC_STATUS_FILE="${VNC_STATUS_FILE:-}"

log() { printf '[vnc-watcher] %s\n' "$*" >&2; }
clear_status() { [ -z "$VNC_STATUS_FILE" ] || rm -f "$VNC_STATUS_FILE"; }
write_status() {
  [ -z "$VNC_STATUS_FILE" ] || printf '%s %s\n' "$CURRENT_DISPLAY" "$X11VNC_PID" > "$VNC_STATUS_FILE"
}

CURRENT_DISPLAY=""
X11VNC_PID=""
WEBSOCKIFY_PID=""
SERVER_PID="$PPID"
SELF_PID="$$"
X11_LOCK_DIR="${X11_LOCK_DIR:-/tmp}"
X11_SOCKET_DIR="${X11_SOCKET_DIR:-/tmp/.X11-unix}"

cleanup() {
  set +e
  stop_pids "$X11VNC_PID" "$WEBSOCKIFY_PID"
  clear_status
}
trap cleanup EXIT
trap 'exit 0' INT TERM HUP
clear_status

# Prepare password file if requested
PASSFILE=""
if [ -n "${VNC_PASSWORD:-}" ]; then
  mkdir -p /tmp/.vnc
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/.vnc/passwd >/dev/null 2>&1
  PASSFILE="/tmp/.vnc/passwd"
  log "x11vnc: password protected"
else
  log "x11vnc: NO password (bind $NOVNC_PORT to 127.0.0.1 on host + SSH tunnel)"
fi

# Start noVNC (websockify) -- proxies to x11vnc regardless of whether it's up yet
NOVNC_DIR="${NOVNC_DIR:-/usr/share/novnc}"
if [ ! -d "$NOVNC_DIR" ]; then
  log "ERROR: $NOVNC_DIR not found; noVNC cannot start"
  exit 1
fi
VNC_BIND="${VNC_BIND:-127.0.0.1}"
log "Starting noVNC (websockify) on $VNC_BIND:$NOVNC_PORT -> 127.0.0.1:$VNC_PORT"
websockify --web "$NOVNC_DIR" "$VNC_BIND:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >/tmp/camofox-novnc.log 2>&1 &
WEBSOCKIFY_PID=$!

log "VNC watcher started -- will attach x11vnc when Camoufox's Xvfb appears"

find_owned_display() {
  # Identify this server's Xvfb child, then map its PID through Xvfb's lock
  # file (or, for a lock-free -displayfd start, its sockets) to the display.
  # This retains the per-server ownership isolation needed when several
  # Camofox servers share a process namespace.
  XVFB_PID=$(ps -eo pid=,ppid=,args= 2>/dev/null | find_owned_xvfb_pid "$SERVER_PID" "$VNC_RESOLUTION")
  [ -n "$XVFB_PID" ] || return 0
  display_for_xvfb_pid "$XVFB_PID" "$X11_LOCK_DIR" "$X11_SOCKET_DIR" /proc
}

while true; do
  if ! server_alive "$SERVER_PID" "$SELF_PID"; then
    log "Camofox server (pid=$SERVER_PID) is gone; stopping"
    exit 0
  fi

  # A browser restart commonly recreates Xvfb on the same display number.
  # Clear stale state when this watcher's own x11vnc process has exited so the
  # same display can be attached again.
  if x11vnc_needs_reattach "$X11VNC_PID"; then
    log "x11vnc exited; waiting to reattach"
    clear_status
    CURRENT_DISPLAY=""
    X11VNC_PID=""
  fi

  FOUND=$(find_owned_display)

  if [ -n "$FOUND" ] && [ "$FOUND" != "$CURRENT_DISPLAY" ]; then
    # New or changed display -- (re)attach x11vnc
    if pid_running "$X11VNC_PID"; then
      log "Camoufox display changed ($CURRENT_DISPLAY -> $FOUND), restarting x11vnc"
      stop_pids "$X11VNC_PID"
    fi

    CURRENT_DISPLAY="$FOUND"
    log "Attaching x11vnc to DISPLAY=$CURRENT_DISPLAY"

    # No -bg: x11vnc stays our child, so we know its PID and can stop exactly it.
    X11VNC_ARGS="-display $CURRENT_DISPLAY -forever -shared -localhost -rfbport $VNC_PORT -noxdamage -quiet -o /tmp/camofox-x11vnc.log"
    [ "${VIEW_ONLY:-0}" = "1" ] && X11VNC_ARGS="$X11VNC_ARGS -viewonly"
    if [ -n "$PASSFILE" ]; then
      X11VNC_ARGS="$X11VNC_ARGS -rfbauth $PASSFILE"
    else
      X11VNC_ARGS="$X11VNC_ARGS -nopw"
    fi

    # shellcheck disable=SC2086
    x11vnc $X11VNC_ARGS </dev/null &
    X11VNC_PID=$!
    sleep 1
    if pid_running "$X11VNC_PID"; then
      write_status
      log "x11vnc running (pid=$X11VNC_PID) on DISPLAY=$CURRENT_DISPLAY"
    else
      log "x11vnc did not stay running on DISPLAY=$CURRENT_DISPLAY; will retry"
      clear_status
      CURRENT_DISPLAY=""
      X11VNC_PID=""
    fi
  fi

  sleep 2
done
