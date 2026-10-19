/* Explicit real-provider smoke check, excluded from the automated fake-device test suite. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.LIGHTING_LAB_URL || 'http://127.0.0.1:4318';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(route, body) {
  const response = await fetch(base + route, {signal: AbortSignal.timeout(20_000),
    ...(body ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {})});
  const data = await response.json();
  assert(response.ok, `${route}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const started = await request('/api/status');
  console.log(JSON.stringify({server: base, device: started.device, sdk: started.sdk}, null, 2));
  if (!process.argv.includes('--exercise')) {
    console.log('Read-only status check. Add --exercise to temporarily change real RGB and release/restore it.');
    return;
  }
  assert(started.sdk.available, 'Chroma SDK must be available for a real-provider check.');
  const evidence = {at: new Date().toISOString(), before: started, exercised: [],
    acceptance: 'SDK acknowledgements only; physical color, mapping, mouse and visual timing need user acceptance.'};
  const root = path.resolve(__dirname, '..');
  const destination = path.join(root, '.artifacts/lighting-lab/live-smoke.json');
  await fs.mkdir(path.dirname(destination), {recursive: true});
  // Preserve the pre-test state before any actual RGB request.
  await fs.writeFile(destination, JSON.stringify(evidence, null, 2));
  try {
    for (const effect of ['matrix', 'stars-stripes', 'rainbow-road', 'chaos']) {
      const selection = {provider: 'chroma-sdk', effect, keyboardModel: 'razer-blackwidow-elite',
        anchors: ['Q', 'W', 'E', 'R', 'T'], protectedAnchors: ['ESC'], speed: 3.5,
        feedback: 'reactive',keywordFeedback:'reactive',protectAnchors:false,force:true};
      await request('/api/apply', selection);
      const first = await request('/api/status');
      await wait(250);
      const feedback = await request('/api/key-press', {key: 'NUM_DECIMAL'});
      const later = await request('/api/status');
      assert.equal(later.sdk.active.effect, effect);
      assert(later.sdk.frames > first.sdk.frames, effect + ' must send successive accepted frames');
      assert.equal(later.sdk.lastError, null);
      assert.equal(feedback.accepted, true);
      evidence.exercised.push({effect, framesBefore: first.sdk.frames, framesAfter: later.sdk.frames,
        feedbackAccepted: feedback.accepted, lastError: later.sdk.lastError});
      console.log(`${effect}: ${later.sdk.frames - first.sdk.frames} additional accepted frames; feedback accepted.`);
    }
  } finally {
    if (started.selection) await request('/api/apply', started.selection);
    else await request('/api/release', {});
    evidence.after = await request('/api/status');
    await fs.writeFile(destination, JSON.stringify(evidence, null, 2));
  }
  console.log('Real Chroma API exercise finished; previous session restored or temporary session released.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
