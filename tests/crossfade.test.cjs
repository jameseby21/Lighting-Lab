/* =====================================================================================================
 * tests/crossfade.test.cjs — crossfade between profiles in the Chroma provider (ISSUES-LOG LL-061).
 *
 * Part of `npm test` / CI. No hardware: the Chroma REST service is a fake that records every request, the
 * clock is fake (nowImpl), and animation ticks are driven by hand through an injected setIntervalImpl.
 * Covers: no fade on the first apply or a forced Apply; a mid-fade frame is a per-cell blend of the old and
 * new selections; the fade ends with a pure frame of the new selection and is then forgotten; the length is
 * clamped to 10 s; status() reports a running transition.
 * ===================================================================================================== */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChromaSdkProvider } = require('../providers/chroma-sdk.cjs');
const { validateSelection } = require('../lighting-domain.cjs');

/** Fake Chroma + fake clock. Returns the provider plus helpers to move time and run one animation tick. */
function harness() {
  let now = 0,
    handler;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    const body =
      options.method === 'POST'
        ? String(url).endsWith('/keyboard')
          ? { id: 'effect-1', result: 0 }
          : { uri: 'http://localhost:54321/session', result: 0 }
        : { result: 0 };
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
  const keyboardFrames = () =>
    calls
      .filter((call) => call.url.endsWith('/keyboard') && call.body)
      .map((call) => JSON.parse(call.body).param);
  return {
    provider,
    calls,
    keyboardFrames,
    setTime: (value) => {
      now = value;
    },
    tick: async () => {
      await handler?.();
    },
  };
}
// Solid-color setups make the expected pixel values easy to reason about (every background key = that color).
const solid = (color) => validateSelection({ provider: 'chroma-sdk', effect: 'solid', color, anchors: [] });
// One background key's cell (Q at grid row 2, col 2) as {red, green, blue} from a BGR integer frame.
const cellQ = (param) => {
  const value = param[2][2];
  return { red: value & 255, green: (value >> 8) & 255, blue: (value >> 16) & 255 };
};

test('a crossfade blends old into new per cell, then ends on a pure new frame and is forgotten', async () => {
  const h = harness();
  await h.provider.apply(solid('#ff0000'));
  assert.deepEqual(
    cellQ(h.keyboardFrames().at(-1)),
    { red: 255, green: 0, blue: 0 },
    'first apply never fades',
  );
  await h.provider.apply(solid('#0000ff'), { transitionMs: 1000 });
  // The apply itself sends the fade's first frame: still (almost) all red.
  assert(cellQ(h.keyboardFrames().at(-1)).red > 230);
  assert.equal((await h.provider.status()).active.transition.durationMs, 1000);
  h.setTime(500);
  await h.tick();
  const middle = cellQ(h.keyboardFrames().at(-1));
  // Roughly half red, half blue (display-time progress includes the small latency estimate).
  assert(Math.abs(middle.red - 127) <= 12 && Math.abs(middle.blue - 128) <= 12, JSON.stringify(middle));
  h.setTime(1100);
  await h.tick();
  assert.deepEqual(
    cellQ(h.keyboardFrames().at(-1)),
    { red: 0, green: 0, blue: 255 },
    'the last frame is purely new',
  );
  assert.equal((await h.provider.status()).active.transition, null, 'the finished fade is dropped');
  const sent = h.keyboardFrames().length;
  h.setTime(1500);
  await h.tick();
  assert.equal(h.keyboardFrames().length, sent, 'a static setup stops streaming once the fade is over');
});

test('forced Apply never fades, and the fade length is clamped to 10 seconds', async () => {
  const h = harness();
  await h.provider.apply(solid('#ff0000'));
  await h.provider.apply(solid('#00ff00'), { force: true, transitionMs: 1000 });
  assert.deepEqual(
    cellQ(h.keyboardFrames().at(-1)),
    { red: 0, green: 255, blue: 0 },
    'explicit Apply is immediate',
  );
  assert.equal((await h.provider.status()).active.transition, null);
  await h.provider.apply(solid('#0000ff'), { transitionMs: 60_000 });
  assert.equal((await h.provider.status()).active.transition.durationMs, 10_000);
  await h.provider.apply(solid('#ffffff'), { transitionMs: 'soon' });
  assert.equal((await h.provider.status()).active.transition, null, 'non-numeric lengths mean no fade');
});
