/*
 * Startup experience: `node server.cjs` from the repo root and the double-click "Start Lighting Lab.cmd".
 *
 * Starts the real server as a child process on a random port (127.0.0.1), fetches every served module,
 * checks the .cmd launcher text (Node 22+ gate, winget hint, --open, CRLF line endings), and simulates a
 * second double-click on a busy port, which must report "already running" and exit 0.
 * Part of `npm test` (node --test tests/*.test.cjs); also run by CI on windows-latest.
 * Needs: nothing but Node. The real server only reads Chroma status (no Apply is sent), so real lighting
 * is never changed.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Regression from the monorepo split: the server must not depend on any ignored or private file to boot.
test('root launcher starts the tracked app and serves its complete module set', async (t) => {
  const root = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, LIGHTING_LAB_PORT: '0', LIGHTING_LAB_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Root startup timed out: ' + output)), 5000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Lighting Lab: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Startup exited ${code}: ${output}`));
    });
  });
  for (const route of ['/', '/ui.js', '/core.js', '/effects.js', '/styles.css']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert((await response.text()).length > 100, route + ' must contain real source');
  }
  assert(
    !output.includes('docs/background/keyboard-layout'),
    'source launcher must not depend on ignored assets',
  );
});

test('Windows launcher enters its own root, reports a missing Node runtime, then opens the local editor', () => {
  const launcher = fs.readFileSync(path.resolve(__dirname, '..', 'Start Lighting Lab.cmd'), 'utf8');
  assert.match(launcher, /cd \/d "%~dp0"/);
  assert.match(launcher, /where node >nul 2>nul/);
  assert.match(launcher, /Node\.js 22 or newer/);
  // The server opens the browser itself once it is really listening (no blind 2-second sleep).
  assert.match(launcher, /node server\.cjs --open/);
  // A too-old Node gets a specific message instead of a cryptic syntax error later.
  assert.match(launcher, /process\.versions\.node/);
  assert.match(launcher, /winget install OpenJS\.NodeJS\.LTS/);
  // cmd.exe can mis-parse LF-only batch files; .gitattributes pins CRLF and this guards the working copy.
  const bytes = fs.readFileSync(path.resolve(__dirname, '..', 'Start Lighting Lab.cmd'), 'latin1');
  assert.equal(bytes.split('\n').length - 1, bytes.split('\r\n').length - 1, 'every line must end in CRLF');
});

// Double-clicking the launcher twice is the most common "it did not start" report; the second copy must defer to the first.
test('a second launch reports the running copy instead of crashing on a busy port', async (t) => {
  const root = path.resolve(__dirname, '..');
  const start = (port) => {
    const child = spawn(process.execPath, ['server.cjs'], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, LIGHTING_LAB_PORT: String(port), LIGHTING_LAB_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.output = '';
    child.stdout.on('data', (chunk) => (child.output += chunk));
    child.stderr.on('data', (chunk) => (child.output += chunk));
    child.exited = new Promise((resolve) => child.once('exit', resolve));
    return child;
  };
  const first = start(0);
  t.after(async () => {
    if (first.exitCode === null) first.kill();
    await first.exited;
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('first server did not start: ' + first.output)), 5000);
    first.stdout.on('data', () => {
      const match = first.output.match(/Lighting Lab: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  const second = start(port);
  const code = await second.exited;
  assert.equal(code, 0, second.output);
  assert.match(second.output, /already running/);
});

test('a default launch reuses an older copy bound to 0.0.0.0 instead of starting a second server', async (t) => {
  // LL-065: Windows allows 127.0.0.1:PORT next to 0.0.0.0:PORT, so the busy-port error never fired and two
  // Lighting Labs streamed to the same keyboard (seen on the dev PC: 1.8 M frames from a forgotten old copy).
  const root = path.resolve(__dirname, '..');
  const start = (env) => {
    const child = spawn(process.execPath, ['server.cjs'], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.output = '';
    child.stdout.on('data', (chunk) => (child.output += chunk));
    child.stderr.on('data', (chunk) => (child.output += chunk));
    child.exited = new Promise((resolve) => child.once('exit', resolve));
    return child;
  };
  const old = start({ LIGHTING_LAB_PORT: '0', LIGHTING_LAB_HOST: '0.0.0.0' });
  t.after(async () => {
    if (old.exitCode === null) old.kill();
    await old.exited;
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('old copy did not start: ' + old.output)), 5000);
    old.stdout.on('data', () => {
      const match = old.output.match(/Lighting Lab: http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const fresh = start({ LIGHTING_LAB_PORT: port, LIGHTING_LAB_HOST: '' });
  const code = await fresh.exited;
  assert.equal(code, 0, fresh.output);
  assert.match(fresh.output, /already running/);
  assert.doesNotMatch(fresh.output, /Lighting Lab: http/, 'no second server may start');
});
