/* =====================================================================================================
 * export.cjs — "Download .exe": turn the current setup into a tiny standalone Windows preset player.
 *
 * PURPOSE
 *   Compile one acknowledged, on-board preset into a small Windows runner; never flash firmware.
 *   The result is a single unsigned console .exe that someone can run on ANOTHER Windows PC without
 *   installing Node or Lighting Lab. Two targets exist:
 *
 *   1. "Auto-detect supported keyboard" — manifest schemaVersion 2 (portable Razer player)
 *      - 128 background frames (46 ms apart ≈ 5.9 s loop) are PRE-RENDERED here with effects.js, the
 *        same renderer as the browser preview, plus optional 9×7 mouse frames and the physical key list
 *        (Chroma row/col, preview x/y, Windows virtual-key code) needed for live reactions.
 *      - At run time portable/ChromaPreset.cs plays the frames through the PC's installed Chroma SDK
 *        and (opt-in) composites key reactions. Closing the window returns the keyboard to Synapse.
 *      - If the user ALSO acknowledged the AL65 approximation and the effect maps to an AL65 built-in,
 *        an `al65` sub-manifest (schema 1) is embedded so the same .exe can fall back to a YUNZII AL65.
 *
 *   2. "YUNZII AL65 firmware mode" — manifest schemaVersion 1 (VIA firmware preset)
 *      - The AL65 exposes only whole-board built-in modes over the VIA protocol (USB HID usage page
 *        0xFF60, usage 0x61, 32-byte reports, lighting channel 3). Lighting Lab's per-key layers CANNOT
 *        be stored, so the user must explicitly accept the approximation (acceptApproximation).
 *      - portable/PresetRunner.cs reads the current lighting, writes a backup file, applies
 *        brightness/mode/speed/hue+saturation, verifies by read-back, asks the firmware to save, verifies
 *        again, and rolls back automatically on any mismatch. `--restore <backup.json>` undoes it.
 *      - Evidence for the IDs: portable/al65-definition.json (official YUNZII VIA definition) and
 *        docs/RESEARCH-EXPORT.md.
 *
 * WHERE IT SITS
 *   server.cjs lazily requires this module (so a non-Windows server can still preview and save JSON):
 *     GET  /api/export/capabilities → getExportCapabilities(model, {effect})
 *     POST /api/export/executable   → createPresetExecutable(setup, {targetModel, acceptApproximation})
 *   tests/export.test.cjs (fake compiler) and tests/build-portable.cjs (real compiler) exercise it.
 *
 * HOW THE .EXE IS BUILT
 *   The C# sources in portable/ are fixed, reviewed code. The user's setup only ever travels as DATA:
 *   it is written to a temporary preset.json and embedded with csc.exe's `/resource:<file>,preset.json`
 *   switch; the program reads it back with GetManifestResourceStream("preset.json"). Nothing the user
 *   typed is ever concatenated into C# source or a shell command (execFile with an argument array).
 *   The compiler is the .NET Framework 4.x csc.exe that ships with every Windows 10/11 install:
 *   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe.
 *
 * DISK
 *   A private mkdtemp folder under the OS temp directory (preset.json + the compiled exe), always deleted
 *   afterwards. Nothing is written to the project or the state folder.
 * ===================================================================================================== */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// The ONLY firmware target. Values come from the official AL65 VIA definition (portable/al65-definition.json):
// vendorId/productId identify the board; usagePage 0xFF60 / usage 0x61 select its VIA raw-HID
// interface (not the typing interface); channel 3 is the backlight (underglow is left untouched).
// PresetRunner.cs re-checks the same identity before any HID write.
const AL65 = Object.freeze({
  model: 'yunzii-al65',
  vendorId: 0x4d4b,
  productId: 0x3068,
  usagePage: 0xff60,
  usage: 0x61,
  reportLength: 32,
  channel: 3,
  definitionVersion: 'AL65_QMK_V0101_20241025',
});
// Lighting Lab effect → closest AL65 built-in mode (zero-based mode IDs from THIS board's VIA definition;
// they are not generic QMK numbers). Effects missing here (Chaos, Aurora, …) cannot be exported to the
// AL65 at all, rather than being silently replaced by a rainbow.
//   Rainbow Road    → 7  Rainbow Moving Chevron (whole-board rainbow)
//   Matrix          → 15 Digital Rain (firmware rain, green by default)
//   Lights Out      → 0  All Off ("ghost" is the internal ID of Lights Out)
//   Subtle Keywords → 1  Solid Color (the anchor color on every key; keyword islands are lost)
//   Solid Color     → 1  Solid Color
const BUILTIN_EFFECTS = Object.freeze({
  'rainbow-road': { id: 7, name: 'Rainbow Moving Chevron' },
  matrix: { id: 15, name: 'Digital Rain' },
  ghost: { id: 0, name: 'All Off' },
  'subtle-keywords': { id: 1, name: 'Solid Color' },
  solid: { id: 1, name: 'Solid Color' },
});
// Shown verbatim under the export button and embedded in the manifest, so the person running the .exe
// on another PC sees the same honest list (`--inspect` prints it).
const LIMITATIONS = Object.freeze([
  'This exports an AL65 built-in whole-board effect, not the exact Lighting Lab preview.',
  'Keyword keys, protected anchors, mouse sync, layered reactions, custom layout, and Minimalist are not copied to AL65 firmware.',
  'Connect the AL65 directly by USB in wired mode. Bluetooth and the 2.4 GHz receiver are not supported.',
  'The runner uses Windows .NET Framework 4.x and the Windows HID driver; it needs no Lighting Lab, VIA, Node, or vendor app.',
  'Export defaults to 80% brightness and maximum firmware speed; the app speed slider uses a different scale and is preserved only in the embedded setup.',
  'Firmware Save is requested and verified in the current session; retention after USB power loss still needs an AL65 hardware test.',
]);

/**
 * Build an Error carrying a machine-readable code (tests assert on it) and an HTTP-ish status.
 * @param {string} message User-facing explanation (shown in the UI).
 * @param {string} [code='EXPORT_UNSUPPORTED'] EXPORT_UNSUPPORTED | EXPORT_INVALID |
 *   EXPORT_APPROXIMATION_REQUIRED | EXPORT_BUILD_UNAVAILABLE | EXPORT_BUILD_FAILED.
 * @returns {Error & {code:string, statusCode:422}}
 */
function exportError(message, code = 'EXPORT_UNSUPPORTED') {
  return Object.assign(new Error(message), { code, statusCode: 422 });
}

/**
 * What "Download .exe" can do for a target. Return capability evidence for the chosen target, without
 * probing or modifying a keyboard.
 *
 * @param {string} model 'auto', 'yunzii-al65', or a core.js model ID (lower-cased here).
 * @param {object|string} [selection={}] Setup (only `effect` matters) or just the effect ID string.
 * @returns {object} `{model, executable, supported, mode, exact, needsApproximationAcknowledgement,
 *   supportedEffects, mappedEffect, limitations, reason[, target]}` where `mode` is
 *   'portable-sdk' (Razer/auto player), 'onboard-via' (AL65 firmware) or 'unsupported'.
 *   The browser uses it to enable/disable the button and show the reason + limitations.
 * Pure function: no device access.
 */
function getExportCapabilities(model, selection = {}) {
  model = String(model || 'standard-full-size').toLowerCase();
  if (typeof selection === 'string') selection = { effect: selection };
  const base = {
    model,
    executable: false,
    supported: false,
    mode: 'unsupported',
    exact: false,
    needsApproximationAcknowledgement: false,
    supportedEffects: [],
    mappedEffect: null,
    limitations: [],
  };
  if (model !== AL65.model) {
    // Auto and any Razer model → the portable Chroma player. It is "exact" (same frames as the preview)
    // except on zone-lit hardware such as the Ornata V3, where per-key detail is merged into zones.
    if (model === 'auto' || model.startsWith('razer-'))
      return {
        ...base,
        executable: true,
        supported: true,
        mode: 'portable-sdk',
        exact: !['razer-ornata-v3', 'razer-ornata-v3-x'].includes(model),
        supportedEffects: [...require('./effects.js').EFFECTS],
        reason:
          'Auto-detecting Windows preset player: Razer keyboard + installed Chroma runtime. No Lighting Lab or Node installation is needed.',
        limitations: [
          'Animated lighting runs while the preset is open; closing it releases control to Synapse.',
          'Backgrounds repeat a baked animation sequence generated by the same renderer as the preview.',
          'Keyboard reactions are opt-in and use key identities only in memory.',
          'Unknown brands are reported as unsupported, without sending guessed USB instructions.',
          'AL65 needs its separately acknowledged built-in firmware preset.',
        ],
      };
    // Everything else (Logitech, Corsair, generic layouts…) has no verified standalone protocol.
    // Note: `razer` is always false here because Razer models returned above; the message is kept for
    // safety should that branch ever change.
    const razer = model.startsWith('razer-');
    return {
      ...base,
      reason: razer
        ? 'This Razer model needs a compatible Chroma/Synapse runtime for custom lighting; a driver-free, persistent preset executable is not implemented. Save JSON or a native Chroma profile instead.'
        : 'No verified standalone lighting protocol is available for this target. Save JSON, or choose YUNZII AL65 for its built-in firmware export.',
    };
  }
  // AL65: supported only when the effect has a built-in equivalent; the approximation must always be
  // acknowledged (needsApproximationAcknowledgement) because per-key layers are lost.
  const effect = selection.effect || 'rainbow-road';
  // Object.hasOwn (not `in`) so names like "toString" can never resolve to a prototype property.
  const mappedEffect = Object.hasOwn(BUILTIN_EFFECTS, effect) ? BUILTIN_EFFECTS[effect] : null;
  const supported = Boolean(mappedEffect);
  return {
    ...base,
    executable: supported,
    supported,
    mode: 'onboard-via',
    needsApproximationAcknowledgement: true,
    supportedEffects: Object.keys(BUILTIN_EFFECTS),
    mappedEffect,
    target: AL65,
    limitations: [...LIMITATIONS],
    reason: supported
      ? `AL65 built-in ${mappedEffect.name}; acknowledge the whole-board approximation before downloading.`
      : `The AL65 definition has no built-in equivalent for ${effect}. Choose Rainbow Road, Matrix, Lights Out, Subtle Keywords, or Solid Color for a whole-board approximation.`,
  };
}

/**
 * Validate an optional firmware byte override (from `selection.portable`).
 * @param {*} value Override, or undefined to use the default.
 * @param {number} fallback Default byte.
 * @param {string} name Field label for the error message.
 * @returns {number} An integer 0–255.
 * @throws {Error} EXPORT_INVALID for anything else (floats, strings, out of range).
 */
function byte(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 255)
    throw exportError(`${name} must be an integer from 0 to 255.`, 'EXPORT_INVALID');
  return value;
}

/**
 * Convert the setup's color to the AL65's color format.
 * VIA color is hue/saturation; brightness remains a separately documented firmware control.
 *
 * @param {object} selection Uses `color`, then `keywordColor`, then `anchorColor` (default #ff0033).
 * @returns {{hue:number, saturation:number}} Both scaled to 0–255 (VIA/QMK HSV bytes), via a standard
 *   RGB → HSV conversion (value/brightness is discarded on purpose).
 * @throws {Error} EXPORT_INVALID when the color is not "#rrggbb".
 */
function firmwareColor(selection) {
  const selected = selection.color ?? selection.keywordColor ?? selection.anchorColor ?? '#ff0033';
  if (typeof selected !== 'string' || !/^#[\da-f]{6}$/i.test(selected))
    throw exportError('Export color must be a six-digit hex color.', 'EXPORT_INVALID');
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(selected.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  const degrees =
    delta === 0
      ? 0
      : max === r
        ? 60 * (((g - b) / delta) % 6)
        : max === g
          ? 60 * ((b - r) / delta + 2)
          : 60 * ((r - g) / delta + 4);
  return {
    hue: Math.round((((degrees + 360) % 360) * 255) / 360),
    saturation: max === 0 ? 0 : Math.round((delta / max) * 255),
  };
}

/**
 * Build the AL65 firmware manifest (schemaVersion 1).
 * Preserve the complete requested setup separately from the explicitly reduced firmware settings.
 *
 * @param {object} selection The full editor setup (kept verbatim under `requested`, max 64 KiB).
 * @param {object} [options]
 * @param {string} [options.targetModel] Normally 'yunzii-al65' (falls back to selection.keyboardModel).
 * @param {boolean} [options.acceptApproximation=false] Must be exactly true.
 * @param {Date} [options.now] Clock for `generatedAt` (tests pin it).
 * @returns {object} `{schemaVersion:1, target, requested, capabilities, approximationAcknowledged,
 *   desired:{brightness, mode, speed, hue, saturation}, settingReduction, operation, restore}`.
 *   `desired` is the ONLY part PresetRunner.cs writes to the keyboard; everything else documents it.
 * @throws {Error} EXPORT_INVALID (bad/oversized setup or byte override), EXPORT_UNSUPPORTED (not an AL65
 *   target, or the effect has no built-in), EXPORT_APPROXIMATION_REQUIRED (consent missing).
 */
function createExportManifest(
  selection,
  { targetModel, acceptApproximation = false, now = new Date() } = {},
) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection))
    throw exportError('Choose a lighting setup to export.', 'EXPORT_INVALID');
  const serialized = JSON.stringify(selection);
  if (Buffer.byteLength(serialized) > 65536)
    throw exportError('The setup exceeds the 64 KiB export limit.', 'EXPORT_INVALID');
  const capabilities = getExportCapabilities(targetModel || selection.keyboardModel, selection);
  if (capabilities.mode === 'portable-sdk')
    throw exportError(
      'This manifest describes AL65 firmware only. Use the portable SDK player for Razer keyboards.',
    );
  if (!capabilities.supported) throw exportError(capabilities.reason);
  if (acceptApproximation !== true)
    throw exportError(
      'Acknowledge the AL65 whole-board approximation before generating this executable. Your exact per-key selection cannot be stored through the documented AL65 controls.',
      'EXPORT_APPROXIMATION_REQUIRED',
    );
  // Optional expert overrides: selection.portable = {brightness, speed, hue, saturation} (each 0–255).
  // They can change only these four bytes — never the target identity or the allowlisted mode.
  const options = selection.portable || {};
  const color = firmwareColor(selection);
  return {
    schemaVersion: 1,
    product: 'Lighting Lab preset',
    generatedAt: now.toISOString(),
    target: AL65,
    requested: JSON.parse(serialized),
    capabilities,
    approximationAcknowledged: true,
    desired: {
      // 204/255 = 80% brightness; speed 255 = fastest firmware animation; Digital Rain is forced to green
      // (hue 85 ≈ 120°) because a user's red anchor color would make a confusing "red rain".
      brightness: byte(options.brightness, 204, 'Portable brightness'),
      mode: capabilities.mappedEffect.id,
      speed: byte(options.speed, 255, 'Portable speed'),
      hue: byte(options.hue, selection.effect === 'matrix' ? 85 : color.hue, 'Portable hue'),
      saturation: byte(
        options.saturation,
        selection.effect === 'matrix' ? 255 : color.saturation,
        'Portable saturation',
      ),
    },
    settingReduction: {
      brightness: '80% by default; portable.brightness overrides on firmware scale 0-255.',
      speed:
        'Maximum firmware speed by default; host animation multiplier is preserved but has no verified firmware equivalent.',
      color:
        selection.effect === 'matrix'
          ? 'Digital Rain uses green by default.'
          : 'Selected hue and saturation are copied; brightness is a separate control.',
    },
    operation:
      'Read original lighting; write backup; apply built-in mode; verify; save channel 3; verify; exit.',
    restore: 'Run the same executable with --restore <backup.json>, or use its on-screen restore command.',
  };
}

/**
 * Build the downloadable preset player.
 * Compile trusted source with an embedded JSON resource; user input never becomes C# or shell text.
 *
 * @param {object} selection The editor setup (server.cjs passes body + validated fields).
 * @param {object} [options]
 * @param {string} [options.targetModel] 'auto' (Razer player, schema 2) or 'yunzii-al65' (schema 1).
 * @param {boolean} [options.acceptApproximation] AL65 consent (also embeds an AL65 fallback in 'auto').
 * @param {string} [options.compilerPath] Override csc.exe (tests use a fake).
 * @param {Function} [options.execFileImpl] promisified execFile (tests use a fake compiler).
 * @returns {Promise<{bytes:Buffer, filename:string, manifest:object, capabilities:object, sha256:string}>}
 * @throws {Error} Validation/capability errors from above; EXPORT_BUILD_UNAVAILABLE on non-Windows;
 *   EXPORT_BUILD_FAILED if csc.exe fails or does not produce a PE file (checked by its "MZ" header).
 * Side effects: creates and always deletes a private temp folder; runs csc.exe (30 s timeout).
 */
async function createPresetExecutable(selection, options = {}) {
  const target = options.targetModel || selection.keyboardModel;
  let manifest;
  if (target === AL65.model) manifest = createExportManifest(selection, options);
  else {
    // ---- Portable Razer player (schema 2) ----
    // Required lazily so `require('./export.cjs')` stays cheap for capability checks.
    const { validateSelection, createCustomMouseFrame } = require('./lighting-domain.cjs'),
      Plan = require('./core.js'),
      Effects = require('./effects.js');
    const normalized = validateSelection(selection),
      full = { ...selection, ...normalized };
    const capabilities = getExportCapabilities(target || 'auto', full);
    if (!capabilities.supported) throw exportError(capabilities.reason);
    // 46 ms matches the live provider's tick (~22 fps); 128 frames ≈ 5.9 s keeps the .exe small
    // (each frame is 6×22 integers) while long enough that most loops are not distracting.
    const frameMs = 46,
      frameCount = 128,
      layout = Plan.layoutForModel(full.keyboardModel, full.customLayout);
    // Windows virtual-key codes for switch IDs that are not a letter, digit, numpad digit or F-key
    // (those four families are computed below). The player's low-level keyboard hook reports VK +
    // scan code; PhysicalInput.cs maps them back to these switch IDs so the right key reacts.
    // Reference: https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
    // (e.g. 160/161 = VK_LSHIFT/VK_RSHIFT, 186–222 = the US-layout OEM punctuation keys).
    const virtualKeys = {
      ESC: 27,
      BACKSPACE: 8,
      TAB: 9,
      CAPS: 20,
      ENTER: 13,
      SPACE: 32,
      LCTRL: 162,
      RCTRL: 163,
      LSHIFT: 160,
      RSHIFT: 161,
      LALT: 164,
      RALT: 165,
      LWIN: 91,
      RWIN: 92,
      MENU: 93,
      INSERT: 45,
      DEL: 46,
      HOME: 36,
      END: 35,
      PGUP: 33,
      PGDN: 34,
      UP: 38,
      DOWN: 40,
      LEFT: 37,
      RIGHT: 39,
      NUM_LOCK: 144,
      NUM_DECIMAL: 110,
      NUM_ADD: 107,
      NUM_SUBTRACT: 109,
      NUM_MULTIPLY: 106,
      NUM_DIVIDE: 111,
      '`': 192,
      '-': 189,
      '=': 187,
      '[': 219,
      ']': 221,
      '\\': 220,
      ';': 186,
      "'": 222,
      ',': 188,
      '.': 190,
      '/': 191,
    };
    // One record per physical key in the chosen layout:
    //   row/col = Chroma 6×22 grid cell to light, x/y = preview geometry (key center x, top y) used for
    //   ripple/trail distances, vk = virtual-key code (0 = no reaction trigger, e.g. Fn/macro keys).
    const keys = layout.keys.map((key) => {
      const coordinate = Plan.chromaCoordinates[key.id];
      let vk = virtualKeys[key.id] || 0;
      // 'A'–'Z' and '0'–'9' have VK codes equal to their ASCII codes; VK_NUMPAD0 = 96; VK_F1 = 112.
      if (/^[A-Z0-9]$/.test(key.id)) vk = key.id.charCodeAt(0);
      if (/^NUM_[0-9]$/.test(key.id)) vk = 96 + Number(key.id.slice(4));
      if (/^F([1-9]|1[0-2])$/.test(key.id)) vk = 111 + Number(key.id.slice(1));
      return { id: key.id, row: coordinate[0], col: coordinate[1], x: key.x + key.w / 2, y: key.y, vk };
    });
    manifest = {
      schemaVersion: 2,
      product: 'Lighting Lab portable preset',
      target: { model: 'auto', supported: ['razer-chroma', 'yunzii-al65'] },
      requested: full,
      capabilities,
      playback: {
        frameMs,
        frames: Array.from({ length: frameCount }, (_, i) => Effects.frame(full, i * frameMs)),
        keys,
      },
    };
    // Mouse frames (CHROMA_CUSTOM2, 9 rows × 7 columns) only when the user asked for mouse sync.
    if (full.mouseSync)
      manifest.playback.mouseFrames = Array.from(
        { length: frameCount },
        (_, i) => createCustomMouseFrame(full.effect, 0, { ...full, timeMs: i * frameMs }).param,
      );
    // Optional AL65 fallback inside the same player (only with explicit consent and a mappable effect).
    if (options.acceptApproximation === true && getExportCapabilities(AL65.model, full).supported)
      manifest.al65 = createExportManifest(full, { targetModel: AL65.model, acceptApproximation: true });
  }
  // ---- Compile (both targets share the same three C# files) ----
  // .NET Framework 4.x's csc.exe ships with Windows; pick the 64-bit framework folder on x64 Node.
  const compilerPath =
    options.compilerPath ||
    path.join(
      process.env.WINDIR || 'C:\\Windows',
      'Microsoft.NET',
      process.arch === 'x64' ? 'Framework64' : 'Framework',
      'v4.0.30319',
      'csc.exe',
    );
  const execFileImpl = options.execFileImpl || promisify(execFile);
  if (!options.execFileImpl && process.platform !== 'win32')
    throw exportError(
      'Executable export currently builds on Windows. Save JSON on this server instead.',
      'EXPORT_BUILD_UNAVAILABLE',
    );
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-lab-preset-'));
  try {
    const resource = path.join(staging, 'preset.json');
    const executable = path.join(staging, 'lighting-preset.exe');
    await fs.writeFile(resource, JSON.stringify(manifest));
    try {
      // /resource embeds the manifest as data under the fixed name "preset.json";
      // System.Web.Extensions provides JavaScriptSerializer for reading it back in C#.
      await execFileImpl(
        compilerPath,
        [
          '/nologo',
          '/target:exe',
          '/platform:anycpu',
          '/optimize+',
          '/reference:System.Web.Extensions.dll',
          `/out:${executable}`,
          `/resource:${resource},preset.json`,
          path.join(__dirname, 'portable', 'PhysicalInput.cs'),
          path.join(__dirname, 'portable', 'ChromaPreset.cs'),
          path.join(__dirname, 'portable', 'PresetRunner.cs'),
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      throw exportError(
        `The preset executable could not be compiled: ${error.stdout || error.message}`,
        'EXPORT_BUILD_FAILED',
      );
    }
    const bytes = await fs.readFile(executable);
    // Every Windows PE executable starts with the "MZ" DOS header; anything else is not a usable .exe.
    if (bytes.length < 2 || bytes.toString('ascii', 0, 2) !== 'MZ')
      throw exportError('The compiler did not produce a Windows executable.', 'EXPORT_BUILD_FAILED');
    return {
      bytes,
      // server.cjs additionally sanitizes this to [A-Za-z0-9_.-] before using it in Content-Disposition.
      filename: `Lighting-Lab-${manifest.schemaVersion === 2 ? 'Auto' : 'AL65'}-${selection.effect}.exe`,
      manifest,
      capabilities: manifest.capabilities,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    // The compiler owns this mkdtemp directory exclusively; no user paths are removed.
    await fs.rm(staging, { recursive: true, force: true });
  }
}

module.exports = {
  AL65,
  BUILTIN_EFFECTS,
  createExportManifest,
  createPresetExecutable,
  getExportCapabilities,
};
