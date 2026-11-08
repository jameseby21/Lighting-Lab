/* =====================================================================================================
 * synapse-profile.cjs — OPTIONAL "Save in: Razer Synapse Studio" path (native Chroma Studio profiles).
 *
 * PURPOSE
 *   Native-profile adapter uses local vendor exports; it never writes Synapse's private database.
 *   Instead of streaming live frames (providers/chroma-sdk.cjs), this builds a real Synapse 3 Studio
 *   effect archive (*.ChromaEffects, a ZIP containing one XML document) and imports/selects it through
 *   Synapse's own visible UI. Such a profile keeps working after Lighting Lab is closed — but only for
 *   the small subset Studio can express (static colors per key + white Reactive), see
 *   profiles.cjs profileCapabilities().
 *
 * WHY IT IS OPTIONAL / LIMITED
 *   - Template-based: the XML structure is copied from archives the owner exported from Studio on the
 *     verified machine (synapse-both.ChromaEffects and reactive-painted.ChromaEffects). They are private
 *     and NOT in the repository; point LIGHTING_LAB_NATIVE_DIRECTORY at a folder containing them, or put
 *     them in docs/native/. Without them, building fails and the UI keeps "Lighting Lab" as the choice.
 *   - Verified for the Razer BlackWidow Elite ONLY: Studio stores LEDs by its own (row, column) grid per
 *     device, and only the Elite's grid has been mapped and checked against real hardware.
 *
 * WHERE IT SITS
 *   server.cjs activateProfile() calls saveNativeProfile({buildOnly:true}) to (re)create the archive and
 *   loadNativeProfile() to select it in Studio; GET /api/profiles/<id>/archive serves the archive for a
 *   manual import when UI automation cannot be verified.
 *
 * DISK
 *   Writes <state>/<profileId>.ChromaEffects and <state>/<profileId>-native-request.json (the build plan
 *   handed to save-native-profile.ps1). Reads the two template archives.
 *
 * EXTERNAL SYSTEMS
 *   powershell.exe running save-native-profile.ps1 (XML/ZIP generation, optional import) and
 *   synapse-control.ps1 (UI Automation of the Synapse 3 window). Arguments are always passed as an
 *   argument array — never through a shell — so a profile name cannot inject commands.
 * ===================================================================================================== */
'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Plan = require('./core.js'),
  Effects = require('./effects.js');
const { profileCapabilities } = require('./profiles.cjs');

/**
 * Build a Studio archive for a saved profile. Materialize a native archive from observed XML, then
 * import it through the visible vendor UI (unless `buildOnly`).
 *
 * @param {{id:string, name:string, settings:object}} profile A record from profiles.cjs.
 * @param {object} options
 * @param {string} options.directory State folder for the archive and its request file.
 * @param {boolean} [options.buildOnly=false] true = only generate the archive (no Synapse UI automation).
 * @param {Function} [options.execFileImpl] promisified execFile (tests inject a fake).
 * @returns {Promise<{saved:boolean, imported:boolean, archive:string, detail:string}>} The last JSON
 *   line printed by save-native-profile.ps1.
 * @throws {Error} BEFORE any file is written when the setup is not representable natively or the
 *   keyboard is not a BlackWidow Elite; afterwards on PowerShell failure/timeout (35 s) or bad output.
 * Side effects: writes the request JSON and the .ChromaEffects archive; with buildOnly=false also drives
 *   the Synapse window (Studio → Actions → Import).
 */
async function saveNativeProfile(
  profile,
  { directory, buildOnly = false, execFileImpl = promisify(execFile) } = {},
) {
  const selection = profile.settings,
    cap = profileCapabilities(selection, true).find((c) => c.id === 'synapse-native');
  if (!cap.exact) throw new Error(cap.reason + ' Choose Lighting Lab to save the complete animated setup.');
  if (selection.keyboardModel !== 'razer-blackwidow-elite')
    throw new Error(
      'Native Studio export currently has a verified BlackWidow Elite template only. Choose Lighting Lab for this keyboard.',
    );
  // Where the owner's private template archives live (same lookup as server.cjs nativeBridge()).
  const legacy = process.env.LIGHTING_LAB_NATIVE_DIRECTORY || path.join(__dirname, 'docs', 'native');
  const output = path.join(directory, profile.id + '.ChromaEffects'),
    requestFile = path.join(directory, profile.id + '-native-request.json');
  // This observed native template puts the tall numpad Enter LED on its lower row.
  // Physical preview geometry and SDK coordinates remain independent of Studio's LED placement.
  //
  // Studio row numbers are derived from the preview geometry in core.js: the function row sits at
  // y = 0 and the main block starts at y = 1.25, so (y - 0.25) rounds to rows 1..5. NUM_ENTER is a
  // 2-unit-tall key whose geometry starts on row 4, but Studio's template stores its LED on row 5 —
  // hence the explicit override. save-native-profile.ps1 then pairs keys with Studio cells row by row,
  // sorted left→right by x, and refuses to build if any row's key count does not match the template.
  const keys = Plan.layoutForModel(selection.keyboardModel).keys.map((key) => ({
    id: key.id,
    row: key.id === 'NUM_ENTER' ? 5 : Math.round(key.y === 0 ? 0 : key.y - 0.25),
    x: key.x,
  }));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    requestFile,
    JSON.stringify({
      name: profile.name,
      source: path.join(legacy, 'synapse-both.ChromaEffects'),
      reactive: path.join(legacy, 'reactive-painted.ChromaEffects'),
      output,
      keys,
      settings: selection,
      // The color of every key at time 0 from the shared renderer — Studio gets the same static colors
      // the preview shows (animated layers are already excluded by the capability check above).
      colors: Object.fromEntries(keys.map((k) => [k.id, Effects.sample(selection, k.id, 0)])),
    }),
    'utf8',
  );
  const { stdout } = await execFileImpl(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'save-native-profile.ps1'),
      '-RequestFile',
      requestFile,
      ...(buildOnly ? ['-BuildOnly'] : []),
    ],
    { windowsHide: true, timeout: 35000, maxBuffer: 256000 },
  );
  // The scripts may print progress first; the result is always the LAST line, as compact JSON.
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
module.exports = { saveNativeProfile };

/**
 * Re-select a saved native archive without rebuilding or overwriting it.
 *
 * @param {{id:string, name:string}} profile A synapse-native profile record.
 * @param {object} options
 * @param {string} options.directory State folder that holds <id>.ChromaEffects.
 * @param {Function} [options.execFileImpl] promisified execFile (tests inject a fake).
 * @returns {Promise<object>} `{saved:true, archive, imported, selected, detail}`. When UI automation
 *   fails it still resolves with `imported:false` and a manual-import hint — the archive exists, so the
 *   user can import it by hand (the UI offers a download link).
 * @throws {Error} Only if the archive file does not exist (fs.access).
 * Side effect: synapse-control.ps1 -Action Select opens Synapse and picks the profile by its exact
 *   name in Studio's effect list, reading the selection back before reporting success.
 */
async function loadNativeProfile(profile, { directory, execFileImpl = promisify(execFile) } = {}) {
  const archive = path.join(directory, profile.id + '.ChromaEffects');
  await fs.access(archive);
  try {
    const { stdout } = await execFileImpl(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'synapse-control.ps1'),
        '-Action',
        'Select',
        '-ProfileName',
        profile.name,
      ],
      { windowsHide: true, timeout: 35000, maxBuffer: 256000 },
    );
    return { saved: true, archive, ...JSON.parse(stdout.trim().split(/\r?\n/).at(-1)) };
  } catch (error) {
    return {
      saved: true,
      archive,
      imported: false,
      detail:
        'Native archive saved. In Studio select the imported profile. Automatic selection could not be verified: ' +
        String(error.stderr || error.message).slice(0, 500),
    };
  }
}
module.exports.loadNativeProfile = loadNativeProfile;
