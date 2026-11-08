/*
 * End-to-end check of the export HTTP route (`npm run check:download`). Manual only.
 *
 * Posts real export requests to a RUNNING Lighting Lab server (LIGHTING_LAB_URL, default
 * http://127.0.0.1:4318) for both the AL65 and Auto targets, saves each returned exe, verifies the MZ
 * header, and runs it with --inspect to prove an extra marker field survived the round trip.
 * Needs: Windows, a running server (npm run serve), csc.exe. Writes exes to .artifacts/lighting-lab/.
 * Real lighting: never changed - the downloaded exe is only run with --inspect.
 */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util');

async function main() {
  const base = process.env.LIGHTING_LAB_URL || 'http://127.0.0.1:4318';
  const requested = {
    provider: 'chroma-sdk',
    effect: 'matrix',
    keyboardModel: 'yunzii-al65',
    exportModel: 'yunzii-al65',
    acceptApproximation: true,
    anchors: ['Q'],
    protectedAnchors: ['ESC'],
    feedback: 'reactive',
    speed: 3.5,
    color: '#00ff44',
    exportTestMarker: 'complete-request-round-trip',
  };
  for (const target of ['yunzii-al65', 'auto']) {
    const payload = { ...requested, exportModel: target };
    const response = await fetch(base + '/api/export/executable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(35_000),
    });
    assert(response.ok, await response.clone().text());
    assert.match(response.headers.get('content-disposition'), /\.exe/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
    const directory = path.resolve(__dirname, '../.artifacts/lighting-lab');
    await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, `Lighting-Lab-${target}-matrix-download.exe`);
    await fs.writeFile(filename, bytes);
    const inspected = JSON.parse(
      (await promisify(execFile)(filename, ['--inspect'], { windowsHide: true, timeout: 10000 })).stdout,
    );
    assert.equal(inspected.requested.exportTestMarker, requested.exportTestMarker);
    assert.equal(inspected.requested.exportModel, target);
    console.log(
      JSON.stringify({
        filename,
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        manifestInspected: true,
        lightingExecuted: false,
        realHidWrites: 0,
      }),
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
