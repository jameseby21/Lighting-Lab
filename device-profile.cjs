/* =====================================================================================================
 * device-profile.cjs — "which keyboard is plugged in?" (read-only identity detection).
 *
 * PURPOSE
 *   Works out which physical keyboard(s) are currently connected so the editor can show the right
 *   layout (full-size, 65%, BlackWidow Elite with media keys, …). It keeps present-device evidence
 *   distinct from RGB-provider availability: knowing the model does NOT mean Lighting Lab can light it.
 *
 * WHERE IT SITS
 *   server.cjs calls detectDevice() from status() at most once a minute (the result is cached and the
 *   call is never awaited by /api/status, because Windows enumeration can take several seconds).
 *   identify() is also unit-tested directly in tests/engine.test.cjs.
 *
 * DISK / SYSTEMS
 *   Writes nothing. Reads Windows Plug-and-Play state through one short-lived `powershell.exe`
 *   (Get-PnpDevice, Get-PnpDeviceProperty and the HKLM\SYSTEM\CurrentControlSet\Enum registry tree).
 *   No network, no vendor software, no HID writes.
 *
 * WHY "ANCESTRY"
 *   Windows' Keyboard-class device is usually a generic "HID Keyboard Device". The real product name
 *   (e.g. "Razer BlackWidow Elite") and the USB VID/PID live on its PARENT devices (HID collection →
 *   USB interface → USB composite device). So the script walks up to 4 parents collecting every name.
 *   Only -PresentOnly devices are used: the registry also remembers keyboards unplugged months ago, and
 *   those must never be mistaken for the keyboard on the desk.
 * ===================================================================================================== */
'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Plan = require('./core.js');
// Static troubleshooting guidance for a numpad "." that does not register (a real owner-reported issue).
// It is attached to every detection result and shown in the "Connection & input" panel.
const numpadDecimal = {
  state: 'needs-user-test',
  key: 'NUM_DECIMAL',
  checks: [
    'toggle Num Lock and test again',
    'test the key in Windows keyboard input',
    'inspect vendor remapping',
    'compare another USB/HID port',
  ],
  workaround: 'Remap a spare numpad key to decimal; a failed switch or PCB needs physical inspection.',
};
// Used whenever the exact model is unknown: the full-size ANSI view shows every possible key, so nothing
// the user owns is hidden. Exported because tests and the server compare against it.
const fallback = {
  model: 'Standard full-size keyboard with numpad',
  modelId: 'standard-full-size',
  source: 'fallback',
  recognized: false,
  geometry: 'full-size-with-numpad',
};

/**
 * Match precise model descriptions and USB identifiers; a generic vendor name is not a model match.
 *
 * @param {string[]} names Every name collected for one keyboard and its parents (friendly names,
 *   device descriptions, bus-reported names, instance IDs such as "USB\VID_1532&PID_0228\...").
 * @returns {object|undefined} The matching entry from core.js modelCatalog, or undefined when no
 *   pattern matches (the caller then falls back to the standard full-size view).
 * Pure function: no I/O.
 */
function identify(names) {
  const text = names.join(' ');
  // Variant suffixes can change key count or RGB zoning; prefix similarity must not claim support.
  // The table is ordered: the first matching row wins. Negative lookaheads exclude SIBLING products
  // that share a name prefix but have a different layout or lighting, e.g.
  //   "Ornata V3 X" / "Ornata V3 TKL"   → not the full-size 10-zone Ornata V3,
  //   "BlackWidow V4 75%" / "Mini"/"TKL" → not the full-size V4 with macro column,
  //   "G915 TKL" / "G915 X", "Apex Pro TKL" / "Mini" → different key counts.
  // Such variants stay unrecognized (→ full-size fallback + "choose a preview model") rather than
  // being shown with the wrong layout. AL65 is also matched by its USB VID/PID because its Windows
  // device names are often generic.
  const patterns = [
    ['yunzii-al65', /\bAL65\b|VID_4D4B&PID_3068/i],
    ['razer-ornata-v3', /ornata\s*v3\b(?!\s*(?:x\b|tkl\b|tenkeyless\b))/i],
    ['razer-ornata-v2', /ornata\s*v2\b/i],
    ['razer-ornata', /ornata\s+chroma\b/i],
    ['razer-cynosa-chroma', /cynosa\s+chroma\b/i],
    ['razer-blackwidow-elite', /blackwidow\s+elite\b/i],
    ['razer-blackwidow-v4', /blackwidow\s+v4\b(?!\s*(?:75|mini\b|tkl\b))/i],
    ['logitech-g915', /\bg915\b(?!\s*(?:tkl\b|x\b))/i],
    ['corsair-k95', /\bk95\b/i],
    ['steelseries-apex-pro', /apex\s+pro\b(?!\s*(?:tkl\b|mini\b))/i],
  ];
  const match = patterns.find(([, pattern]) => pattern.test(text));
  return match ? Plan.modelCatalog.find((m) => m.id === match[0]) : undefined;
}
/**
 * Keep every present keyboard distinct so a shared PC can choose its editor identity deliberately.
 *
 * @param {{id?:string, name?:string, names?:string[]}} item One record from the PowerShell script.
 * @param {number} index Position in the list (used for a stable fallback ID/name).
 * @param {object} baseline Shared fields (fallback layout, provider reachability, numpad guidance).
 * @returns {object} A device record shown in the "Connected keyboard" picker.
 * Pure function: no I/O.
 */
function toDevice(item, index, baseline) {
  const names = (item?.names || []).map(String),
    model = identify(names),
    // The Windows instance ID is the stable identity; cap its length so a hostile/odd value stays bounded.
    id = String(item?.id || `keyboard-${index}`).slice(0, 260);
  return {
    ...baseline,
    id,
    model: model?.label || String(item?.name || names[0] || `Keyboard ${index + 1}`),
    modelId: model?.id || 'standard-full-size',
    recognized: Boolean(model),
    geometry: model?.geometry || 'full-size-with-numpad',
    accuracy: model?.accuracy || 'reference',
    lighting: model?.lighting,
    source: model ? 'Windows present-keyboard ancestry' : 'Windows present-keyboard enumeration',
    deviceState: 'present',
    guidance:
      model?.note ||
      (model
        ? 'RGB support still needs a visual test.'
        : 'Exact model variant was not identified. Choose a preview model.'),
  };
}

/**
 * Detect present keyboards. Walk only present keyboard parents; registry fallback must never mistake a
 * disconnected historical device for presence.
 *
 * @param {object} [options]
 * @param {Function} [options.execFileImpl] promisified execFile (tests inject a fake PowerShell).
 * @param {boolean} [options.sdkAvailable=false] Chroma SDK answered (only labels rgbCapability).
 * @param {boolean} [options.synapseAvailable=false] Native Synapse bridge answered (same purpose).
 * @param {string} [options.platform=process.platform] Detection only runs on 'win32'.
 * @returns {Promise<object>} The selected device record plus `devices` (every present keyboard) and
 *   `selectedDeviceId`. The first RECOGNIZED keyboard is preselected, otherwise the first one.
 *   Never rejects: failures and timeouts become `source:'detection-unavailable'` with guidance, so the
 *   editor always has something to show.
 * Side effect: spawns one hidden powershell.exe (killed after 20 s).
 */
async function detectDevice({
  execFileImpl = promisify(execFile),
  sdkAvailable = false,
  synapseAvailable = false,
  platform = process.platform,
} = {}) {
  const reachable = sdkAvailable || synapseAvailable;
  const baseline = {
    ...fallback,
    rgbCapability: reachable ? 'provider-reachable' : 'unknown',
    deviceState: 'unknown',
    numpadDecimal,
  };
  if (platform !== 'win32')
    return {
      ...baseline,
      source: 'unsupported-platform',
      guidance:
        'Automatic keyboard identity detection is currently available on Windows. Choose your preview model manually.',
    };
  // Some PnP properties exist as error/empty records without Data. Tolerant property access keeps other identity evidence usable.
  //
  // What the one-line PowerShell script below does, step by step:
  //   1. $devices = every PRESENT device of class Keyboard (Get-PnpDevice -PresentOnly -Class Keyboard).
  //   2. For each keyboard, start a name list with its FriendlyName and remember its InstanceId.
  //   3. Walk up to 4 levels of ancestry ($depth 0..3), for each level:
  //        a. add the instance ID itself (contains VID_xxxx&PID_xxxx for USB devices),
  //        b. read that node's registry key under HKLM:\SYSTEM\CurrentControlSet\Enum\<id> and add its
  //           FriendlyName and DeviceDesc (SilentlyContinue: many nodes lack one or both),
  //        c. read two PnP properties: DEVPKEY_Device_BusReportedDeviceDesc (the product string the
  //           device reports over USB — often the most precise name) and DEVPKEY_Device_Parent,
  //        d. continue with the parent's instance ID (the loop stops early if there is no parent).
  //   4. Emit {id, name, names[]} with empty entries filtered out.
  //   5. Print everything as compressed JSON (-InputObject @($out) keeps a one-item list an array).
  // Nothing is written anywhere; this is pure enumeration.
  const script = `$ErrorActionPreference='Stop'; $devices=@(Get-PnpDevice -PresentOnly -Class Keyboard); $out=@(); foreach($device in $devices){ $names=@($device.FriendlyName); $instanceId=$device.InstanceId; $id=$instanceId; for($depth=0;$depth -lt 4 -and $id;$depth++){ $names+=$id; $path='HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\'+$id; $entry=Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue; if($entry){$names+=@($entry.FriendlyName,$entry.DeviceDesc)}; $properties=@(Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc','DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue); $names+=@($properties | Where-Object KeyName -eq 'DEVPKEY_Device_BusReportedDeviceDesc' | ForEach-Object {$_.Data}); $parent=($properties | Where-Object KeyName -eq 'DEVPKEY_Device_Parent' | Select-Object -First 1); $id=$parent.Data }; $out+=@{id=$instanceId;name=$device.FriendlyName;names=@($names | Where-Object {$_})} }; ConvertTo-Json -InputObject @($out) -Depth 4 -Compress`;
  try {
    const { stdout } = await execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      // 20 s: PnP/registry queries are usually ~1–3 s but can stall on machines with many devices or a
      // busy driver stack. The caller never blocks on this (server.cjs caches the promise).
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    // ConvertTo-Json may still produce a single object or even a bare string on older PowerShell
    // builds; normalize both into an array of records.
    const value = JSON.parse(stdout || '[]'),
      items = Array.isArray(value) ? value : [value];
    const devices = items.map((item, index) =>
      toDevice(typeof item === 'string' ? { name: item, names: [item] } : item, index, baseline),
    );
    const selected = devices.find((device) => device.recognized) || devices[0];
    if (selected)
      return {
        ...selected,
        devices,
        selectedDeviceId: selected.id,
        guidance:
          devices.length > 1
            ? `${devices.length} keyboards are present. Choose the one you are editing; SDK routing capability is shown separately.`
            : selected.guidance,
      };
    return {
      ...baseline,
      devices: [],
      selectedDeviceId: null,
      source: 'Windows present-keyboard enumeration',
      deviceState: 'not-detected',
      guidance:
        'Windows returned no present keyboards. Check the USB connection; exact RGB capability remains unknown.',
    };
  } catch (error) {
    // error.killed = execFile's timeout fired. Otherwise keep only the last two non-empty stderr lines
    // (PowerShell puts the useful part at the end), capped at 300 characters for the UI/diagnostics.
    return {
      ...baseline,
      source: 'detection-unavailable',
      detectionError: error.killed
        ? 'Windows keyboard enumeration exceeded its 20-second limit.'
        : String(error.stderr || error.message)
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(-2)
            .join(' ')
            .slice(0, 300),
      guidance:
        'Automatic model detection was unavailable. Use Identify My Layout for a guided physical-layout check, including broken keys.',
    };
  }
}
module.exports = { detectDevice, fallback, identify };
