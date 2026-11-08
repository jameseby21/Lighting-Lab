/*
 * Guided "Identify My Layout" interview (layout-guide.js).
 *
 * Checks that five yes/no/choice answers map to the right reference layout (full, ISO, TKL, 75%, 65%, 60%)
 * without guessing a brand, and that a broken key never shrinks the layout: the step stays open, an
 * alternate key can answer it, and "unknown" answers fall back to the larger layout and mark it provisional.
 * Part of `npm test` (node --test tests/*.test.cjs); also run by CI on windows-latest.
 * Needs: nothing but Node. Real lighting: never changed.
 */
'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const G = require('../layout-guide.js');
function interview(values) {
  let state = G.begin();
  for (const value of values) state = G.answer(state, value);
  return G.result(state);
}
test('guided physical layouts distinguish full, ISO, TKL, 75, 65 and 60 without a brand claim', () => {
  for (const [values, model] of [
    [[true, true, true, 'block', 'ansi'], 'standard-full-size'],
    [[true, true, true, 'block', 'iso'], 'standard-iso'],
    [[false, true, true, 'block', 'ansi'], 'standard-tkl'],
    [[false, true, true, 'column', 'ansi'], 'standard-75'],
    [[false, false, true, 'column', 'ansi'], 'standard-65'],
    [[false, false, false, 'none', 'ansi'], 'standard-60'],
  ]) {
    const result = interview(values);
    assert.equal(result.model, model);
    assert.equal(result.brandDetected, false);
  }
});
test('a broken probe retains presence uncertainty and accepts an alternate numpad key', () => {
  let state = G.broken(G.begin(), 'NUM_ENTER');
  assert.equal(state.index, 0);
  assert.equal(state.answers.numpad, undefined);
  assert.equal(G.press(state, 'ENTER').accepted, false);
  const alternate = G.press(state, 'NUM_ADD');
  assert(alternate.accepted);
  state = alternate.state;
  for (const value of [true, true, 'block', 'ansi']) state = G.answer(state, value);
  assert.equal(G.result(state).model, 'standard-full-size');
  assert.deepEqual(G.result(state).brokenKeys, ['NUM_ENTER']);
  assert.equal(interview(['unknown', true, true, 'block', 'ansi']).provisional, true);
  assert.equal(
    interview(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']).model,
    'standard-full-size',
  );
  assert.equal(interview([false, 'unknown', 'unknown', 'unknown', 'ansi']).model, 'standard-tkl');
});
