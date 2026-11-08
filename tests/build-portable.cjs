/*
 * Portable "Download .exe" build smoke test (`npm run build:portable`). Manual, not in `npm test`; CI runs it.
 *
 * Uses the REAL export pipeline (export.cjs) to compile two presets with the Windows csc.exe:
 *   1. an AL65 firmware preset (schema 1) - checks --inspect returns the exact requested setup and that
 *      --self-test runs >= 260 VIA protocol/rollback assertions with zero real HID writes;
 *   2. an Auto/Razer player (schema 2) with mouse sync - checks 128 keyboard + 128 mouse frames and
 *      >= 1000 self-test assertions (compositor, key identity, frame shape).
 * Needs: Windows with .NET Framework 4.x csc.exe. Writes the exes + portable-build-evidence.json to
 * .artifacts/lighting-lab/. Real lighting: never changed; no HID device is enumerated.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createPresetExecutable } = require('../export.cjs');
const run = promisify(execFile);

/** Keep built artifacts and an inspectable manifest under the workspace's ignored artifact directory. */
async function main() {
  if (process.platform !== 'win32')
    throw new Error('This smoke check needs the Windows .NET Framework C# compiler.');
  const selection = {
    effect: 'matrix',
    provider: 'chroma-sdk',
    keyboardModel: 'yunzii-al65',
    anchors: ['Q', 'W'],
    protectedAnchors: ['ESC'],
    feedback: 'reactive',
    mouseSync: false,
    minimalist: false,
  };
  const built = await createPresetExecutable(selection, {
    targetModel: 'yunzii-al65',
    acceptApproximation: true,
  });
  const directory = path.resolve(__dirname, '../.artifacts/lighting-lab');
  await fs.mkdir(directory, { recursive: true });
  const executable = path.join(directory, built.filename);
  await fs.writeFile(executable, built.bytes);
  const inspection = JSON.parse(
    (await run(executable, ['--inspect'], { windowsHide: true, timeout: 10000 })).stdout,
  );
  assert.deepEqual(inspection.requested, selection);
  assert.equal(inspection.desired.mode, 15);
  assert.equal(inspection.approximationAcknowledged, true);
  const checked = JSON.parse(
    (await run(executable, ['--self-test'], { windowsHide: true, timeout: 10000 })).stdout,
  );
  assert.ok(checked.passed >= 260);
  assert.equal(checked.realHidWrites, 0);
  const auto = await createPresetExecutable(
    {
      ...selection,
      keyboardModel: 'razer-blackwidow-elite',
      keywordFeedback: 'ripple',
      feedback: 'waterfall',
      protectAnchors: false,
      mouseSync: true,
    },
    { targetModel: 'auto' },
  );
  const autoExecutable = path.join(directory, auto.filename);
  await fs.writeFile(autoExecutable, auto.bytes);
  const autoInspect = JSON.parse(
    (await run(autoExecutable, ['--inspect'], { windowsHide: true, timeout: 10000 })).stdout,
  );
  assert.equal(autoInspect.schemaVersion, 2);
  assert.equal(autoInspect.requested.keywordFeedback, 'ripple');
  assert.equal(autoInspect.playback.frames.length, 128);
  assert.equal(autoInspect.playback.mouseFrames.length, 128);
  const autoChecked = JSON.parse(
    (await run(autoExecutable, ['--self-test'], { windowsHide: true, timeout: 10000 })).stdout,
  );
  assert.ok(autoChecked.passed >= 1000);
  assert.equal(autoChecked.realHidWrites, 0);
  const evidence = {
    ok: true,
    artifact: executable,
    bytes: built.bytes.length,
    sha256: built.sha256,
    inspectPreservedPayload: true,
    selfTests: checked.passed,
    realHidWrites: 0,
    al65HardwareVerified: false,
    auto: {
      artifact: autoExecutable,
      bytes: auto.bytes.length,
      selfTests: autoChecked.passed,
      realHidWrites: 0,
      hardwareVerified: false,
    },
  };
  await fs.writeFile(
    path.join(directory, 'portable-build-evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(evidence) + '\n');
}
main().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
