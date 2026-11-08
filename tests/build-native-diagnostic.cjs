/*
 * Build check for tools/NativeChromaDiagnostic.cs (`npm run test:native-diagnostic`). Manual, not in `npm test`.
 *
 * Compiles the native-SDK troubleshooting exe with the Windows .NET Framework csc.exe (x64) into
 * .artifacts/lighting-lab/ and runs ONLY its --self-test, which makes zero native calls.
 * Needs: Windows with C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe.
 * Real lighting: never changed (the lime --run mode is not invoked).
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

async function main() {
  if (process.platform !== 'win32')
    throw new Error('This check needs the Windows .NET Framework C# compiler.');
  const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const source = path.resolve(__dirname, '../tools/NativeChromaDiagnostic.cs');
  const directory = path.resolve(__dirname, '../.artifacts/lighting-lab');
  const executable = path.join(directory, 'NativeChromaDiagnostic.exe');
  await fs.mkdir(directory, { recursive: true });
  await run(compiler, ['/nologo', '/platform:x64', '/target:exe', `/out:${executable}`, source], {
    windowsHide: true,
    timeout: 20000,
  });
  const checked = JSON.parse(
    (await run(executable, ['--self-test'], { windowsHide: true, timeout: 10000 })).stdout,
  );
  assert.equal(checked.ok, true);
  assert.equal(checked.nativeCalls, 0);
  assert.equal(checked.rgbWrites, 0);
  assert.equal(checked.effect, 'solid-lime-keyboard-only');
  process.stdout.write(JSON.stringify({ ok: true, artifact: executable, ...checked }) + '\n');
}
main().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
