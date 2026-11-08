/*
 * Native Synapse Studio profile build check. Manual, not in `npm test`; NOT runnable on a clean clone.
 *
 * Generates a .ChromaEffects archive for a Razer BlackWidow Elite "Subtle Keywords" setup through
 * synapse-profile.cjs + save-native-profile.ps1 in build-only mode, then reopens the ZIP and reads the
 * XML back to prove the expected layers exist (>= 2 Lighting Lab layers, exactly one reactive key).
 * Needs: Windows, PowerShell, and the PRIVATE vendor template archives in docs/native/ (or
 * LIGHTING_LAB_NATIVE_DIRECTORY). Those archives are deliberately not published.
 * Writes: .artifacts/lighting-lab/native-check/. Real lighting: never changed; nothing is imported into Synapse.
 */
'use strict';
const assert = require('node:assert/strict'),
  path = require('node:path'),
  fs = require('node:fs/promises'),
  crypto = require('node:crypto');
const { saveNativeProfile } = require('../synapse-profile.cjs');
const { validateSelection } = require('../lighting-domain.cjs');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util');
async function main() {
  const directory = path.resolve(__dirname, '../.artifacts/lighting-lab/native-check');
  const profile = {
    id: crypto.randomUUID(),
    name: 'Lighting Lab native verification',
    settings: validateSelection({
      provider: 'chroma-sdk',
      keyboardModel: 'razer-blackwidow-elite',
      effect: 'subtle-keywords',
      anchors: ['Q'],
      feedback: 'none',
      keywordFeedback: 'reactive',
      protectAnchors: false,
    }),
  };
  const result = await saveNativeProfile(profile, { directory, buildOnly: true });
  assert.equal(result.saved, true);
  assert.equal(result.imported, false);
  // Read the actual vendor XML back; a successful ZIP write alone is not layer verification.
  const script =
    "param($file) Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($file);try{$reader=New-Object IO.StreamReader($zip.Entries[0].Open());try{[xml]$doc=$reader.ReadToEnd()}finally{$reader.Dispose()};$layers=@($doc.LightingEffects.EffectLayers.EffectLayer|Where-Object {$_.Name -like 'Lighting Lab -*'});$feedback=@($layers|Where-Object Effect -eq 'reactive');@{layers=$layers.Count;feedbackKeys=@($feedback.Regions.EffectRegion.Cells.Item.Value.ArrayOfDeviceCell.DeviceCell).Count;name=[string]$doc.LightingEffects.Name}|ConvertTo-Json -Compress}finally{$zip.Dispose()}";
  const check = path.join(directory, 'readback.ps1');
  await fs.writeFile(check, script, 'utf8');
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', check, result.archive],
    { windowsHide: true, timeout: 10000 },
  );
  const readback = JSON.parse(stdout.trim());
  assert.equal(readback.name, profile.name);
  assert.equal(readback.feedbackKeys, 1);
  assert(readback.layers >= 2);
  console.log(
    JSON.stringify({ archive: result.archive, ...readback, imported: false, hardwareChanged: false }),
  );
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
