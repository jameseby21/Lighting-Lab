/*
 * Core engine regression suite: key geometry (core.js), the shared renderer (effects.js), validation
 * (lighting-domain.cjs), the Chroma REST provider (providers/chroma-sdk.cjs), device detection
 * (device-profile.cjs), and a few native-adapter contracts.
 *
 * Each test reproduces a real bug or design rule: Q/W coordinate shift, numpad identity, Matrix cadence,
 * reaction layering, session recovery after Synapse restarts, model-variant matching, mouse sync, etc.
 * Part of `npm test` (node --test tests/*.test.cjs); also run by CI on windows-latest.
 * Needs: nothing but Node. The Chroma provider runs against an in-memory fake fetch and fake clock;
 * device detection against a fake execFile. Real lighting: never changed.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const Plan = require('../core.js'),
  Effects = require('../effects.js');
const { validateSelection, createCustomKeyboardFrame } = require('../lighting-domain.cjs');
const { createChromaSdkProvider } = require('../providers/chroma-sdk.cjs');
const { detectDevice, identify } = require('../device-profile.cjs');
const settings = (extra) =>
  validateSelection({ effect: 'rainbow-road', provider: 'chroma-sdk', anchors: [], ...extra });
const rgbToBgr = Effects.bgr;

// Regression: an off-by-one in the Chroma grid once lit W-E-R-T-Y when the user selected Q-W-E-R-T.
test('QWERT aligns with the official SDK enumeration rather than lighting WERTY', () => {
  for (const [id, col] of [...'QWERT'].map((id, i) => [id, i + 2]))
    assert.deepEqual(Plan.chromaCoordinates[id], [2, col]);
  assert.deepEqual(Plan.chromaCoordinates['1'], [1, 2]);
  assert.deepEqual(Plan.chromaCoordinates.Z, [4, 3]);
  assert.deepEqual(Plan.chromaCoordinates.NUM_1, [4, 18]);
  const frame = createCustomKeyboardFrame('ghost', ['Q', 'W', 'E', 'R', 'T']).param;
  assert.equal(frame[2][1], 0);
  assert.equal(frame[2][2], 0x3300ff);
  assert.equal(frame[2][7], 0);
});

test('layouts expose every main switch, function key, navigation key and independent numpad', () => {
  const expected = {
    'standard-full-size': 104,
    'standard-iso': 105,
    'standard-tkl': 87,
    'standard-75': 84,
    'standard-65': 68,
    'standard-60': 61,
    'yunzii-al65': 68,
  };
  for (const [id, count] of Object.entries(expected)) {
    const layout = Plan.layoutForModel(id);
    assert.equal(layout.keys.length, count, id);
    assert.equal(new Set(layout.keys.map((k) => k.id)).size, count, id);
    assert(
      layout.keys.every(
        (k) =>
          Plan.chromaCoordinates[k.id] &&
          k.x >= 0 &&
          k.y >= 0 &&
          k.x + k.w <= layout.width &&
          k.y + k.h <= layout.height,
      ),
    );
    // Absolute unit geometry keeps the numpad beside the alphas instead of wrapping below them.
    for (let i = 0; i < layout.keys.length; i++)
      for (let j = i + 1; j < layout.keys.length; j++) {
        const a = layout.keys[i],
          b = layout.keys[j];
        assert(
          !(
            a.x < b.x + b.w - 0.001 &&
            a.x + a.w > b.x + 0.001 &&
            a.y < b.y + b.h - 0.001 &&
            a.y + a.h > b.y + 0.001
          ),
          `${id}: ${a.id} overlaps ${b.id}`,
        );
      }
  }
  const full = Plan.layoutForModel();
  assert(full.keys.find((k) => k.id === 'NUM_7').x > full.keys.find((k) => k.id === 'ENTER').x);
  assert.equal(Plan.layoutForModel('unrecognized').id, 'standard-full-size');
  assert.equal(Plan.layoutForModel('razer-ornata-v3').lighting, '10-zone');
});

test('full-size preview aligns the number row with Escape while preserving function-cluster gaps', () => {
  const keys = Plan.layoutForModel('standard-full-size').keys,
    byId = (id) => keys.find((key) => key.id === id);
  assert.equal(byId('`').x, byId('ESC').x);
  assert(byId('F1').x > byId('ESC').x + 1, 'Escape keeps its physical gap before F1');
  assert(byId('F5').x - byId('F4').x > 1, 'function clusters retain their deliberate gap');
});

test('physical browser events distinguish numpad, shifted characters, controls and ISO switches', () => {
  assert.equal(Plan.eventKey({ code: 'Digit1', key: '!' }), '1');
  assert.equal(Plan.eventKey({ code: 'Numpad1', key: 'End' }), 'NUM_1');
  assert.equal(Plan.eventKey({ code: 'NumpadDecimal', key: 'Delete' }), 'NUM_DECIMAL');
  assert.equal(Plan.eventKey({ code: 'NumpadEnter', key: 'Enter' }), 'NUM_ENTER');
  assert.equal(Plan.eventKey({ code: 'Enter', key: 'Enter' }), 'ENTER');
  assert.equal(Plan.eventKey({ code: 'IntlBackslash', key: '\\' }), 'ISO_BACKSLASH');
  assert.deepEqual(Plan.validate(['33']), []);
  assert(Plan.validate(['333']).length);
});

test('media silhouettes reflect documented model hardware without becoming fake RGB switches', () => {
  for (const id of ['razer-blackwidow-elite', 'razer-ornata-v2', 'razer-ornata-v3']) {
    const layout = Plan.layoutForModel(id);
    assert.equal(layout.keys.length, 104);
    assert.equal(layout.controls.length, 4);
    assert.equal(new Set([...layout.keys, ...layout.controls].map((part) => part.id)).size, 108);
    for (const control of layout.controls) {
      assert.equal(control.rgb, false);
      assert.equal(control.selectable, false);
      assert.equal(Plan.chromaCoordinates[control.id], undefined);
      assert(
        control.x >= 0 &&
          control.y >= 0 &&
          control.x + control.w <= layout.width &&
          control.y + control.h <= layout.height,
      );
      for (const part of [...layout.keys, ...layout.controls].filter((other) => other.id !== control.id)) {
        assert(
          !(
            control.x < part.x + part.w &&
            control.x + control.w > part.x &&
            control.y < part.y + part.h &&
            control.y + control.h > part.y
          ),
          `${id}: ${control.id} overlaps ${part.id}`,
        );
      }
    }
    assert.equal(
      layout.controls.filter((control) => control.type === 'dial').length,
      id === 'razer-ornata-v3' ? 0 : 1,
    );
  }
  assert.deepEqual(Plan.layoutForModel('standard-full-size').controls, []);
  assert.throws(() => settings({ anchors: ['HW_VOLUME_DIAL'] }), /No Chroma coordinate/);
});

test('custom view validates geometry while retaining stable transport coordinates', () => {
  const custom = Plan.layoutForModel('custom', [{ id: 'Q', label: 'Custom Q', x: 2, y: 1, w: 1, h: 1 }]);
  assert.equal(custom.keys[0].label, 'Custom Q');
  assert.deepEqual(Plan.chromaCoordinates.Q, [2, 2]);
  assert.throws(() => Plan.layoutForModel('custom', [{ id: 'Q', x: -1, y: 0 }]));
  assert.throws(() =>
    Plan.layoutForModel('custom', [
      { id: 'Q', x: 0, y: 0 },
      { id: 'Q', x: 1, y: 0 },
    ]),
  );
});

// Moving a key in Customize view must move where ripples travel (physical distance) without changing which LED the SDK addresses.
test('custom geometry edits update feedback paths even though the model ID and SDK coordinates stay unchanged', () => {
  const config = (keys) =>
    settings({ keyboardModel: 'custom', customLayout: keys, feedback: 'waterfall', minimalist: true });
  const inline = config([
    { id: 'Q', x: 0, y: 0 },
    { id: 'A', x: 0, y: 1 },
  ]);
  const moved = config([
    { id: 'Q', x: 0, y: 0 },
    { id: 'A', x: 5, y: 1 },
  ]);
  const events = [{ id: 'Q', at: 0 }];
  assert.equal(rgbToBgr(Effects.sample(inline, 'A', 150, events)), 0xffffff);
  assert.equal(rgbToBgr(Effects.sample(moved, 'A', 150, events)), 0);
  assert.equal(Effects.frame(moved, 150, events)[3][2], 0);
  assert.deepEqual(Plan.chromaCoordinates.A, [3, 2]);
  const ripple = { ...moved, feedback: 'ripple' };
  assert.equal(rgbToBgr(Effects.sample(ripple, 'A', 120, events)), 0);
  assert(rgbToBgr(Effects.sample(ripple, 'A', 570, events)) > 0);
});

// Pins the visual contract owners approved: exactly one lit Matrix row with a 3-7 row randomized dark gap; Stripes is one rising red/white row.
test('Matrix uses one falling green row with deterministic dark spacing; stripes use one rising alternating row', () => {
  const matrix = settings({ effect: 'matrix' }),
    start = Effects.frame(matrix, 0),
    later = Effects.frame(matrix, 1500);
  assert.notDeepEqual(start, later, 'matrix advances');
  assert(start.filter((row) => row[2] === 0x2df000).length <= 1, 'only one Matrix row is bright');
  assert(
    Effects.frame(matrix, 3000).some((row) => row[2] === 0),
    'Matrix includes dark spacing between lines',
  );
  const stripes = settings({ effect: 'stars-stripes' }),
    stripeStart = Effects.frame(stripes, 0),
    stripeLater = Effects.frame(stripes, 800);
  assert.notDeepEqual(stripeStart, stripeLater, 'stripes rise');
  assert.notEqual(stripeStart[0][2], stripeStart[1][2]);
  assert.equal(stripeStart[0][2], stripeStart[2][2]);
  assert(Effects.sample(matrix, 'F1', 0).green > 200);
});

test('Lighting Lab originals extend the native-style catalog with distinct rendered motion and reactions', () => {
  for (const effect of ['aurora', 'radar', 'prism']) assert(Effects.EFFECTS.includes(effect), effect);
  for (const reaction of ['pulse', 'sparkle', 'comet', 'flame'])
    assert(Effects.REACTIONS.includes(reaction), reaction);
  const base = settings({ effect: 'aurora' }),
    radar = settings({ effect: 'radar' }),
    prism = settings({ effect: 'prism' });
  assert.notDeepEqual(Effects.frame(base, 400), Effects.frame(radar, 400));
  assert.notDeepEqual(Effects.frame(base, 400), Effects.frame(prism, 400));
  assert(
    rgbToBgr(
      Effects.sample(settings({ feedback: 'pulse', minimalist: true }), 'Q', 0, [{ id: 'Q', at: 0 }]),
    ) > 0,
  );
});

test('white feedback stays above rainbow, slowly fades, and minimalist still reacts', () => {
  const s = settings(),
    events = [{ id: 'Q', at: 0 }];
  assert.deepEqual(Effects.sample(s, 'Q', 0, events), { red: 255, green: 255, blue: 255 });
  const middle = Effects.sample(s, 'Q', 650, events),
    base = Effects.sample(s, 'Q', 650);
  assert(middle.red >= base.red && middle.green >= base.green && middle.blue >= base.blue);
  assert.notDeepEqual(middle, base);
  assert.deepEqual(Effects.sample(s, 'Q', 1300, events), Effects.sample(s, 'Q', 1300));
  const minimal = settings({ minimalist: true });
  assert.equal(rgbToBgr(Effects.sample(minimal, 'Q', 0)), 0);
  assert.equal(rgbToBgr(Effects.sample(minimal, 'Q', 0, events)), 0xffffff);
  assert.equal(Effects.frame(s, 650, events)[2][2], rgbToBgr(middle));
});

test('anchor protection is configurable and feedback is an animated ring or descending trail', () => {
  const protectedSelection = settings({ anchors: ['Q'], protectedAnchors: ['W'], protectAnchors: true });
  const events = [{ id: 'Q', at: 0 }];
  assert.equal(rgbToBgr(Effects.sample(protectedSelection, 'Q', 0, events)), 0x3300ff);
  assert.equal(
    rgbToBgr(Effects.sample({ ...protectedSelection, protectAnchors: false }, 'Q', 0, events)),
    0xffffff,
  );
  assert.equal(
    rgbToBgr(Effects.sample({ ...protectedSelection, protectAnchors: false }, 'W', 0, [{ id: 'W', at: 0 }])),
    0x3300ff,
  );
  const ripple = settings({ feedback: 'ripple', minimalist: true });
  assert.equal(rgbToBgr(Effects.sample(ripple, 'W', 0, events)), 0);
  assert(rgbToBgr(Effects.sample(ripple, 'W', 110, events)) > 0);
  const waterfall = settings({ feedback: 'waterfall', minimalist: true });
  assert.equal(rgbToBgr(Effects.sample(waterfall, 'A', 0, events)), 0);
  assert.equal(rgbToBgr(Effects.sample(waterfall, 'A', 150, events)), 0xffffff);
  assert.equal(rgbToBgr(Effects.sample(waterfall, 'Z', 300, events)), 0xffffff);
  assert.equal(rgbToBgr(Effects.sample(waterfall, 'P', 300, events)), 0);
});

test('Chaos is per-key deterministic random behavior distinct from Rainbow Road', () => {
  const selection = settings({ effect: 'chaos' }),
    first = Effects.frame(selection, 777);
  assert.deepEqual(first, Effects.frame(selection, 777));
  assert.notDeepEqual(first, Effects.frame(selection, 999));
  assert.notDeepEqual(first, Effects.frame(settings(), 777));
  assert.notEqual(first[2][2], first[2][3]);
  assert.equal(settings().speed, 3.5);
  assert.throws(() => settings({ speed: Infinity }));
  assert.throws(() => settings({ anchors: 'Q' }));
});

function fakeSdk() {
  let now = 0,
    running = 0,
    maxConcurrent = 0,
    handler,
    failResult = 0,
    failFetch = false,
    failDelete = false;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    calls.push({ url: String(url), ...options });
    await new Promise((resolve) => setTimeout(resolve, 1));
    running--;
    if (failFetch) throw new Error('local SDK unavailable');
    if (failDelete && options.method === 'DELETE') throw new Error('stale session cannot be deleted');
    const body =
      options.method === 'POST'
        ? String(url).endsWith('/keyboard')
          ? { id: 'test-effect', result: failResult }
          : { uri: 'http://localhost:54321/session', result: 0 }
        : { result: failResult };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const provider = createChromaSdkProvider({
    fetchImpl,
    nowImpl: () => now,
    setIntervalImpl: (fn) => {
      handler = fn;
      return 1;
    },
    clearIntervalImpl: () => {
      handler = undefined;
    },
  });
  return {
    provider,
    calls,
    setTime: (value) => {
      now = value;
    },
    tick: async () => {
      await handler?.();
    },
    setResult: (value) => {
      failResult = value;
    },
    setUnavailable: (value) => {
      failFetch = value;
    },
    setDeleteFailure: (value) => {
      failDelete = value;
    },
    max: () => maxConcurrent,
  };
}

// Live editing must not re-register with Synapse on every change (that flickers and can lose Chroma app priority).
test('live edits reuse one registration and Matrix/stripes both continue rendering', async () => {
  const f = fakeSdk();
  await f.provider.apply(settings({ effect: 'matrix' }));
  f.setTime(1600);
  await f.tick();
  await f.provider.apply(settings({ effect: 'stars-stripes' }));
  // Identical frames are deliberately not re-sent (LL-055). At t=3.2 s the stripes are in the same phase as
  // at 1.6 s (they flip every ~0.71 s), so sample at 4.0 s where the picture has really moved.
  f.setTime(4000);
  await f.tick();
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0);
  const frames = f.calls.filter((c) => c.url.endsWith('/keyboard'));
  assert.equal(frames.length, 4);
  assert.notEqual(frames[0].body, frames[1].body);
  assert(f.calls.some((c) => c.url.endsWith('/heartbeat')));
  assert.equal(f.max(), 1);
  await f.provider.release();
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1);
});

// If one SDK request is slow, the 46 ms animation timer must skip ticks rather than stack concurrent PUTs; non-zero SDK result codes must surface as errors.
test('slow frames never overlap and SDK nonzero results surface instead of being swallowed', async () => {
  const f = fakeSdk();
  await f.provider.apply(settings());
  await Promise.all([f.provider.keyPress('Q'), f.provider.apply(settings({ effect: 'matrix' })), f.tick()]);
  assert.equal(f.max(), 1);
  f.setResult(5);
  f.setTime(2000);
  await f.tick();
  const status = await f.provider.status();
  assert.match(status.lastError.message, /SDK result 5/);
  assert.equal(status.active.effect, 'matrix');
  assert(status.failedFrames > 0);
  f.setResult(0);
  await f.provider.release();
});

test('request timeout is bounded and bad registration URIs are rejected', async () => {
  let signal;
  const provider = createChromaSdkProvider({
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: 0, uri: 'http://outside.invalid/session' }),
      };
    },
  });
  await assert.rejects(provider.apply(settings()), /non-loopback/);
  assert(signal instanceof AbortSignal);
  await provider.release();
});

// Simulates Synapse dropping the session (e.g. after a Synapse restart): after two failed frames the provider re-registers and continues the SAME effect.
test('an expired session is reopened after repeated animation failures without changing effects', async () => {
  const f = fakeSdk();
  await f.provider.apply(settings({ effect: 'matrix' }));
  f.setResult(5);
  f.setTime(2000);
  await f.tick();
  f.setTime(4000);
  await f.tick();
  f.setResult(0);
  f.setTime(6000);
  await f.tick();
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 2);
  const state = await f.provider.status();
  assert.equal(state.active.effect, 'matrix');
  assert.equal(state.lastError, null);
  await f.provider.release();
});

// Static setups normally send no frames; after a re-registration the saved colors must still be pushed once.
test('reopening a static session redraws its saved colors even without a new key press', async () => {
  const f = fakeSdk();
  await f.provider.apply(settings({ effect: 'subtle-keywords', anchors: ['Q'] }));
  f.setResult(5);
  f.setTime(2000);
  await f.tick();
  f.setTime(4000);
  await f.tick();
  f.setResult(0);
  f.setTime(6000);
  await f.tick();
  const frames = f.calls.filter((call) => call.url.endsWith('/keyboard'));
  assert.equal(frames.length, 2);
  assert.equal(JSON.parse(frames.at(-1).body).param[2][2], 0x3300ff);
  await f.provider.release();
});

// Detection must walk only PRESENT keyboards (not stale registry entries), and an access-denied enumeration must stay "unknown" rather than guessing.
test('device identity uses present ancestry and denied enumeration remains unknown', async () => {
  const device = await detectDevice({
    platform: 'win32',
    sdkAvailable: true,
    execFileImpl: async (_file, args) => {
      // Missing optional PnP Data records must not abort all present-device identification.
      assert(!args.at(-1).includes('-ExpandProperty Data'));
      return { stdout: JSON.stringify([{ names: ['HID Keyboard Device', 'USB\\VID_4D4B&PID_3068'] }]) };
    },
  });
  assert.equal(device.modelId, 'yunzii-al65');
  assert.equal(device.deviceState, 'present');
  const denied = await detectDevice({
    platform: 'win32',
    execFileImpl: async () => {
      throw new Error('access denied');
    },
  });
  assert.equal(denied.recognized, false);
  assert.equal(denied.deviceState, 'unknown');
  assert.match(denied.detectionError, /denied/);
  const ambiguous = await detectDevice({
    platform: 'win32',
    sdkAvailable: true,
    execFileImpl: async () => ({ stdout: '["Razer Ornata"]' }),
  });
  assert.equal(ambiguous.recognized, false);
  assert.equal(ambiguous.modelId, 'standard-full-size');
});

test('present keyboard detection preserves every identity and chooses a recognized default', async () => {
  const detected = await detectDevice({
    platform: 'win32',
    sdkAvailable: true,
    execFileImpl: async () => ({
      stdout: JSON.stringify([
        { id: 'HID\\Razer', name: 'Razer BlackWidow Elite', names: ['Razer BlackWidow Elite'] },
        { id: 'HID\\AL65', name: 'YUNZII AL65', names: ['YUNZII AL65'] },
      ]),
    }),
  });
  assert.equal(detected.devices.length, 2);
  assert.equal(detected.selectedDeviceId, 'HID\\Razer');
  assert.equal(detected.devices[1].modelId, 'yunzii-al65');
});

// e.g. "BlackWidow V4 75%" must not match the full-size V4 entry, and "Ornata V3 X" must not inherit V3 zone lighting.
test('unsupported model variants cannot inherit full-size layouts or another variants RGB zoning', () => {
  for (const name of [
    'Logitech G915 TKL',
    'SteelSeries Apex Pro Mini',
    'SteelSeries Apex Pro TKL',
    'Razer Ornata V3 X',
    'Razer BlackWidow V4 75%',
  ])
    assert.equal(identify([name]), undefined, name);
  assert.equal(identify(['Logitech G915']).id, 'logitech-g915');
  assert.equal(identify(['SteelSeries Apex Pro']).id, 'steelseries-apex-pro');
  assert.equal(identify(['Razer Ornata V3']).lighting, '10-zone');
});

test('keyword reactions override fixed colors by default and can differ from other-key reactions', () => {
  const s = settings({
    anchors: ['Q'],
    feedback: 'waterfall',
    keywordFeedback: 'reactive',
    minimalist: true,
  });
  assert.equal(s.protectAnchors, false);
  assert.equal(rgbToBgr(Effects.sample(s, 'Q', 0, [{ id: 'Q', at: 0 }])), 0xffffff);
  assert.equal(rgbToBgr(Effects.sample(s, 'A', 150, [{ id: 'Q', at: 0 }])), 0);
  assert.equal(rgbToBgr(Effects.sample(s, 'S', 150, [{ id: 'W', at: 0 }])), 0xffffff);
  const muted = settings({ anchors: ['Q'], feedback: 'reactive', keywordFeedback: 'none' });
  assert.equal(rgbToBgr(Effects.sample(muted, 'Q', 0, [{ id: 'Q', at: 0 }])), 0x3300ff);
});

test('group settings independently compose anchor, background, and orientation layers', () => {
  const selection = settings({
    groups: {
      anchor: {
        keys: ['Q'],
        base: 'static',
        color: '#ff00aa',
        dynamic: 'none',
        reaction: 'flash',
        reactionColor: '#ffffff',
      },
      background: {
        keys: ['W', 'E'],
        base: 'off',
        color: '#000000',
        dynamic: 'matrix',
        reaction: 'waterfall',
        reactionColor: '#00ffff',
      },
      orientation: {
        keys: ['ESC'],
        base: 'static',
        color: '#00ffcc',
        dynamic: 'none',
        reaction: 'ripple',
        reactionColor: '#ffffff',
      },
    },
  });
  assert.equal(rgbToBgr(Effects.sample(selection, 'Q', 0)), 0xaa00ff);
  assert.equal(rgbToBgr(Effects.sample(selection, 'Q', 0, [{ id: 'Q', at: 0 }])), 0xffffff);
  assert.equal(rgbToBgr(Effects.sample(selection, 'ESC', 0)), 0xccff00);
  const flame = {
    ...selection,
    groups: {
      ...selection.groups,
      anchor: { ...selection.groups.anchor, reaction: 'flame', reactionColor: '#2aa8ff' },
    },
  };
  const flare = Effects.sample(flame, 'Q', 0, [{ id: 'Q', at: 0 }]);
  assert(flare.blue > flare.red && flare.blue > flare.green, 'blue flame sits above a fixed anchor color');
  assert.equal(
    rgbToBgr(Effects.sample(flame, 'Q', 1000, [{ id: 'Q', at: 0 }])),
    0xaa00ff,
    'blue flame returns to the anchor base after its fade',
  );
  assert.equal(Effects.isAnimated(selection), true);
});

test('explicit Apply registers afresh and uses create then SetEffect without claiming visible LEDs', async () => {
  const f = fakeSdk();
  await f.provider.apply(settings());
  assert.equal(JSON.parse(f.calls.find((call) => call.method === 'POST').body).title, 'Jeby Lighting Lab');
  const result = await f.provider.apply(settings({ effect: 'matrix' }), { force: true });
  assert(f.calls.some((call) => call.method === 'DELETE'));
  assert(f.calls.some((call) => call.url.endsWith('/keyboard') && call.method === 'POST'));
  assert(
    f.calls.some(
      (call) =>
        call.url.endsWith('/effect') && call.method === 'PUT' && JSON.parse(call.body).id === 'test-effect',
    ),
  );
  assert.equal(result.physicalLightingVerified, false);
  assert.equal(result.delivery, 'sdk-acknowledged');
  await f.provider.release();
});

test('a working alternate key can trigger feedback for an unresponsive physical key without typing remaps', async () => {
  const f = fakeSdk();
  await f.provider.apply(settings({ brokenKeys: ['NUM_DECIMAL'], inputAliases: { NUM_ADD: 'NUM_DECIMAL' } }));
  const result = await f.provider.keyPress('NUM_ADD');
  assert.equal(result.key, 'NUM_DECIMAL');
  assert.throws(() => settings({ inputAliases: { missing: 'Q' } }), /coordinate/);
  await f.provider.release();
});

// An expired session cannot be DELETEd; Apply must still register afresh and report the cleanup failure as a warning, not as a failed Apply.
test('force Apply can replace an undeletable expired session while preserving the cleanup warning', async () => {
  const f = fakeSdk();
  await f.provider.apply(settings());
  f.setDeleteFailure(true);
  const result = await f.provider.apply(settings({ effect: 'matrix' }), { force: true });
  assert.match(result.releaseWarning, /stale session/);
  assert.equal(result.effect, 'matrix');
  f.setDeleteFailure(false);
  await f.provider.release();
});

// Source-level guard for synapse-control.ps1: these UI Automation selectors were discovered against the real Synapse 3 UI and are easy to break by "cleanup".
test('native import finds the real named Studio tab before requiring Studio content', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../synapse-control.ps1'), 'utf8');
  assert(
    source.includes(
      "$_.Current.Name -eq 'STUDIO' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem",
    ),
  );
  assert(source.indexOf("Current.Name -eq 'STUDIO'") < source.indexOf("'Studio Actions'"));
  assert.match(source, /if\(-not \$studioContent\)/);
  assert(source.includes("$_.Current.Name -eq 'Open' -and $_.Current.ClassName -eq '#32770'"));
  assert(source.includes("$_.Current.AutomationId -eq '1148' -and $_.Current.ClassName -eq 'Edit'"));
  assert.match(source, /SendText.*0x000C/);
  assert.match(source, /SendAction.*0x00F5/);
  assert.match(source, /ScreenToClient/);
  assert.match(source, /SendAction\(\$mainHandle,0x0201/);
  assert.match(source, /SendAction\(\$mainHandle,0x0202/);
  assert.match(
    source,
    /candidate\.TryGetCurrentPattern\(\[System\.Windows\.Automation\.SelectionItemPattern\]/,
  );
  assert.match(source, /combo\.TryGetCurrentPattern\(\[System\.Windows\.Automation\.SelectionPattern\]/);
  assert.match(source, /ValidateSet\('Open','Import','Select','Inspect','Repair'\)/);
  assert(
    source.indexOf("AutomationId -eq 'ExpanderButton'") < source.indexOf("Current.Name -eq 'CONNECT'"),
    'open Studio effect flyouts must close before CONNECT navigation',
  );
  assert.match(
    source,
    /effectToggle\.Current\.ToggleState -eq \[System\.Windows\.Automation\.ToggleState\]::On/,
  );
  // The adapter contract (Select by exact profile name, as an argument array) is checked by
  // behavior in 'native profile selection passes the exact name as a separate argument' below,
  // not by grepping source text — formatting must never break a test.
  const synapseControl = fs.readFileSync(path.resolve(__dirname, '../synapse-control.ps1'), 'utf8');
  assert(synapseControl.includes("ById $window 'btnChromaApp'"));
  assert(synapseControl.includes('Selecting CONNECT alone leaves that panel closed'));
});

test('native profile selection passes the exact name as a separate argument', async (t) => {
  const { loadNativeProfile } = require('../synapse-profile.cjs');
  const os = require('node:os');
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'native-select-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  // loadNativeProfile only re-selects an archive that already exists on disk.
  await fs.promises.writeFile(path.join(directory, 'profile-1.ChromaEffects'), 'zip');
  let seen;
  const result = await loadNativeProfile(
    { id: 'profile-1', name: 'Quote "and" space' },
    {
      directory,
      execFileImpl: async (file, args) => {
        seen = { file, args };
        return { stdout: JSON.stringify({ imported: true, selected: true }) };
      },
    },
  );
  assert.equal(seen.file, 'powershell.exe');
  // The name travels as one argv element (no shell), so quotes/spaces cannot become script text.
  assert.deepEqual(seen.args.slice(seen.args.indexOf('-Action'), seen.args.indexOf('-Action') + 4), [
    '-Action',
    'Select',
    '-ProfileName',
    'Quote "and" space',
  ]);
  assert.equal(result.selected, true);
});

test('mouse sync follows the composed background group instead of going black on static presets', () => {
  const { createCustomMouseFrame } = require('../lighting-domain.cjs');
  const solid = createCustomMouseFrame('solid', 0, { effect: 'solid', color: '#00ff00', timeMs: 0 });
  // CHROMA_CUSTOM2 colors are BGR integers: pure green is 0x00ff00.
  assert(
    solid.param.flat().every((value) => value === 0x00ff00),
    'Solid Color mouse must be the solid color',
  );
  const keywords = createCustomMouseFrame('subtle-keywords', 0, {
    effect: 'subtle-keywords',
    anchors: ['Q'],
    color: '#ff0000',
    timeMs: 0,
  });
  assert(
    keywords.param.flat().every((value) => value === 0x0000ff),
    'dark background borrows the anchor color (BGR red)',
  );
  const dark = createCustomMouseFrame('ghost', 0, { effect: 'ghost', anchors: [], timeMs: 0 });
  assert(
    dark.param.flat().every((value) => value === 0),
    'Lights Out without anchors stays dark',
  );
  const minimal = createCustomMouseFrame('solid', 0, {
    effect: 'solid',
    minimalist: true,
    color: '#00ff00',
    timeMs: 0,
  });
  assert(
    minimal.param.flat().every((value) => value === 0),
    'Keypress-only keeps the mouse dark',
  );
  const rainbow = createCustomMouseFrame('rainbow-road', 0, { effect: 'rainbow-road', timeMs: 500 });
  assert(new Set(rainbow.param.flat()).size > 3, 'animated backgrounds still animate across the mouse');
});

test('Matrix keeps raining after a long session instead of going dark at ~11 minutes', () => {
  // The cycle walk used to stop at 256 cycles (~2,816 steps × 230 ms), after which every sample was black.
  const selection = { effect: 'matrix', speed: 3.5, seed: 17, anchors: [] };
  const litAt = (minutes) => {
    let lit = 0;
    for (let t = minutes * 60_000; t < minutes * 60_000 + 200 * 230; t += 230)
      for (let row = 0; row < 6; row++) if (Effects.sampleAt(selection, row, 3, t).green > 200) lit++;
    return lit;
  };
  for (const minutes of [0, 10, 11, 12, 30, 600])
    assert(litAt(minutes) > 50, `Matrix must still rain at ${minutes} min`);
});

test('the speed slider affects Breathing, Fire and Aurora (and leaves the 3.5 default unchanged)', () => {
  // Total color distance travelled over 4 s: a faster speed must move the colors more than a slow one.
  for (const effect of ['breathing', 'fire', 'aurora']) {
    const at = (speed, time) => Effects.sampleAt({ effect, speed, color: '#00ff88' }, 2, 5, time);
    const travel = (speed) => {
      let total = 0;
      for (let time = 0; time < 4000; time += 20) {
        const a = at(speed, time),
          b = at(speed, time + 20);
        total += Math.abs(a.red - b.red) + Math.abs(a.green - b.green) + Math.abs(a.blue - b.blue);
      }
      return total;
    };
    assert(travel(6) > travel(0.5) * 1.5, `${effect}: speed 6 must animate visibly faster than 0.5`);
  }
});

test('Matrix falls through the VISIBLE rows of every layout, one row per step, never two at once', () => {
  // LL-054: compact boards used Chroma grid rows, so Esc (grid row 0) lit a step before the rest of its
  // physical row and the line spent an invisible step at the bottom.
  for (const model of [
    'standard-full-size',
    'standard-75',
    'standard-65',
    'standard-60',
    'yunzii-al65',
    'standard-iso',
  ]) {
    const layout = Plan.layoutForModel(model);
    const selection = { effect: 'matrix', speed: 3.5, seed: 17, keyboardModel: model };
    const rowsOf = (time) => {
      const rows = new Set();
      for (const key of layout.keys) {
        const color = Effects.sample(selection, key.id, time);
        if (color.green > 200 && color.red < 30) rows.add(Effects.physicalRowOf(selection, key.id).row);
      }
      return [...rows];
    };
    const count = Effects.physicalRowOf(selection, 'Q').count;
    for (let step = 0; step < count; step++)
      assert.deepEqual(rowsOf(step * 230 + 5), [step], `${model} step ${step}`);
    assert.deepEqual(rowsOf(count * 230 + 5), [], `${model}: the gap starts right after the bottom row`);
  }
});

test('nextStepAt reports the exact next boundary for stepped effects and null for smooth ones', () => {
  assert.equal(Effects.nextStepAt({ effect: 'matrix', speed: 3.5 }, 100), 230);
  assert.equal(Effects.nextStepAt({ effect: 'matrix', speed: 7 }, 100), 115);
  assert.equal(Effects.nextStepAt({ effect: 'rainbow-road', speed: 3.5 }, 100), null);
  assert.equal(Effects.nextStepAt({ effect: 'matrix', speed: 3.5, minimalist: true }, 100), null);
});

test('the Chroma provider never re-sends an identical animation frame (static stretches cost no requests)', async () => {
  // LL-055: Matrix is unchanged for most of each 230 ms row; re-sending it every tick congested the REST path.
  const f = fakeSdk();
  await f.provider.apply(settings({ effect: 'matrix' }));
  const keyboardPuts = () => f.calls.filter((call) => call.url.endsWith('/keyboard')).length;
  const afterApply = keyboardPuts();
  for (const time of [60, 110, 160]) {
    f.setTime(time); // all inside the first row step (0-230 ms): picture unchanged
    await f.tick();
  }
  assert.equal(keyboardPuts(), afterApply, 'no request while the picture is unchanged');
  f.setTime(260); // next row
  await f.tick();
  assert.equal(keyboardPuts(), afterApply + 1, 'exactly one request when the row changes');
});

test('group strength and Protect change rendering only when set, and are validated before hardware', () => {
  const all = Object.keys(Plan.chromaCoordinates);
  const groups = (extra = {}) => ({
    anchor: {
      keys: ['Q'],
      base: 'static',
      color: '#ff0000',
      dynamic: 'none',
      reaction: 'reactive',
      reactionColor: '#ffffff',
      ...extra.anchor,
    },
    background: {
      keys: all.filter((id) => !['Q', 'ESC'].includes(id)),
      base: 'static',
      color: '#0000ff',
      dynamic: 'none',
      reaction: 'ripple',
      reactionColor: '#ffffff',
      ...extra.background,
    },
    orientation: {
      keys: ['ESC'],
      base: 'static',
      color: '#00ff00',
      dynamic: 'none',
      reaction: 'none',
      reactionColor: '#ffffff',
      ...extra.orientation,
    },
  });
  const sel = (extra) => ({ effect: 'solid', groups: groups(extra) });
  // Defaults: full-strength red anchor.
  assert.deepEqual(Effects.sample(sel(), 'Q', 0), { red: 255, green: 0, blue: 0 });
  // Base strength 50% dims toward black.
  assert.deepEqual(Effects.sample(sel({ anchor: { baseStrength: 0.5 } }), 'Q', 0), {
    red: 128,
    green: 0,
    blue: 0,
  });
  // A background-key ripple reaches the anchor key Q - unless the anchor group is protected.
  const press = [{ id: 'W', at: 0 }];
  // (The anchor group needs a spreading reaction for a press elsewhere to reach it.)
  const lit = Effects.sample(sel({ anchor: { reaction: 'ripple' } }), 'Q', 120, press);
  const shielded = Effects.sample(sel({ anchor: { reaction: 'ripple', protect: true } }), 'Q', 120, press);
  assert.notDeepEqual(lit, { red: 255, green: 0, blue: 0 }, 'unprotected anchor shows the ripple');
  assert.deepEqual(shielded, { red: 255, green: 0, blue: 0 }, 'protected anchor ignores other groups');
  // Its own key still reacts while protected.
  assert.notDeepEqual(Effects.sample(sel({ anchor: { protect: true } }), 'Q', 10, [{ id: 'Q', at: 0 }]), {
    red: 255,
    green: 0,
    blue: 0,
  });
  // Reaction strength 0 disables the visible reaction.
  assert.deepEqual(Effects.sample(sel({ anchor: { reactionStrength: 0 } }), 'Q', 10, [{ id: 'Q', at: 0 }]), {
    red: 255,
    green: 0,
    blue: 0,
  });
  // Validation: accepted in range, rejected outside, carried through.
  const ok = validateSelection({
    provider: 'chroma-sdk',
    effect: 'solid',
    groups: groups({ anchor: { baseStrength: 0.4, protect: true } }),
  });
  assert.equal(ok.groups.anchor.baseStrength, 0.4);
  assert.equal(ok.groups.anchor.protect, true);
  assert.throws(
    () =>
      validateSelection({
        provider: 'chroma-sdk',
        effect: 'solid',
        groups: groups({ anchor: { baseStrength: 2 } }),
      }),
    /0 to 1/,
  );
  assert.throws(
    () =>
      validateSelection({
        provider: 'chroma-sdk',
        effect: 'solid',
        groups: groups({ anchor: { protect: 'yes' } }),
      }),
    /true or false/,
  );
});
