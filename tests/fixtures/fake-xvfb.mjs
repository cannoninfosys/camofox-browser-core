#!/usr/bin/env node
// Stand-in for Xvfb in unit tests: `fake-xvfb.mjs :N ...` writes the lock file
// ($FAKE_XVFB_LOCK_DIR/.XN-lock, padded like Xvfb's) and listens on
// $FAKE_XVFB_SOCKET_DIR/XN until SIGTERM, then removes both.
// $FAKE_XVFB_FAIL_ON (comma-separated numbers): exit 1 at once for those displays.
// $FAKE_XVFB_KEEP_FILES=1: leave the lock and socket behind on exit (like a crash).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const display = Number(String(process.argv[2] || '').replace(/^:/, ''));
const lockDir = process.env.FAKE_XVFB_LOCK_DIR;
const socketDir = process.env.FAKE_XVFB_SOCKET_DIR;
const failOn = (process.env.FAKE_XVFB_FAIL_ON || '').split(',').filter(Boolean).map(Number);

if (!Number.isSafeInteger(display) || !lockDir || !socketDir) process.exit(2);
if (failOn.includes(display)) process.exit(1);

const lock = path.join(lockDir, `.X${display}-lock`);
const socket = path.join(socketDir, `X${display}`);
fs.writeFileSync(lock, `${String(process.pid).padStart(10)}\n`);
try { fs.unlinkSync(socket); } catch { /* none */ }
const server = net.createServer();
server.listen(socket);

const stop = () => {
  if (process.env.FAKE_XVFB_KEEP_FILES === '1') process.exit(0);
  server.close();
  try { fs.unlinkSync(lock); } catch { /* gone */ }
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
