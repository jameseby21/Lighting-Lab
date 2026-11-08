/*
 * HTTP API suite for server.cjs with fake devices.
 *
 * Every test starts a real Lighting Lab HTTP server on a random 127.0.0.1 port with an injected fake Chroma
 * provider, fake Synapse bridge, fake device detection and (where relevant) fake app probe, plus a fresh
 * temp state folder. It covers: audit-before-mutation ordering, request serialization, the static file
 * allowlist, export consent, cross-origin and DNS-rebinding refusal, physical-observation storage,
 * multi-keyboard selection, profiles (save/load/delete), Synapse repair reporting, local activity records,
 * App Profiles switching/return behavior, and the PowerShell app-watcher lifecycle.
 * Part of `npm test` (node --test tests/*.test.cjs); also run by CI on windows-latest.
 * Needs: nothing but Node. Real lighting: never changed; PowerShell is never spawned.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createLightingLabServer } = require('../server.cjs');

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-api-'));
  const calls = [];
  const sdk = {
    status: async () => ({ available: true }),
    apply: async (selection) => {
      calls.push(selection);
      return { provider: 'chroma-sdk', effect: selection.effect };
    },
    release: async () => ({ released: true }),
    keyPress: async (key) => ({ accepted: true, key }),
  };
  const server = createLightingLabServer({
    sdk,
    synapse: { status: async () => ({ available: false, archives: {}, installed: {} }) },
    detectDeviceImpl: async () => ({ model: 'Standard full-size', recognized: false }),
    stateDirectory: directory,
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await server.shutdown();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    base,
    directory,
    calls,
    sdk,
    post: (route, body) =>
      fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}
const setup = {
  effect: 'matrix',
  provider: 'chroma-sdk',
  anchors: ['Q'],
  keyboardModel: 'standard-full-size',
};

// The audit line for a request is written BEFORE the provider runs, so even a crash mid-apply leaves the full request on disk.
test('captures every requested field before device mutation, including rejected requests', async (t) => {
  let directory;
  const f = await fixture(t, {
    sdk: {
      status: async () => ({ available: true }),
      release: async () => ({}),
      apply: async () => {
        const audit = await fs.readFile(path.join(directory, 'audit.jsonl'), 'utf8');
        assert.equal(JSON.parse(audit.split('\n')[0]).requestedPayload.extra.userChoice, 42);
        return { provider: 'chroma-sdk' };
      },
    },
  });
  directory = f.directory;
  const result = await f.post('/api/apply', { ...setup, extra: { userChoice: 42 } });
  assert.equal(result.status, 200);
  const invalid = await f.post('/api/apply', { ...setup, effect: 'does-not-exist' });
  assert.equal(invalid.status, 422);
  const records = (await fs.readFile(path.join(directory, 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert(records.some((record) => record.requestedPayload?.effect === 'does-not-exist'));
  assert.equal(records.at(-1).event, 'operation-failed');
});

test('all switches and independent numpad IDs reach the API without alpha-only filtering', async (t) => {
  const f = await fixture(t);
  for (const id of ['Q', 'ESC', 'F12', 'NUM_1', 'NUM_DECIMAL', 'ENTER']) {
    const response = await f.post('/api/apply', { ...setup, anchors: [id] });
    assert.equal(response.status, 200, `${id}: ${await response.text()}`);
  }
});

// A slow older request (matrix) must finish before a newer one (rainbow) starts, so the keyboard ends on the latest edit.
test('serializes simultaneous live edits so old requests cannot finish after newer ones', async (t) => {
  const completed = [];
  const f = await fixture(t, {
    sdk: {
      status: async () => ({ available: true }),
      release: async () => ({}),
      apply: async (selection) => {
        if (selection.effect === 'matrix') await new Promise((resolve) => setTimeout(resolve, 30));
        completed.push(selection.effect);
        return { effect: selection.effect };
      },
    },
  });
  const first = f.post('/api/apply', setup);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = f.post('/api/apply', { ...setup, effect: 'rainbow-road' });
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.deepEqual(completed, ['matrix', 'rainbow-road']);
});

// Only the six public front-end files are served; source, audit logs, and traversal attempts all 404.
test('static allowlist excludes source, private audit files, traversal and local backups', async (t) => {
  const f = await fixture(t);
  for (const route of [
    '/server.cjs',
    '/audit.jsonl',
    '/lighting-lab-audit.jsonl',
    '/README.md',
    '/%2e%2e/AGENTS.md',
  ]) {
    assert.equal((await fetch(f.base + route)).status, 404, route);
  }
  assert.equal((await fetch(f.base + '/')).status, 200);
  assert.equal((await fetch(f.base + '/api/status')).status, 200);
});

test('executable is a download and cannot bypass explicit approximation consent', async (t) => {
  let builds = 0;
  const f = await fixture(t, {
    exporter: {
      getExportCapabilities: (model) => ({ model, supported: true, exact: false }),
      createPresetExecutable: async (_selection, options) => {
        builds++;
        assert.equal(options.targetModel, 'yunzii-al65');
        return {
          filename: 'AL65-preset.exe',
          bytes: Buffer.from('MZ-fake-test-only'),
          manifest: { exact: false },
        };
      },
    },
  });
  const rejected = await f.post('/api/export/executable', { ...setup, exportModel: 'yunzii-al65' });
  assert.equal(rejected.status, 422);
  assert.equal(builds, 0);
  const built = await f.post('/api/export/executable', {
    ...setup,
    exportModel: 'yunzii-al65',
    acceptApproximation: true,
  });
  assert.equal(built.status, 200);
  assert.match(built.headers.get('content-disposition'), /AL65-preset.exe/);
  assert.equal(await built.text(), 'MZ-fake-test-only');
  assert.equal(builds, 1);
});

test('foreign browser origins cannot change the host keyboard', async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/api/apply', {
    method: 'POST',
    headers: { origin: 'http://another-site.invalid', 'content-type': 'application/json' },
    body: JSON.stringify(setup),
  });
  assert.equal(response.status, 403);
  assert.equal(f.calls.length, 0);
});

test('physical control observations persist separately from accepted SDK requests', async (t) => {
  const f = await fixture(t, {
    detectDeviceImpl: async () => ({
      model: 'Razer BlackWidow Elite',
      modelId: 'razer-blackwidow-elite',
      recognized: true,
    }),
  });
  await fetch(f.base + '/api/status');
  await new Promise((resolve) => setImmediate(resolve));
  const rejected = await f.post('/api/control-verification', { provider: 'chroma-sdk', visible: false });
  assert.equal(rejected.status, 200);
  const confirmed = await f.post('/api/control-verification', { provider: 'synapse-native', visible: true });
  assert.equal(confirmed.status, 200);
  const status = await (await fetch(f.base + '/api/status')).json();
  assert.equal(status.controlVerification.providers['chroma-sdk'].status, 'rejected');
  assert.equal(status.controlVerification.providers['synapse-native'].status, 'confirmed');
  assert.equal(
    (await f.post('/api/control-verification', { provider: 'unknown', visible: true })).status,
    422,
  );
  const audit = (await fs.readFile(path.join(f.directory, 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert(
    audit.some(
      (record) =>
        record.event === 'control-verification-started' && record.requestedPayload.visible === false,
    ),
  );
});

// Windows PnP enumeration can take seconds; /api/status must answer immediately with "detection-pending" and start only one probe.
test('slow device enumeration cannot block live status or trigger overlapping probes', async (t) => {
  let resolveDevice,
    probes = 0;
  const f = await fixture(t, {
    detectDeviceImpl: () => {
      probes++;
      return new Promise((resolve) => {
        resolveDevice = resolve;
      });
    },
  });
  const first = await fetch(f.base + '/api/status', { signal: AbortSignal.timeout(2000) });
  assert.equal((await first.json()).device.source, 'detection-pending');
  await fetch(f.base + '/api/status');
  assert.equal(probes, 1);
  resolveDevice({ model: 'Razer BlackWidow Elite', modelId: 'razer-blackwidow-elite', recognized: true });
  await new Promise((resolve) => setImmediate(resolve));
  const updated = await (await fetch(f.base + '/api/status')).json();
  assert.equal(updated.device.modelId, 'razer-blackwidow-elite');
  assert.equal(updated.device.recognized, true);
});

// Two keyboards present: the user can pick which one the editor describes, but the response admits both may receive the same SDK frame.
test('a shared PC can select among detected keyboards without claiming undocumented SDK routing', async (t) => {
  const f = await fixture(t, {
    detectDeviceImpl: async () => ({
      model: 'Razer BlackWidow Elite',
      modelId: 'razer-blackwidow-elite',
      id: 'razer',
      selectedDeviceId: 'razer',
      devices: [
        { id: 'razer', model: 'Razer BlackWidow Elite', modelId: 'razer-blackwidow-elite', recognized: true },
        { id: 'al65', model: 'YUNZII AL65', modelId: 'yunzii-al65', recognized: true },
      ],
    }),
  });
  await fetch(f.base + '/api/status');
  await new Promise((resolve) => setImmediate(resolve));
  const changed = await f.post('/api/device', { id: 'al65' });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).device.selectedDeviceId, 'al65');
  const status = await (await fetch(f.base + '/api/status')).json();
  assert.equal(status.device.modelId, 'yunzii-al65');
  assert.equal(status.device.controlScope.independentlyAddressable, false);
});

test('Apply forwards forced activation independently from live state and profiles preserve full editor settings', async (t) => {
  const applied = [];
  const f = await fixture(t, {
    sdk: {
      status: async () => ({ available: true }),
      release: async () => ({}),
      apply: async (selection, options) => {
        applied.push({ selection, options });
        return { delivery: 'sdk-acknowledged', physicalLightingVerified: false };
      },
    },
  });
  assert.equal((await f.post('/api/apply', { ...setup, force: true, live: false })).status, 200);
  assert.equal(applied[0].options.force, true);
  const response = await f.post('/api/profiles', {
    name: 'My Matrix',
    software: 'lighting-lab',
    settings: { ...setup, words: ['JAMES'], keywordFeedback: 'waterfall', brokenKeys: ['NUM_DECIMAL'] },
  });
  const saved = await response.json();
  assert.equal(response.status, 200);
  assert.equal(saved.activationError, undefined);
  const loaded = await (await fetch(f.base + '/api/profiles/' + saved.profile.id)).json();
  assert.deepEqual(loaded.settings.words, ['JAMES']);
  assert.equal(loaded.settings.keywordFeedback, 'waterfall');
  assert.deepEqual(loaded.settings.brokenKeys, ['NUM_DECIMAL']);
  const listed = await (await fetch(f.base + '/api/profiles')).json();
  assert.equal(listed.profiles.length, 1);
  assert.equal(listed.controllers[1].available, false);
  const reloaded = await (await f.post('/api/profiles/' + saved.profile.id + '/load', {})).json();
  assert.equal(reloaded.profile.name, 'My Matrix');
  assert.equal(applied.at(-1).options.force, true);
  assert.equal((await fetch(f.base + '/api/profiles/' + saved.profile.id + '/archive')).status, 404);
  assert.equal((await fetch(f.base + '/layout-guide.js')).status, 200);
});

test('a saved profile remains editable when its device activation fails', async (t) => {
  const f = await fixture(t, {
    sdk: {
      status: async () => ({ available: false }),
      release: async () => ({}),
      apply: async () => {
        throw Error('Controller unavailable');
      },
    },
  });
  const response = await f.post('/api/profiles', { name: 'Kept', settings: setup });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.activationError, /Controller unavailable/);
  assert.equal((await (await fetch(f.base + '/api/profiles/' + body.profile.id)).json()).name, 'Kept');
  const records = (await fs.readFile(path.join(f.directory, 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(records.at(-1).activationError, 'Controller unavailable');
});

test('auto-detecting executable export needs no unrelated AL65 approximation consent', async (t) => {
  let target;
  const f = await fixture(t, {
    exporter: {
      createPresetExecutable: async (selection, options) => {
        target = options.targetModel;
        assert.equal(selection.keywordFeedback, 'ripple');
        return { filename: 'Auto.exe', bytes: Buffer.from('MZ'), manifest: {} };
      },
    },
  });
  assert.equal((await f.post('/api/export/executable', { ...setup, keywordFeedback: 'ripple' })).status, 200);
  assert.equal(target, 'auto');
});

// Repair must report what Synapse actually shows (app not listed) instead of claiming success because Synapse launched.
test('repair reports the actual Connect panel and exact app state instead of claiming process launch established control', async (t) => {
  const steps = [];
  const f = await fixture(t, {
    sdk: {
      status: async () => ({ available: true }),
      release: async () => ({}),
      apply: async (_selection, options) => {
        assert(options.force);
        steps.push('registered');
        return { physicalLightingVerified: false };
      },
    },
    execFileImpl: async (_file, args) => {
      assert.equal(args[args.indexOf('-Action') + 1], 'Repair');
      assert.equal(args[args.indexOf('-AppTitle') + 1], 'Jeby Lighting Lab');
      assert.deepEqual(steps, ['registered']);
      return {
        stdout: JSON.stringify({
          opened: true,
          connectPanelVerified: true,
          masterEnabled: true,
          appListed: false,
          detail: 'Exact app not listed; takeover unresolved.',
        }),
      };
    },
  });
  const body = await (await f.post('/api/repair', setup)).json();
  assert.equal(body.opened, true);
  assert.equal(body.controlState.appListed, false);
  assert.equal(body.physicalLightingVerified, false);
  assert.match(body.detail, /unresolved/);
  const audit = (await fs.readFile(path.join(f.directory, 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(audit.at(-1).controlState.appListed, false);
});

test('a failed Synapse launch or navigation cannot become a successful repair message', async (t) => {
  const stderr = 'Connect panel timeout\n' + 'details'.repeat(200) + '\ncomplete error tail';
  const f = await fixture(t, {
    execFileImpl: async () => {
      throw Object.assign(Error('Connect panel timeout'), { stderr, stdout: 'helper output', code: 1 });
    },
  });
  const body = await (await f.post('/api/repair', setup)).json();
  assert.equal(body.opened, false);
  assert.match(body.detail, /could not be verified/);
  assert.match(body.openError, /timeout/);
  const records = (await fs.readFile(path.join(f.directory, 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(records.at(-1).openFailure.stderr, stderr);
  assert.equal(records.at(-1).openFailure.stdout, 'helper output');
});

// The /api/activity endpoint keeps only allowlisted metadata keys; free-text fields such as "note" are dropped before writing.
test('local activity records preserve action metadata without typed text and diagnostics exposes the audit trail', async (t) => {
  const f = await fixture(t);
  const accepted = await f.post('/api/activity', {
    action: 'control-clicked',
    detail: { control: 'apply', state: 'live', note: 'do not retain' },
  });
  assert.equal(accepted.status, 200);
  assert.equal(
    (await f.post('/api/activity', { action: 'Bad Action', detail: { control: 'apply' } })).status,
    422,
  );
  const diagnostics = await (await fetch(f.base + '/api/diagnostics')).json();
  const action = diagnostics.recentAudit.find((record) => record.event === 'client-action');
  assert.equal(action.activity.detail.control, 'apply');
  assert.equal(action.activity.detail.note, undefined);
  assert.match(diagnostics.recordScope, /excludes typed text/);
});

// Full loop with a fake probe: discover -> configure (wait 0 ms) -> add rule -> first refresh arms the switch -> second refresh activates the profile.
test('app profile API switches only an explicit matching saved profile after ordered rule evaluation', async (t) => {
  let present = false;
  const probes = [];
  const f = await fixture(t, {
    platform: 'win32',
    appProbe: async (names, options = {}) => {
      probes.push({ names, options });
      return {
        apps: options.discover
          ? [{ executable: 'Game.exe', running: true, foreground: true }]
          : names.map((executable) => ({ executable, running: present, foreground: present })),
        checkedAt: '2026-10-19T00:00:00.000Z',
      };
    },
  });
  const saved = await (
    await f.post('/api/profiles', {
      name: 'Code Focus',
      software: 'lighting-lab',
      settings: { ...setup, effect: 'matrix' },
    })
  ).json();
  const rule = {
    name: 'Visual Studio Code',
    executable: 'Code.exe',
    condition: 'foreground',
    profileId: saved.profile.id,
  };
  const discovered = await (await f.post('/api/app-profiles/discover', {})).json();
  assert.equal(discovered.discoveries[0].executable, 'Game.exe');
  assert.equal(probes[0].options.discover, true);
  assert.equal(
    (await f.post('/api/app-profiles/config', { automatic: true, waitMs: 0, transitionMs: 400 })).status,
    200,
  );
  assert.equal((await f.post('/api/app-profiles', rule)).status, 200);
  present = true;
  const first = await (await f.post('/api/app-profiles/refresh', {})).json();
  assert.match(first.runtime.detail, /waiting 0 ms/);
  const switched = await (await f.post('/api/app-profiles/refresh', {})).json();
  assert.match(switched.runtime.detail, /Active: Visual Studio Code/);
  assert.equal(f.calls.at(-1).effect, 'matrix');
  const listed = await (await fetch(f.base + '/api/app-profiles')).json();
  assert.equal(listed.config.rules[0].executable, 'Code.exe');
  assert.equal(listed.runtime.apps[0].foreground, true);
  const missing = await f.post('/api/app-profiles', {
    ...rule,
    profileId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(missing.status, 422);
});

test('saved profiles can be deleted, and a deleted profile reports a friendly error instead of a file path', async (t) => {
  const f = await fixture(t);
  const saved = await (await f.post('/api/profiles', { name: 'Temporary', settings: setup })).json();
  const deleted = await f.post(`/api/profiles/${saved.profile.id}/delete`, {});
  assert.equal(deleted.status, 200);
  assert.deepEqual((await deleted.json()).profiles, []);
  const missing = await (await fetch(`${f.base}/api/profiles/${saved.profile.id}`)).json();
  assert.match(missing.error, /no longer exists/);
  assert.doesNotMatch(missing.error, /ENOENT|[A-Z]:[\\/]/);
});

test('DNS-rebinding hosts are refused while localhost, IP literals and this PC name are accepted', async (t) => {
  const { isAllowedHost } = require('../server.cjs');
  for (const host of [
    'localhost:4318',
    '127.0.0.1:4318',
    '192.168.1.20:4318',
    '[::1]:4318',
    `${os.hostname()}:4318`,
  ])
    assert.equal(isAllowedHost(host, ''), true, host);
  for (const host of ['evil.example:4318', 'attacker.test'])
    assert.equal(isAllowedHost(host, ''), false, host);
  assert.equal(
    isAllowedHost('my-desk.lan:4318', 'my-desk.lan'),
    true,
    'extra names can be allowed explicitly',
  );
  const f = await fixture(t);
  // Node's fetch will not let us forge Host, so use the raw http client for the hostile request.
  const status = await new Promise((resolve, reject) => {
    const http = require('node:http');
    const request = http.request(
      `${f.base}/api/apply`,
      { method: 'POST', headers: { host: 'evil.example:4318', 'content-type': 'application/json' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(setup));
  });
  assert.equal(status, 403);
  assert.equal(f.calls.length, 0, 'a rebinding page must never reach the keyboard');
});

test('physical observations are stored against the keyboard the user selected, not the first one detected', async (t) => {
  const f = await fixture(t, {
    detectDeviceImpl: async () => ({
      model: 'Razer BlackWidow Elite',
      modelId: 'razer-blackwidow-elite',
      id: 'razer',
      selectedDeviceId: 'razer',
      devices: [
        { id: 'razer', model: 'Razer BlackWidow Elite', modelId: 'razer-blackwidow-elite', recognized: true },
        { id: 'ornata', model: 'Razer Ornata V2', modelId: 'razer-ornata-v2', recognized: true },
      ],
    }),
  });
  await fetch(f.base + '/api/status');
  await new Promise((resolve) => setImmediate(resolve));
  await f.post('/api/device', { id: 'ornata' });
  const recorded = await (
    await f.post('/api/control-verification', { provider: 'chroma-sdk', visible: true })
  ).json();
  assert.equal(recorded.result.modelId, 'razer-ornata-v2');
  const status = await (await fetch(f.base + '/api/status')).json();
  assert.equal(status.controlVerification.providers['chroma-sdk'].status, 'confirmed');
});

// Leaving the app clears the active rule, so coming back applies the profile again even if lighting was changed by hand meanwhile.
test('returning to an app re-applies its profile after another app (or none) was in front', async (t) => {
  let present = true;
  const f = await fixture(t, {
    platform: 'win32',
    appProbe: async (names) => ({
      apps: names.map((executable) => ({ executable, running: present, foreground: present })),
      checkedAt: '2026-10-20T00:00:00.000Z',
    }),
  });
  const saved = await (
    await f.post('/api/profiles', { name: 'Code', settings: { ...setup, effect: 'matrix' } })
  ).json();
  await f.post('/api/app-profiles/config', { automatic: true, waitMs: 0, transitionMs: 0 });
  await f.post('/api/app-profiles', {
    name: 'Code',
    executable: 'Code.exe',
    condition: 'foreground',
    profileId: saved.profile.id,
  });
  const refresh = async () => (await f.post('/api/app-profiles/refresh', {})).json();
  await refresh(); // candidate seen
  await refresh(); // switched
  const switches = () => f.calls.filter((call) => call.effect === 'matrix').length;
  const afterFirst = switches();
  present = false;
  assert.equal((await refresh()).runtime.activeId, null, 'leaving the app forgets the active rule');
  present = true;
  await refresh();
  await refresh();
  assert.equal(switches(), afterFirst + 1, 'coming back applies the profile again');
});

// Regression LL-010: PowerShell -File only bound the first of several space-separated names, so only rule #1 was ever checked.
test('the Windows app probe passes every rule name in one argument and reuses a single watcher process', async () => {
  const { createWindowsAppProbe } = require('../server.cjs');
  const { EventEmitter } = require('node:events');
  const oneShots = [];
  const spawned = [];
  let clock = 1_000;
  const execFileImpl = async (_file, args) => {
    oneShots.push(args);
    return {
      stdout: JSON.stringify({ apps: [{ executable: 'Code.exe', running: true, foreground: true }] }),
    };
  };
  const spawnImpl = (_file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => {
      child.killed = true;
    };
    spawned.push({ args, child });
    return child;
  };
  const probe = createWindowsAppProbe(execFileImpl, spawnImpl, { now: () => clock });
  await probe(['Spotify.exe', 'Code.exe']);
  // Until the watcher speaks, a one-shot answers - with ALL names in a single -AppNames value (LL-010).
  assert.deepEqual(oneShots[0].slice(-2), ['-AppNames', 'Code.exe,Spotify.exe']);
  assert.equal(spawned.length, 1);
  assert(spawned[0].args.includes('-Watch'));
  spawned[0].child.stdout.emit(
    'data',
    JSON.stringify({
      apps: [{ executable: 'Spotify.exe', running: true, foreground: false }],
      checkedAt: 'w',
    }) + '\n',
  );
  const cached = await probe(['Code.exe', 'Spotify.exe']);
  assert.equal(cached.checkedAt, 'w', 'fresh watcher output is reused without another process');
  assert.equal(oneShots.length, 1);
  assert.equal(spawned.length, 1, 'same rule set (any order) keeps the same watcher');
  clock += 10_000;
  await probe(['Code.exe', 'Spotify.exe']);
  assert.equal(oneShots.length, 2, 'stale watcher output falls back to a one-shot check');
  await probe(['Code.exe']);
  assert.equal(spawned.length, 2, 'a changed rule set restarts the watcher');
  assert.equal(spawned[0].child.killed, true);
  probe.stop();
  assert.equal(spawned[1].child.killed, true);
});

test('a stopped app probe never starts another watcher (shutdown race)', async () => {
  const { createWindowsAppProbe } = require('../server.cjs');
  const { EventEmitter } = require('node:events');
  let spawned = 0;
  const probe = createWindowsAppProbe(
    async () => ({ stdout: JSON.stringify({ apps: [] }) }),
    () => {
      spawned++;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.kill = () => {};
      return child;
    },
  );
  probe.stop();
  await probe(['Code.exe']);
  assert.equal(spawned, 0, 'after stop(), checks fall back to one-shot runs only');
});

test('a POST from an opaque "null" origin is refused as cross-site, not as a malformed request', async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/api/apply', {
    method: 'POST',
    headers: { origin: 'null', 'content-type': 'application/json' },
    body: JSON.stringify(setup),
  });
  assert.equal(response.status, 403);
  assert.equal(f.calls.length, 0);
});

test('openBrowser passes Windows start an exact empty title and refuses unexpected URL characters', () => {
  const { openBrowser } = require('../server.cjs');
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  openBrowser('http://localhost:4318', { platform: 'win32', spawnImpl });
  assert.equal(calls[0].command, 'cmd.exe');
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].args[0], '/d /s /c "start "" "http://localhost:4318""');
  openBrowser('http://localhost:4318/" & calc', { platform: 'win32', spawnImpl });
  assert.equal(calls.length, 1, 'a URL with shell metacharacters is printed, never executed');
});

// ----- LL-060 / LL-061: App Profiles conditions, default profile, inline editing, thumbnails, crossfade -----

// A time-of-day rule (no executable) is accepted, evaluated with zero app rules WITHOUT starting the probe,
// and the automatic switch passes the configured crossfade length down to the provider.
test('time rules work without any app rule, never start the probe, and switch with a crossfade', async (t) => {
  let probes = 0;
  const applied = [];
  const f = await fixture(t, {
    platform: 'win32',
    appProbe: async () => {
      probes++;
      return { apps: [] };
    },
    sdk: {
      status: async () => ({ available: true }),
      release: async () => ({}),
      keyPress: async () => ({ accepted: true }),
      apply: async (selection, options) => {
        applied.push({ selection, options });
        return { provider: 'chroma-sdk' };
      },
    },
  });
  const saved = await (
    await f.post('/api/profiles', { name: 'Night', settings: { ...setup, effect: 'solid' } })
  ).json();
  applied.length = 0; // saving activates the profile once; only the automatic switch matters below
  await f.post('/api/app-profiles/config', { automatic: true, waitMs: 0, transitionMs: 750 });
  const added = await f.post('/api/app-profiles', {
    name: 'Always',
    condition: 'time',
    from: '08:00',
    to: '08:00',
    profileId: saved.profile.id,
  });
  assert.equal(added.status, 200, await added.clone().text());
  assert.equal((await added.json()).config.rules[0].executable, null);
  await f.post('/api/app-profiles/refresh', {});
  const switched = await (await f.post('/api/app-profiles/refresh', {})).json();
  assert.equal(probes, 0, 'no app rules means no PowerShell probe');
  assert.equal(switched.runtime.activeRule.condition, 'time');
  assert.equal(switched.runtime.activeProfileName, 'Night');
  assert.equal(applied.at(-1).options.transitionMs, 750, 'automatic switches crossfade');
  assert.equal(applied.at(-1).options.force, false);
  // A manual Test of the same rule never fades.
  await f.post(`/api/app-profiles/${switched.config.rules[0].id}/test`, {});
  assert.equal(applied.at(-1).options.transitionMs, 0);
});

// The "Everything else" default profile is stored through /config, must exist, and drives runtime.activeRule.
test('the default profile is validated on save and applies when no rule matches', async (t) => {
  const f = await fixture(t, {
    platform: 'win32',
    appProbe: async (names) => ({
      apps: names.map((executable) => ({ executable, running: false, foreground: false })),
    }),
  });
  const saved = await (await f.post('/api/profiles', { name: 'Calm', settings: setup })).json();
  const missing = await f.post('/api/app-profiles/config', {
    defaultProfileId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(missing.status, 422);
  const ok = await (
    await f.post('/api/app-profiles/config', {
      automatic: true,
      waitMs: 0,
      defaultProfileId: saved.profile.id,
    })
  ).json();
  assert.equal(ok.config.defaultProfileId, saved.profile.id);
  assert.equal(ok.config.waitMs, 0, 'omitted fields keep their values, given ones change');
  await f.post('/api/app-profiles/refresh', {});
  const active = await (await f.post('/api/app-profiles/refresh', {})).json();
  assert.equal(active.runtime.activeRule.id, 'default');
  assert.equal(active.runtime.activeProfileName, 'Calm');
  const cleared = await (await f.post('/api/app-profiles/config', { defaultProfileId: null })).json();
  assert.equal(cleared.config.defaultProfileId, null);
});

// Inline editing: POST /api/app-profiles/:id/update merges fields, re-validates, and keeps the rule id.
test('rules can be edited inline and invalid edits are rejected without changing the stored rule', async (t) => {
  const f = await fixture(t, {
    platform: 'win32',
    appProbe: async (names) => ({
      apps: names.map((executable) => ({ executable, running: false, foreground: false })),
    }),
  });
  const a = await (await f.post('/api/profiles', { name: 'A', settings: setup })).json();
  const b = await (await f.post('/api/profiles', { name: 'B', settings: setup })).json();
  const added = await (
    await f.post('/api/app-profiles', {
      name: 'Code',
      executable: 'Code.exe',
      condition: 'foreground',
      profileId: a.profile.id,
    })
  ).json();
  const id = added.config.rules[0].id;
  const updated = await (
    await f.post(`/api/app-profiles/${id}/update`, {
      condition: 'fullscreen',
      profileId: b.profile.id,
      name: 'Code full',
    })
  ).json();
  assert.deepEqual(
    {
      id: updated.config.rules[0].id,
      condition: updated.config.rules[0].condition,
      profileId: updated.config.rules[0].profileId,
      name: updated.config.rules[0].name,
    },
    { id, condition: 'fullscreen', profileId: b.profile.id, name: 'Code full' },
  );
  const toTime = await (
    await f.post(`/api/app-profiles/${id}/update`, { condition: 'time', from: '22:00', to: '06:00' })
  ).json();
  assert.equal(toTime.config.rules[0].executable, null, 'switching to a time rule drops the executable');
  assert.equal((await f.post(`/api/app-profiles/${id}/update`, { from: 'late' })).status, 422);
  assert.equal(
    (await f.post(`/api/app-profiles/${id}/update`, { profileId: '33333333-3333-4333-8333-333333333333' }))
      .status,
    422,
  );
  assert.equal(
    (await f.post(`/api/app-profiles/${id}/update`, { condition: 'running' })).status,
    422,
    'an app condition needs an executable again',
  );
  const listed = await (await fetch(f.base + '/api/app-profiles')).json();
  assert.equal(listed.config.rules[0].condition, 'time', 'rejected edits change nothing');
  assert.equal(
    (await f.post('/api/app-profiles/44444444-4444-4444-8444-444444444444/update', { name: 'x' })).status,
    422,
  );
});

// Thumbnails: App Profiles responses carry each profile's settings; /api/profiles stays lightweight unless asked.
test('App Profiles responses include profile settings for thumbnails while /api/profiles stays light', async (t) => {
  const f = await fixture(t, { platform: 'win32', appProbe: async () => ({ apps: [] }) });
  await f.post('/api/profiles', { name: 'Thumb', settings: { ...setup, effect: 'matrix' } });
  const page = await (await fetch(f.base + '/api/app-profiles')).json();
  assert.equal(page.profiles[0].settings.effect, 'matrix');
  assert.equal((await (await fetch(f.base + '/api/profiles')).json()).profiles[0].settings, undefined);
  assert.equal(
    (await (await fetch(f.base + '/api/profiles?settings=1')).json()).profiles[0].settings.effect,
    'matrix',
  );
});

// Brand assets are served from explicit allowlist entries only, with correct types; no directory serving.
test('brand assets and the favicon are allowlisted with correct content types and traversal stays 404', async (t) => {
  const f = await fixture(t);
  const icon = await fetch(f.base + '/favicon.svg');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  assert.equal(icon.headers.get('x-content-type-options'), 'nosniff');
  const png = await fetch(f.base + '/assets/brand/ja-insights-wordmark-dark.png');
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await png.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG');
  // Raw request so the client does not normalize the dot-dot segment before sending it.
  const status = await new Promise((resolve, reject) => {
    const request = require('node:http').request(
      `${f.base}/assets/brand/../server.cjs`,
      { method: 'GET' },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 404);
  assert.equal(
    (await fetch(f.base + '/assets/brand/lighting-lab-lockup-dark.svg')).status,
    404,
    'unlisted files stay private',
  );
});
