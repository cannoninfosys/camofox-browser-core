#!/bin/sh
# Pure helpers for vnc-watcher.sh. Kept separate so display ownership and
# lifecycle decisions can be tested without starting Xvfb, x11vnc, or Docker.

# Every Xvfb child of the server at the resolution, oldest first (pid order).
list_owned_xvfb_pids() {
  parent_pid="$1"
  resolution="$2"
  awk -v parent="$parent_pid" -v res="$resolution" '
    $2 == parent && $3 ~ /(^|\/)Xvfb$/ && index($0, res) { print $1 }
  '
}

# The display to show among the owned ones (one ":N" per line, oldest first):
# the preferred display when it is one of them, else the newest.
choose_display() {
  preferred="$1"
  last=""
  while IFS= read -r display; do
    [ -n "$display" ] || continue
    if [ -n "$preferred" ] && [ "$display" = "$preferred" ]; then
      printf '%s\n' "$display"
      return 0
    fi
    last="$display"
  done
  [ -z "$last" ] || printf '%s\n' "$last"
}

find_owned_xvfb_pid() {
  parent_pid="$1"
  resolution="$2"
  awk -v parent="$parent_pid" -v res="$resolution" '
    $2 == parent && $3 ~ /(^|\/)Xvfb$/ && index($0, res) { found=$1 }
    END { if (found) print found }
  '
}

display_for_xvfb_pid() {
  xvfb_pid="$1"
  lock_dir="${2:-/tmp}"
  socket_dir="${3:-/tmp/.X11-unix}"
  proc_root="${4:-/proc}"

  # Traditional X servers expose a lock file containing the owning PID.
  for lock in "$lock_dir"/.X*-lock; do
    [ -f "$lock" ] || continue
    lock_pid=$(tr -d '[:space:]' < "$lock" 2>/dev/null || true)
    [ "$lock_pid" = "$xvfb_pid" ] || continue

    display_num=$(basename "$lock" | sed -n 's/^\.X\([0-9][0-9]*\)-lock$/\1/p')
    [ -n "$display_num" ] || continue
    [ -S "$socket_dir/X$display_num" ] || continue
    printf ':%s\n' "$display_num"
    return 0
  done

  # Xvfb -displayfd may create no lock file. On Linux, map the sockets opened
  # by the owned Xvfb PID through /proc/net/unix, then require the matching
  # filesystem entry to be a real Unix socket.
  [ -d "$proc_root/$xvfb_pid/fd" ] || return 0
  [ -r "$proc_root/net/unix" ] || return 0
  for fd in "$proc_root/$xvfb_pid/fd"/*; do
    socket_ref=$(readlink "$fd" 2>/dev/null || true)
    inode=$(printf '%s\n' "$socket_ref" | sed -n 's/^socket:\[\([0-9][0-9]*\)\]$/\1/p')
    [ -n "$inode" ] || continue
    socket_path=$(awk -v inode="$inode" '$7 == inode { print $8; exit }' "$proc_root/net/unix")
    case "$socket_path" in
      "$socket_dir"/X[0-9]*) ;;
      *) continue ;;
    esac
    [ -S "$socket_path" ] || continue
    display_num=${socket_path##*/X}
    case "$display_num" in *[!0-9]*|'') continue ;; esac
    printf ':%s\n' "$display_num"
    return 0
  done
}

# True while a process exists and is not a zombie (a dead child the shell has
# not reaped yet still answers kill -0).
pid_running() {
  pid="$1"
  proc_root="${2:-/proc}"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  stat=$(cat "$proc_root/$pid/stat" 2>/dev/null) || return 0
  state=$(printf '%s\n' "${stat##*) }" | awk '{ print $1 }')
  [ "$state" != "Z" ]
}

x11vnc_needs_reattach() {
  tracked_pid="$1"
  [ -n "$tracked_pid" ] || return 1
  ! pid_running "$tracked_pid"
}

# Current parent PID of a process, from /proc (the shell's $PPID is fixed at
# startup and does not change when the process is re-parented).
current_ppid() {
  pid="$1"
  proc_root="${2:-/proc}"
  stat=$(cat "$proc_root/$pid/stat" 2>/dev/null) || return 0
  # Field 4, counted after the last ")" (the command name may contain spaces).
  printf '%s\n' "${stat##*) }" | awk '{ print $2 }'
}

# True while the server that started the watcher is alive and still its parent
# (after the server dies the watcher is re-parented, even if the PID is reused).
server_alive() {
  server_pid="$1"
  self_pid="$2"
  proc_root="${3:-/proc}"
  pid_running "$server_pid" "$proc_root" || return 1
  [ "$(current_ppid "$self_pid" "$proc_root")" = "$server_pid" ]
}

# TERM the given PIDs, give them a few seconds, then KILL what is left.
stop_pids() {
  pids=""
  for pid in "$@"; do
    pid_running "$pid" && pids="$pids $pid"
  done
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  waited=0
  while [ "$waited" -lt "${STOP_GRACE_TENTHS:-30}" ]; do
    alive=""
    for pid in $pids; do
      pid_running "$pid" && alive="$alive $pid"
    done
    [ -n "$alive" ] || return 0
    sleep 0.1
    waited=$((waited + 1))
  done
  # shellcheck disable=SC2086
  kill -KILL $alive 2>/dev/null || true
  return 0
}
