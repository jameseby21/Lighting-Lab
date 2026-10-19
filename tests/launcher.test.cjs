/* The documented root command must work without ignored source files or personal profiles. */
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

test('root launcher starts the tracked app and serves its complete module set', async t => {
  const root = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['server.cjs'], {cwd: root, windowsHide: true,
    env: {...process.env, LIGHTING_LAB_PORT: '0', LIGHTING_LAB_HOST: '127.0.0.1'},
    stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Root startup timed out: ' + output)), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Lighting Lab: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited ${code}: ${output}`)); });
  });
  for (const route of ['/', '/ui.js', '/core.js', '/effects.js', '/styles.css']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert((await response.text()).length > 100, route + ' must contain real source');
  }
  assert(!output.includes('docs/background/keyboard-layout'), 'source launcher must not depend on ignored assets');
});

test('Windows launcher enters its own root, reports a missing Node runtime, then opens the local editor', () => {
  const launcher = fs.readFileSync(path.resolve(__dirname, '..', 'Start Lighting Lab.cmd'), 'utf8');
  assert.match(launcher, /cd \/d "%~dp0"/);
  assert.match(launcher, /where node >nul 2>nul/);
  assert.match(launcher, /Node\.js 22 or newer/);
  assert.match(launcher, /Start-Process 'http:\/\/localhost:4318'/);
  assert.match(launcher, /node server\.cjs/);
});