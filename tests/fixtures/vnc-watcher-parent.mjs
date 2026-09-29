#!/usr/bin/env node
// Stands in for the Camofox server in vnc-watcher tests: starts a stand-in Xvfb
// (tests/fixtures/fake-xvfb.mjs, shown as ".../Xvfb" in ps) on $FAKE_DISPLAY and
// then the watcher ($WATCHER_SHELL vnc-watcher.sh), both as its children.
// Prints {"xvfb":pid,"watcher":pid} on stdout and stays alive until killed.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const resolution = process.env.VNC_RESOLUTION;

const xvfb = spawn(process.execPath, [path.join(here, 'fake-xvfb.mjs'), `:${process.env.FAKE_DISPLAY}`, '-screen', '0', resolution], {
  argv0: path.join(process.env.STUB_DIR, 'Xvfb'),
  stdio: 'ignore',
  env: { ...process.env, FAKE_XVFB_LOCK_DIR: process.env.X11_LOCK_DIR, FAKE_XVFB_SOCKET_DIR: process.env.X11_SOCKET_DIR },
});

const watcher = spawn(process.env.WATCHER_SHELL || 'sh', [path.join(root, 'plugins', 'vnc', 'vnc-watcher.sh')], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: process.env,
});

process.stdout.write(`${JSON.stringify({ xvfb: xvfb.pid, watcher: watcher.pid })}\n`);
setInterval(() => {}, 1000);
