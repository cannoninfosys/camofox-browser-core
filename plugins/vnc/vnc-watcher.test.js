import { afterEach, describe, expect, test } from '@jest/globals';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const library = path.join(here, 'vnc-watcher-lib.sh');
const tempDirs = [];
const servers = [];

function shell(script, args = [], input = '') {
  return execFileSync('sh', ['-c', `. "$1"; ${script}`, 'sh', library, ...args], {
    input,
    encoding: 'utf8',
  }).trim();
}

async function unixSocket(socketPath) {
  const server = net.createServer();
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('vnc watcher helpers', () => {
  test('finds only the owned -displayfd Xvfb process', () => {
    const processes = [
      '100 7 /usr/bin/Xvfb -displayfd 3 -screen 0 1920x1080x24',
      '200 8 /usr/bin/Xvfb -displayfd 3 -screen 0 1920x1080x24',
      '300 7 /usr/bin/other -screen 0 1920x1080x24',
    ].join('\n');

    expect(shell('find_owned_xvfb_pid 7 1920x1080x24', [], processes)).toBe('100');
  });

  test('maps the owned Xvfb PID through its lock file and real Unix socket', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-test-'));
    tempDirs.push(root);
    const sockets = path.join(root, '.X11-unix');
    fs.mkdirSync(sockets);
    fs.writeFileSync(path.join(root, '.X0-lock'), '111\n');
    fs.writeFileSync(path.join(root, '.X7-lock'), '222\n');
    await unixSocket(path.join(sockets, 'X0'));
    await unixSocket(path.join(sockets, 'X7'));

    expect(shell('display_for_xvfb_pid "$2" "$3" "$4"', ['222', root, sockets])).toBe(':7');
  });

  test('maps lock-free -displayfd sockets through the owned PID in procfs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-test-'));
    tempDirs.push(root);
    const sockets = path.join(root, '.X11-unix');
    const procRoot = path.join(root, 'proc');
    const fdDir = path.join(procRoot, '222', 'fd');
    fs.mkdirSync(sockets);
    fs.mkdirSync(fdDir, { recursive: true });
    fs.mkdirSync(path.join(procRoot, 'net'));
    await unixSocket(path.join(sockets, 'X7'));
    fs.symlinkSync('socket:[98765]', path.join(fdDir, '5'));
    fs.writeFileSync(
      path.join(procRoot, 'net', 'unix'),
      `Num RefCount Protocol Flags Type St Inode Path\n000: 2 0 00010000 1 01 98765 ${sockets}/X7\n`,
    );

    expect(shell('display_for_xvfb_pid "$2" "$3" "$4" "$5"', ['222', root, sockets, procRoot])).toBe(':7');
  });

  test('rejects another process lock and non-socket files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-test-'));
    tempDirs.push(root);
    const sockets = path.join(root, '.X11-unix');
    fs.mkdirSync(sockets);
    fs.writeFileSync(path.join(root, '.X0-lock'), '111\n');
    fs.writeFileSync(path.join(sockets, 'X0'), 'not a socket');

    expect(shell('display_for_xvfb_pid "$2" "$3" "$4"', ['111', root, sockets])).toBe('');
    expect(shell('display_for_xvfb_pid "$2" "$3" "$4"', ['222', root, sockets])).toBe('');
  });

  test('requests reattachment only after the tracked process exits', () => {
    expect(shell('if x11vnc_needs_reattach "$2"; then echo yes; else echo no; fi', [String(process.pid)])).toBe('no');
    expect(shell('if x11vnc_needs_reattach 99999999; then echo yes; else echo no; fi')).toBe('yes');
    expect(shell('if x11vnc_needs_reattach ""; then echo yes; else echo no; fi')).toBe('no');
  });

  test('server_alive: the server is alive and still our parent', () => {
    // The shell's parent is this test process.
    expect(shell('if server_alive "$2" "$$"; then echo yes; else echo no; fi', [String(process.pid)])).toBe('yes');
    expect(shell('if server_alive 1 "$$"; then echo yes; else echo no; fi')).toBe('no');
    expect(shell('if server_alive 99999999 "$$"; then echo yes; else echo no; fi')).toBe('no');
    expect(shell('if server_alive "" "$$"; then echo yes; else echo no; fi')).toBe('no');
  });

  test('current_ppid reads field 4 even when the command name has spaces and parentheses', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-test-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, '123'));
    fs.writeFileSync(path.join(root, '123', 'stat'), '123 (odd) name) S 77 123 123 0 -1 4194304\n');

    expect(shell('current_ppid 123 "$2"', [root])).toBe('77');
  });
});

// --- Lifecycle: the watcher, its x11vnc and websockify end with the server ---

const WATCHER_SHELL = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v dash'], { encoding: 'utf8' }).trim() || 'sh';
  } catch {
    return 'sh';
  }
})();
const parentScript = path.join(here, '..', '..', 'tests', 'fixtures', 'vnc-watcher-parent.mjs');
const children = [];

function running(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0] !== 'Z';
  } catch {
    return false;
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function writeStub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

async function startWatcherUnderParent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-life-'));
  tempDirs.push(root);
  const stubDir = path.join(root, 'bin');
  const sockets = path.join(root, '.X11-unix');
  const novnc = path.join(root, 'novnc');
  for (const dir of [stubDir, sockets, novnc]) fs.mkdirSync(dir);
  // websockify: records its PID and waits. x11vnc: records its PID and ignores
  // SIGTERM (like an x11vnc whose X server is gone), so only KILL ends it.
  writeStub(stubDir, 'websockify', `echo $$ > "${root}/websockify.pid"; exec sleep 1000`);
  writeStub(stubDir, 'x11vnc', `echo $$ > "${root}/x11vnc.pid"; trap '' TERM; exec sleep 1000`);

  const statusFile = path.join(root, 'status');
  const parent = spawn(process.execPath, [parentScript], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      STUB_DIR: stubDir,
      NOVNC_DIR: novnc,
      X11_LOCK_DIR: root,
      X11_SOCKET_DIR: sockets,
      FAKE_DISPLAY: '7',
      VNC_RESOLUTION: '1234x567x24',
      VNC_PORT: '15999',
      NOVNC_PORT: '16999',
      VNC_STATUS_FILE: statusFile,
      STOP_GRACE_TENTHS: '10',
      WATCHER_SHELL,
    },
  });
  children.push(parent);
  const pids = await new Promise((resolve, reject) => {
    let buf = '';
    parent.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('\n')) resolve(JSON.parse(buf));
    });
    parent.once('exit', () => reject(new Error('parent exited early')));
  });
  pids.parent = parent.pid;
  children.push({ pid: pids.xvfb });
  await waitFor(() => fs.existsSync(statusFile), 15_000, 'x11vnc attached (status file)');
  pids.x11vnc = Number(fs.readFileSync(path.join(root, 'x11vnc.pid'), 'utf8'));
  pids.websockify = Number(fs.readFileSync(path.join(root, 'websockify.pid'), 'utf8'));
  children.push({ pid: pids.x11vnc }, { pid: pids.websockify }, { pid: pids.watcher });
  return { pids, statusFile, root };
}

const lifecycleTest = os.platform() === 'linux' ? test : test.skip;

describe(`vnc watcher lifecycle (${path.basename(WATCHER_SHELL)})`, () => {
  afterEach(() => {
    for (const child of children.splice(0)) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  lifecycleTest('attaches to the server\'s own Xvfb display', async () => {
    const { pids, statusFile } = await startWatcherUnderParent();

    expect(fs.readFileSync(statusFile, 'utf8').trim()).toBe(`:7 ${pids.x11vnc}`);
    expect(running(pids.watcher)).toBe(true);
    expect(running(pids.x11vnc)).toBe(true);
    expect(running(pids.websockify)).toBe(true);
  });

  lifecycleTest('exits with x11vnc and websockify when the server dies', async () => {
    const { pids, statusFile } = await startWatcherUnderParent();

    process.kill(pids.parent, 'SIGKILL');

    await waitFor(() => !running(pids.watcher), 8_000, 'watcher exit');
    await waitFor(() => !running(pids.x11vnc) && !running(pids.websockify), 3_000, 'x11vnc and websockify gone');
    expect(fs.existsSync(statusFile)).toBe(false);
  });

  lifecycleTest('SIGTERM stops the watcher, x11vnc (TERM-deaf, so KILLed) and websockify', async () => {
    const { pids } = await startWatcherUnderParent();

    process.kill(pids.watcher, 'SIGTERM');

    await waitFor(() => !running(pids.watcher), 8_000, 'watcher exit');
    await waitFor(() => !running(pids.x11vnc) && !running(pids.websockify), 3_000, 'x11vnc and websockify gone');
    expect(running(pids.parent)).toBe(true);
  });
});
