/* =====================================================================================================
 * ui.js - the Lighting Lab browser editor
 * -----------------------------------------------------------------------------------------------------
 * Everything on http://localhost:4318 that you click, drag, or type into is wired up here. The page is one
 * static HTML file (index.html) plus four classic <script> tags, loaded in this order:
 *
 *   1. core.js          -> window.KeyboardPlan     physical switch IDs, Chroma grid coordinates, layouts,
 *                                                  the model catalog, browser key-event mapping, cap planner
 *   2. effects.js       -> window.LightingEffects  the shared renderer: (setup, key, time) -> RGB color.
 *                                                  The SAME code renders Chroma frames on the server, so the
 *                                                  preview is the real effect, not an approximation.
 *   3. layout-guide.js  -> window.LayoutGuide      the untimed "Identify My Layout" interview
 *   4. ui.js (this file)                           reads/writes the DOM and talks to server.cjs over /api/*
 *
 * There is no framework and no build step. State lives in module-level variables (SECTION 1), the DOM is
 * updated imperatively, and every user edit funnels through one hub function, changed() (SECTION 8):
 *
 *   user edit (click / select / slider / key paint)
 *     -> mutate state (groupKeys, groupSettings, form controls)
 *     -> changed(rebuild)
 *          -> renderBoard() or renderSelection()  redraw keycaps (full rebuild only when geometry may change)
 *          -> renderDetails()                     group cards, onboarding, readiness, warnings, recipe text
 *          -> persist()                           localStorage snapshot of configuration()
 *          -> paintPreview()                      recolor every keycap from LightingEffects.sample()
 *          -> queueLiveUpdate()                   if Live changes is on: POST /api/apply (after 120 ms)
 *          -> refreshExportCapabilities()         re-ask the server what "Download .exe" can do
 *          -> recordActivity('setup-changed')     debounced, privacy-bounded local audit line
 *
 * KEY GROUPS. Every physical switch belongs to exactly one of three paint groups:
 *   anchor       keys you want to stand out (pink dot; older code and saved files say "anchors"/"keywords")
 *   orientation  landmark keys such as Esc or WASD (cyan dot; older names: "protected anchors")
 *   background   everything else - always computed as "all switches minus anchor and orientation"
 * Each group independently has a base (off or a static color), a dynamic effect, and a key-press reaction
 * with its own color. The "Click keys to select" picker sets paintMode: 'anchor' | 'background' |
 * 'orientation' paint clicked keys into that group; 'test' fires reactions instead of painting.
 * For compatibility, configuration() still emits the older flat fields (effect, feedback, anchors,
 * protectedAnchors, keywordFeedback, ...) derived from the groups, because the server validator, saved
 * profiles, the AL65 exporter, and existing share links all understand them.
 *
 * LIVE WRITES. queueLiveUpdate() + drainLiveUpdates() form a single-slot coalescing queue:
 *   pendingSelection holds only the NEWEST complete setup, and applying is true while one request is in
 *   flight. A burst of 50 slider events therefore produces at most two requests (the one in flight plus
 *   the latest), requests never overlap, and an older response can never overwrite a newer edit. The
 *   Apply button reuses the same queue with force:true, which asks the server for a fresh Chroma session.
 *
 * BROWSER STORAGE (localStorage; every access is wrapped in try/catch so private windows still work):
 *   lighting-lab-setup-v2       the full configuration(), restored on reload
 *   lighting-lab-onboarding-v1  first-run guide progress: {preset, test, apply, dismissed}
 *   lighting-lab-feedback-v1    feedback notes kept "only in this browser"
 *   lighting-lab-effect         LEGACY v1 key (just an effect name); read once, only if v2 is absent
 *
 * POLLING. refreshProviderStatus() runs at startup and then every 8 seconds (statusTimer). It learns
 * whether the server and the Chroma SDK are reachable, which keyboards are present, and the last
 * human-recorded "did the lights change?" answer for the selected keyboard.
 *
 * PRIVACY. recordActivity() sends small local audit records (control IDs, effect names, outcomes) to
 * POST /api/activity, and the server filters them again against its own allowlist. It never sends typed
 * text, feedback notes, key history, or window titles; a key click is recorded only as "a preview key was
 * clicked in mode X", never which key. Nothing leaves this PC unless the user downloads diagnostics or
 * opens a GitHub issue draft themselves.
 * =====================================================================================================
 *
 * TABLE OF CONTENTS (search for "SECTION n." to jump)
 *   SECTION 1.  State & constants
 *   SECTION 2.  DOM built by script, and the preset gallery data
 *   SECTION 3.  Configuration, persistence & the activity helper
 *   SECTION 4.  Share links
 *   SECTION 5.  Restore / import, and the keycap word planner
 *   SECTION 6.  Group editor & reaction testing
 *   SECTION 7.  Board rendering
 *   SECTION 8.  Onboarding, readiness, details panel & the changed() hub
 *   SECTION 9.  Preview animation & keyboard events
 *   SECTION 10. Live updates (the coalescing write queue)
 *   SECTION 11. Provider status polling
 *   SECTION 12. Export & downloads
 *   SECTION 13. Geometry editor
 *   SECTION 14. Page bootstrap: populate pickers, restore a shared or saved setup
 *   SECTION 15. Control wiring: editor, Apply, share, export, input, release, geometry buttons
 *   SECTION 16. Feedback panel
 *   SECTION 17. Layout guide ("Identify My Layout")
 *   SECTION 18. Key issues & lighting substitutes
 *   SECTION 19. Physical verification & repair
 *   SECTION 20. Saved profiles
 *   SECTION 21. Startup: first render and status polling
 *   SECTION 22. App Profiles view
 *   SECTION 23. Activity telemetry listeners (and the App Profiles first load)
 */
'use strict';
// =====================================================================================================
// SECTION 1. STATE & CONSTANTS
// Module-level state. Nothing here is persisted directly; persist() snapshots configuration() instead.
// K / E are short aliases for the globals from core.js and effects.js; $ is document.getElementById.
// =====================================================================================================
const K = KeyboardPlan,
  E = LightingEffects,
  $ = (id) => document.getElementById(id);
// localStorage keys (see the header). Bump the suffix if the stored shape ever changes incompatibly.
const STORAGE_KEY = 'lighting-lab-setup-v2';
const ONBOARDING_KEY = 'lighting-lab-onboarding-v1';
// Legacy mirrors of the anchor / orientation groups, plus the keycap word planner's output:
//   anchors           Set of switch IDs in the anchor group (kept in sync by normalizeGroups())
//   protectedAnchors  Set of switch IDs in the orientation group (same)
//   legends           {switchId: "X"} custom cap legends proposed by the word planner (shown in "caps" mode)
//   assignments       [{word, switches} | {word, error}] word-planner placements, shown under the planner
let anchors = new Set(K.defaultAnchors),
  protectedAnchors = new Set(),
  legends = {},
  assignments = [];
// Keyboard view state:
//   customLayout     key array from "Customize keyboard view" (null = use the model's own geometry)
//   customBaseModel  which model the custom view started from (used by "Reset to model")
//   manualModel      true once the user picks a view; stops status polling from overriding it
let customLayout = null,
  customBaseModel = 'standard-full-size',
  manualModel = false;
// Last /api/status answers: deviceStatus is the selected keyboard identity, providerStatus the whole body.
let deviceStatus = { model: 'Unknown keyboard', source: 'fallback' },
  providerStatus = null;
// Connection + live-queue flags:
//   serverAvailable        the local server answered /api/status
//   providerAvailable      the selected provider (Chroma SDK or Synapse) is reachable
//   liveProviderAvailable  live streaming is possible (Chroma SDK only; Synapse works through saved profiles)
//   pendingSelection       the ONE queued live write {selection, force}, or null (see SECTION 10)
//   applying               true while a /api/apply request is in flight
let serverAvailable = false,
  providerAvailable = false,
  liveProviderAvailable = false,
  pendingSelection = null,
  applying = false;
// Timers and the export capability cache:
//   liveUpdateTimer     the 120 ms debounce before a live write
//   statusTimer         the 8 s provider status poll
//   exportCapabilities  last /api/export/capabilities answer; lastCapabilityKey is its "model:effect" key
//   capabilityRevision  increments per request so a slow, stale answer is ignored (SECTION 12)
let liveUpdateTimer,
  statusTimer,
  exportCapabilities = null,
  capabilityRevision = 0,
  lastCapabilityKey = '';
// Rendering state:
//   layout            current K.layoutForModel(...) result (keys, hardware controls, width/height in key units)
//   keyElements       Map switchId -> keycap <button> in the preview
//   events            recent key presses [{id, at}] used to draw reactions in the preview (kept 2.4 s)
//   lastPreviewFrame  timestamp of the last painted animation frame (throttle in animatePreview)
let layout,
  keyElements = new Map(),
  events = [],
  lastPreviewFrame = -100;
// Respect the OS "reduce motion" setting by starting with the animated preview paused (WCAG 2.2.2).
// Pausing only stops the on-screen animation; the physical keyboard keeps its effect.
let previewPaused = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Physical-reality state:
//   brokenKeys           switch IDs the user reported as not registering (they stay in the layout)
//   inputAliases         {workingKey: brokenKey} "lighting substitutes": pressing workingKey fires brokenKey's reaction
//   guideState           LayoutGuide interview state while the dialog is open
//   physicalConfirmed    a person said "Yes, I see it" for the current keyboard + provider
//   controlRejected      the last recorded answer for this provider was "No, unchanged"
//   lastAttemptProvider  which provider the last Apply/live write went to (what a Yes/No answer refers to)
let brokenKeys = new Set(),
  inputAliases = {},
  guideState = null,
  physicalConfirmed = false,
  controlRejected = false,
  lastAttemptProvider = 'chroma-sdk';
// Factory settings for each key group. A fresh page shows a rainbow background, pink anchors with a blue
// flame reaction, and cyan orientation keys. restoreSetup() layers imported group fields over these.
// Every group also carries per-layer strength (0..1) and Protect (redesign, LL-062); the defaults reproduce the
// pre-redesign look exactly.
const LAYER_DEFAULTS = { baseStrength: 1, dynamicStrength: 1, reactionStrength: 1, protect: false };
const GROUP_DEFAULTS = {
  anchor: {
    base: 'static',
    color: '#ff4fb8',
    dynamic: 'none',
    reaction: 'flame',
    reactionColor: '#2aa8ff',
    ...LAYER_DEFAULTS,
  },
  background: {
    base: 'off',
    color: '#8090ae',
    dynamic: 'rainbow-road',
    reaction: 'reactive',
    reactionColor: '#ffffff',
    ...LAYER_DEFAULTS,
  },
  orientation: {
    base: 'static',
    color: '#52ddea',
    dynamic: 'none',
    reaction: 'none',
    reactionColor: '#ffffff',
    ...LAYER_DEFAULTS,
  },
};
// Human labels for the dynamic effects in the group cards. "(Chroma)" marks Razer-Studio-style looks.
const EFFECT_LABELS = {
  none: 'None',
  'rainbow-road': 'Rainbow Road',
  'stars-stripes': 'Stars & Stripes',
  matrix: 'Matrix',
  chaos: 'Chaos',
  breathing: 'Breathing (Chroma)',
  spectrum: 'Spectrum Cycling (Chroma)',
  fire: 'Fire (Chroma)',
  starlight: 'Starlight (Chroma)',
  wave: 'Wave (Chroma)',
  aurora: 'Aurora',
  radar: 'Radar Sweep',
  prism: 'Prism Flow',
};
// Human labels for the reactions in the group cards and status messages.
const REACTION_LABELS = {
  none: 'None',
  reactive: 'Reactive / white fade (Chroma)',
  ripple: 'Ripple (Chroma)',
  waterfall: 'Waterfall',
  flash: 'Flash',
  'fading-trail': 'Fading trail',
  'rainbow-ripple': 'Rainbow ripple',
  pulse: 'Pulse',
  sparkle: 'Sparkle',
  comet: 'Comet trail',
  flame: 'Blue flame',
};
// paintMode: what clicking a preview key does ('anchor' | 'background' | 'orientation' paint, 'test' fires).
// groupKeys: Set of switch IDs per group (background is recomputed by normalizeGroups()).
// groupSettings: {base, color, dynamic, reaction, reactionColor} per group.
// UI mode (user request, LL-063): 'simple' = the live keyboard + the looks gallery only; 'fancy' = every
// control. New visitors start simple; the choice is remembered in this browser only.
const UI_MODE_KEY = 'lighting-lab-mode-v1';
let uiMode = 'simple';
try {
  if (localStorage.getItem(UI_MODE_KEY) === 'fancy') uiMode = 'fancy';
} catch {
  /* storage disabled: start simple */
}
// Groups hidden in the PREVIEW ONLY by the eye chips (hardware output is unaffected).
const previewHidden = new Set();
let paintMode = 'anchor',
  groupKeys = { anchor: new Set(anchors), background: new Set(), orientation: new Set(protectedAnchors) },
  groupSettings = structuredClone(GROUP_DEFAULTS);
// The physical switch list never changes at runtime, so build it once. normalizeGroups() runs on every
// preview frame via configuration(); the old per-call Object.keys(...).includes(...) was O(n²) per frame.
const PHYSICAL_IDS = Object.keys(K.chromaCoordinates);
const PHYSICAL_ID_SET = new Set(PHYSICAL_IDS);
/**
 * Every physical switch ID Lighting Lab knows (the keys of KeyboardPlan.chromaCoordinates).
 * @returns {string[]} The shared, never-mutated ID list.
 */
function allPhysicalIds() {
  return PHYSICAL_IDS;
}
/**
 * Enforce the group invariants after any edit:
 *   - drop unknown IDs (for example from an old or hand-edited import),
 *   - background = every switch that is not anchor or orientation (so each key is in exactly one group),
 *   - refresh the legacy anchors / protectedAnchors mirrors.
 * Side effects: replaces groupKeys.*, anchors, protectedAnchors. No DOM access.
 */
function normalizeGroups() {
  for (const name of E.GROUP_NAMES)
    groupKeys[name] = new Set([...groupKeys[name]].filter((id) => PHYSICAL_ID_SET.has(id)));
  const occupied = new Set([...groupKeys.anchor, ...groupKeys.orientation]);
  groupKeys.background = new Set(allPhysicalIds().filter((id) => !occupied.has(id)));
  anchors = new Set(groupKeys.anchor);
  protectedAnchors = new Set(groupKeys.orientation);
}
/**
 * Build the "groups" object sent to the server and stored in saved setups.
 * @returns {{anchor:object, background:object, orientation:object}} Each: {keys:[...], base, color,
 *   dynamic, reaction, reactionColor}.
 */
function groupPayload() {
  normalizeGroups();
  return Object.fromEntries(
    E.GROUP_NAMES.map((name) => [name, { keys: [...groupKeys[name]], ...groupSettings[name] }]),
  );
}
// =====================================================================================================
// SECTION 2. DOM BUILT BY SCRIPT, AND THE PRESET GALLERY DATA
// Some controls are created here rather than in index.html because they were added in later passes and
// depend on data from core.js (key lists) or need ids that other code looks up. Each block below inserts one
// piece of UI next to an existing landmark element.
// =====================================================================================================
// "Anchor key reaction" select, inserted just before the existing "On keypress" (background) select.
// A color pin and a key reaction are separate layers; protecting a keyword is an explicit choice.
const keywordLabel = document.createElement('label');
keywordLabel.innerHTML =
  'Anchor key reaction<select id="keyword-feedback"><option value="reactive">White fade</option><option value="ripple">Ripple</option><option value="waterfall">Waterfall</option><option value="none">No reaction</option></select>';
$('feedback').parentElement.before(keywordLabel);
// "Anchor" and "background" are the same words the group cards and paint modes use (one vocabulary everywhere).
$('feedback').parentElement.firstChild.textContent = 'Background key reaction';
// Reactions show ABOVE anchor colors by default; "Keep anchor colors during reactions" is opt-in.
$('protect').checked = false;
// "Identify My Layout" button, placed left of "Pause preview" in the board toolbar.
const identifyButton = document.createElement('button');
identifyButton.id = 'identify-layout';
identifyButton.className = 'quiet';
identifyButton.textContent = 'Identify My Layout';
$('pause-preview').before(identifyButton);
// One-line hint above the keyboard (#layout-prompt); refreshProviderStatus() fills it.
const detectionPrompt = document.createElement('p');
detectionPrompt.id = 'layout-prompt';
detectionPrompt.className = 'help';
detectionPrompt.dataset.fancy = ''; // layout hints are an All-controls detail
$('board-scroll').before(detectionPrompt);
// The "Layered lighting" panel: group cards (#group-editor), quick actions, reaction status line, and the
// "Test typing" box. Inserted above the classic effect controls.
const groupPanel = document.createElement('section');
groupPanel.className = 'group-panel';
// Redesign (LL-062): a group x layer MATRIX on the left and an INSPECTOR on the right. All markup here is
// static; renderGroupEditor() fills the matrix and renderInspector() updates the inspector in place.
groupPanel.innerHTML =
  '<div class="group-heading"><div><p class="eyebrow">LAYERED LIGHTING</p><h2>What each group does</h2><p class="help">Pick a cell to edit it. Use “Shows on” or “Link all” to change several groups at once.</p></div><div class="group-actions"><button id="anchor-blue-flame" class="quiet">Blue flame anchor keys</button><button id="preview-apply" class="primary">Apply to keyboard</button></div></div>' +
  '<div class="group-layout"><div class="group-main"><div id="group-editor" class="group-matrix" role="grid" aria-label="Key groups and their lighting layers"></div>' +
  '<div class="quick-keys"><span class="tool-label">ADD KEYS TO THE PAINT GROUP</span><button class="chip" data-key-set="wasd">WASD</button><button class="chip" data-key-set="arrows">Arrows</button><button class="chip" data-key-set="numpad">Number pad</button><button class="chip" data-key-set="frow">Function row</button><button class="chip" data-key-set="numbers">Number row</button></div>' +
  '<p class="layer-order"><span class="tool-label">LAYER ORDER · TOP WINS</span><span class="layer-chip">1 Reaction</span><span class="layer-chip">2 Dynamic effect</span><span class="layer-chip">3 Base lighting</span></p>' +
  '<p class="help">Protected groups ignore reactions that start on keys in other groups; their own keys still react.</p>' +
  '<p id="reaction-status" class="help" aria-live="polite">Pick a reaction, then click a key or type in Test typing to try it.</p></div>' +
  '<aside id="group-inspector" class="group-inspector" aria-labelledby="inspector-title"><p class="eyebrow">EDITING</p><h3 id="inspector-title"></h3><p id="inspector-link" class="help"></p>' +
  '<label class="inspector-search">Choose<input id="inspector-search" type="search" placeholder="Search, e.g. ripple" autocomplete="off"></label>' +
  '<div id="inspector-categories" class="inspector-categories" role="group" aria-label="Categories"></div>' +
  '<div id="inspector-options" class="inspector-options" role="listbox" aria-label="Options"></div>' +
  '<p id="inspector-count" class="help"></p>' +
  '<div class="inspector-fields"><label id="inspector-color-label">Color<input id="inspector-color" type="color"></label>' +
  '<label>Strength <output id="inspector-strength-value" for="inspector-strength">100%</output><input id="inspector-strength" type="range" min="0" max="100" step="5"></label>' +
  '<label id="inspector-speed-label">Speed (all motion) <output id="inspector-speed-value" for="inspector-speed">3.5×</output><input id="inspector-speed" type="range" min="0.25" max="6" step="0.25"></label></div>' +
  '<div class="inspector-targets"><span class="tool-label">SHOWS ON</span><div id="inspector-targets" role="group" aria-label="Apply this layer to"></div></div></aside></div>';
document.querySelector('.effect-controls').before(groupPanel);
// The original single-row controls stay below the matrix as whole-board shortcuts (presets and older setups use them).
document
  .querySelector('.effect-controls')
  .insertAdjacentHTML('beforebegin', '<p class="eyebrow shortcuts-heading">WHOLE-BOARD SHORTCUTS</p>');
// "Connected keyboard" picker (#selected-device) under the device status line, for PCs with 2+ keyboards.
const devicePicker = document.createElement('label');
devicePicker.className = 'device-picker';
devicePicker.innerHTML =
  'Connected keyboard<select id="selected-device"></select><small id="device-scope"></small>';
$('device-status').after(devicePicker);
// The paint-mode options live in index.html (one source of truth); start in anchor painting.
$('selection-mode').value = 'anchor';
// "Key Issues & Workarounds" panel, added as the first advanced section (see SECTION 18 for its buttons).
const issuePanel = document.createElement('details');
issuePanel.className = 'panel';
issuePanel.innerHTML =
  '<summary>Key Issues & Workarounds <span>Broken keys, Num Lock, alternate lighting triggers</span></summary><div class="details-content"><label>Problem key<select id="issue-key"></select></label><div class="button-row"><button id="mark-broken" class="quiet">This Key Does Not Register</button><button id="clear-broken" class="quiet">Mark Working</button></div><p id="issue-status" class="help"></p><label>Use this working key instead for lighting reactions<select id="issue-alternate"><option value="">No substitution</option></select></label><button id="issue-use" class="quiet">Set Lighting Substitute</button><p class="help">This changes lighting feedback only. It does not change typing or remap Windows. For a number-pad key, check Num Lock and vendor remapping; a physical fault can need repair or an OS-level remap.</p></div>';
document.querySelector('.advanced-grid').prepend(issuePanel);
// Fill both Key Issues pickers with every physical switch ID.
for (const id of Object.keys(K.chromaCoordinates))
  for (const target of ['issue-key', 'issue-alternate']) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    $(target).append(option);
  }
// The twelve one-click looks in the "Find your frequency" gallery. Each sets the background effect, the
// background reaction, and optionally Keypress Only. 'swatch' picks a CSS class (.swatch-*) for the tile.
// Effects 'ghost' (Lights Out), 'solid', and 'subtle-keywords' are base-only looks with no motion.
const presets = [
  {
    name: 'Rainbow Road',
    detail: 'A spectrum in motion',
    swatch: 'rainbow',
    effect: 'rainbow-road',
    feedback: 'reactive',
  },
  {
    name: 'Rainbow Ripple',
    detail: 'Make a little wave',
    swatch: 'ripple',
    effect: 'rainbow-road',
    feedback: 'ripple',
  },
  {
    name: 'Waterfall',
    detail: 'Light follows your lead',
    swatch: 'waterfall',
    effect: 'ghost',
    feedback: 'waterfall',
    minimalist: true,
  },
  {
    name: 'Matrix',
    detail: 'Falling lines of green rain',
    swatch: 'matrix',
    effect: 'matrix',
    feedback: 'waterfall',
  },
  {
    name: 'After Dark',
    detail: 'Only light when you type',
    swatch: 'minimal',
    effect: 'ghost',
    feedback: 'reactive',
    minimalist: true,
  },
  {
    name: 'Stars & Stripes',
    detail: 'Red & white rising bands',
    swatch: 'stripes',
    effect: 'stars-stripes',
    feedback: 'reactive',
  },
  {
    name: 'Noob Deterrent',
    detail: 'Your chosen anchor keys',
    swatch: 'keywords',
    effect: 'subtle-keywords',
    feedback: 'reactive',
  },
  {
    name: 'Chaos',
    detail: 'Random color. Random motion.',
    swatch: 'chaos',
    effect: 'chaos',
    feedback: 'reactive',
  },
  {
    name: 'Color Study',
    detail: 'One color. All yours.',
    swatch: 'solid',
    effect: 'solid',
    feedback: 'reactive',
  },
  {
    name: 'Aurora',
    detail: 'Slow teal and violet drift',
    swatch: 'aurora',
    effect: 'aurora',
    feedback: 'pulse',
  },
  {
    name: 'Radar Sweep',
    detail: 'A green scan through the dark',
    swatch: 'radar',
    effect: 'radar',
    feedback: 'sparkle',
  },
  { name: 'Prism Flow', detail: 'Clean color movement', swatch: 'prism', effect: 'prism', feedback: 'comet' },
];

// =====================================================================================================
// SECTION 3. CONFIGURATION, PERSISTENCE & THE ACTIVITY HELPER
// configuration() is the single source of truth for "the current setup". Everything that leaves the page
// (live writes, saved profiles, JSON export, share links, .exe export, feedback records) is built from it.
// =====================================================================================================
/**
 * Snapshot the complete current setup as a plain object (a fresh copy every call; safe to mutate).
 * Suitable for JSON export, live providers, saved profiles, and executable export.
 * Reads many form controls: #provider, #selected-device, #speed, #color, #mode, #words, #numpad, #protect,
 * #minimalist, #keyboard-model, #sync-mouse, #live.
 * Side effect: normalizeGroups() via groupPayload(). Called on every preview frame, so keep it cheap.
 * @returns {object} A 'lighting-lab-effect-v1' setup with both the layered "groups" and the legacy flat fields.
 */
function configuration() {
  const groups = groupPayload(),
    backgroundGroup = groups.background,
    anchorGroup = groups.anchor;
  return {
    // Format tag for files and share links. Unchanged since v1; reactionLayersVersion below marks newer content.
    format: 'lighting-lab-effect-v1',
    device: deviceStatus.model,
    provider: $('provider').value,
    // undefined (not "") so JSON.stringify omits the field entirely when no keyboard is selected.
    deviceId: $('selected-device').value || undefined,
    groups,
    // Legacy single "effect": the background's motion if it has one; otherwise 'solid' for a static base color
    // and 'ghost' (Lights Out) for an unlit base. The server validator, AL65 exporter, export capability check,
    // and preset-gallery highlighting all still key off this one field.
    effect:
      backgroundGroup.dynamic === 'none'
        ? backgroundGroup.base === 'static'
          ? 'solid'
          : 'ghost'
        : backgroundGroup.dynamic,
    background: backgroundGroup.dynamic,
    feedback: backgroundGroup.reaction,
    keywordFeedback: anchorGroup.reaction,
    // Marks setups that carry per-group reactions (v3). restoreSetup() reads this; see the note there.
    reactionLayersVersion: 3,
    speed: Number($('speed').value),
    color: $('color').value,
    // One color picker historically fed three legacy fields; group colors now live in groups.*.color.
    keywordColor: $('color').value,
    anchorColor: $('color').value,
    mode: $('mode').value,
    words: words(),
    physicalInventoryIssues: K.validate(words(), $('numpad').checked),
    placements: structuredClone(assignments),
    anchors: [...groups.anchor.keys],
    protectedAnchors: [...groups.orientation.keys],
    legends: { ...legends },
    protectAnchors: $('protect').checked,
    minimalist: $('minimalist').checked,
    keyboardModel: $('keyboard-model').value,
    customLayout: customLayout ? structuredClone(customLayout) : null,
    customBaseModel,
    manualModel,
    mouseSync: $('sync-mouse').checked,
    numpadInventory: $('numpad').checked,
    live: $('live').checked,
    previewPaused,
    brokenKeys: [...brokenKeys],
    inputAliases: { ...inputAliases },
    // Hint for the native Synapse path: true only when anchors equal the (empty) defaults and no orientation keys.
    synapseImportable:
      JSON.stringify([...anchors].sort()) === JSON.stringify([...K.defaultAnchors].sort()) &&
      protectedAnchors.size === 0,
  };
}
/**
 * The keycap word planner's words, from the comma-separated #words textarea.
 * @returns {string[]} Trimmed, non-empty words.
 */
function words() {
  return $('words')
    .value.split(',')
    .map((word) => word.trim())
    .filter(Boolean);
}
/**
 * Show a message in a status element and tag its state for styling (CSS keys off data-state).
 * @param {string} id      Element id, e.g. 'apply-status', 'profile-status', 'reaction-status'.
 * @param {string} message Plain text (never HTML).
 * @param {''|'ready'|'problem'} [state] '' neutral, 'ready' success/green, 'problem' warning/orange.
 */
function setStatus(id, message, state = '') {
  $(id).textContent = message;
  $(id).dataset.state = state;
}
// ---- Activity helper (the listeners that call it are in SECTION 23) ----
// Coalesce bursts (dragging the speed slider fires dozens of 'input' events per second) into one record.
const ACTIVITY_DEBOUNCE_MS = 1500;
const activityTimers = new Map();
/**
 * Keep a local, privacy-bounded action trail without collecting typed text, notes, or key history.
 * Fire-and-forget POST /api/activity; failures are ignored (the editor never depends on it).
 * @param {string} action  kebab-case action name, e.g. 'control-clicked' (the server rejects anything else).
 * @param {object} [detail] Small metadata: only control/effect/model/provider/state/outcome/category/rating/
 *   mode/force keys survive the server's allowlist; strings are limited to safe characters.
 * @param {{debounce?: boolean}} [options] debounce: keep only the last call per action within 1.5 s.
 * Does nothing while the server is unreachable (serverAvailable === false).
 */
function recordActivity(action, detail = {}, { debounce = false } = {}) {
  if (!serverAvailable) return;
  if (debounce) {
    clearTimeout(activityTimers.get(action));
    activityTimers.set(
      action,
      setTimeout(() => {
        activityTimers.delete(action);
        recordActivity(action, detail);
      }, ACTIVITY_DEBOUNCE_MS),
    );
    return;
  }
  fetch('/api/activity', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, detail }),
  }).catch(() => undefined);
}
/**
 * Save the full configuration() to localStorage ('lighting-lab-setup-v2') so a reload restores everything.
 * Silently skipped when storage is unavailable (private mode, disabled storage, preview iframes).
 */
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configuration()));
  } catch {
    /* Storage-disabled previews still work. */
  }
}
// =====================================================================================================
// SECTION 4. SHARE LINKS
// A share link is a browser-only recipe in the URL fragment (#lighting-lab=<base64 JSON>). Fragments are
// never sent to any server, and opening one restores the PREVIEW only; the recipient chooses whether to Apply.
// =====================================================================================================
/**
 * Encode a setup into a share URL. UTF-8 bytes are converted to a binary string first because btoa() only
 * accepts Latin-1 (custom key labels may contain other characters).
 * @param {object} setup     Usually configuration().
 * @param {string} [base]    Page URL to attach the fragment to (defaults to this page).
 * @returns {string} The full share URL.
 * @throws If the JSON exceeds 6000 bytes (long URLs get truncated by chat apps and browsers).
 */
function createShareLink(setup, base = location.href) {
  const bytes = new TextEncoder().encode(JSON.stringify(setup));
  if (bytes.length > 6000)
    throw Error('This setup is too large for a reliable share link. Export Setup JSON instead.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const url = new URL(base);
  url.hash = `lighting-lab=${btoa(binary)}`;
  return url.href;
}
/**
 * Decode a share fragment back into a setup object.
 * @param {string} [hash] A location.hash string; defaults to this page's.
 * @returns {object|null} The setup, or null when the URL has no lighting-lab fragment.
 * @throws A friendly error for corrupted links (bad base64, bad JSON, or no anchors array).
 */
function readShareLink(hash = location.hash) {
  const encoded = new URLSearchParams(String(hash).replace(/^#/, '')).get('lighting-lab');
  if (!encoded) return null;
  try {
    const binary = atob(encoded),
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const setup = JSON.parse(new TextDecoder().decode(bytes));
    if (!setup || typeof setup !== 'object' || !Array.isArray(setup.anchors)) throw Error('missing anchors');
    return setup;
  } catch {
    throw Error('This Lighting Lab share link is incomplete or invalid.');
  }
}
/**
 * Copy text to the clipboard. Uses the async Clipboard API when available (https/localhost), otherwise
 * falls back to a hidden <textarea> + execCommand('copy') for older or locked-down browsers.
 * @param {string} value Text to copy.
 * @returns {Promise<boolean>} true when the browser reports success.
 */
async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand?.('copy') === true;
  field.remove();
  return copied;
}

// =====================================================================================================
// SECTION 5. RESTORE / IMPORT, AND THE KEYCAP WORD PLANNER
// restoreSetup() is the one path for loading a setup from anywhere: localStorage on reload, a share link,
// "Import Setup JSON", a saved profile, or the browser test. It only mutates state and form controls; callers
// then call changed() (or renderBoard()/renderDetails()) to redraw.
// =====================================================================================================
/**
 * Load a setup object into the editor's state and controls.
 * Restoring a layout never implies that the keyboard supports physical RGB.
 * Accepts both current layered setups (with "groups") and older flat setups (effect/feedback/anchors only).
 * @param {object} data A setup as produced by configuration() (any version since v1).
 * @throws If data is not an object with an anchors array (the minimum every version has).
 * Touches: #background, #feedback, #provider, #mode, #keyword-feedback, #keyboard-model, #words, #speed,
 * #color, #protect, #minimalist, #sync-mouse, #numpad, #live.
 */
function restoreSetup(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.anchors))
    throw Error('Choose a Lighting Lab setup JSON containing an anchors array.');
  // Set a <select> only if the value is one of its options, so a malformed file cannot select nothing.
  const setValue = (id, value) => {
    if (value !== undefined && [...$(id).options].some((option) => option.value === String(value)))
      $(id).value = value;
  };
  setValue('background', data.effect || data.background);
  setValue('feedback', data.feedback);
  setValue('provider', data.provider);
  setValue('mode', data.mode);
  setValue('keyword-feedback', data.keywordFeedback || 'reactive');
  brokenKeys = new Set(data.brokenKeys || []);
  inputAliases = { ...(data.inputAliases || {}) };
  // Unknown model IDs (from a newer version or a typo) fall back to the full-size reference view.
  const model = K.modelCatalog.some((item) => item.id === data.keyboardModel)
    ? data.keyboardModel
    : 'standard-full-size';
  $('keyboard-model').value = model;
  // Restored views count as user-chosen unless the file says otherwise, so polling will not override them.
  manualModel = data.manualModel !== false;
  // Custom geometry is re-validated by core.js (unknown IDs, duplicates, out-of-range sizes throw).
  if (data.customLayout) {
    const checked = K.layoutForModel('custom', data.customLayout);
    customLayout = checked.keys;
    if (model === 'custom') $('keyboard-model').value = 'custom';
  } else customLayout = null;
  customBaseModel = K.modelCatalog.some((item) => item.id === data.customBaseModel)
    ? data.customBaseModel
    : model;
  // The server still validates physical IDs. Invalid imported values never become markup or executable code.
  anchors = new Set(data.anchors.filter((id) => typeof id === 'string'));
  protectedAnchors = new Set((data.protectedAnchors || []).filter((id) => typeof id === 'string'));
  // Layered setup: take each group's keys and settings, defaulting any missing field.
  // SECURITY: share links and setup JSON are untrusted input, and group settings are later interpolated into
  // innerHTML by renderGroupEditor(). Every field is therefore checked against its allowlist/format here
  // (sanitizeGroupSettings) - a crafted link can no longer inject markup or script (ISSUES-LOG LL-035).
  if (data.groups && typeof data.groups === 'object') {
    for (const name of E.GROUP_NAMES) {
      const imported = data.groups[name] && typeof data.groups[name] === 'object' ? data.groups[name] : {};
      groupKeys[name] = new Set(
        (Array.isArray(imported.keys) ? imported.keys : []).filter((id) => typeof id === 'string'),
      );
      groupSettings[name] = sanitizeGroupSettings(name, imported);
    }
  } else {
    // LEGACY flat setup (before key groups existed): anchors -> anchor group, protectedAnchors -> orientation,
    // and the single effect/feedback/keywordFeedback fields become the background/anchor group settings.
    // The flat "effect" may be a non-motion value (solid / ghost / subtle-keywords); those map to a base mode
    // exactly like choosePreset() does, instead of becoming an invalid dynamic effect the server rejects (LL-036).
    groupKeys.anchor = new Set(anchors);
    groupKeys.orientation = new Set(protectedAnchors);
    const legacyEffect = data.effect || data.background || GROUP_DEFAULTS.background.dynamic;
    groupSettings.background = sanitizeGroupSettings('background', {
      ...groupSettings.background,
      dynamic: E.DYNAMIC_EFFECTS.includes(legacyEffect) ? legacyEffect : 'none',
      base: legacyEffect === 'solid' ? 'static' : 'off',
      color: data.color,
      reaction: data.feedback || GROUP_DEFAULTS.background.reaction,
    });
    groupSettings.anchor = sanitizeGroupSettings('anchor', {
      ...groupSettings.anchor,
      reaction: data.keywordFeedback || GROUP_DEFAULTS.anchor.reaction,
    });
  }
  normalizeGroups();
  legends = data.legends && typeof data.legends === 'object' ? data.legends : {};
  assignments = Array.isArray(data.placements) ? data.placements : [];
  if (Array.isArray(data.words)) $('words').value = data.words.join(', ');
  // Speed is clamped to the slider's range (0.25 to 6).
  if (Number.isFinite(Number(data.speed))) $('speed').value = Math.max(0.25, Math.min(6, Number(data.speed)));
  if (/^#[a-f\d]{6}$/i.test(data.color || data.anchorColor || ''))
    $('color').value = data.color || data.anchorColor;
  // Checkbox fields: only real booleans are applied, so a missing field keeps the current state.
  for (const [id, key] of [
    ['protect', 'protectAnchors'],
    ['minimalist', 'minimalist'],
    ['sync-mouse', 'mouseSync'],
    ['numpad', 'numpadInventory'],
    ['live', 'live'],
  ])
    if (typeof data[key] === 'boolean') $(id).checked = data[key];
  if (typeof data.previewPaused === 'boolean') previewPaused = data.previewPaused;
  // Setups saved before reaction layers existed (no reactionLayersVersion, i.e. < 2) used the old meaning of
  // "protect", so they restore with "Keep anchor colors during reactions" off. Version 2 AND later keep the saved
  // choice. (This used to test `!== 2`, so every current v3 save silently lost the setting - LL-037.)
  if (!(Number(data.reactionLayersVersion) >= 2)) $('protect').checked = false;
}

/**
 * Return a safe copy of one group's settings from untrusted input (share link, imported JSON, saved profile).
 * Each field must match its allowlist or format, otherwise the group's default is used.
 * @param {'anchor'|'background'|'orientation'} name
 * @param {object} input raw imported group object (its `keys` are handled by the caller)
 * @returns {{base:string,color:string,dynamic:string,reaction:string,reactionColor:string}}
 */
function sanitizeGroupSettings(name, input = {}) {
  const defaults = GROUP_DEFAULTS[name];
  const hex = (value, fallback) =>
    typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : fallback;
  const unit = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  return {
    base: input.base === 'static' || input.base === 'off' ? input.base : defaults.base,
    color: hex(input.color, defaults.color),
    dynamic: E.DYNAMIC_EFFECTS.includes(input.dynamic) ? input.dynamic : defaults.dynamic,
    reaction: E.REACTIONS.includes(input.reaction) ? input.reaction : defaults.reaction,
    reactionColor: hex(input.reactionColor, defaults.reactionColor),
    baseStrength: unit(input.baseStrength, defaults.baseStrength),
    dynamicStrength: unit(input.dynamicStrength, defaults.dynamicStrength),
    reactionStrength: unit(input.reactionStrength, defaults.reactionStrength),
    protect: typeof input.protect === 'boolean' ? input.protect : defaults.protect,
  };
}

/**
 * Keycap word planner: place each word from #words as a contiguous "island" of keys on the first main-cluster
 * row with room (first-fit), make those keys the anchor group, and record proposed cap legends.
 * Only runs when asked (Rebuild word islands / choosing a word set); choosing a preset keeps manual selections.
 * Side effects: replaces anchors, groupKeys.anchor, legends, assignments; then changed().
 */
function arrange() {
  anchors = new Set();
  groupKeys.anchor = new Set();
  legends = {};
  assignments = [];
  const used = K.rows.map(() => 0);
  for (const word of words()) {
    const tokens = K.tokens(word),
      row = used.findIndex((count, index) => count + tokens.length <= K.rows[index].length);
    if (row < 0) {
      assignments.push({ word, error: 'No contiguous main-cluster row space remains' });
      continue;
    }
    const ids = [...K.rows[row]].slice(used[row], used[row] + tokens.length);
    ids.forEach((id, index) => {
      anchors.add(id);
      groupKeys.anchor.add(id);
      legends[id] = tokens[index];
    });
    used[row] += tokens.length + 1;
    assignments.push({ word, switches: ids });
  }
  changed();
}

// =====================================================================================================
// SECTION 6. GROUP EDITOR & REACTION TESTING
// The three group cards expose the renderer's layers directly: base (off/static color), dynamic motion,
// and reaction (drawn above both). Clicking a preview key paints it into the current group or, in Test mode,
// fires its reaction in the preview and (when live) on the keyboard.
// =====================================================================================================
// ---- Redesigned group editor (matrix + inspector), from the redesign pack's "What each group does" screen ----
// Catalog of every choice per layer, with the plain-language description and category the inspector shows.
// ids are the renderer's own values (effects.js); labels/descriptions are UI copy only.
const LAYER_COLUMNS = [
  { id: 'base', label: 'Base lighting', field: 'base', strengthField: 'baseStrength', colorField: 'color' },
  {
    id: 'dynamic',
    label: 'Dynamic effect',
    field: 'dynamic',
    strengthField: 'dynamicStrength',
    colorField: 'color',
  },
  {
    id: 'reaction',
    label: 'Reaction',
    field: 'reaction',
    strengthField: 'reactionStrength',
    colorField: 'reactionColor',
  },
];
const OPTION_CATALOG = {
  base: [
    { id: 'off', label: 'Off', description: 'Unlit under effects', category: 'Basic' },
    { id: 'static', label: 'Solid color', description: 'One steady color', category: 'Basic' },
  ],
  dynamic: [
    { id: 'none', label: 'None', description: 'No animation', category: 'Basic' },
    {
      id: 'rainbow-road',
      label: 'Rainbow Road',
      description: 'A spectrum sliding across the board',
      category: 'Colorful',
    },
    { id: 'matrix', label: 'Matrix', description: 'One falling line of green rain', category: 'Energetic' },
    {
      id: 'stars-stripes',
      label: 'Stars & Stripes',
      description: 'Red and white bands rising',
      category: 'Playful',
    },
    { id: 'chaos', label: 'Chaos', description: 'Every key does its own thing', category: 'Energetic' },
    {
      id: 'breathing',
      label: 'Breathing',
      description: 'A slow fade in and out of the color',
      category: 'Basic',
    },
    {
      id: 'spectrum',
      label: 'Spectrum cycling',
      description: 'The whole group shifts hue together',
      category: 'Colorful',
    },
    { id: 'fire', label: 'Fire', description: 'Flickering embers', category: 'Energetic' },
    {
      id: 'starlight',
      label: 'Starlight',
      description: 'Random keys twinkle in the color',
      category: 'Playful',
    },
    { id: 'wave', label: 'Wave', description: 'A rainbow sweeping sideways', category: 'Colorful' },
    { id: 'aurora', label: 'Aurora', description: 'Slow teal and violet drift', category: 'Colorful' },
    {
      id: 'radar',
      label: 'Radar sweep',
      description: 'A green scan line through the dark',
      category: 'Playful',
    },
    { id: 'prism', label: 'Prism flow', description: 'Clean diagonal color movement', category: 'Colorful' },
  ],
  reaction: [
    { id: 'none', label: 'None', description: 'Ignores key presses', category: 'Basic' },
    {
      id: 'reactive',
      label: 'White fade',
      description: 'The pressed key glows, then fades',
      category: 'Typing',
    },
    { id: 'ripple', label: 'Ripple', description: 'A ring spreads from the key', category: 'Typing' },
    {
      id: 'rainbow-ripple',
      label: 'Rainbow ripple',
      description: 'A ring that shifts hue',
      category: 'Colorful',
    },
    { id: 'waterfall', label: 'Waterfall', description: 'Light falls down the board', category: 'Typing' },
    { id: 'flash', label: 'Flash', description: 'Only the pressed key, quick', category: 'Typing' },
    { id: 'pulse', label: 'Pulse', description: 'A softer, longer glow', category: 'Basic' },
    {
      id: 'fading-trail',
      label: 'Fading trail',
      description: 'Light runs along the row',
      category: 'Playful',
    },
    { id: 'comet', label: 'Comet trail', description: 'A long streak to the right', category: 'Playful' },
    { id: 'sparkle', label: 'Sparkle', description: 'Random keys twinkle around it', category: 'Playful' },
    { id: 'flame', label: 'Blue flame', description: 'A flickering flare on the key', category: 'Energetic' },
  ],
};
const OPTION_CATEGORIES = ['All', 'Basic', 'Typing', 'Colorful', 'Energetic', 'Playful'];
const GROUP_LABELS = { anchor: 'Anchor', background: 'Background', orientation: 'Orientation' };
// What the inspector is editing: one column (layer) for one or more groups ("Shows on" / "Link all").
const inspector = {
  column: 'reaction',
  row: 'background',
  targets: new Set(['background']),
  query: '',
  category: 'All',
};
// Quick key sets for "Add keys to the paint group" (switch IDs; filtered to the drawn layout when used).
const KEY_SETS = {
  wasd: ['W', 'A', 'S', 'D'],
  arrows: ['UP', 'DOWN', 'LEFT', 'RIGHT'],
  numpad: PHYSICAL_IDS.filter((id) => id.startsWith('NUM_')),
  frow: Array.from({ length: 12 }, (_, i) => 'F' + (i + 1)),
  numbers: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
};
/** Look up a catalog entry (falls back to a generic label for unexpected ids). */
function optionFor(column, id) {
  return (
    OPTION_CATALOG[column].find((option) => option.id === id) || {
      id,
      label: String(id),
      description: '',
      category: 'Basic',
    }
  );
}
/** Short second line for a matrix cell, e.g. "#2F16B8 · 100%" or "3.5× · 45%". */
function cellDetail(column, group, name) {
  const percent = (value) => `${Math.round((value ?? 1) * 100)}%`;
  if (column === 'base')
    return group.base === 'static'
      ? `${group.color.toUpperCase()} · ${percent(group.baseStrength)}`
      : 'Unlit under effects';
  if (column === 'dynamic')
    return group.dynamic === 'none'
      ? 'No animation'
      : `${Number($('speed').value)}× · ${percent(group.dynamicStrength)}`;
  if (group.reaction === 'none') return 'Ignores key presses';
  return `${group.protect ? 'own keys' : 'any key'} → ${GROUP_LABELS[name]} · ${percent(group.reactionStrength)}`;
}
/** Small element helper: tag + class + text (text always via textContent, never markup). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
/**
 * Rebuild the group x layer matrix from groupSettings/groupKeys, then refresh the inspector.
 * Rows: Anchor / Background / Orientation (color bar + key count). Columns: Base / Dynamic / Reaction (each cell
 * shows the choice and its parameters; clicking selects it for the inspector) and Protect (a toggle).
 * Called from renderDetails() on every change.
 */
function renderGroupEditor() {
  const matrix = $('group-editor');
  matrix.replaceChildren();
  // Header row.
  matrix.append(el('div', 'matrix-corner'));
  for (const column of LAYER_COLUMNS) {
    const head = el('div', 'matrix-head');
    head.append(el('b', '', column.label), el('small', '', `${OPTION_CATALOG[column.id].length} options`));
    const linkAll = el('button', 'quiet link-all', 'Link all');
    linkAll.type = 'button';
    linkAll.title = `Edit ${column.label.toLowerCase()} for all three groups at once`;
    linkAll.onclick = () => {
      inspector.column = column.id;
      inspector.targets = new Set(E.GROUP_NAMES);
      renderGroupEditor();
    };
    head.append(linkAll);
    matrix.append(head);
  }
  matrix.append(el('div', 'matrix-head matrix-protect-head', 'Protect'));
  // One row per group.
  for (const name of E.GROUP_NAMES) {
    const group = groupSettings[name];
    const label = el('div', `matrix-group group-${name}`);
    label.append(
      el('i', 'group-bar'),
      el('b', '', GROUP_LABELS[name]),
      el('small', '', `${groupKeys[name].size} keys`),
    );
    matrix.append(label);
    for (const column of LAYER_COLUMNS) {
      const option = optionFor(column.id, group[column.field]);
      const cell = el('button', 'matrix-cell');
      cell.type = 'button';
      cell.dataset.row = name;
      cell.dataset.column = column.id;
      const selected = inspector.column === column.id && inspector.targets.has(name);
      cell.setAttribute('aria-pressed', String(selected));
      if (selected && inspector.targets.size > 1) cell.dataset.linked = 'true';
      const swatch = el('i', `cell-swatch fx-${column.id}-${option.id}`);
      if (column.id === 'base' && group.base === 'static') swatch.style.background = group.color;
      if (column.id === 'reaction' && option.id !== 'none' && option.id !== 'rainbow-ripple')
        swatch.style.background = group.reactionColor;
      const text = el('span', 'cell-text');
      text.append(el('b', '', option.label), el('small', '', cellDetail(column.id, group, name)));
      cell.append(swatch, text);
      cell.onclick = () => {
        inspector.column = column.id;
        inspector.row = name;
        inspector.targets = new Set([name]);
        renderGroupEditor();
      };
      matrix.append(cell);
    }
    const shield = el('button', 'protect-toggle');
    shield.type = 'button';
    shield.setAttribute('aria-pressed', String(group.protect === true));
    shield.setAttribute('aria-label', `Protect ${GROUP_LABELS[name]} from reactions started in other groups`);
    shield.title = group.protect ? 'Protected: ignores other groups’ reactions' : 'Not protected';
    shield.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    shield.onclick = () => {
      groupSettings[name].protect = !groupSettings[name].protect;
      if (name === 'anchor') $('protect').checked = groupSettings.anchor.protect; // keep the shortcut in sync
      changed(false);
    };
    matrix.append(shield);
  }
  renderInspector();
}
/** Update the inspector panel in place (title, link note, option list, fields, Shows on chips). */
function renderInspector() {
  const column = LAYER_COLUMNS.find((item) => item.id === inspector.column);
  if (!inspector.targets.size) inspector.targets = new Set([inspector.row]);
  if (!inspector.targets.has(inspector.row)) inspector.row = [...inspector.targets][0];
  const focus = groupSettings[inspector.row];
  const targetNames = E.GROUP_NAMES.filter((name) => inspector.targets.has(name));
  $('inspector-title').textContent =
    targetNames.length > 1
      ? `${targetNames.map((n) => GROUP_LABELS[n]).join(' + ')} · ${column.label}`
      : `${GROUP_LABELS[inspector.row]} · ${column.label}`;
  $('inspector-link').textContent =
    targetNames.length > 1
      ? `Linked: changes apply to ${targetNames.map((n) => GROUP_LABELS[n]).join(', ')}.`
      : `Not linked: changes apply to ${GROUP_LABELS[inspector.row]} only.`;
  // Category chips.
  const categories = $('inspector-categories');
  categories.replaceChildren();
  for (const category of OPTION_CATEGORIES) {
    if (category !== 'All' && !OPTION_CATALOG[column.id].some((option) => option.category === category))
      continue;
    const chip = el('button', 'chip', category);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(inspector.category === category));
    chip.onclick = () => {
      inspector.category = category;
      renderInspector();
    };
    categories.append(chip);
  }
  // Option list (filtered by search + category).
  const query = inspector.query.trim().toLowerCase();
  const matches = OPTION_CATALOG[column.id].filter(
    (option) =>
      (inspector.category === 'All' || option.category === inspector.category) &&
      (!query || `${option.label} ${option.description} ${option.category}`.toLowerCase().includes(query)),
  );
  const list = $('inspector-options');
  list.replaceChildren();
  for (const option of matches) {
    const item = el('button', 'inspector-option');
    item.type = 'button';
    item.setAttribute('role', 'option');
    item.dataset.option = option.id;
    item.setAttribute('aria-selected', String(focus[column.field] === option.id));
    const swatch = el('i', `option-swatch fx-${column.id}-${option.id}`);
    if (column.id === 'base' && option.id === 'static') swatch.style.background = focus.color;
    const text = el('span', 'option-text');
    text.append(el('b', '', option.label), el('small', '', option.description));
    item.append(swatch, text, el('em', 'option-category', option.category));
    item.onclick = () => {
      for (const name of inspector.targets) groupSettings[name][column.field] = option.id;
      changed(false);
    };
    list.append(item);
  }
  $('inspector-count').textContent = `Showing ${matches.length} of ${OPTION_CATALOG[column.id].length}.`;
  // Fields. Values are only written when the control is not being dragged/typed in.
  const colorInput = $('inspector-color');
  $('inspector-color-label').firstChild.textContent =
    column.id === 'reaction' ? 'Reaction color' : column.id === 'base' ? 'Base color' : 'Accent color';
  if (document.activeElement !== colorInput) colorInput.value = focus[column.colorField];
  const strength = $('inspector-strength');
  if (document.activeElement !== strength)
    strength.value = Math.round((focus[column.strengthField] ?? 1) * 100);
  $('inspector-strength-value').textContent = `${strength.value}%`;
  $('inspector-speed-label').hidden = column.id === 'base';
  if (document.activeElement !== $('inspector-speed')) $('inspector-speed').value = $('speed').value;
  $('inspector-speed-value').textContent = `${Number($('speed').value)}×`;
  // Shows on: which groups this layer edit applies to.
  const targets = $('inspector-targets');
  targets.replaceChildren();
  for (const name of E.GROUP_NAMES) {
    const chip = el('button', `chip chip-${name}`, GROUP_LABELS[name]);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(inspector.targets.has(name)));
    chip.onclick = () => {
      if (inspector.targets.has(name) && inspector.targets.size > 1) inspector.targets.delete(name);
      else inspector.targets.add(name);
      renderGroupEditor();
    };
    targets.append(chip);
  }
}
/** Wire the inspector's persistent controls once (they are never rebuilt, so dragging is uninterrupted). */
function wireInspector() {
  $('inspector-search').oninput = () => {
    inspector.query = $('inspector-search').value;
    renderInspector();
  };
  $('inspector-color').oninput = () => {
    const column = LAYER_COLUMNS.find((item) => item.id === inspector.column);
    for (const name of inspector.targets) {
      groupSettings[name][column.colorField] = $('inspector-color').value;
      // Picking a base color implies the base should be visible.
      if (column.id === 'base' && groupSettings[name].base === 'off') groupSettings[name].base = 'static';
    }
    changed(false);
  };
  $('inspector-strength').oninput = () => {
    const column = LAYER_COLUMNS.find((item) => item.id === inspector.column);
    for (const name of inspector.targets)
      groupSettings[name][column.strengthField] = Number($('inspector-strength').value) / 100;
    $('inspector-strength-value').textContent = `${$('inspector-strength').value}%`;
    changed(false);
  };
  $('inspector-speed').oninput = () => {
    // One shared speed for all motion: mirror into the main #speed control and reuse its handler.
    $('speed').value = $('inspector-speed').value;
    $('speed').dispatchEvent(new Event('input'));
  };
  for (const button of document.querySelectorAll('[data-key-set]'))
    button.onclick = () => addKeySet(button.dataset.keySet);
}
/**
 * "Add keys" quick sets: put WASD / arrows / number pad / function row / number row into the current paint
 * group (Anchor when the paint mode is Test or in Simple mode). Only keys drawn in the current layout are used.
 */
function addKeySet(setName) {
  const group = paintMode === 'test' || paintMode === 'background' ? 'anchor' : paintMode;
  const visible = new Set(layout.keys.map((key) => key.id));
  const ids = (KEY_SETS[setName] || []).filter((id) => visible.has(id));
  for (const id of ids) {
    for (const name of E.GROUP_NAMES) groupKeys[name].delete(id);
    groupKeys[group].add(id);
  }
  normalizeGroups();
  changed(false);
  setStatus('reaction-status', `Added ${ids.length} keys to ${GROUP_LABELS[group]}.`, 'ready');
}
/**
 * Handle a click on a preview key in paint mode.
 * Clicking a key already in the anchor/orientation group toggles it back to background; otherwise the key
 * moves into the current group. In 'test' mode this fires the key's reaction instead.
 * @param {string} id Physical switch ID, e.g. 'Q' or 'NUM_ENTER'.
 */
function assignToPaintGroup(id) {
  if (paintMode === 'test' || uiMode === 'simple') {
    fireReaction(id);
    return;
  }
  const target = groupKeys[paintMode];
  if (target.has(id) && paintMode !== 'background') {
    target.delete(id);
    groupKeys.background.add(id);
  } else {
    for (const name of E.GROUP_NAMES) groupKeys[name].delete(id);
    target.add(id);
  }
  normalizeGroups();
  changed(false);
}
/**
 * "Blue flame anchor keys" quick action: give the anchor group the flame reaction in blue (#2aa8ff).
 * Updates #reaction-status with a hint to test it.
 */
function enableBlueAnchorFlame() {
  groupSettings.anchor.reaction = 'flame';
  groupSettings.anchor.reactionColor = '#2aa8ff';
  renderGroupEditor();
  changed(false);
  setStatus(
    'reaction-status',
    'Blue flame is now assigned to anchor keys. Click or type an anchor key to test it.',
    'ready',
  );
}
/**
 * Fire a reaction for one key: always in the preview, and also on the keyboard (POST /api/key-press) when the
 * server, a live-capable provider, and "Live changes" are all on.
 * Lighting substitutes apply first: if the user mapped a working key to a broken one, the broken key's
 * reaction plays. Updates #reaction-status with what happened (preview only / delivered / rejected).
 * Privacy: the activity record contains the reaction name only, never the key.
 * @param {string} id Physical switch ID from a click, the test box, or a document keydown.
 */
function fireReaction(id) {
  if (!id) return;
  const physicalId = inputAliases[id] || id,
    selection = configuration(),
    reaction = E.groupFor(selection, physicalId).reaction;
  recordActivity('reaction-tested', { state: 'preview', outcome: reaction });
  markOnboarding('test');
  events.push({ id: physicalId, at: performance.now() });
  paintPreview(performance.now());
  if (reaction === 'none') {
    setStatus(
      'reaction-status',
      'This key group has reactions off. Choose a reaction or use Blue flame anchor keys.',
      'problem',
    );
    return;
  }
  setStatus(
    'reaction-status',
    physicalId +
      ' preview: ' +
      (REACTION_LABELS[reaction] || reaction) +
      ' is above its base and dynamic layers.',
    'ready',
  );
  if (!(serverAvailable && liveProviderAvailable && $('live').checked)) {
    setStatus(
      'reaction-status',
      physicalId + ' previewed. Turn on Live Connection to send this reaction to the keyboard.',
      '',
    );
    return;
  }
  fetch('/api/key-press', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: physicalId }),
  })
    .then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.accepted === false) {
        recordActivity('reaction-delivery', { outcome: 'rejected' });
        setStatus(
          'reaction-status',
          result.reason || 'The live reaction was not accepted. Apply the current setup and try again.',
          'problem',
        );
        return;
      }
      recordActivity('reaction-delivery', { outcome: 'accepted' });
      setStatus(
        'reaction-status',
        physicalId +
          ' live ' +
          (REACTION_LABELS[result.mode] || result.mode) +
          ' reached the Chroma session.',
        'ready',
      );
    })
    .catch(() => {
      recordActivity('reaction-delivery', { outcome: 'failed' });
      setStatus(
        'reaction-status',
        'The preview reacted, but the live reaction was not delivered. Apply the current setup and try again.',
        'problem',
      );
    });
}

// =====================================================================================================
// SECTION 7. BOARD RENDERING
// The preview is absolutely positioned keycap buttons in "key units" (1u = one standard key width). Using
// physical geometry instead of text wrapping keeps full-height Enter/numpad keys and unique switch identities.
// =====================================================================================================
/**
 * Rebuild the whole keyboard preview for the selected model (or custom view).
 * Touches: #key-surface (keycaps + inert hardware controls), #case-name, #key-count, #board[data-model],
 * #model-note, #geometry-key options. Also calls readGeometryFields(), renderSelection(), paintPreview().
 * Use it when geometry may have changed (model switch, custom view, legend mode, window resize); for
 * simple group edits renderSelection() is enough.
 */
function renderBoard() {
  layout = K.layoutForModel($('keyboard-model').value, customLayout);
  // --unit (px per key unit) is set in styles.css and grows on wide screens; gap leaves 5 px between caps.
  const unit = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--unit')) || 48;
  const gap = 5,
    surface = $('key-surface');
  surface.replaceChildren();
  keyElements = new Map();
  surface.style.width = `${layout.width * unit}px`;
  surface.style.height = `${layout.height * unit}px`;
  $('case-name').textContent = layout.label.toUpperCase();
  $('key-count').textContent = `${layout.keys.length} switches`;
  $('board').dataset.model = layout.id;
  $('model-note').textContent = [
    manualModel ? 'View chosen by you.' : 'Automatic view.',
    layout.note ||
      (layout.accuracy === 'reference'
        ? 'Standard reference layout; casing is schematic.'
        : 'Layout illustration; casing is approximate.'),
  ].join(' ');
  for (const position of layout.keys) {
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'key';
    key.dataset.id = position.id;
    key.dataset.code = position.code || '';
    // "Proposed custom cap legends" mode shows the word planner's letters on anchor keys.
    key.textContent = $('mode').value === 'caps' ? legends[position.id] || position.label : position.label;
    key.style.left = `${position.x * unit}px`;
    key.style.top = `${position.y * unit}px`;
    key.style.width = `${position.w * unit - gap}px`;
    key.style.height = `${position.h * unit - gap}px`;
    key.title = `${position.label} (${position.id})`;
    key.setAttribute('aria-label', `${position.label} · ${position.id}`);
    // Keycap click: in geometry-edit mode select the key for editing; otherwise paint or test it.
    key.onclick = () => {
      if ($('edit-geometry').checked) {
        $('geometry-key').value = position.id;
        readGeometryFields();
        return;
      }
      assignToPaintGroup(position.id);
    };
    surface.append(key);
    keyElements.set(position.id, key);
  }
  // Media buttons and dials help orient the view but have no addressable keyboard LED.
  for (const control of layout.controls || []) {
    const element = document.createElement('div');
    element.className = `hardware-control ${control.type === 'dial' || control.kind === 'dial' ? 'hardware-dial' : ''}`;
    element.dataset.controlId = control.id;
    const name = control.title || control.label;
    element.textContent = control.label;
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', `${name} · hardware control; no addressable RGB LED`);
    element.title = `${name} · physical control, no addressable RGB LED`;
    element.style.left = `${control.x * unit}px`;
    element.style.top = `${control.y * unit}px`;
    element.style.width = `${(control.w || 1) * unit - gap}px`;
    element.style.height = `${(control.h || 1) * unit - gap}px`;
    surface.append(element);
  }
  const previous = $('geometry-key').value;
  $('geometry-key').replaceChildren();
  for (const key of layout.keys) {
    const option = document.createElement('option');
    option.value = key.id;
    option.textContent = `${key.label} · ${key.id}`;
    $('geometry-key').append(option);
  }
  if (layout.keys.some((key) => key.id === previous)) $('geometry-key').value = previous;
  readGeometryFields();
  renderSelection();
  paintPreview(performance.now());
}
/**
 * Refresh group markers on existing keycaps without rebuilding them: .anchor / .protected classes (the
 * pink/cyan dots), aria-pressed for the current paint group, and the "N anchor · N orientation" count
 * (#selection-count, counting only keys visible in this layout).
 */
function renderSelection() {
  normalizeGroups();
  for (const [id, key] of keyElements) {
    key.classList.toggle('anchor', groupKeys.anchor.has(id));
    key.classList.toggle('protected', groupKeys.orientation.has(id));
    key.setAttribute('aria-pressed', String(paintMode !== 'test' && groupKeys[paintMode]?.has(id)));
  }
  const visible = new Set(layout.keys.map((key) => key.id));
  $('selection-count').textContent =
    `${[...anchors].filter((id) => visible.has(id)).length} anchor · ${[...protectedAnchors].filter((id) => visible.has(id)).length} orientation`;
  for (const pill of document.querySelectorAll('[data-paint]'))
    pill.setAttribute('aria-pressed', String(pill.dataset.paint === paintMode));
  for (const chip of document.querySelectorAll('[data-preview-group]')) {
    const name = chip.dataset.previewGroup;
    chip.querySelector('b').textContent = String([...groupKeys[name]].filter((id) => visible.has(id)).length);
    chip.setAttribute('aria-pressed', String(!previewHidden.has(name)));
  }
  renderCaseHint();
}
/** One line under the keyboard saying what a click on a key does right now. */
function renderCaseHint() {
  $('case-hint').textContent =
    uiMode === 'simple' || paintMode === 'test'
      ? 'Click or type to fire reactions'
      : `Painting ${paintMode}: click keys to add or remove them`;
}
// =====================================================================================================
// SECTION 8. ONBOARDING, READINESS, DETAILS PANEL & THE changed() HUB
// The first-run guide (#quickstart) tracks three steps in localStorage. The "Ready check" separates three
// facts that are easy to confuse: the preview works, the controller accepted a request, and a PERSON saw
// the physical lights change.
// =====================================================================================================
/**
 * Read first-run progress from localStorage ('lighting-lab-onboarding-v1').
 * @returns {{preset?:boolean, test?:boolean, apply?:boolean, dismissed?:boolean}} {} when unavailable.
 */
function onboardingState() {
  try {
    return JSON.parse(localStorage.getItem(ONBOARDING_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
/**
 * Mark one onboarding step done and redraw the guide.
 * First-run progress stays in this browser; it never becomes device or account telemetry.
 * @param {'preset'|'test'|'apply'} step
 */
function markOnboarding(step) {
  try {
    const next = { ...onboardingState(), [step]: true };
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify(next));
  } catch {
    /* A private-mode preview remains fully usable. */
  }
  renderOnboarding();
}
/**
 * Show or hide the first-run guide (#quickstart), tick completed steps (data-complete on each <li>), and
 * update #quickstart-status. A dismissed guide stays hidden.
 */
function renderOnboarding() {
  const panel = $('quickstart');
  if (!panel) return;
  const state = onboardingState();
  panel.hidden = state.dismissed === true;
  if (panel.hidden) return;
  for (const item of panel.querySelectorAll('[data-onboarding-step]'))
    item.dataset.complete = String(Boolean(state[item.dataset.onboardingStep]));
  const completed = ['preset', 'test', 'apply'].filter((step) => state[step]).length;
  $('quickstart-status').textContent =
    completed === 3
      ? 'You are ready to save a profile or keep customizing.'
      : `${completed} of 3 complete. Live changes sends edits to a connected keyboard; Apply forces a fresh send.`;
}
/**
 * Apply a gallery preset through the same state path as the advanced controls: set #background/#feedback,
 * translate the legacy effect name into background group settings, set Keypress Only, then changed(false).
 * Base-only looks ('ghost', 'solid', 'subtle-keywords') have dynamic 'none'; only 'solid' lights the base.
 * @param {{effect:string, feedback:string, minimalist?:boolean}} preset One entry of presets.
 */
function choosePreset(preset) {
  $('background').value = preset.effect;
  $('feedback').value = preset.feedback;
  groupSettings.background.dynamic =
    preset.effect === 'ghost' || preset.effect === 'solid' || preset.effect === 'subtle-keywords'
      ? 'none'
      : preset.effect;
  groupSettings.background.base = preset.effect === 'solid' ? 'static' : 'off';
  groupSettings.background.reaction = preset.feedback;
  $('minimalist').checked = Boolean(preset.minimalist);
  markOnboarding('preset');
  changed(false);
}
/**
 * Fill the three "Ready check" rows ([data-readiness=preview|controller|physical]) from providerAvailable
 * and physicalConfirmed, and relabel #readiness-action ("Review Apply" vs "Open saved profiles").
 */
function renderReadiness() {
  const states = {
    preview: { state: 'ready', text: 'The browser preview is ready.' },
    controller: providerAvailable
      ? { state: 'ready', text: 'The selected controller can receive a request.' }
      : { state: 'problem', text: 'No controllable provider is available yet.' },
    physical: physicalConfirmed
      ? { state: 'ready', text: 'A person confirmed the current provider changed the lights.' }
      : { state: 'pending', text: 'Awaiting a physical confirmation after Apply.' },
  };
  for (const [name, detail] of Object.entries(states)) {
    const item = document.querySelector(`[data-readiness="${name}"]`);
    item.dataset.state = detail.state;
    item.querySelector('span').textContent = detail.text;
  }
  $('readiness-action').textContent = physicalConfirmed ? 'Open saved profiles' : 'Review Apply';
}
/**
 * Redraw everything derived from state that is not the keycaps themselves: group cards, onboarding,
 * readiness, the layer warning (#layer-warning), Key Issues status, speed label, cap inventory validation,
 * word placements, which gallery preset looks selected (aria-pressed), the Setup recipe (#recipe), and the
 * pause button label.
 */
function renderDetails() {
  renderGroupEditor();
  renderOnboarding();
  renderReadiness();
  const pinned = layout.keys.filter((key) => anchors.has(key.id) || protectedAnchors.has(key.id)).length;
  const layerMessages = [];
  if ($('minimalist').checked)
    layerMessages.push('Keypress Only is on: the background is deliberately dark.');
  if (pinned)
    layerMessages.push(
      pinned +
        ' of ' +
        layout.keys.length +
        ' keys have fixed colors; the background appears on the remaining ' +
        (layout.keys.length - pinned) +
        '. Clear color anchors to expose more of the effect.',
    );
  if (controlRejected)
    layerMessages.push(
      'A prior physical check was marked unchanged. Live edits remain available; use Apply and record the latest result.',
    );
  layerMessages.push('Keyword reactions sit above their fixed colors unless you explicitly protect them.');
  $('layer-warning').textContent = layerMessages.join(' ');
  $('issue-status').textContent = brokenKeys.size
    ? `Reported unresponsive: ${[...brokenKeys].join(', ')}. These keys remain in the layout.`
    : 'No unresponsive keys recorded.';
  $('speed-value').textContent = `${Number($('speed').value)}×`;
  const issues = K.validate(words(), $('numpad').checked);
  $('validation').textContent = issues.length
    ? `Physical cap inventory: ${issues.join(' · ')}`
    : 'Cap inventory fits the stated US-legend assumptions. Check actual cap sizes before moving caps.';
  $('placements').replaceChildren();
  for (const assignment of assignments) {
    const p = document.createElement('p');
    p.textContent = `${assignment.word} → ${assignment.error || (assignment.switches || []).join(' ')}`;
    $('placements').append(p);
  }
  // A gallery tile looks "selected" when the current background effect, reaction, and Keypress Only match it.
  for (const [index, preset] of presets.entries())
    $('preset-gallery').children[index].setAttribute(
      'aria-pressed',
      String(
        $('background').value === preset.effect &&
          $('feedback').value === preset.feedback &&
          $('minimalist').checked === Boolean(preset.minimalist),
      ),
    );
  const selected = configuration();
  $('recipe').textContent = [
    `Model view: ${layout.label} (${layout.keys.length} switches)`,
    `Background: ${selected.effect} · speed ${selected.speed}×`,
    `On keypress: ${selected.feedback}`,
    `Anchor keys: ${selected.anchors.join(' ') || '(none)'}`,
    `Orientation keys: ${selected.protectedAnchors.join(' ') || '(none)'}`,
    `Anchor color: ${selected.anchorColor}`,
    `Keypress only: ${selected.minimalist ? 'on' : 'off'}`,
    `Live provider: ${selected.provider}`,
    `Mouse sync: ${selected.mouseSync ? 'requested; provider support required' : 'off'}`,
    'JSON stores the complete setup and customized view.',
    'An executable export reports what the target firmware can actually reproduce.',
    'A browser preview is not physical keyboard validation.',
  ].join('\n');
  $('pause-preview').textContent = previewPaused ? 'Resume preview' : 'Pause preview';
  $('pause-preview').setAttribute('aria-pressed', String(previewPaused));
}
/**
 * THE HUB: call after any state change. Redraws, persists, paints, queues a live write, refreshes export
 * options, and records a debounced activity line. See the data-flow diagram in the file header.
 * @param {boolean} [rebuild=true] true = full renderBoard() (geometry or labels may have changed);
 *   false = cheaper renderSelection() for group/color/effect edits.
 */
function changed(rebuild = true) {
  if (rebuild) renderBoard();
  else renderSelection();
  renderDetails();
  persist();
  paintPreview(performance.now());
  queueLiveUpdate();
  refreshExportCapabilities();
  const setup = configuration();
  recordActivity(
    'setup-changed',
    {
      effect: setup.effect,
      model: setup.keyboardModel,
      provider: setup.provider,
      state: setup.live ? 'live' : 'preview',
    },
    { debounce: true },
  );
}

// =====================================================================================================
// SECTION 9. PREVIEW ANIMATION & KEYBOARD EVENTS
// The preview and the hardware use the same color samples (LightingEffects.sample). Only the keycap
// illustration darkens its fill, so the white key legends stay readable on bright colors.
// =====================================================================================================
/**
 * Recolor every keycap for a moment in time. Drops reaction events older than 2.4 s (the longest reaction).
 * Writes data-rgb (the exact sampled color; the browser test reads it), a darkened fill, a colored border
 * and underglow, and the .pressed class for near-white samples (white reactions).
 * @param {number} time A performance.now() timestamp in ms.
 */
// configuration() rebuilds the whole setup (validation, clones). The preview now paints every display frame,
// so the computed setup is reused for up to PREVIEW_CONFIG_TTL_MS; any explicit repaint (from changed(), a key
// press, a restore...) passes fresh=true. Edits therefore show instantly while idle frames stay cheap.
const PREVIEW_CONFIG_TTL_MS = 250;
let previewConfig = null,
  previewConfigAt = -Infinity;
function paintPreview(time, { fresh = true } = {}) {
  events = events.filter((event) => time - event.at < 2400);
  if (fresh || !previewConfig || time - previewConfigAt > PREVIEW_CONFIG_TTL_MS) {
    previewConfig = configuration();
    previewConfigAt = time;
  }
  const selection = previewConfig;
  for (const [id, key] of keyElements) {
    const group = groupKeys.orientation.has(id)
      ? 'orientation'
      : groupKeys.anchor.has(id)
        ? 'anchor'
        : 'background';
    const color = previewHidden.has(group)
        ? { red: 0, green: 0, blue: 0 }
        : E.sample(selection, id, time, events),
      { red, green, blue } = color;
    const rgbText = `${red},${green},${blue}`;
    // Unchanged key: skip the style writes (most keys are static between Matrix steps).
    if (key.dataset.rgb === rgbText && key.dataset.painted === 'true') continue;
    key.dataset.painted = 'true';
    key.dataset.rgb = rgbText;
    // Fill = 19% of the LED color over the dark keycap base (#13151d). Full-brightness fills would wash out
    // the legends; the true color still shows in the border and the inset "underglow" below.
    key.style.background = `rgb(${Math.round(19 + red * 0.19)},${Math.round(21 + green * 0.19)},${Math.round(29 + blue * 0.19)})`;
    key.style.borderColor = `rgba(${red},${green},${blue},${Math.max(red, green, blue) > 30 ? 0.65 : 0.14})`;
    key.style.boxShadow = `inset 0 -3px 0 rgba(${red},${green},${blue},.65),0 1px 0 #080b10`;
    // Near-white means a white reaction is showing; .pressed gives it a visible "lit" look.
    key.classList.toggle('pressed', red > 220 && green > 220 && blue > 220);
  }
}
/**
 * requestAnimationFrame loop: repaints on EVERY display frame (skipped while the preview is paused).
 * It used to repaint at most every 40 ms, which on a 60 Hz screen meant every third frame (50 ms), so 230 ms
 * Matrix rows showed for 200 or 250 ms alternately - a visible stutter (ISSUES-LOG LL-055). Unchanged keys
 * cost nothing (see paintPreview). Time comes from performance.now(), the same clock key-press events use;
 * the rAF timestamp is the frame START and could put a just-pressed key "in the future" for one frame.
 */
function animatePreview() {
  if (!previewPaused) {
    const now = performance.now();
    paintPreview(now, { fresh: false });
    lastPreviewFrame = now;
  }
  requestAnimationFrame(animatePreview);
}
// Physical keyboard -> preview reactions anywhere on the page.
//  - While the layout guide dialog is open, key presses answer the guide instead.
//  - Typing in form fields, shortcuts with Ctrl/Meta/Alt, and auto-repeat are ignored.
//  - K.eventKey() maps by physical position (event.code), so Num Lock and Shift cannot merge keys.
document.addEventListener('keydown', (event) => {
  if ($('layout-guide').open) {
    const response = LayoutGuide.press(guideState, K.eventKey(event) || '');
    if (response.accepted) {
      event.preventDefault();
      guideState = response.state;
      renderGuide();
    }
    return;
  }
  if (
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) ||
    event.target.isContentEditable ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.repeat
  )
    return;
  const id = K.eventKey(event);
  if (!id) return;
  fireReaction(id);
});
// "Test typing" box: unlike the page-level listener above, typing HERE does fire reactions.
$('test-typing').addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const id = K.eventKey(event);
  if (id) fireReaction(id);
});

// =====================================================================================================
// SECTION 10. LIVE UPDATES (THE COALESCING WRITE QUEUE)
// A single pending slot keeps only the latest complete setup while a provider call is in flight.
// See "LIVE WRITES" in the file header for why this guarantees ordering without a real queue.
// =====================================================================================================
/**
 * Schedule a live (non-forced) write of the current setup, 120 ms from now, replacing any queued one.
 * No-op unless Live changes is on, the server is up, and the provider supports live streaming.
 * @param {boolean} [immediate=false] true = send on the next tick (used after (re)connecting).
 */
function queueLiveUpdate(immediate = false) {
  if (!$('live').checked || !serverAvailable || !liveProviderAvailable) return;
  pendingSelection = { selection: configuration(), force: false };
  clearTimeout(liveUpdateTimer);
  liveUpdateTimer = setTimeout(drainLiveUpdates, immediate ? 0 : 120);
}
/**
 * Send queued setups to POST /api/apply one at a time until the slot is empty.
 * Re-entrancy is prevented by the applying flag; anything queued meanwhile is picked up by the while loop.
 * Each success shows the "Did your physical keyboard change?" prompt (#physical-check) because an SDK
 * acknowledgement is not proof the LEDs changed. Updates #apply-status.
 */
async function drainLiveUpdates() {
  if (applying || !pendingSelection) return;
  applying = true;
  try {
    while (pendingSelection) {
      const current = pendingSelection;
      pendingSelection = null;
      const selection = current.selection,
        force = current.force;
      recordActivity('live-write-started', { effect: selection.effect, provider: selection.provider, force });
      setStatus('apply-status', 'Sending settings to your keyboard…');
      try {
        const response = await fetch('/api/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...selection, force }),
        });
        const body = await response.json();
        if (!response.ok) throw Error(body.error || 'Live lighting failed (' + response.status + ').');
        recordActivity('live-write-completed', { effect: selection.effect, outcome: 'accepted', force });
        lastAttemptProvider = selection.provider;
        physicalConfirmed = false;
        $('physical-check').hidden = false;
        setStatus(
          'apply-status',
          (force ? 'Apply' : 'Live edit') +
            ' acknowledged by ' +
            (body.result?.provider || 'controller') +
            '. Check your physical keyboard below; visible lighting is not yet confirmed.',
          '',
        );
      } catch (error) {
        recordActivity('live-write-completed', { effect: selection.effect, outcome: 'failed', force });
        setStatus('apply-status', 'Preview updated; hardware update failed: ' + error.message, 'problem');
      }
    }
  } finally {
    applying = false;
  }
}
// =====================================================================================================
// SECTION 11. PROVIDER STATUS POLLING
// GET /api/status every 8 s: server reachability, Chroma/Synapse availability, detected keyboards, global
// input state, and the recorded physical check for the selected keyboard + provider.
// =====================================================================================================
/**
 * Poll the server and update connection-related UI: #selected-device options, #device-scope, #global-input,
 * the auto-detected #keyboard-model (only while the user has not picked one), #device-status,
 * #connection-label / #connection-dot in the header, #layout-prompt, and #hardware-guidance.
 * When live control becomes available for the first time, immediately sends the current setup.
 * On failure everything falls back to "Preview only" with instructions to start the server.
 */
async function refreshProviderStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw Error(`Status request failed (${response.status}).`);
    const data = await response.json(),
      wasLiveAvailable = liveProviderAvailable;
    providerStatus = data;
    serverAvailable = true;
    deviceStatus = data.device || deviceStatus;
    const picker = $('selected-device'),
      previousDevice = picker.value,
      devices = deviceStatus.devices || [deviceStatus];
    picker.replaceChildren();
    for (const item of devices) {
      const option = new Option(item.model || item.name || 'Keyboard', item.id || item.deviceId || '');
      picker.append(option);
    }
    picker.value = deviceStatus.selectedDeviceId || previousDevice || picker.options[0]?.value || '';
    // The server sends controlScope.reason; reading `.detail` meant this note never appeared (LL-028).
    $('device-scope').textContent =
      deviceStatus.controlScope?.reason || deviceStatus.controlScope?.detail || '';
    const selectedProvider = $('provider').value,
      // Chroma: the SDK REST service answered. Synapse: the app or one of its profile paths is present.
      transportAvailable =
        selectedProvider === 'chroma-sdk'
          ? Boolean(data.sdk?.available)
          : Boolean(
              data.synapse?.available ||
                data.synapse?.uiOpen ||
                Object.values(data.synapse?.installed || {}).some(Boolean),
            );
    const verification = data.controlVerification?.providers?.[selectedProvider],
      rejected = verification?.status === 'rejected';
    controlRejected = rejected;
    physicalConfirmed = verification?.status === 'confirmed';
    // A prior unchanged observation is evidence to revisit, not proof that a reachable controller must stay disabled.
    providerAvailable = transportAvailable;
    liveProviderAvailable = selectedProvider === 'chroma-sdk' && transportAvailable;
    $('global-input').checked = Boolean(data.input?.enabled);
    // Auto-pick the preview model from the detected keyboard (by id, or by a normalized label match).
    if (!manualModel) {
      const normalized = String(deviceStatus.model || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      const detected = K.modelCatalog.find(
        (model) =>
          model.id === deviceStatus.modelId ||
          model.id === deviceStatus.keyboardModel ||
          model.label.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized,
      );
      const next = detected?.id || 'standard-full-size';
      if ($('keyboard-model').value !== next) {
        $('keyboard-model').value = next;
        renderBoard();
        renderDetails();
      }
    }
    const model = `${deviceStatus.model || 'Unknown keyboard'} · ${deviceStatus.source || 'reported by provider'}`;
    const capability = deviceStatus.guidance || deviceStatus.capability?.reason || '';
    const providerError =
      selectedProvider === 'chroma-sdk'
        ? data.sdk?.lastError?.message || data.sdk?.error || data.sdk?.active?.mouseSyncError
        : data.synapse?.error;
    const providerSummary = rejected
      ? 'A previous physical check said unchanged. The controller is still reachable: live edits stay available, but Apply and record a fresh physical result.'
      : selectedProvider === 'synapse-native' && physicalConfirmed
        ? 'Synapse Studio profile control is physically confirmed. Save or load a named profile to change the keyboard.'
        : providerAvailable
          ? 'The controller is reachable; physical lighting still needs confirmation.'
          : 'Provider unavailable; preview and file saves still work.';
    setStatus(
      'device-status',
      `${model}. ${providerError ? `Provider reports: ${providerError}.` : providerSummary} ${capability}`.trim(),
      providerAvailable && !providerError ? 'ready' : 'problem',
    );
    $('connection-label').textContent = providerError
      ? 'Lighting needs attention'
      : rejected
        ? 'Controller reachable · recheck lights'
        : physicalConfirmed
          ? 'Lighting confirmed'
          : providerAvailable
            ? 'Controller reachable · lights unconfirmed'
            : 'Preview · provider unavailable';
    $('connection-dot').dataset.state = providerError ? 'problem' : physicalConfirmed ? 'ready' : '';
    $('layout-prompt').textContent = deviceStatus.recognized
      ? 'Identify My Layout is available if this illustration needs correction.'
      : 'Keyboard model detection is unavailable. Choose Identify My Layout for a guided physical-layout check; broken keys can be skipped without treating them as missing.';
    if (deviceStatus.numpadDecimal) {
      const info = deviceStatus.numpadDecimal;
      $('hardware-guidance').textContent =
        `${info.key}: ${info.state}. ${(info.checks || []).join('; ')}. Workaround: ${info.workaround || 'test another numpad key remapping.'}`;
    }
    // Transition from "not live" to "live" (server started, SDK came up): push the current setup right away.
    if (liveProviderAvailable && !wasLiveAvailable) queueLiveUpdate(true);
  } catch (error) {
    serverAvailable = false;
    providerAvailable = false;
    physicalConfirmed = false;
    $('connection-label').textContent = 'Preview only';
    $('connection-dot').dataset.state = 'problem';
    setStatus(
      'device-status',
      `Preview only: the Lighting Lab server is not running. Double-click "Start Lighting Lab.cmd" (or run npm start) and keep its window open. (${error.message})`,
      'problem',
    );
    renderReadiness();
  }
  refreshExportCapabilities();
}

// =====================================================================================================
// SECTION 12. EXPORT & DOWNLOADS
// "Download .exe" builds a portable preset player on the server (export.cjs). What it can reproduce depends
// on the target (Auto/Razer vs YUNZII AL65 firmware) and the effect, so the button is gated by a capability
// answer from GET /api/export/capabilities.
// =====================================================================================================
/**
 * Fetch export capabilities for the current target (#export-target) and background effect, then render them.
 * Cached per "model:effect". Each request takes a new revision number; if a newer request started while
 * this one was in flight, the late answer is dropped, so a slow response for a previous model can never
 * enable the wrong export. Offline: the button is disabled with a JSON-export hint.
 */
async function refreshExportCapabilities() {
  const model = $('export-target').value,
    effect = $('background').value,
    key = `${model}:${effect}`;
  if (exportCapabilities && key === lastCapabilityKey) {
    renderExportCapability();
    return;
  }
  const revision = ++capabilityRevision;
  try {
    const response = await fetch(
      `/api/export/capabilities?model=${encodeURIComponent(model)}&effect=${encodeURIComponent(effect)}`,
    );
    if (!response.ok) throw Error('Export capability check unavailable.');
    const data = await response.json();
    if (revision !== capabilityRevision) return;
    exportCapabilities = data;
    lastCapabilityKey = key;
    renderExportCapability();
  } catch {
    if (revision !== capabilityRevision) return;
    exportCapabilities = null;
    $('export-executable').disabled = true;
    $('approximation-option').hidden = true;
    $('executable-status').textContent =
      'Executable export needs the local server. You can always save the complete setup JSON.';
  }
}
/**
 * Apply the cached capability to the UI: show the AL65 approximation checkbox when needed, enable or
 * disable #export-executable, and explain why in #executable-status (reason, limitations, missing consent).
 */
function renderExportCapability() {
  const capability = exportCapabilities || {},
    allowed = Boolean(capability.executable ?? capability.supported);
  const needsApproximation = capability.needsApproximationAcknowledgement === true;
  $('approximation-option').hidden = !needsApproximation;
  const effectAllowed =
    !Array.isArray(capability.supportedEffects) ||
    capability.supportedEffects.includes($('background').value);
  $('export-executable').disabled =
    !allowed || !effectAllowed || (needsApproximation && !$('accept-approximation').checked);
  $('executable-status').textContent = [
    capability.reason,
    ...(capability.limitations || []),
    !effectAllowed
      ? // Name the options from the capability itself so this hint can never drift from what export supports.
        `This effect has no supported executable equivalent. Choose ${capability.supportedEffects
          .map((id) => [...$('background').options].find((option) => option.value === id)?.textContent || id)
          .join(', ')}.`
      : '',
    needsApproximation && !$('accept-approximation').checked
      ? 'Choose the built-in lighting option above to enable this export.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}
/**
 * Save a Blob as a file via a temporary <a download> link; the object URL is revoked a second later.
 * @param {Blob} blob
 * @param {string} name Suggested file name.
 */
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/**
 * Save any value as pretty-printed JSON.
 * @param {*} data
 * @param {string} name File name, e.g. 'lighting-lab-setup.json'.
 */
function downloadJSON(data, name) {
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name);
}
/** "Export Setup JSON": download configuration(). This does not apply lighting or create a profile. */
function saveSetup() {
  downloadJSON(configuration(), 'lighting-lab-setup.json');
  setStatus(
    'profile-status',
    'Exported a JSON recipe. This does not apply lighting or import a vendor profile.',
  );
}
/**
 * Download a server response as a file (POST with a JSON body, or GET when body is null). The file name
 * comes from Content-Disposition when present.
 * @param {string} path      API route, e.g. '/api/export/executable'.
 * @param {object|null} body JSON body, or null for GET.
 * @param {string} fallback  File name if the server does not suggest one.
 * @throws With the server's error message on a non-2xx response.
 */
async function downloadAPI(path, body, fallback) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(error.error || `Download failed (${response.status}).`);
  }
  const filename =
    response.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1] || fallback;
  downloadBlob(await response.blob(), filename);
}

// =====================================================================================================
// SECTION 13. GEOMETRY EDITOR
// "Customize keyboard view" edits only the illustration (label, x, y, width, height in key units). Physical
// lighting IDs and Chroma coordinates never change, so editing a view cannot shift which LED lights up.
// Its buttons are wired in SECTION 15.
// =====================================================================================================
/**
 * Load the selected switch (#geometry-key) into the geometry fields (#geometry-label/x/y/w/h) and outline
 * it in the preview (.geometry-selected) while "Click a key to edit its geometry" is checked.
 */
function readGeometryFields() {
  const selected = layout?.keys.find((key) => key.id === $('geometry-key').value);
  if (!selected) return;
  $('geometry-label').value = selected.label;
  for (const field of ['x', 'y', 'w', 'h']) $(`geometry-${field}`).value = selected[field];
  for (const [id, key] of keyElements)
    key.classList.toggle('geometry-selected', $('edit-geometry').checked && id === selected.id);
}
/**
 * "Update switch": copy the current layout, apply the edited fields to one key, re-validate the whole view
 * through core.js, then switch the model picker to 'custom'. Errors show in #geometry-status.
 */
function applyGeometry() {
  try {
    const id = $('geometry-key').value,
      keys = structuredClone(layout.keys),
      key = keys.find((item) => item.id === id);
    key.label = $('geometry-label').value.trim() || key.id;
    for (const field of ['x', 'y', 'w', 'h']) key[field] = Number($(`geometry-${field}`).value);
    const validated = K.layoutForModel('custom', keys);
    if ($('keyboard-model').value !== 'custom') customBaseModel = $('keyboard-model').value;
    customLayout = validated.keys;
    manualModel = true;
    $('keyboard-model').value = 'custom';
    changed();
    setStatus('geometry-status', 'Custom view updated. Physical lighting identities are unchanged.', 'ready');
  } catch (error) {
    setStatus('geometry-status', error.message, 'problem');
  }
}

// =====================================================================================================
// SECTION 14. PAGE BOOTSTRAP: POPULATE PICKERS, RESTORE A SHARED OR SAVED SETUP
// Runs once at load, in this order: fill the model picker and preset gallery, wire the onboarding buttons,
// fill the word-set picker, then restore state. Precedence: share link > saved setup > legacy effect key.
// =====================================================================================================
// Keyboard view picker: every catalog model (the catalog already contains 'custom').
for (const model of K.modelCatalog) {
  const option = document.createElement('option');
  option.value = model.id;
  option.textContent = model.label;
  $('keyboard-model').append(option);
}
// Defensive: guarantee a 'custom' option even if a future catalog drops it.
if (!K.modelCatalog.some((model) => model.id === 'custom')) {
  const option = document.createElement('option');
  option.value = 'custom';
  option.textContent = 'Custom keyboard view';
  $('keyboard-model').append(option);
}
$('keyboard-model').value = 'standard-full-size';
// Build the twelve gallery tiles (button > swatch + name + one-line detail).
presets.forEach((preset) => {
  const button = document.createElement('button');
  button.className = 'preset-card';
  button.setAttribute('aria-pressed', 'false');
  const swatch = document.createElement('span');
  swatch.className = `preset-swatch swatch-${preset.swatch}`;
  swatch.setAttribute('aria-hidden', 'true');
  const title = document.createElement('b');
  title.textContent = preset.name;
  const detail = document.createElement('small');
  detail.textContent = preset.detail;
  button.append(swatch, title, detail);
  button.onclick = () => choosePreset(preset);
  $('preset-gallery').append(button);
});
// Guide step 1 "Try Rainbow Ripple": apply that preset.
$('onboarding-starter').onclick = () =>
  choosePreset(presets.find((preset) => preset.name === 'Rainbow Ripple'));
// Guide step 2 "Test in preview": switch to Test reactions mode and focus the test box.
$('onboarding-test').onclick = () => {
  $('selection-mode').value = 'test';
  paintMode = 'test';
  renderSelection();
  markOnboarding('test');
  $('test-typing').focus();
};
// Guide step 3 "Go to Apply": scroll to the editor and focus Apply (no hardware write by itself).
$('onboarding-apply').onclick = () => {
  markOnboarding('apply');
  $('workspace').scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
  $('apply').focus();
};
// "Hide guide": remember dismissal in localStorage and hide the panel.
$('onboarding-dismiss').onclick = () => {
  try {
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ ...onboardingState(), dismissed: true }));
  } catch {
    /* Dismissing is optional convenience only. */
  }
  $('quickstart').hidden = true;
};
// Word planner presets ("Noob Deterrent" and alternates) in #candidate; the first set fills #words.
K.alternatives.forEach((candidate, index) => {
  const option = document.createElement('option');
  option.value = index;
  option.textContent = `${index === 0 ? 'Noob Deterrent' : `Option ${index}`} · ${candidate.join(' / ')}`;
  $('candidate').append(option);
});
$('words').value = K.alternatives[0].join(', ');
// Default look before any restore: Rainbow Road.
$('background').value = 'rainbow-road';
try {
  // 1) A share link wins and is loaded into the PREVIEW only. 2) Otherwise the last session from
  // localStorage. 3) Otherwise migrate the LEGACY v1 key, which stored just an effect name.
  const shared = readShareLink();
  if (shared) {
    restoreSetup(shared);
    setStatus(
      'apply-status',
      'Shared setup loaded into the preview. Review it, then choose Apply yourself if you want hardware changes.',
      'ready',
    );
  } else {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) restoreSetup(JSON.parse(saved));
    else {
      const legacyEffect = localStorage.getItem('lighting-lab-effect');
      if ([...$('background').options].some((option) => option.value === legacyEffect)) {
        $('background').value = legacyEffect;
        groupSettings.background.dynamic =
          legacyEffect === 'ghost' || legacyEffect === 'solid' || legacyEffect === 'subtle-keywords'
            ? 'none'
            : legacyEffect;
        groupSettings.background.base = legacyEffect === 'solid' ? 'static' : 'off';
      }
    }
  }
} catch (error) {
  setStatus('apply-status', `Saved setup could not be restored: ${error.message}`, 'problem');
}

// =====================================================================================================
// SECTION 15. CONTROL WIRING: EDITOR, APPLY, SHARE, EXPORT, INPUT, RELEASE, GEOMETRY BUTTONS
// Event handlers for the main editor. Each handler mutates state and then calls changed(), or talks to the
// server and reports the outcome in a status line.
// =====================================================================================================
// Word set picker: load that set's words and rebuild the anchor islands.
$('candidate').onchange = () => {
  $('words').value = K.alternatives[Number($('candidate').value)].join(', ');
  arrange();
};
// Typing words only re-validates the cap inventory; islands rebuild on demand.
$('words').oninput = () => {
  renderDetails();
  persist();
};
// "Rebuild word islands".
$('reset').onclick = arrange;
// Classic effect controls and checkboxes. The legacy selects (#background, #feedback, #keyword-feedback)
// write through to the matching group settings so both UIs stay in sync. Changing the legend mode needs a
// full board rebuild; changing the provider also re-polls status.
for (const id of [
  'background',
  'feedback',
  'keyword-feedback',
  'protect',
  'numpad',
  'provider',
  'minimalist',
  'sync-mouse',
  'mode',
])
  $(id).onchange = () => {
    if (id === 'background') {
      const effect = $('background').value;
      groupSettings.background.dynamic =
        effect === 'ghost' || effect === 'solid' || effect === 'subtle-keywords' ? 'none' : effect;
      groupSettings.background.base = effect === 'solid' ? 'static' : 'off';
    }
    if (id === 'feedback') groupSettings.background.reaction = $('feedback').value;
    if (id === 'keyword-feedback') groupSettings.anchor.reaction = $('keyword-feedback').value;
    if (id === 'protect') groupSettings.anchor.protect = $('protect').checked;
    changed(id === 'mode');
    if (id === 'provider') refreshProviderStatus();
  };
// "Click keys to select" picker: switch paint mode (anchor/background/orientation/test).
$('selection-mode').onchange = () => {
  paintMode = $('selection-mode').value;
  renderSelection();
};
// Speed slider and anchor/solid color picker update continuously while dragging.
for (const id of ['speed', 'color']) $(id).oninput = () => changed(false);
// Keyboard view picker: the choice is now manual (polling will not override it), AL65 consent resets, and
// picking "custom" for the first time starts from the current layout.
$('keyboard-model').onchange = () => {
  manualModel = true;
  $('accept-approximation').checked = false;
  if ($('keyboard-model').value === 'custom' && !customLayout) {
    customLayout = structuredClone(layout.keys);
    customBaseModel = layout.id;
  }
  changed();
};
// Connected keyboard picker: tell the server which present keyboard is "the one" (model, preview, checks).
$('selected-device').onchange = async () => {
  try {
    const response = await fetch('/api/device', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: $('selected-device').value }),
      }),
      body = await response.json();
    if (!response.ok) throw Error(body.error);
    deviceStatus = body.device || deviceStatus;
    setStatus(
      'apply-status',
      'Selected keyboard updated. Apply sends the current setup to the shared Chroma canvas.',
      'ready',
    );
    refreshProviderStatus();
  } catch (error) {
    setStatus('apply-status', `Could not select keyboard: ${error.message}`, 'problem');
  }
};
// "Select all": move every visible key into the current paint group.
$('select-all').onclick = () => {
  if (paintMode === 'test') return;
  for (const key of layout.keys) {
    for (const name of E.GROUP_NAMES) groupKeys[name].delete(key.id);
    groupKeys[paintMode].add(key.id);
  }
  normalizeGroups();
  changed(false);
};
// "Clear all": empty the current paint group (its keys return to background).
$('clear-all').onclick = () => {
  if (paintMode === 'test') return;
  groupKeys[paintMode].clear();
  normalizeGroups();
  changed(false);
};
// "Pause preview"/"Resume preview": stops only the on-screen animation.
$('pause-preview').onclick = () => {
  previewPaused = !previewPaused;
  renderDetails();
  persist();
};
// "Live changes" switch: on = send the current setup now and stream later edits; off = drop any queued write.
$('live').onchange = () => {
  persist();
  if ($('live').checked) queueLiveUpdate(true);
  else {
    clearTimeout(liveUpdateTimer);
    pendingSelection = null;
    setStatus(
      'apply-status',
      'Live changes paused. Current hardware lighting continues; edits affect the preview.',
    );
  }
};
// "Reconnect": re-poll status and, if live control is available, turn Live changes on and send now.
$('connect').onclick = async () => {
  await refreshProviderStatus();
  if (liveProviderAvailable) {
    $('live').checked = true;
    persist();
    queueLiveUpdate(true);
  } else
    setStatus(
      'apply-status',
      'Live control is not physically available through the selected provider. Apply can retest Chroma; Synapse uses Save as Profile and Load Profile.',
      'problem',
    );
};
// "Apply": force-send the exact preview (fresh Chroma session) even with Live changes off.
// Synapse is profile-based, so Apply explains that path instead of switching providers silently.
$('apply').onclick = () => {
  markOnboarding('apply');
  if ($('provider').value !== 'chroma-sdk') {
    setStatus(
      'apply-status',
      'Synapse Studio applies saved profiles. Use Save as Profile, then Load Profile, for this provider.',
      'problem',
    );
    return;
  }
  pendingSelection = { selection: configuration(), force: true };
  clearTimeout(liveUpdateTimer);
  drainLiveUpdates();
};
// "Apply to keyboard" in the Layered lighting panel is the same action as Apply.
$('preview-apply').onclick = () => $('apply').click();
// "Blue flame anchor keys" quick action.
$('anchor-blue-flame').onclick = enableBlueAnchorFlame;
// "Export Setup JSON".
$('save-json').onclick = saveSetup;
// "Copy Share Link": copy a preview-only recipe URL to the clipboard.
$('share-link').onclick = async () => {
  try {
    const link = createShareLink(configuration());
    const copied = await copyText(link);
    setStatus(
      'profile-status',
      copied
        ? 'Share link copied. Opening it restores this preview only; the recipient chooses whether to Apply.'
        : 'Could not copy this link. Export Setup JSON instead.',
      copied ? 'ready' : 'problem',
    );
  } catch (error) {
    setStatus('profile-status', error.message, 'problem');
  }
};
// Ready check button: jump to Apply, or to saved profiles once the lights are confirmed.
$('readiness-action').onclick = () => {
  if (physicalConfirmed) {
    $('saved-profiles').focus();
    return;
  }
  $('apply').scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'center',
  });
  $('apply').focus();
};
// Executable target picker: consent is per target, so reset it, then re-check capabilities.
$('export-target').onchange = () => {
  $('accept-approximation').checked = false;
  refreshExportCapabilities();
};
// "Import Setup JSON" file picker: restore the file, redraw, and clear the input so the same file can be
// chosen again.
$('import-setup').onchange = async (event) => {
  try {
    restoreSetup(JSON.parse(await event.target.files[0].text()));
    changed();
    setStatus('apply-status', 'Setup loaded. All settings and key selections restored.', 'ready');
  } catch (error) {
    setStatus('apply-status', error.message, 'problem');
  } finally {
    event.target.value = '';
  }
};
// AL65 "use built-in lighting" consent checkbox re-evaluates whether export is allowed.
$('accept-approximation').onchange = renderExportCapability;
// "Download .exe": the server compiles a portable preset player; the button is disabled while it builds.
$('export-executable').onclick = async () => {
  const button = $('export-executable');
  button.disabled = true;
  try {
    await downloadAPI(
      '/api/export/executable',
      {
        ...configuration(),
        exportModel: $('export-target').value,
        acceptApproximation: $('accept-approximation').checked,
      },
      'lighting-lab-preset.exe',
    );
    setStatus(
      'apply-status',
      'Preset executable downloaded. Open it on the target Windows PC; it detects a supported keyboard and explains any missing controller.',
      'ready',
    );
  } catch (error) {
    setStatus('apply-status', error.message, 'problem');
  } finally {
    renderExportCapability();
  }
};
// "Download diagnostics": device/provider status plus recent local audit records (no typed text).
$('diagnostics').onclick = async () => {
  try {
    await downloadAPI('/api/diagnostics', null, 'lighting-lab-diagnostics.json');
    setStatus('apply-status', 'Downloaded device, provider, input, and audit diagnostics.', 'ready');
  } catch (error) {
    setStatus('apply-status', error.message, 'problem');
  }
};
// "Global key feedback": ask the server to start/stop its Windows key listener so typing in ANY app
// triggers reactions. The checkbox reflects what the server actually did.
$('global-input').onchange = async () => {
  try {
    const response = await fetch('/api/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: $('global-input').checked }),
      }),
      data = await response.json();
    if (!response.ok) throw Error(data.error || 'Global input unavailable.');
    $('global-input').checked = Boolean(data.enabled);
    setStatus(
      'apply-status',
      data.enabled ? 'Global key feedback is on.' : 'Global key feedback is off.',
      'ready',
    );
  } catch (error) {
    $('global-input').checked = false;
    setStatus('apply-status', error.message, 'problem');
  }
};
// "Return to Synapse": stop live writes, wait for any in-flight write, then release the Chroma session so
// Synapse's own saved effect comes back.
$('release').onclick = async () => {
  $('live').checked = false;
  pendingSelection = null;
  clearTimeout(liveUpdateTimer);
  persist();
  try {
    while (applying) await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await fetch('/api/release', { method: 'POST' });
    if (!response.ok) throw Error('Could not release direct control.');
    setStatus('apply-status', 'Direct lighting released. Synapse can resume its saved effect.', 'ready');
  } catch (error) {
    setStatus('apply-status', error.message, 'problem');
  }
};
// Geometry editor controls (functions in SECTION 13): edit-mode toggle and switch picker reload the fields.
$('edit-geometry').onchange = readGeometryFields;
$('geometry-key').onchange = readGeometryFields;
// "Update switch".
$('geometry-apply').onclick = applyGeometry;
// "Reset to model": drop the custom view and return to the model it started from.
$('geometry-reset').onclick = () => {
  $('keyboard-model').value = customBaseModel === 'custom' ? 'standard-full-size' : customBaseModel;
  customLayout = null;
  manualModel = true;
  changed();
  setStatus('geometry-status', 'Restored the model view.', 'ready');
};
// "Save view JSON": download just the view geometry ('lighting-lab-view-v1').
$('geometry-export').onclick = () =>
  downloadJSON(
    {
      format: 'lighting-lab-view-v1',
      baseModel: $('keyboard-model').value === 'custom' ? customBaseModel : $('keyboard-model').value,
      keys: layout.keys,
    },
    'lighting-lab-view.json',
  );
// "Load view JSON": accepts a saved view file (or a bare key array), re-validated by core.js.
$('geometry-import').onchange = async (event) => {
  try {
    const data = JSON.parse(await event.target.files[0].text()),
      validated = K.layoutForModel('custom', data.keys || data);
    customLayout = validated.keys;
    customBaseModel = data.baseModel || 'standard-full-size';
    manualModel = true;
    $('keyboard-model').value = 'custom';
    changed();
    setStatus('geometry-status', 'Custom view loaded.', 'ready');
  } catch (error) {
    setStatus('geometry-status', error.message, 'problem');
  } finally {
    event.target.value = '';
  }
};
// =====================================================================================================
// SECTION 16. FEEDBACK PANEL
// Feedback stays local until a tester explicitly downloads it or opens a GitHub issue draft.
// =====================================================================================================
/**
 * Build one feedback record from the panel (#feedback-category/-rating/-note) plus context: device,
 * provider, effect, and the full configuration so a report can be reproduced.
 * @returns {object}
 */
function feedbackRecord() {
  return {
    category: $('feedback-category').value,
    rating: Number($('feedback-rating').value),
    note: $('feedback-note').value,
    createdAt: new Date().toISOString(),
    device: deviceStatus.model,
    provider: $('provider').value,
    effect: configuration().effect,
    configuration: configuration(),
  };
}
/**
 * Read feedback saved in this browser ('lighting-lab-feedback-v1').
 * @returns {object[]} [] when missing, corrupt, or storage is unavailable.
 */
function storedFeedback() {
  try {
    const value = JSON.parse(localStorage.getItem('lighting-lab-feedback-v1') || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
/**
 * Build a prefilled "new issue" URL on the public GitHub repo. Only a short summary goes into the URL; the
 * full configuration is NOT included (URLs have length limits, and the user reviews the draft first).
 * @param {object} record From feedbackRecord().
 * @returns {string}
 */
function feedbackIssueUrl(record) {
  const title = `Lighting Lab feedback: ${record.category}`;
  const body = [
    `Rating: ${record.rating}/5`,
    `Category: ${record.category}`,
    `Device: ${record.device}`,
    `Provider: ${record.provider}`,
    `Effect: ${record.effect}`,
    '',
    'What happened:',
    record.note || '(no note supplied)',
    '',
    `Created locally: ${record.createdAt}`,
  ].join('\n');
  return `https://github.com/jameseby21/Lighting-Lab/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
// "Save locally": append the record to this browser's feedback list and close the panel.
$('feedback-submit').onclick = () => {
  try {
    const existing = storedFeedback();
    existing.push(feedbackRecord());
    localStorage.setItem('lighting-lab-feedback-v1', JSON.stringify(existing));
    $('feedback-development').hidden = true;
    setStatus(
      'apply-status',
      'Feedback saved only in this browser. Download it or open a GitHub draft when you want to share it.',
      'ready',
    );
  } catch (error) {
    setStatus('apply-status', `Could not save feedback: ${error.message}`, 'problem');
  }
};
// "Download feedback": all locally saved records as JSON.
$('feedback-export').onclick = () => downloadJSON(storedFeedback(), 'lighting-lab-feedback.json');
// "Open GitHub draft": open the prefilled issue in a new tab (nothing is posted until the user submits it).
$('feedback-github').onclick = () =>
  window.open(feedbackIssueUrl(feedbackRecord()), '_blank', 'noopener,noreferrer');
// "Later": close the panel.
$('feedback-dismiss').onclick = () => ($('feedback-development').hidden = true);
/**
 * Open the feedback panel (#feedback-development) with a preselected category and focus it.
 * @param {string} [category]
 */
function openFeedback(category = 'Visual quality') {
  $('feedback-category').value = category;
  $('feedback-development').hidden = false;
  $('feedback-category').focus();
}
// Footer "Leave feedback".
$('feedback-open').onclick = () => openFeedback();
// "That effect landed" strip: "Save this setup" jumps to the profile name field.
$('success-save').onclick = () => {
  $('success-next').hidden = true;
  $('profile-name').focus();
  $('profile-name').scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'center',
  });
};
// "Give feedback" from the success strip.
$('success-feedback').onclick = () => {
  $('success-next').hidden = true;
  openFeedback('Visual quality');
};
// "Not now" hides the success strip.
$('success-dismiss').onclick = () => {
  $('success-next').hidden = true;
};
// File-picker labels retain a compact appearance without excluding keyboard users.
document.querySelectorAll('label.button[for]').forEach((label) => {
  label.tabIndex = 0;
  label.setAttribute('role', 'button');
  label.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      $(label.htmlFor).click();
    }
  };
});
// Rebuild the board when the width changes by more than 30 px (the --unit size can change at breakpoints).
// Small changes (mobile URL bar showing/hiding) are ignored to avoid needless rebuilds.
let lastWindowWidth = innerWidth;
addEventListener('resize', () => {
  if (Math.abs(lastWindowWidth - innerWidth) > 30) {
    lastWindowWidth = innerWidth;
    renderBoard();
  }
});

// =====================================================================================================
// SECTION 17. LAYOUT GUIDE ("IDENTIFY MY LAYOUT")
// A short, user-started, untimed interview (logic in layout-guide.js) that picks a reference layout. A key
// that does not respond can be recorded as broken without concluding that the key does not exist.
// =====================================================================================================
/**
 * Render the current guide step into the dialog (#guide-progress/-title/-instruction/-choices and the
 * Yes/No/Skip/Broken buttons). When the interview is finished, apply the result: set the model, record
 * broken keys, redraw, and show a review message.
 */
function renderGuide() {
  if (guideState.finished) {
    const result = LayoutGuide.result(guideState);
    $('keyboard-model').value = result.model;
    manualModel = true;
    for (const id of result.brokenKeys) brokenKeys.add(id);
    changed();
    $('guide-title').textContent = 'Review Your Layout';
    $('guide-progress').textContent = 'Layout guide complete';
    $('guide-instruction').textContent =
      `Showing ${K.modelCatalog.find((m) => m.id === result.model).label}. ${result.note}`;
    $('guide-choices').replaceChildren();
    for (const id of ['guide-yes', 'guide-no', 'guide-unknown', 'guide-broken']) $(id).hidden = true;
    return;
  }
  const step = LayoutGuide.step(guideState);
  $('guide-progress').textContent = `Step ${guideState.index + 1} of ${LayoutGuide.steps.length}`;
  $('guide-title').textContent = step.title;
  $('guide-instruction').textContent = step.instruction;
  $('guide-note').textContent =
    'No timeout. Skip an unavailable test, or confirm the physical feature by sight.';
  $('guide-choices').replaceChildren();
  for (const [value, label] of step.choices || []) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = () => {
      guideState = LayoutGuide.answer(guideState, value);
      renderGuide();
    };
    $('guide-choices').append(button);
  }
  $('guide-yes').hidden = $('guide-no').hidden = $('guide-broken').hidden = Boolean(step.choices);
  $('guide-unknown').hidden = false;
  $('guide-yes').textContent = step.yes || 'Yes';
  $('guide-no').textContent = step.no || 'No';
}
// "Identify My Layout": start a fresh interview in the modal dialog.
$('identify-layout').onclick = () => {
  guideState = LayoutGuide.begin();
  renderGuide();
  $('layout-guide').showModal();
};
// Guide buttons: Close, Yes, No, Not Sure / Skip.
$('guide-close').onclick = () => $('layout-guide').close();
$('guide-yes').onclick = () => {
  guideState = LayoutGuide.answer(guideState, true);
  renderGuide();
};
$('guide-no').onclick = () => {
  guideState = LayoutGuide.answer(guideState, false);
  renderGuide();
};
$('guide-unknown').onclick = () => {
  guideState = LayoutGuide.answer(guideState, 'unknown');
  renderGuide();
};
// "This Key Doesn't Work": record the step's example key as broken and stay on the step, so the user can
// try an alternate key or answer by sight.
$('guide-broken').onclick = () => {
  const id = LayoutGuide.step(guideState).example;
  guideState = LayoutGuide.broken(guideState, id);
  brokenKeys.add(id);
  persist();
  $('guide-note').textContent =
    `Recorded ${id} as unresponsive. Try an alternate key from the instructions, choose the visible feature, or skip. The layout has not been shrunk.`;
};
// =====================================================================================================
// SECTION 18. KEY ISSUES & LIGHTING SUBSTITUTES
// These only change LIGHTING behavior. They never remap typing in Windows or repair a switch.
// =====================================================================================================
// "This Key Does Not Register": add the chosen key to brokenKeys.
$('mark-broken').onclick = () => {
  brokenKeys.add($('issue-key').value);
  changed(false);
};
// "Mark Working": remove it again.
$('clear-broken').onclick = () => {
  brokenKeys.delete($('issue-key').value);
  changed(false);
};
// "Set Lighting Substitute": pressing the chosen working key will fire the broken key's reaction.
// Choosing "No substitution" removes every substitute that pointed at the broken key.
$('issue-use').onclick = () => {
  const target = $('issue-key').value,
    source = $('issue-alternate').value;
  if (source) inputAliases[source] = target;
  else
    for (const key of Object.keys(inputAliases)) if (inputAliases[key] === target) delete inputAliases[key];
  changed(false);
};
// =====================================================================================================
// SECTION 19. PHYSICAL VERIFICATION & REPAIR
// Only a person can say whether the LEDs changed; an SDK "OK" is not proof. The answer is stored on the
// server per keyboard model + provider and shapes the status UI on later visits.
// =====================================================================================================
/**
 * Record the user's answer about the physical keyboard (POST /api/control-verification) for the provider
 * the last write went to.
 * @param {boolean} visible true for "Yes, I see it", false for "No, unchanged".
 * @returns {Promise<object>} The stored observation.
 */
async function recordControlObservation(visible) {
  const response = await fetch('/api/control-verification', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: lastAttemptProvider, visible }),
    }),
    body = await response.json();
  if (!response.ok) throw Error(body.error || 'Physical result could not be recorded.');
  return body.result;
}
// "Yes, I see it": store the confirmation and offer the save/feedback next-steps strip.
$('confirm-visible').onclick = async () => {
  try {
    await recordControlObservation(true);
    physicalConfirmed = true;
    $('physical-check').hidden = true;
    $('success-next').hidden = false;
    setStatus('apply-status', 'Physical lighting change confirmed for this keyboard and provider.', 'ready');
    await refreshProviderStatus();
  } catch (error) {
    setStatus('apply-status', error.message, 'problem');
  }
};
// "No, unchanged": store the rejection and turn Live changes off for now; Reconnect/Apply can retry.
$('confirm-unchanged').onclick = async () => {
  try {
    await recordControlObservation(false);
    physicalConfirmed = false;
    $('success-next').hidden = true;
    $('live').checked = false;
    pendingSelection = null;
    clearTimeout(liveUpdateTimer);
    persist();
    $('physical-check').hidden = true;
    setStatus(
      'apply-status',
      'Recorded: the controller acknowledged the request, but the physical lights did not change. Live changes is now off; check Chroma Apps in Synapse, then use Retry Chroma Connection or Apply to test again.',
      'problem',
    );
    await refreshProviderStatus();
  } catch (error) {
    setStatus('apply-status', error.message, 'problem');
  }
};
// "Retry Chroma Connection": the server re-applies with a fresh session and opens Synapse's Connect panel
// to read back whether Chroma Apps and this app are enabled. The result is reported, never assumed.
$('repair-connection').onclick = async () => {
  try {
    setStatus('apply-status', 'Opening Synapse and restarting this lighting session…');
    const response = await fetch('/api/repair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(configuration()),
      }),
      body = await response.json();
    if (!response.ok) throw Error(body.error);
    physicalConfirmed = false;
    setStatus('apply-status', body.detail, 'problem');
  } catch (error) {
    setStatus('apply-status', `Repair did not establish physical control: ${error.message}`, 'problem');
  }
};
// =====================================================================================================
// SECTION 20. SAVED PROFILES
// Named profiles live on the server (.artifacts/lighting-lab/profiles/*.json), not in the browser, so App
// Profiles can switch to them. "Save in" picks the controller: Lighting Lab (full setup) or Synapse Studio
// (a native archive; only simple static/reactive setups are representable).
// =====================================================================================================
// People see controller names, never internal IDs such as "lighting-lab" or "synapse-native".
const SOFTWARE_LABELS = { 'lighting-lab': 'Lighting Lab', 'synapse-native': 'Synapse Studio' };
/**
 * Display text for a saved profile, e.g. "Code Focus — Lighting Lab".
 * @param {{name:string, software:string}} profile
 * @returns {string}
 */
function profileLabel(profile) {
  return `${profile.name} — ${SOFTWARE_LABELS[profile.software] || profile.software}`;
}
/**
 * Reload the #saved-profiles picker (keeping the current choice) and enable/disable "Save in" options based
 * on which controllers can represent the current effect. Silent when the server is offline.
 */
async function refreshProfiles() {
  try {
    const response = await fetch(
        `/api/profiles?effect=${encodeURIComponent($('background').value)}&feedback=${encodeURIComponent($('feedback').value)}`,
      ),
      body = await response.json();
    if (!response.ok) return;
    const previous = $('saved-profiles').value;
    $('saved-profiles').replaceChildren(new Option('Choose a profile', ''));
    for (const item of body.profiles || [])
      $('saved-profiles').append(new Option(profileLabel(item), item.id));
    $('saved-profiles').value = previous;
    for (const controller of body.controllers || []) {
      const option = [...$('profile-software').options].find((o) => o.value === controller.id);
      if (option) {
        option.disabled = !controller.available;
        option.title = controller.reason;
      }
    }
  } catch {
    /* Offline previews can still export JSON. */
  }
}
/**
 * Report a save/load result in #profile-status, including activation errors and, for native Synapse
 * profiles, a link to download the generated .ChromaEffects archive for manual import.
 * @param {{profile:object, loaded?:object, activationError?:string}} body Server response.
 */
function profileResult(body) {
  const loaded = body.loaded;
  if (body.profile?.name) updateProfileIndicator(body.profile.name);
  setStatus(
    'profile-status',
    body.activationError
      ? `Profile saved, but not activated: ${body.activationError}`
      : loaded?.detail || `Saved and loaded “${body.profile.name}” in Lighting Lab. No download was created.`,
    body.activationError || loaded?.imported === false ? 'problem' : '',
  );
  if (loaded?.archiveDownloadUrl) {
    const link = document.createElement('a');
    link.href = loaded.archiveDownloadUrl;
    link.textContent = ' Download Native Chroma Profile';
    link.download = '';
    $('profile-status').append(link);
  }
}
// "Save as Profile": store the current setup under #profile-name in the chosen controller and activate it.
// Saving to Synapse first stops live writes so they cannot override the native profile.
$('save-profile').onclick = async () => {
  const button = $('save-profile');
  button.disabled = true;
  try {
    if ($('profile-software').value === 'synapse-native') {
      $('live').checked = false;
      pendingSelection = null;
      clearTimeout(liveUpdateTimer);
    }
    const response = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: $('profile-name').value,
          software: $('profile-software').value,
          settings: configuration(),
        }),
      }),
      body = await response.json();
    if (!response.ok) throw Error(body.error);
    profileResult(body);
    await refreshProfiles();
  } catch (error) {
    setStatus('profile-status', error.message, 'problem');
  } finally {
    button.disabled = false;
  }
};
// "Load Profile": activate the chosen saved profile on the server, then load its settings into the editor.
// Live changes resumes only for Lighting Lab profiles.
$('load-profile').onclick = async () => {
  try {
    if (!$('saved-profiles').value) throw Error('Choose a saved profile first.');
    // Stop pending browser writes so they cannot immediately override the selected native controller.
    $('live').checked = false;
    pendingSelection = null;
    clearTimeout(liveUpdateTimer);
    while (applying) await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await fetch('/api/profiles/' + encodeURIComponent($('saved-profiles').value) + '/load', {
        method: 'POST',
      }),
      body = await response.json();
    if (!response.ok) throw Error(body.error);
    restoreSetup(body.profile.settings);
    $('live').checked = body.profile.software === 'lighting-lab';
    $('profile-software').value = body.profile.software;
    renderBoard();
    renderDetails();
    persist();
    paintPreview(performance.now());
    refreshExportCapabilities();
    $('profile-name').value = body.profile.name;
    profileResult(body);
  } catch (error) {
    setStatus('profile-status', error.message, 'problem');
  }
};
// "Delete": remove the selected saved profile after an explicit confirm. App Profile rules that pointed at it
// are kept (shown as "Missing saved profile") so the user can re-point them.
$('delete-profile').onclick = async () => {
  const id = $('saved-profiles').value;
  if (!id) {
    setStatus('profile-status', 'Choose a saved profile to delete.', 'problem');
    return;
  }
  const label = $('saved-profiles').selectedOptions[0]?.textContent || 'this profile';
  if (
    !confirm(
      `Delete ${label}? This cannot be undone. App rules that use it will show "Missing saved profile".`,
    )
  )
    return;
  try {
    const response = await fetch('/api/profiles/' + encodeURIComponent(id) + '/delete', { method: 'POST' }),
      body = await response.json();
    if (!response.ok) throw Error(body.error);
    setStatus('profile-status', `Deleted ${label}.`, 'ready');
    await refreshProfiles();
    refreshAppProfiles();
  } catch (error) {
    setStatus('profile-status', error.message, 'problem');
  }
};
// (Keyboard access for the label-styled file buttons is wired once, in the label.button[for] loop above.
// A second, overriding onkeydown assignment used to live here and has been removed.)
// =====================================================================================================
// SECTION 21. STARTUP: FIRST RENDER AND STATUS POLLING
// Everything above only defined functions and wired handlers. These lines draw the first frame, start the
// animation loop, and begin polling the server every 8 seconds.
// =====================================================================================================
// ===== Simple / All-controls mode, header actions, paint pills and preview chips (redesign) =====
/**
 * Switch between Simple (keyboard + looks) and All controls. CSS hides [data-fancy] in simple mode and
 * [data-simple] in fancy mode (body[data-mode]). Remembered in localStorage.
 * @param {'simple'|'fancy'} mode
 * @param {{reveal?: string}} [options] element id to scroll to after switching
 */
function setUiMode(mode, { reveal } = {}) {
  uiMode = mode === 'fancy' ? 'fancy' : 'simple';
  document.body.dataset.mode = uiMode;
  $('mode-toggle').setAttribute('aria-pressed', String(uiMode === 'fancy'));
  $('mode-toggle').textContent = uiMode === 'fancy' ? 'Simple view' : 'All controls';
  try {
    localStorage.setItem(UI_MODE_KEY, uiMode);
  } catch {
    /* storage disabled: the mode still applies for this visit */
  }
  renderCaseHint();
  recordActivity('ui-mode-changed', { mode: uiMode });
  if (reveal)
    $(reveal)?.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
}
/** Header label: which saved profile the editor last saved or loaded. */
function updateProfileIndicator(name) {
  $('profile-indicator').textContent = `Profile · ${name}`;
  $('profile-indicator').title = `Last saved or loaded profile: ${name}`;
}
$('mode-toggle').onclick = () => setUiMode(uiMode === 'fancy' ? 'simple' : 'fancy');
$('expand-fancy').onclick = () => setUiMode('fancy', { reveal: 'workspace' });
$('header-apply').onclick = () => $('apply').click();
$('header-save').onclick = () => {
  setUiMode('fancy');
  $('profile-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('profile-name').focus();
};
for (const pill of document.querySelectorAll('[data-paint]'))
  pill.onclick = () => {
    $('selection-mode').value = pill.dataset.paint;
    $('selection-mode').dispatchEvent(new Event('change'));
  };
for (const chip of document.querySelectorAll('[data-preview-group]'))
  chip.onclick = () => {
    const name = chip.dataset.previewGroup;
    if (previewHidden.has(name)) previewHidden.delete(name);
    else previewHidden.add(name);
    renderSelection();
    paintPreview(performance.now());
  };
wireInspector();
setUiMode(uiMode);
refreshProfiles();
renderBoard();
renderDetails();
requestAnimationFrame(animatePreview);
refreshProviderStatus();
statusTimer = setInterval(refreshProviderStatus, 8000);

// =====================================================================================================
// SECTION 22. APP PROFILES VIEW
// App Profiles switch to a saved profile when a chosen app is running or in front. The rules are evaluated
// on the SERVER (it keeps working with this page closed); this view only edits rules and shows their state.
// Rules keep their own metadata and always point back to a named saved lighting profile by id.
// =====================================================================================================
// Last server answer: config (rules + switching preferences), runtime (detected apps, active rule),
// profiles (saved profiles for the picker), discoveries (from "Find running apps").
let appProfilesState = {
  config: { automatic: true, waitMs: 1000, transitionMs: 400, rules: [] },
  runtime: { apps: [], detail: 'Checking local app rules.' },
  profiles: [],
};
/**
 * Name of the saved profile a rule points to, or "Missing saved profile" if it was deleted.
 * @param {string} id Profile id.
 * @returns {string}
 */
function appProfileName(id) {
  return appProfilesState.profiles.find((profile) => profile.id === id)?.name || 'Missing saved profile';
}
/** setStatus() for the App Profiles view's own status line (#app-profile-status). */
function setAppProfileStatus(message, state = '') {
  setStatus('app-profile-status', message, state);
}
const CONDITION_LABELS = {
  foreground: 'In front',
  running: 'Running',
  fullscreen: 'Full screen',
  time: 'Time of day',
};
/** Two-letter badge + stable hue for an app (from its executable or rule name), like the mockup's tiles. */
function appBadgeFor(rule) {
  const source = (rule.condition === 'time' ? rule.name : rule.executable || rule.name || '?').replace(
    /\.exe$/i,
    '',
  );
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : source.slice(0, 2)) || '?';
  let hash = 0;
  for (const ch of source.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    text: rule.condition === 'time' ? '☾' : letters[0].toUpperCase() + (letters[1] || '').toLowerCase(),
    hue: hash % 360,
  };
}
function badgeElement(rule) {
  const badge = appBadgeFor(rule);
  const node = el('span', 'app-badge', badge.text);
  node.style.background = `hsl(${badge.hue} 62% 46%)`;
  node.setAttribute('aria-hidden', 'true');
  return node;
}
/** Rough color word for a hex color, for auto-written profile descriptions. */
function colorName(hex) {
  const c = E.parseColor(hex);
  const max = Math.max(c.red, c.green, c.blue),
    min = Math.min(c.red, c.green, c.blue);
  if (max < 40) return 'dark';
  if (max - min < 30) return max > 200 ? 'white' : 'gray';
  let hue;
  const d = max - min;
  if (max === c.red) hue = (60 * ((c.green - c.blue) / d) + 360) % 360;
  else if (max === c.green) hue = 60 * ((c.blue - c.red) / d) + 120;
  else hue = 60 * ((c.red - c.green) / d) + 240;
  const names = [
    [15, 'red'],
    [40, 'orange'],
    [65, 'amber'],
    [160, 'green'],
    [190, 'teal'],
    [205, 'cyan'],
    [250, 'blue'],
    [275, 'indigo'],
    [300, 'violet'],
    [340, 'pink'],
    [361, 'red'],
  ];
  return names.find(([limit]) => hue < limit)[1];
}
/** One-sentence description of a saved setup, e.g. "Matrix background; pink anchors with Blue flame." */
function describeSetup(settings = {}) {
  const groups = E.groupsFor(settings);
  const parts = [];
  const bg = groups.background;
  if (settings.minimalist) parts.push('Dark board that lights only when you type');
  else if (bg.dynamic !== 'none') parts.push(`${optionFor('dynamic', bg.dynamic).label} background`);
  else if (bg.base === 'static') parts.push(`Solid ${colorName(bg.color)} board`);
  else parts.push('Dim board');
  const anchor = groups.anchor;
  if (anchor.keys.length) {
    const reaction =
      anchor.reaction !== 'none' ? ` with ${optionFor('reaction', anchor.reaction).label.toLowerCase()}` : '';
    parts.push(`${anchor.keys.length} ${colorName(anchor.color)} anchor keys${reaction}`);
  }
  if (groups.orientation.keys.length) parts.push(`${colorName(groups.orientation.color)} landmarks`);
  return parts.join('; ') + '.';
}
/**
 * Draw a small keyboard picture of a setup on a canvas, using the real renderer (effects.js) at `time` ms.
 * Used by the Active-now preview (animated) and the saved-profile thumbnails (one frame).
 */
function drawMiniKeyboard(canvas, settings, time = 1200) {
  const context = canvas.getContext('2d');
  let miniLayout;
  try {
    miniLayout = K.layoutForModel(settings?.keyboardModel || 'standard-full-size', settings?.customLayout);
  } catch {
    miniLayout = K.layoutForModel('standard-full-size');
  }
  const pad = 8,
    unit = Math.min(
      (canvas.width - pad * 2) / miniLayout.width,
      (canvas.height - pad * 2) / miniLayout.height,
    ),
    gap = Math.max(1, unit * 0.12);
  context.fillStyle = '#12131a';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const key of miniLayout.keys) {
    const color = settings ? E.sample(settings, key.id, time) : { red: 40, green: 40, blue: 52 };
    const lit = Math.max(color.red, color.green, color.blue) > 24;
    context.fillStyle = lit ? `rgb(${color.red},${color.green},${color.blue})` : '#262734';
    const x = pad + key.x * unit,
      y = pad + key.y * unit,
      w = key.w * unit - gap,
      h = key.h * unit - gap;
    context.beginPath();
    context.roundRect ? context.roundRect(x, y, w, h, Math.min(4, unit * 0.18)) : context.rect(x, y, w, h);
    context.fill();
  }
}
/** Profile objects from the server, by id (settings are included in App Profiles responses). */
function savedProfileById(id) {
  return appProfilesState.profiles.find((profile) => profile.id === id);
}
/**
 * Client-side mirror of app-profiles.cjs resolveRule() for the "Try it" chips: which rule would win if only
 * `executable` were running and in front (full screen too), at the current local time. Preview only.
 */
function simulateRule(executable) {
  const config = appProfilesState.config;
  const now = new Date(),
    minutes = now.getHours() * 60 + now.getMinutes();
  const inWindow = (from, to) => {
    const [fh, fm] = String(from).split(':').map(Number),
      [th, tm] = String(to).split(':').map(Number);
    const start = fh * 60 + fm,
      end = th * 60 + tm;
    if (start === end) return true;
    return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  };
  const exists = (id) => Boolean(savedProfileById(id));
  for (const [index, rule] of (config.rules || []).entries()) {
    if (rule.enabled === false || !exists(rule.profileId)) continue;
    const match =
      rule.condition === 'time'
        ? inWindow(rule.from, rule.to)
        : executable && String(rule.executable).toLowerCase() === executable.toLowerCase();
    if (match) return { rule, index };
  }
  if (config.defaultProfileId && exists(config.defaultProfileId))
    return {
      rule: {
        id: 'default',
        name: 'Everything else',
        condition: 'default',
        profileId: config.defaultProfileId,
      },
      index: -1,
    };
  return null;
}
let activePreviewSettings = null,
  activePreviewTimer;
/** Show a profile in the Active-now card (title, detail, animated mini preview). */
function showActiveProfile(rule, detail, { simulated = false } = {}) {
  const profile = rule ? savedProfileById(rule.profileId) : null;
  const badge = $('app-active-badge');
  if (rule) {
    const info = appBadgeFor(rule);
    badge.textContent = rule.id === 'default' ? '∞' : info.text;
    badge.style.background = rule.id === 'default' ? '#3a3550' : `hsl(${info.hue} 62% 46%)`;
  } else {
    badge.textContent = '–';
    badge.style.background = '#2b2d3a';
  }
  $('app-profile-active-title').textContent = rule
    ? `${rule.name} → ${profile?.name || 'Missing saved profile'}`
    : 'No app profile is active';
  $('app-profile-active-detail').textContent = detail;
  activePreviewSettings = profile?.settings || null;
  $('app-active-caption').textContent = profile?.settings
    ? (simulated ? 'Preview only: ' : '') + describeSetup(profile.settings)
    : 'Your current lighting stays as it is.';
  drawMiniKeyboard($('app-active-preview'), activePreviewSettings, performance.now());
}
/** Animate the Active-now preview at ~12 fps while the App Profiles view is open. */
function runActivePreview(on) {
  clearInterval(activePreviewTimer);
  if (on)
    activePreviewTimer = setInterval(() => {
      if (activePreviewSettings)
        drawMiniKeyboard($('app-active-preview'), activePreviewSettings, performance.now());
    }, 80);
}
/** Build a <select> of saved profiles (with an optional first "none" option). */
function profileSelect(selectedId, noneLabel) {
  const select = document.createElement('select');
  if (noneLabel) select.append(new Option(noneLabel, ''));
  for (const profile of appProfilesState.profiles) select.append(new Option(profile.name, profile.id));
  if (selectedId && !savedProfileById(selectedId))
    select.append(new Option('Missing saved profile', selectedId));
  select.value = selectedId || '';
  return select;
}
/** POST an inline rule edit; on failure the server's message is shown and the view reloads the true state. */
function updateRule(rule, changes, success) {
  return appProfileAction('/api/app-profiles/' + encodeURIComponent(rule.id) + '/update', changes, success);
}
/**
 * Draw the whole App Profiles view from appProfilesState. Every user-supplied string (rule names, executables,
 * profile names) is set with textContent.
 */
function renderAppProfiles() {
  const config = appProfilesState.config,
    runtime = appProfilesState.runtime,
    profiles = appProfilesState.profiles;
  $('app-profiles-auto').checked = config.automatic !== false;
  for (const [input, output, value] of [
    ['app-switch-wait', 'app-switch-wait-value', config.waitMs],
    ['app-switch-transition', 'app-switch-transition-value', config.transitionMs],
  ]) {
    if (document.activeElement !== $(input)) $(input).value = Number(value || 0) / 1000;
    $(output).textContent = (Number($(input).value) || 0).toFixed(1) + ' s';
  }
  // Active now.
  const activeRule =
    runtime.activeRule || (config.rules || []).find((rule) => rule.id === runtime.activeId) || null;
  const activeIndex = activeRule ? (config.rules || []).findIndex((rule) => rule.id === activeRule.id) : -1;
  showActiveProfile(
    activeRule,
    activeRule
      ? activeRule.id === 'default'
        ? 'No rule matches, so the default profile is in use.'
        : `Matched rule ${activeIndex + 1}: ${activeRule.name} is ${CONDITION_LABELS[activeRule.condition]?.toLowerCase() || 'active'}.`
      : runtime.detail || 'No local app state is available yet.',
  );
  // Try it chips: one per distinct app in the rules (preview of which rule would win).
  const tryChips = $('app-try-chips');
  tryChips.replaceChildren();
  const seen = new Set();
  for (const rule of config.rules || []) {
    if (rule.condition === 'time' || !rule.executable || seen.has(rule.executable.toLowerCase())) continue;
    seen.add(rule.executable.toLowerCase());
    const chip = el('button', 'chip', rule.name);
    chip.type = 'button';
    chip.onclick = () => {
      const result = simulateRule(rule.executable);
      for (const other of tryChips.children) other.setAttribute('aria-pressed', String(other === chip));
      showActiveProfile(
        result?.rule || null,
        result
          ? `If ${rule.executable} were in front: ${result.index >= 0 ? `rule ${result.index + 1}, ${result.rule.name}` : 'Everything else'}. (Preview only - nothing changed.)`
          : `If ${rule.executable} were in front, no rule would match. (Preview only.)`,
        { simulated: true },
      );
    };
    tryChips.append(chip);
  }
  if (!tryChips.children.length) tryChips.append(el('span', 'help', 'Add an app rule to try it here.'));
  // Rule rows.
  const list = $('app-profile-rule-list');
  list.replaceChildren();
  for (const [index, rule] of (config.rules || []).entries()) {
    const row = el('article', 'app-rule');
    if (activeRule && activeRule.id === rule.id) row.dataset.active = 'true';
    if (rule.enabled === false) row.dataset.disabled = 'true';
    const who = el('div', 'app-rule-who');
    const names = el('div');
    names.append(
      el('strong', '', rule.name),
      el('small', '', rule.condition === 'time' ? `${rule.from} – ${rule.to}` : rule.executable),
    );
    who.append(badgeElement(rule), names);
    // Condition select (+ time window inputs for "Time of day").
    const conditionCell = el('div', 'app-rule-condition');
    const condition = document.createElement('select');
    condition.setAttribute('aria-label', `Condition for ${rule.name}`);
    for (const [value, label] of Object.entries(CONDITION_LABELS)) condition.append(new Option(label, value));
    condition.value = rule.condition;
    condition.onchange = () => {
      if (condition.value === 'time')
        updateRule(
          rule,
          { condition: 'time', from: rule.from || '23:00', to: rule.to || '07:00' },
          'Rule updated.',
        );
      else if (!rule.executable) {
        setAppProfileStatus('Time rules have no app. Add a new app rule instead.', 'problem');
        condition.value = rule.condition;
      } else updateRule(rule, { condition: condition.value }, 'Rule updated.');
    };
    conditionCell.append(condition);
    if (rule.condition === 'time') {
      for (const field of ['from', 'to']) {
        const input = document.createElement('input');
        input.type = 'time';
        input.value = rule[field] || '';
        input.setAttribute('aria-label', `${field === 'from' ? 'Start' : 'End'} time for ${rule.name}`);
        input.onchange = () => updateRule(rule, { [field]: input.value }, 'Time window updated.');
        conditionCell.append(input);
      }
    }
    // Profile select with the profile's color dot.
    const profileCell = el('div', 'app-rule-profile');
    const select = profileSelect(rule.profileId);
    select.setAttribute('aria-label', `Profile for ${rule.name}`);
    select.onchange = () => updateRule(rule, { profileId: select.value }, 'Rule updated.');
    const dot = el('i', 'profile-dot');
    const settings = savedProfileById(rule.profileId)?.settings;
    if (settings) dot.style.background = E.groupsFor(settings).anchor.color;
    profileCell.append(dot, select);
    // On/off switch.
    const toggleLabel = el('label', 'switch-label rule-switch');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = rule.enabled !== false;
    toggle.setAttribute('aria-label', `${rule.name} on`);
    toggle.onchange = () =>
      appProfileAction('/api/app-profiles/' + encodeURIComponent(rule.id) + '/toggle', {
        enabled: toggle.checked,
      });
    toggleLabel.append(toggle, el('span', 'switch'));
    // Actions.
    const actions = el('div', 'app-rule-actions');
    const action = (label, title, handler, disabled = false) => {
      const button = el('button', 'quiet', label);
      button.type = 'button';
      button.title = title;
      button.setAttribute('aria-label', `${title}: ${rule.name}`);
      button.disabled = disabled;
      button.onclick = handler;
      actions.append(button);
    };
    action('Test', 'Apply this rule’s profile now', () =>
      appProfileAction(
        '/api/app-profiles/' + encodeURIComponent(rule.id) + '/test',
        {},
        `Applied ${appProfileName(rule.profileId)} for this rule.`,
      ),
    );
    action(
      '↑',
      'Move up',
      () =>
        appProfileAction('/api/app-profiles/' + encodeURIComponent(rule.id) + '/move', { direction: 'up' }),
      index === 0,
    );
    action(
      '↓',
      'Move down',
      () =>
        appProfileAction('/api/app-profiles/' + encodeURIComponent(rule.id) + '/move', { direction: 'down' }),
      index === config.rules.length - 1,
    );
    action('✕', 'Delete', () =>
      appProfileAction('/api/app-profiles/' + encodeURIComponent(rule.id) + '/delete', {}, 'Rule deleted.'),
    );
    row.append(
      el('b', 'app-rule-order', String(index + 1)),
      who,
      conditionCell,
      profileCell,
      toggleLabel,
      actions,
    );
    list.append(row);
  }
  if (!list.children.length)
    list.append(el('p', 'help', 'No rules yet. Save a lighting profile, then connect it to an app here.'));
  // Default ("Everything else") profile.
  const fallback = $('app-default-profile');
  fallback.replaceChildren(new Option('Keep current lighting', ''));
  for (const profile of profiles) fallback.append(new Option(profile.name, profile.id));
  fallback.value =
    config.defaultProfileId && savedProfileById(config.defaultProfileId) ? config.defaultProfileId : '';
  // Add-rule profile picker.
  const addSelect = $('app-rule-profile'),
    previous = addSelect.value;
  addSelect.replaceChildren(
    new Option(profiles.length ? 'Choose a saved profile' : 'Save a Lighting profile first', ''),
  );
  for (const profile of profiles) addSelect.append(new Option(profileLabel(profile), profile.id));
  addSelect.value = profiles.some((profile) => profile.id === previous) ? previous : '';
  // Detected apps (discoveries) and apps in rules.
  const ruleApps = new Set((config.rules || []).map((rule) => String(rule.executable || '').toLowerCase()));
  const renderApps = (target, apps, emptyText, allowUse) => {
    target.replaceChildren();
    for (const app of apps || []) {
      const row = el('div', 'app-detected');
      const name = el('span', 'app-detected-name');
      name.append(
        badgeElement({ executable: app.executable, condition: 'running' }),
        el('b', '', app.executable.replace(/\.exe$/i, '')),
      );
      const state = el(
        'span',
        '',
        app.fullscreen
          ? 'Full screen'
          : app.foreground
            ? 'In front'
            : app.running
              ? 'Running'
              : 'Not running',
      );
      state.dataset.state = app.fullscreen || app.foreground ? 'foreground' : app.running ? 'running' : 'off';
      row.append(name, state);
      if (allowUse) {
        const use = el('button', 'quiet', 'Use');
        use.type = 'button';
        use.title = `Start a rule for ${app.executable}`;
        use.onclick = () => startRuleFor(app.executable);
        row.append(use);
      }
      target.append(row);
    }
    if (!target.children.length) target.append(el('p', 'help', emptyText));
  };
  renderApps(
    $('app-profile-discoveries'),
    appProfilesState.discoveries,
    'Press Find running apps to list visible desktop apps.',
    true,
  );
  renderApps(
    $('app-profile-detected'),
    runtime.apps,
    runtime.available === false
      ? 'This local server is not running on Windows.'
      : 'Add an enabled app rule to see its state here.',
    false,
  );
  // Quick add: detected apps that no rule mentions yet.
  const quick = $('app-quick-add');
  quick.replaceChildren();
  for (const app of appProfilesState.discoveries || []) {
    if (ruleApps.has(app.executable.toLowerCase())) continue;
    const chip = el('button', 'chip', '+ ' + app.executable.replace(/\.exe$/i, ''));
    chip.type = 'button';
    chip.onclick = () => startRuleFor(app.executable);
    quick.append(chip);
    if (quick.children.length >= 6) break;
  }
  if (!quick.children.length) quick.append(el('span', 'help', 'Use Find running apps to see suggestions.'));
  renderProfileGallery();
}
/** Open the Add-rule form pre-filled for one app. */
function startRuleFor(executable) {
  $('app-rule-add-panel').open = true;
  $('app-rule-executable').value = executable;
  if (!$('app-rule-name').value) $('app-rule-name').value = executable.replace(/\.exe$/i, '');
  if ($('app-rule-condition').value === 'time') $('app-rule-condition').value = 'foreground';
  syncAddRuleCondition();
  setAppProfileStatus(
    `${executable} is ready for a new rule - choose a profile and press Add rule.`,
    'ready',
  );
}
/** Show the time inputs for "Time of day" rules and the executable field for app rules. */
function syncAddRuleCondition() {
  const time = $('app-rule-condition').value === 'time';
  $('app-rule-time').hidden = !time;
  $('app-rule-executable-label').hidden = time;
}
let selectedGalleryProfile = null;
/** Saved profiles as cards with live-renderer thumbnails, rule counts and auto descriptions. */
function renderProfileGallery() {
  const gallery = $('app-profile-gallery');
  gallery.replaceChildren();
  const config = appProfilesState.config;
  for (const profile of appProfilesState.profiles) {
    const card = el('button', 'profile-card');
    card.type = 'button';
    card.setAttribute('aria-pressed', String(selectedGalleryProfile === profile.id));
    const canvas = document.createElement('canvas');
    canvas.width = 260;
    canvas.height = 96;
    canvas.setAttribute('aria-hidden', 'true');
    drawMiniKeyboard(canvas, profile.settings || null);
    const rules = (config.rules || []).filter((rule) => rule.profileId === profile.id).length;
    const meta = el('div', 'profile-card-meta');
    meta.append(
      el('b', '', profile.name),
      el(
        'small',
        '',
        config.defaultProfileId === profile.id
          ? 'Default'
          : rules
            ? `${rules} rule${rules === 1 ? '' : 's'}`
            : '',
      ),
    );
    card.append(
      canvas,
      meta,
      el('p', 'help', profile.settings ? describeSetup(profile.settings) : profile.software),
    );
    card.onclick = () => {
      selectedGalleryProfile = profile.id;
      renderProfileGallery();
    };
    gallery.append(card);
  }
  if (!gallery.children.length)
    gallery.append(
      el('p', 'help', 'No saved profiles yet. In Lighting, set up a look and press Save as Profile.'),
    );
}
/**
 * POST an App Profiles change, merge the returned state, show an optional success message, then reload the
 * view. Errors are shown in #app-profile-status and never thrown.
 * @param {string} route   e.g. '/api/app-profiles/config' or '/api/app-profiles/<ruleId>/move'.
 * @param {object} body    JSON body.
 * @param {string} [success] Message to show on success.
 */
async function appProfileAction(route, body, success) {
  try {
    const response = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      data = await response.json();
    if (!response.ok) throw Error(data.error || 'App Profile update failed.');
    if (data.config) appProfilesState = { ...appProfilesState, ...data };
    if (success) setAppProfileStatus(success, 'ready');
    await refreshAppProfiles();
    return true;
  } catch (error) {
    setAppProfileStatus(error.message, 'problem');
    return false; // Callers use this to keep the user's typing when a save was rejected (LL-038).
  }
}
/**
 * Reload App Profiles state from the server and redraw. With switchNow, POST /refresh lets the server
 * evaluate rules and switch immediately; otherwise GET is read-only (it never switches lighting).
 * @param {{switchNow?: boolean}} [options]
 */
async function refreshAppProfiles({ switchNow = false } = {}) {
  try {
    const response = await fetch(switchNow ? '/api/app-profiles/refresh' : '/api/app-profiles', {
        method: switchNow ? 'POST' : 'GET',
        ...(switchNow ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      }),
      data = await response.json();
    if (!response.ok) throw Error(data.error || 'App Profiles is unavailable.');
    appProfilesState = { ...appProfilesState, ...data };
    renderAppProfiles();
  } catch (error) {
    setAppProfileStatus(`Could not read App Profiles: ${error.message}`, 'problem');
  }
}
/**
 * Switch between the Lighting editor and the App Profiles view (header nav). Hides every other <main> child
 * and remembers which ones it hid (data-hidden-for-app-profiles) so it restores exactly those, leaving
 * panels that were already hidden (such as a dismissed guide) hidden.
 * @param {boolean} active true = show App Profiles.
 */
function showAppProfiles(active) {
  const view = $('app-profiles-view'),
    main = document.querySelector('main');
  view.hidden = !active;
  for (const child of main.children) {
    if (child === view) continue;
    if (active && !child.hidden) {
      child.dataset.hiddenForAppProfiles = 'true';
      child.hidden = true;
    } else if (!active && child.dataset.hiddenForAppProfiles === 'true') {
      child.hidden = false;
      delete child.dataset.hiddenForAppProfiles;
    }
  }
  runActivePreview(active);
  $('show-lighting').setAttribute('aria-pressed', String(!active));
  $('show-app-profiles').setAttribute('aria-pressed', String(active));
  if (active) {
    refreshAppProfiles();
    view.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
// Header nav: "Lighting" and "App profiles".
$('show-lighting').onclick = () => showAppProfiles(false);
$('show-app-profiles').onclick = () => showAppProfiles(true);
// "Automatic switching" toggle: save it together with the current timing values.
$('app-profiles-auto').onchange = () =>
  appProfileAction('/api/app-profiles/config', {
    automatic: $('app-profiles-auto').checked,
    waitMs: Math.round(Number($('app-switch-wait').value) * 1000),
    transitionMs: Math.round(Number($('app-switch-transition').value) * 1000),
  });
// "Everything else" default profile (empty = keep current lighting when nothing matches).
$('app-default-profile').onchange = () =>
  appProfileAction(
    '/api/app-profiles/config',
    { defaultProfileId: $('app-default-profile').value || null },
    $('app-default-profile').value
      ? 'Default profile set for when no rule matches.'
      : 'No default: lighting stays as it is when no rule matches.',
  );
$('app-rule-condition').onchange = syncAddRuleCondition;
// "Edit in Lighting": open the selected (or first) saved profile in the editor WITHOUT applying it.
$('app-edit-in-lighting').onclick = async () => {
  const id = selectedGalleryProfile || appProfilesState.profiles[0]?.id;
  if (!id) return setAppProfileStatus('Save a profile in Lighting first.', 'problem');
  try {
    const response = await fetch('/api/profiles/' + encodeURIComponent(id)),
      body = await response.json();
    if (!response.ok) throw Error(body.error);
    $('live').checked = false; // editing must not push to the keyboard until the user chooses to
    restoreSetup(body.settings);
    showAppProfiles(false);
    setUiMode('fancy');
    $('profile-name').value = body.name;
    updateProfileIndicator(body.name);
    changed();
    setStatus(
      'apply-status',
      `Editing "${body.name}". Live changes is off - press Apply when you want it on the keyboard.`,
      'ready',
    );
  } catch (error) {
    setAppProfileStatus(error.message, 'problem');
  }
};
// "Wait before switching" / "Transition window" sliders: update the label while dragging, save on release.
for (const [input, output] of [
  ['app-switch-wait', 'app-switch-wait-value'],
  ['app-switch-transition', 'app-switch-transition-value'],
]) {
  $(input).oninput = () => {
    $(output).textContent = `${Number($(input).value).toFixed(1)} s`;
  };
  $(input).onchange = () =>
    appProfileAction('/api/app-profiles/config', {
      automatic: $('app-profiles-auto').checked,
      waitMs: Math.round(Number($('app-switch-wait').value) * 1000),
      transitionMs: Math.round(Number($('app-switch-transition').value) * 1000),
    });
}
// "Check now": evaluate rules immediately (may switch lighting).
$('app-profiles-refresh').onclick = () =>
  appProfileAction('/api/app-profiles/refresh', {}, 'Checked the configured app rules now.');
// "Find running apps": user-started list of visible desktop apps, to fill in an executable name.
$('app-profiles-discover').onclick = () =>
  appProfileAction('/api/app-profiles/discover', {}, 'Listed visible desktop apps on this PC.');
// "Add a rule" form: requires a saved profile; the server validates the name, executable, and condition.
$('app-profile-add').onsubmit = (event) => {
  event.preventDefault();
  const profileId = $('app-rule-profile').value;
  if (!profileId) {
    setAppProfileStatus('Save a lighting profile first, then choose it for this app rule.', 'problem');
    return;
  }
  const condition = $('app-rule-condition').value;
  appProfileAction(
    '/api/app-profiles',
    condition === 'time'
      ? {
          name: $('app-rule-name').value,
          condition,
          from: $('app-rule-from').value,
          to: $('app-rule-to').value,
          profileId,
        }
      : { name: $('app-rule-name').value, executable: $('app-rule-executable').value, condition, profileId },
    'App rule saved.',
  ).then((saved) => {
    // Only clear the form after a successful save; a rejected rule keeps what the user typed so they can fix it.
    if (!saved) return;
    $('app-rule-name').value = '';
    $('app-rule-executable').value = '';
  });
};
// =====================================================================================================
// SECTION 23. ACTIVITY TELEMETRY LISTENERS (AND THE APP PROFILES FIRST LOAD)
// Local-only action trail for diagnostics (see recordActivity() in SECTION 3 and PRIVACY in the header).
// Only controls in this allowlist report their VALUE; text inputs (profile names, words, feedback notes,
// rule names, executables) are deliberately absent so typed text is never recorded.
// =====================================================================================================
const SAFE_ACTIVITY_CONTROLS = new Set([
  'background',
  'feedback',
  'keyword-feedback',
  'provider',
  'keyboard-model',
  'selected-device',
  'selection-mode',
  'speed',
  'color',
  'minimalist',
  'protect',
  'sync-mouse',
  'live',
  'global-input',
  'app-profiles-auto',
  'app-switch-wait',
  'app-switch-transition',
  'app-rule-condition',
  'app-rule-profile',
]);
// Clicks: preview keys are recorded only as "a key was clicked in mode X" (never which key); buttons by id.
document.addEventListener('click', (event) => {
  const target = event.target.closest('button,.key');
  if (!target) return;
  if (target.classList.contains('key')) recordActivity('keyboard-preview-click', { mode: paintMode });
  else if (target.id) recordActivity('control-clicked', { control: target.id });
});
// Changes: allowlisted controls only; checkbox values become 'on'/'off', other values are capped at 120 chars.
document.addEventListener('change', (event) => {
  const target = event.target;
  if (!SAFE_ACTIVITY_CONTROLS.has(target.id)) return;
  const value =
    target.type === 'checkbox' ? (target.checked ? 'on' : 'off') : String(target.value || '').slice(0, 120);
  recordActivity('control-changed', { control: target.id, state: value });
});
// Load App Profiles state once at startup so the view is ready when opened.
refreshAppProfiles();
