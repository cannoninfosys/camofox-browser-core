import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Safe X display selection for the Xvfb virtual display.
 *
 * camoufox-js starts Xvfb with `-displayfd`, letting Xvfb take the first display
 * number it can bind. That number can belong to another X server: Xwayland on a
 * Wayland desktop, for example, holds :0 without a lock file or an abstract
 * socket, so Xvfb binds :0, replaces /tmp/.X11-unix/X0 and unlinks it again on
 * exit -- browser windows appear on the user's desktop and the desktop loses
 * its X display. Services that run several servers side by side (one display
 * each) also need a way to say which display a server must use.
 *
 * The subclass created here:
 *   - honors DISPLAY (`:N` or `:N.S`) when that display is free;
 *   - otherwise scans upward from a high base for a display that no live X
 *     server holds (a listening socket, path or abstract, in /proc/net/unix, or
 *     a lock file naming a live process);
 *   - starts `Xvfb :N` and waits until that very process listens on the socket;
 *   - on kill, removes leftover files only for a display it started itself.
 */

export const DEFAULT_DISPLAY_BASE = 500;
export const DEFAULT_DISPLAY_SPAN = 200;
const READY_TIMEOUT_MS = 10_000;
const PENDING_EXIT_WAIT_MS = 3_000;
const MAX_SPAWN_ATTEMPTS = 5;
const LISTENING = 0x10000; // __SO_ACCEPTCON in /proc/net/unix Flags

/** Display number from a DISPLAY value (`:N`, `:N.S`); null for anything else (hosts, empty). */
export function parseDisplayNumber(value) {
  const m = /^:(\d+)(?:\.\d+)?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** Listening X sockets from /proc/net/unix text: [{ display, abstract, inode }]. */
export function listeningXSockets(procNetUnixText, socketDir = '/tmp/.X11-unix') {
  const out = [];
  const prefixes = [`${socketDir}/X`, `@${socketDir}/X`];
  for (const line of String(procNetUnixText || '').split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const flags = Number.parseInt(cols[3], 16);
    if (!Number.isFinite(flags) || !(flags & LISTENING)) continue;
    const socketPath = cols.slice(7).join(' ');
    const prefix = prefixes.find((p) => socketPath.startsWith(p));
    if (!prefix) continue;
    const rest = socketPath.slice(prefix.length);
    if (!/^\d+$/.test(rest)) continue;
    out.push({ display: Number(rest), abstract: prefix.startsWith('@'), inode: Number(cols[6]) });
  }
  return out;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLockPid(lockFile) {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
    return Number.isSafeInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Why display `n` is taken, or null when it is free. A stale lock (dead PID) or a
 * socket file nobody listens on does not count: Xvfb clears those itself.
 */
export function displayInUse(n, {
  socketDir = '/tmp/.X11-unix',
  lockDir = '/tmp',
  procNetUnix = '/proc/net/unix',
  isAlive = pidAlive,
} = {}) {
  if (listeningXSockets(readText(procNetUnix), socketDir).some((s) => s.display === n)) return 'listening socket';
  const lockPid = readLockPid(path.join(lockDir, `.X${n}-lock`));
  if (lockPid !== null && isAlive(lockPid)) return `lock held by pid ${lockPid}`;
  return null;
}

/** First display number worth trying: the assigned one when free, else the first free one from `base`. */
export function pickDisplay({ assigned = null, base = DEFAULT_DISPLAY_BASE, span = DEFAULT_DISPLAY_SPAN, exclude = new Set(), inUse }) {
  let assignedBusy = null;
  if (assigned !== null && !exclude.has(assigned)) {
    assignedBusy = inUse(assigned);
    if (!assignedBusy) return { display: assigned, assigned: true, assignedBusy: null };
  }
  for (let n = base; n < base + span; n++) {
    if (exclude.has(n) || n === assigned) continue;
    if (!inUse(n)) return { display: n, assigned: false, assignedBusy };
  }
  return { display: null, assigned: false, assignedBusy };
}

/** Socket inodes a process holds open (empty when unreadable). */
function socketInodes(pid) {
  const inodes = new Set();
  let fds;
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return inodes;
  }
  for (const fd of fds) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (m) inodes.add(Number(m[1]));
    } catch { /* fd closed meanwhile */ }
  }
  return inodes;
}

/** True once process `pid` listens on display `n` (path or abstract socket). */
export function listensOn(pid, n, { socketDir = '/tmp/.X11-unix', procNetUnix = '/proc/net/unix' } = {}) {
  const sockets = listeningXSockets(readText(procNetUnix), socketDir).filter((s) => s.display === n);
  if (sockets.length === 0) return false;
  const inodes = socketInodes(pid);
  return sockets.some((s) => inodes.has(s.inode));
}

// Exits of Xvfb processes this module started and asked to stop, so a relaunch
// can wait for its old display to be released before picking one.
const pendingExits = new Set();

/**
 * Subclass of camoufox-js VirtualDisplay with safe display selection.
 * Options: `assignedDisplay` (a DISPLAY value), `base`/`span` (scan range),
 * `socketDir`/`lockDir`/`procNetUnix` (for tests), `log(level, msg, fields)`.
 */
export function createSafeVirtualDisplay(Base, options = {}) {
  const {
    assignedDisplay = null,
    base = DEFAULT_DISPLAY_BASE,
    span = DEFAULT_DISPLAY_SPAN,
    socketDir = '/tmp/.X11-unix',
    lockDir = '/tmp',
    procNetUnix = '/proc/net/unix',
    readyTimeoutMs = READY_TIMEOUT_MS,
    log = () => {},
  } = options;
  const assigned = parseDisplayNumber(assignedDisplay);
  const probe = { socketDir, lockDir, procNetUnix };

  return class SafeVirtualDisplay extends Base {
    /** The display number this instance runs Xvfb on (null before get()). */
    get display() {
      return this._display ?? null;
    }

    /** Whether the display is the assigned one (DISPLAY). */
    get displayAssigned() {
      return this._displayAssigned === true;
    }

    async get() {
      Base.assert_linux();
      if (this.proc) return `:${this._display}`;

      if (pendingExits.size > 0) {
        await Promise.race([
          Promise.allSettled([...pendingExits]),
          new Promise((r) => setTimeout(r, PENDING_EXIT_WAIT_MS)),
        ]);
      }

      const tried = new Set();
      for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS; attempt++) {
        const pick = pickDisplay({ assigned, base, span, exclude: tried, inUse: (n) => displayInUse(n, probe) });
        if (pick.assignedBusy && attempt === 1) {
          log('warn', 'assigned display is in use; picking a free one', { assigned: `:${assigned}`, reason: pick.assignedBusy });
        }
        if (pick.display === null) break;
        tried.add(pick.display);
        const started = await this._startXvfb(pick.display);
        if (started) {
          this._displayAssigned = pick.assigned;
          return `:${this._display}`;
        }
        log('warn', 'xvfb could not take display; trying another', { display: `:${pick.display}`, attempt });
      }
      throw new Error(`no free X display for Xvfb (assigned ${assigned === null ? 'none' : `:${assigned}`}, scanned :${base}-:${base + span - 1})`);
    }

    async _startXvfb(n) {
      const proc = spawn(this.xvfb_path, [`:${n}`, ...this.xvfb_args], {
        stdio: ['ignore', this.debug ? 'inherit' : 'ignore', this.debug ? 'inherit' : 'ignore'],
        detached: true,
        env: {
          ...process.env,
          __GLX_VENDOR_LIBRARY_NAME: 'mesa',
          LIBGL_ALWAYS_SOFTWARE: '1',
        },
      });
      let exited = false;
      const exit = new Promise((resolve) => {
        proc.once('exit', () => { exited = true; resolve(); });
        proc.once('error', () => { exited = true; resolve(); });
      });

      const deadline = Date.now() + readyTimeoutMs;
      while (!exited && Date.now() < deadline) {
        if (proc.pid && listensOn(proc.pid, n, probe)) {
          this.proc = proc;
          this._display = n;
          this._exit = exit;
          return true;
        }
        await Promise.race([exit, new Promise((r) => setTimeout(r, 50))]);
      }
      if (!exited) {
        proc.kill('SIGKILL');
        await exit;
      }
      return false;
    }

    kill() {
      const proc = this.proc;
      if (!proc || this._killRequested || proc.exitCode !== null || proc.signalCode !== null) return;
      this._killRequested = true;
      const n = this._display;
      const exit = this._exit.then(() => {
        pendingExits.delete(exit);
        this._removeLeftovers(n, proc.pid);
      });
      pendingExits.add(exit);
      if (this.debug) console.log('Terminating virtual display:', n);
      proc.kill();
    }

    /** After our Xvfb exited: remove its lock and socket files if they are still ours. */
    _removeLeftovers(n, pid) {
      const lockFile = path.join(lockDir, `.X${n}-lock`);
      if (readLockPid(lockFile) !== pid) return;
      for (const file of [path.join(socketDir, `X${n}`), lockFile]) {
        try {
          fs.unlinkSync(file);
        } catch { /* already gone */ }
      }
    }
  };
}
