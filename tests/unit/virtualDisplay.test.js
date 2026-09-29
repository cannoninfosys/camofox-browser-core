import { afterEach, describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VirtualDisplay } from 'camoufox-js/dist/virtdisplay.js';
import {
  createSafeVirtualDisplay,
  displayInUse,
  listeningXSockets,
  listensOn,
  parseDisplayNumber,
  pickDisplay,
} from '../../lib/virtual-display.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_XVFB = path.join(here, '..', 'fixtures', 'fake-xvfb.mjs');
const isLinux = os.platform() === 'linux';
const linuxTest = isLinux ? test : test.skip;

const tempDirs = [];
const servers = [];
const displays = [];
const savedEnv = { ...process.env };

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vd-test-'));
  tempDirs.push(root);
  const socketDir = path.join(root, '.X11-unix');
  fs.mkdirSync(socketDir);
  return { root, socketDir, lockDir: root };
}

async function listen(socketPath) {
  const server = net.createServer();
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

function procNetUnixLine({ flags = '00010000', state = '01', inode = 1000, socketPath }) {
  return `0000000000000000: 00000002 00000000 ${flags} 0001 ${state} ${inode} ${socketPath}`;
}

function procNetUnix(lines) {
  return ['Num       RefCount Protocol Flags    Type St Inode Path', ...lines].join('\n');
}

function waitForExit(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => proc.once('exit', resolve));
}

afterEach(async () => {
  process.env = { ...savedEnv };
  for (const d of displays.splice(0)) {
    d.kill();
    await waitForExit(d.proc);
  }
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseDisplayNumber', () => {
  test('accepts :N and :N.S', () => {
    expect(parseDisplayNumber(':0')).toBe(0);
    expect(parseDisplayNumber(':101')).toBe(101);
    expect(parseDisplayNumber(':7.0')).toBe(7);
  });

  test('rejects remote, empty and malformed values', () => {
    for (const value of [undefined, null, '', 'localhost:10.0', ':x', '101', ': 1']) {
      expect(parseDisplayNumber(value)).toBeNull();
    }
  });
});

describe('listeningXSockets', () => {
  test('keeps listening path and abstract X sockets, drops connections and other paths', () => {
    const text = procNetUnix([
      procNetUnixLine({ inode: 1, socketPath: '/tmp/.X11-unix/X0' }),
      procNetUnixLine({ inode: 2, socketPath: '@/tmp/.X11-unix/X938' }),
      procNetUnixLine({ inode: 3, flags: '00000000', state: '03', socketPath: '/tmp/.X11-unix/X5' }),
      procNetUnixLine({ inode: 4, socketPath: '/tmp/.X11-unix/X0_' }),
      procNetUnixLine({ inode: 5, socketPath: '/run/user/1000/bus' }),
    ]);

    expect(listeningXSockets(text)).toEqual([
      { display: 0, abstract: false, inode: 1 },
      { display: 938, abstract: true, inode: 2 },
    ]);
  });
});

describe('displayInUse', () => {
  test('a listener counts even when its socket file was unlinked (Xwayland :0)', () => {
    const { root, socketDir, lockDir } = tempRoot();
    const procFile = path.join(root, 'unix');
    fs.writeFileSync(procFile, procNetUnix([procNetUnixLine({ socketPath: `${socketDir}/X0` })]));

    expect(fs.existsSync(path.join(socketDir, 'X0'))).toBe(false);
    expect(displayInUse(0, { socketDir, lockDir, procNetUnix: procFile })).toBe('listening socket');
  });

  test('an abstract listener counts (another server behind PrivateTmp)', () => {
    const { root, socketDir, lockDir } = tempRoot();
    const procFile = path.join(root, 'unix');
    fs.writeFileSync(procFile, procNetUnix([procNetUnixLine({ socketPath: `@${socketDir}/X101` })]));

    expect(displayInUse(101, { socketDir, lockDir, procNetUnix: procFile })).toBe('listening socket');
  });

  test('a lock naming a live process counts; a stale lock or socket file does not', () => {
    const { root, socketDir, lockDir } = tempRoot();
    const procFile = path.join(root, 'unix');
    fs.writeFileSync(procFile, procNetUnix([]));
    fs.writeFileSync(path.join(lockDir, '.X7-lock'), `${String(process.pid).padStart(10)}\n`);
    fs.writeFileSync(path.join(lockDir, '.X8-lock'), '    999999\n');
    fs.writeFileSync(path.join(socketDir, 'X9'), '');
    const opts = { socketDir, lockDir, procNetUnix: procFile, isAlive: (pid) => pid === process.pid };

    expect(displayInUse(7, opts)).toBe(`lock held by pid ${process.pid}`);
    expect(displayInUse(8, opts)).toBeNull();
    expect(displayInUse(9, opts)).toBeNull();
  });
});

describe('pickDisplay', () => {
  test('uses the assigned display when it is free', () => {
    expect(pickDisplay({ assigned: 101, inUse: () => null })).toEqual({ display: 101, assigned: true, assignedBusy: null });
  });

  test('falls back to the scan when the assigned display is taken', () => {
    const busy = new Set([0, 500]);
    const pick = pickDisplay({ assigned: 0, base: 500, inUse: (n) => (busy.has(n) ? 'listening socket' : null) });
    expect(pick).toEqual({ display: 501, assigned: false, assignedBusy: 'listening socket' });
  });

  test('scans upward from the base, skipping taken and excluded numbers', () => {
    const pick = pickDisplay({ base: 500, exclude: new Set([501]), inUse: (n) => (n === 500 ? 'x' : null) });
    expect(pick.display).toBe(502);
  });

  test('returns no display when the range is exhausted', () => {
    expect(pickDisplay({ base: 500, span: 3, inUse: () => 'x' }).display).toBeNull();
  });
});

function fakeDisplayClass(dirs, options = {}) {
  const Safe = createSafeVirtualDisplay(VirtualDisplay, {
    socketDir: dirs.socketDir,
    lockDir: dirs.lockDir,
    base: 600,
    span: 20,
    readyTimeoutMs: 5000,
    ...options,
  });
  return class extends Safe {
    get xvfb_path() {
      return FAKE_XVFB;
    }
  };
}

describe('SafeVirtualDisplay with a stand-in Xvfb', () => {
  function useFake(dirs, failOn = '') {
    process.env.FAKE_XVFB_LOCK_DIR = dirs.lockDir;
    process.env.FAKE_XVFB_SOCKET_DIR = dirs.socketDir;
    process.env.FAKE_XVFB_FAIL_ON = failOn;
  }

  linuxTest('honors a free assigned display and never passes -displayfd', async () => {
    const dirs = tempRoot();
    useFake(dirs);
    const Display = fakeDisplayClass(dirs, { assignedDisplay: ':101' });
    const d = new Display();
    displays.push(d);

    expect(await d.get()).toBe(':101');
    expect(d.displayAssigned).toBe(true);
    expect(d.proc.spawnargs).not.toContain('-displayfd');
    expect(d.proc.spawnargs.slice(0, 2)).toEqual([FAKE_XVFB, ':101']);
    expect(listensOn(d.proc.pid, 101, { socketDir: dirs.socketDir })).toBe(true);
  });

  linuxTest('picks another display when the assigned one has a live holder', async () => {
    const dirs = tempRoot();
    useFake(dirs);
    await listen(path.join(dirs.socketDir, 'X101'));
    const warnings = [];
    const Display = fakeDisplayClass(dirs, { assignedDisplay: ':101', log: (level, msg) => warnings.push([level, msg]) });
    const d = new Display();
    displays.push(d);

    expect(await d.get()).toBe(':600');
    expect(d.displayAssigned).toBe(false);
    expect(warnings).toContainEqual(['warn', 'assigned display is in use; picking a free one']);
  });

  linuxTest('moves on when Xvfb cannot take the picked display', async () => {
    const dirs = tempRoot();
    useFake(dirs, '600,601');
    const d = new (fakeDisplayClass(dirs))();
    displays.push(d);

    expect(await d.get()).toBe(':602');
  });

  linuxTest('kill() removes leftovers only while the lock is still ours', async () => {
    const dirs = tempRoot();
    useFake(dirs);
    process.env.FAKE_XVFB_KEEP_FILES = '1';
    const d = new (fakeDisplayClass(dirs))();
    await d.get();
    const socket = path.join(dirs.socketDir, 'X600');
    const lock = path.join(dirs.lockDir, '.X600-lock');
    const proc = d.proc;
    const exited = waitForExit(proc);

    d.kill();
    await exited;
    await new Promise((r) => setImmediate(r));

    expect(fs.existsSync(socket)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
  });

  linuxTest('kill() leaves another server\'s files alone', async () => {
    const dirs = tempRoot();
    useFake(dirs);
    process.env.FAKE_XVFB_KEEP_FILES = '1';
    const d = new (fakeDisplayClass(dirs))();
    await d.get();
    const lock = path.join(dirs.lockDir, '.X600-lock');
    const exited = waitForExit(d.proc);
    const originalKill = d.proc.kill.bind(d.proc);
    // Another server takes the display (new lock) while ours shuts down.
    d.proc.kill = (sig) => {
      fs.writeFileSync(lock, '         1\n');
      return originalKill(sig);
    };

    d.kill();
    await exited;
    await new Promise((r) => setImmediate(r));

    expect(fs.readFileSync(lock, 'utf8').trim()).toBe('1');
    expect(fs.existsSync(path.join(dirs.socketDir, 'X600'))).toBe(true);
  });

  linuxTest('a relaunch right after kill() gets the assigned display back', async () => {
    const dirs = tempRoot();
    useFake(dirs);
    const Display = fakeDisplayClass(dirs, { assignedDisplay: ':101' });
    const first = new Display();
    expect(await first.get()).toBe(':101');

    first.kill();
    const second = new Display();
    displays.push(second);

    expect(await second.get()).toBe(':101');
    expect(second.displayAssigned).toBe(true);
  });
});

function hasXvfb() {
  try {
    execFileSync('which', ['Xvfb'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('SafeVirtualDisplay with the real Xvfb', () => {
  const realTest = isLinux && hasXvfb() ? test : test.skip;

  realTest('starts on a display no other X server holds', async () => {
    const zeroBusy = displayInUse(0);
    const Safe = createSafeVirtualDisplay(VirtualDisplay, { assignedDisplay: zeroBusy ? ':0' : null });
    const d = new Safe();
    displays.push(d);

    const display = await d.get();
    const n = parseDisplayNumber(display);

    expect(n).not.toBeNull();
    if (zeroBusy) expect(n).not.toBe(0);
    expect(listensOn(d.proc.pid, n)).toBe(true);
    expect(d.proc.spawnargs).not.toContain('-displayfd');

    const exited = waitForExit(d.proc);
    d.kill();
    await exited;
    expect(listensOn(d.proc.pid, n)).toBe(false);
  });
});
