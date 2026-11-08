/*
 * App Profiles rule engine (app-profiles.cjs) as pure logic plus its tiny JSON store.
 *
 * Covers: executable-name validation (no paths), first-enabled-match-wins ordering, the automatic
 * switch toggle, and that the store writes app-profiles.json atomically into a temp folder.
 * Part of `npm test` (node --test tests/*.test.cjs); also run by CI on windows-latest.
 * Needs: nothing but Node. Never spawns PowerShell, never touches lighting.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { normalizeConfig, normalizeRule, resolveRule, createAppProfileStore } = require('../app-profiles.cjs');
const profileA = '11111111-1111-4111-8111-111111111111',
  profileB = '22222222-2222-4222-8222-222222222222';
// Two rules for the same exe: the "In front" rule is listed first, so it wins while Code is focused; the "Running" fallback wins when it is merely open.
test('app profile rules reject paths and resolve the first enabled matching saved profile', () => {
  assert.throws(
    () =>
      normalizeRule({
        name: 'Unsafe',
        executable: 'C:\\Games\\game.exe',
        condition: 'running',
        profileId: profileA,
      }),
    /file name/,
  );
  const config = normalizeConfig({
    automatic: true,
    rules: [
      { name: 'Foreground Code', executable: 'Code.exe', condition: 'foreground', profileId: profileA },
      { name: 'Code fallback', executable: 'Code.exe', condition: 'running', profileId: profileB },
    ],
  });
  const rule = resolveRule(
    config,
    [{ executable: 'Code.exe', running: true, foreground: true }],
    new Set([profileA, profileB]),
  );
  assert.equal(rule.profileId, profileA);
  assert.equal(
    resolveRule(config, [{ executable: 'Code.exe', running: true, foreground: false }], new Set([profileB]))
      .profileId,
    profileB,
  );
  assert.equal(
    resolveRule(
      { ...config, automatic: false },
      [{ executable: 'Code.exe', running: true, foreground: true }],
      new Set([profileA, profileB]),
    ),
    null,
  );
});
test('app profile store writes a bounded portable config', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-app-profiles-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createAppProfileStore(directory);
  const saved = await store.save({
    automatic: true,
    waitMs: 1200,
    transitionMs: 500,
    rules: [{ name: 'Code', executable: 'Code.exe', condition: 'foreground', profileId: profileA }],
  });
  assert.equal(saved.rules.length, 1);
  assert.equal((await store.load()).waitMs, 1200);
  assert.equal((await fs.stat(path.join(directory, 'app-profiles.json'))).isFile(), true);
});

// ----- LL-060: Full screen / Time of day conditions and the "Everything else" default profile -----

// Time windows use LOCAL clock minutes; from > to wraps past midnight; from === to means all day.
test('time-of-day windows handle same-day ranges, midnight wrap, all-day and the exclusive end', () => {
  const { timeWindowContains } = require('../app-profiles.cjs');
  const at = (hours, minutes) => new Date(2026, 9, 20, hours, minutes);
  assert.equal(timeWindowContains('09:00', '17:00', at(9, 0)), true, 'start is inclusive');
  assert.equal(timeWindowContains('09:00', '17:00', at(17, 0)), false, 'end is exclusive');
  assert.equal(
    timeWindowContains('23:00', '07:00', at(23, 30)),
    true,
    'late evening is inside a wrapping window',
  );
  assert.equal(
    timeWindowContains('23:00', '07:00', at(6, 59)),
    true,
    'early morning is inside a wrapping window',
  );
  assert.equal(timeWindowContains('23:00', '07:00', at(12, 0)), false, 'midday is outside');
  assert.equal(timeWindowContains('08:00', '08:00', at(3, 0)), true, 'from === to is all day');
});

// A time rule needs no executable (stored as null) but must have valid HH:MM bounds; app rules still need one.
test('time rules store no executable and validate HH:MM; app conditions still require an executable', () => {
  const rule = normalizeRule({
    name: 'Night',
    condition: 'time',
    from: '23:00',
    to: '07:00',
    profileId: profileA,
  });
  assert.equal(rule.executable, null);
  assert.deepEqual([rule.from, rule.to], ['23:00', '07:00']);
  // Fields of the other kind are dropped, so switching a rule's condition leaves no stale data.
  const switched = normalizeRule({ ...rule, condition: 'time', executable: 'Code.exe' });
  assert.equal(switched.executable, null);
  assert.throws(
    () => normalizeRule({ name: 'Bad', condition: 'time', from: '24:00', to: '07:00', profileId: profileA }),
    /HH:MM/,
  );
  assert.throws(
    () => normalizeRule({ name: 'Bad', condition: 'time', from: '7:00', to: '08:00', profileId: profileA }),
    /HH:MM/,
  );
  assert.throws(
    () => normalizeRule({ name: 'No exe', condition: 'fullscreen', profileId: profileA }),
    /executable/,
  );
  assert.throws(
    () => normalizeRule({ name: 'Odd', condition: 'sometimes', executable: 'a.exe', profileId: profileA }),
    /condition/,
  );
  const full = normalizeRule({
    name: 'Game',
    condition: 'fullscreen',
    executable: 'VALORANT.exe',
    profileId: profileA,
  });
  assert.equal(full.from, undefined, 'app rules carry no time window');
});

// Full screen matches only when the probe says that app owns a monitor-covering window in front.
test('fullscreen rules match the fullscreen flag, and time rules match by clock', () => {
  const config = normalizeConfig({
    automatic: true,
    rules: [
      { name: 'Game', executable: 'Game.exe', condition: 'fullscreen', profileId: profileA },
      { name: 'Night', condition: 'time', from: '22:00', to: '06:00', profileId: profileB },
    ],
  });
  const ids = new Set([profileA, profileB]);
  const noon = new Date(2026, 9, 20, 12, 0),
    late = new Date(2026, 9, 20, 23, 0);
  assert.equal(
    resolveRule(
      config,
      [{ executable: 'Game.exe', running: true, foreground: true, fullscreen: false }],
      ids,
      noon,
    ),
    null,
  );
  assert.equal(
    resolveRule(
      config,
      [{ executable: 'game.exe', running: true, foreground: true, fullscreen: true }],
      ids,
      noon,
    ).name,
    'Game',
  );
  assert.equal(resolveRule(config, [], ids, late).name, 'Night');
});

// "Everything else": when no rule matches, the default profile applies - but only if it still exists.
test('the default profile is a synthetic fallback rule and is validated like any profile id', () => {
  const config = normalizeConfig({
    automatic: true,
    defaultProfileId: profileB,
    rules: [{ name: 'Code', executable: 'Code.exe', condition: 'foreground', profileId: profileA }],
  });
  const fallback = resolveRule(
    config,
    [{ executable: 'Code.exe', running: true, foreground: false }],
    new Set([profileA, profileB]),
  );
  assert.deepEqual(fallback, {
    id: 'default',
    name: 'Everything else',
    condition: 'default',
    profileId: profileB,
    enabled: true,
  });
  assert.equal(resolveRule(config, [], new Set([profileA])), null, 'a deleted default profile is ignored');
  assert.equal(
    resolveRule({ ...config, automatic: false }, [], new Set([profileB])),
    null,
    'automatic off wins',
  );
  assert.equal(normalizeConfig({}).defaultProfileId, null);
  assert.throws(() => normalizeConfig({ defaultProfileId: '../etc' }), /Everything else/);
});
