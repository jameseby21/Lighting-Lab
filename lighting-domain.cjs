/* =====================================================================================================
 * lighting-domain.cjs — validate complete settings before providers touch hardware; rendering stays
 * shared with the preview.
 *
 * ROLE IN THE ARCHITECTURE
 *   Browser (ui.js) ──POST /api/apply──▶ server.cjs ──validateSelection()──▶ provider (Chroma / Synapse)
 *                                                                       └─▶ profiles, export, app rules
 *
 *   validateSelection() is THE trust boundary. Everything arriving from a browser (or a saved JSON file,
 *   a share link, an exported profile) is untrusted until it passes here. Providers, the profile store
 *   and the .exe exporter only ever receive its normalized output, so they can assume well-formed data.
 *   It is deliberately strict: unknown effects, unknown switch IDs, malformed colors and out-of-range
 *   numbers are REJECTED with a human-readable message (the server turns that into HTTP 422), never
 *   silently "fixed".
 *
 *   The frame builders below wrap effects.js so the Chroma provider and the exporter produce exactly the
 *   same pixels as the browser preview.
 *
 * LOADED BY
 *   Node only (CommonJS): server.cjs, profiles.cjs, providers/chroma-sdk.cjs, export.cjs,
 *   synapse-profile.cjs and the tests. (core.js and effects.js are shared with the browser; this is not.)
 *
 * WHAT validateSelection() CHECKS (and the limits)
 *   effect            required; one of Effects.EFFECTS (legacy whole-board effect name).
 *   provider          required; 'chroma-sdk' (live SDK) or 'synapse-native' (Synapse Studio profile).
 *   anchors           optional switch-ID list (≤150 entries, every ID must have a Chroma coordinate); de-duplicated.
 *   protectedAnchors  same rules (the orientation keys).
 *   keyboardModel     optional; must be a KeyboardPlan.modelCatalog id (default 'standard-full-size').
 *   speed             optional finite number 0.1..10 (default 3.5 = baseline speed).
 *   feedback          optional reaction name (default 'reactive').
 *   keywordFeedback   optional reaction name (defaults to `feedback`).
 *   minimalist, mouseSync  coerced to booleans; protectAnchors is true only if exactly `true`.
 *   brokenKeys        optional switch-ID list (keys the user reported as not registering).
 *   inputAliases      optional {fromSwitch: toSwitch} map; both sides must be known switch IDs.
 *   color, keywordColor, anchorColor  '#rrggbb' strings (each defaults to '#ff0033').
 *   seed              integer 0..2^32-1 (default 17) for the deterministic Chaos/Fire/Starlight patterns.
 *   groups            optional {anchor, background, orientation}; when present EACH must exist and have:
 *                       keys (switch list; a switch may belong to only ONE group), base 'off'|'static',
 *                       dynamic in DYNAMIC_EFFECTS, reaction in REACTIONS, color + reactionColor '#rrggbb'.
 *                     Legacy fields (anchors, effect, feedback, ...) are then DERIVED from the groups so
 *                     both representations always agree.
 *   customLayout      optional; validated by KeyboardPlan.layoutForModel('custom', ...).
 *   Any other field is dropped from the normalized result (callers that need to keep the full original —
 *   the audit log, saved profiles — spread the original object separately).
 *
 * EXPORTS
 *   validateSelection         untrusted object → normalized selection (throws on invalid input).
 *   createCustomKeyboardFrame selection pieces + time → Chroma CHROMA_CUSTOM keyboard body.
 *   createCustomMouseFrame    selection + time → Chroma CHROMA_CUSTOM2 mouse body (9 x 7).
 *   bgr                       {red,green,blue} → Chroma BGR integer.
 *   EFFECTS, PROVIDERS        the accepted name sets.
 *   ANCHOR_RGB, DEFAULT_ANCHORS, isSavedProfileSelection  kept for older callers.
 * ===================================================================================================== */
'use strict';
const KeyboardPlan = require('./core.js');
const Effects = require('./effects.js');
// Sets for O(1) membership checks against the renderer's own lists (single source of truth).
const EFFECTS = new Set(Effects.EFFECTS),
  DYNAMIC_EFFECTS = new Set(Effects.DYNAMIC_EFFECTS),
  REACTIONS = new Set(Effects.REACTIONS),
  PROVIDERS = new Set(['synapse-native', 'chroma-sdk']);
const DEFAULT_ANCHORS = KeyboardPlan.defaultAnchors;
// The project's signature red (#ff0033) as RGB; kept as an export for older callers.
const ANCHOR_RGB = { red: 255, green: 0, blue: 51 };

/**
 * Normalize only supported configuration fields while rejecting malformed or unknown switch IDs.
 *
 * See the file header for every field and its limits.
 * @param {object} selection  Untrusted setup (request body, saved profile settings, imported JSON).
 * @returns {object} A new, normalized selection containing only known fields.
 * @throws {Error} With a user-facing message describing the first problem found.
 * @example
 *   validateSelection({ effect: 'matrix', provider: 'chroma-sdk', anchors: ['Q'] })
 *   // → { effect:'matrix', provider:'chroma-sdk', anchors:['Q'], protectedAnchors:[], speed:3.5,
 *   //     feedback:'reactive', keywordFeedback:'reactive', color:'#ff0033', seed:17, ... }
 */
function validateSelection(selection) {
  if (!selection || typeof selection !== 'object') throw new Error('Provide a lighting configuration.');
  const effect = selection.effect,
    provider = selection.provider;
  if (!EFFECTS.has(effect)) throw new Error('Choose a supported Lighting Lab effect.');
  if (!PROVIDERS.has(provider)) throw new Error('Choose a supported control provider.');
  /**
   * Validate an optional switch-ID list: an array of at most 150 strings that all have a Chroma
   * coordinate. (150 comfortably exceeds the ~110 known switches while bounding request work.)
   * @param {*} value  The candidate list; undefined means "empty".
   * @param {string} label  Field name used in the error message.
   * @returns {string[]} De-duplicated list, original order kept.
   */
  function ids(value, label) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 150) throw new Error(`${label} must be a switch list.`);
    for (const id of value)
      if (typeof id !== 'string' || !KeyboardPlan.chromaCoordinates[id])
        // Echo at most 30 characters of the bad value so a hostile payload cannot flood the message.
        throw new Error(`No Chroma coordinate is known for ${String(id).slice(0, 30)}.`);
    return [...new Set(value)];
  }
  const anchors = ids(selection.anchors, 'Keyword selection'),
    protectedAnchors = ids(selection.protectedAnchors, 'Anchor selection');
  const keyboardModel =
    typeof selection.keyboardModel === 'string' ? selection.keyboardModel : 'standard-full-size';
  if (!KeyboardPlan.modelCatalog.some((m) => m.id === keyboardModel))
    throw new Error('Choose a keyboard from the model list.');
  // 3.5 is the baseline speed the effects were tuned at; 0.1-10 is wider than the UI slider (0.25-6).
  const speed = selection.speed === undefined ? 3.5 : selection.speed;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.1 || speed > 10)
    throw new Error('Speed must be between 0.1 and 10.');
  const feedback = selection.feedback === undefined ? 'reactive' : selection.feedback;
  if (!REACTIONS.has(feedback)) throw new Error('Choose supported key feedback.');
  const keywordFeedback = selection.keywordFeedback ?? feedback;
  if (!REACTIONS.has(keywordFeedback)) throw new Error('Choose supported keyword feedback.');
  const result = {
    effect,
    provider,
    anchors,
    protectedAnchors,
    keyboardModel,
    speed,
    feedback,
    keywordFeedback,
    minimalist: Boolean(selection.minimalist),
    mouseSync: Boolean(selection.mouseSync),
    // Only an explicit `true` protects anchors from reactions; truthy strings etc. do not.
    protectAnchors: selection.protectAnchors === true,
  };
  result.brokenKeys = ids(selection.brokenKeys, 'Unresponsive keys');
  // "Lighting substitute" map: pressing `from` fires the reaction for `to` (lighting only, no typing remap).
  result.inputAliases = {};
  if (selection.inputAliases != null) {
    if (typeof selection.inputAliases !== 'object' || Array.isArray(selection.inputAliases))
      throw new Error('Feedback substitutions must be a switch map.');
    for (const [from, to] of Object.entries(selection.inputAliases)) {
      ids([from, to], 'Feedback substitutions');
      result.inputAliases[from] = to;
    }
  }
  // Exactly '#' + six hex digits; shorthand (#f03), names ('red') and rgb() strings are rejected.
  for (const field of ['color', 'keywordColor', 'anchorColor']) {
    const value = selection[field] ?? '#ff0033';
    if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value))
      throw new Error(`${field} must be a six-digit hex color.`);
    result[field] = value;
  }
  // Seed for deterministic "random" effects (see hash() in effects.js); must fit an unsigned 32-bit int.
  const seed = selection.seed ?? 17;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('Chaos seed must be a 32-bit unsigned integer.');
  result.seed = seed;
  if (selection.groups !== undefined) {
    if (!selection.groups || typeof selection.groups !== 'object' || Array.isArray(selection.groups))
      throw new Error('Lighting groups must be an object.');
    result.groups = {};
    // Tracks every switch already claimed by an earlier group: one key, one group.
    const assigned = new Set();
    for (const name of Effects.GROUP_NAMES) {
      const group = selection.groups[name];
      if (!group || typeof group !== 'object' || Array.isArray(group))
        throw new Error(`Provide the ${name} lighting group.`);
      const keys = ids(group.keys, `${name} group`);
      for (const id of keys) {
        if (assigned.has(id)) throw new Error(`Switch ${id} belongs to more than one lighting group.`);
        assigned.add(id);
      }
      if (!['off', 'static'].includes(group.base))
        throw new Error(`Choose a base lighting mode for ${name}.`);
      if (!DYNAMIC_EFFECTS.has(group.dynamic))
        throw new Error(`Choose a supported dynamic effect for ${name}.`);
      if (!REACTIONS.has(group.reaction)) throw new Error(`Choose a supported reaction for ${name}.`);
      for (const field of ['color', 'reactionColor'])
        if (typeof group[field] !== 'string' || !/^#[\da-f]{6}$/i.test(group[field]))
          throw new Error(`${name} ${field} must be a six-digit hex color.`);
      // Copy field by field so nothing unexpected inside a group survives validation.
      result.groups[name] = {
        keys,
        base: group.base,
        dynamic: group.dynamic,
        reaction: group.reaction,
        color: group.color,
        reactionColor: group.reactionColor,
      };
      // Optional redesign fields (LL-062): per-layer strength 0..1 and Protect. Omitted = previous behavior.
      for (const field of ['baseStrength', 'dynamicStrength', 'reactionStrength']) {
        if (group[field] === undefined || group[field] === null) continue;
        if (
          typeof group[field] !== 'number' ||
          !Number.isFinite(group[field]) ||
          group[field] < 0 ||
          group[field] > 1
        )
          throw new Error(`${name} ${field} must be a number from 0 to 1.`);
        result.groups[name][field] = group[field];
      }
      if (group.protect !== undefined) {
        if (typeof group.protect !== 'boolean') throw new Error(`${name} protect must be true or false.`);
        result.groups[name].protect = group.protect;
      }
    }
    // Groups are authoritative: re-derive the legacy summary fields from them so the two never disagree.
    result.anchors = result.groups.anchor.keys;
    result.protectedAnchors = result.groups.orientation.keys;
    // Background with no motion → 'solid' if lit, 'ghost' (Lights Out) if off; otherwise its dynamic effect.
    result.effect =
      result.groups.background.dynamic === 'none'
        ? result.groups.background.base === 'static'
          ? 'solid'
          : 'ghost'
        : result.groups.background.dynamic;
    result.feedback = result.groups.background.reaction;
    result.keywordFeedback = result.groups.anchor.reaction;
  }
  // `!= null` deliberately treats both null and undefined as "no custom layout".
  if (selection.customLayout != null)
    result.customLayout = KeyboardPlan.layoutForModel('custom', selection.customLayout);
  return result;
}

// Native-profile matching remains conservative: an empty default is not evidence of a saved vendor profile.
/**
 * Kept for older callers. Always false: a selection is never assumed to already exist as a Synapse profile.
 * @returns {false}
 */
function isSavedProfileSelection() {
  return false;
}
/**
 * {red, green, blue} → Chroma BGR integer (0x00BBGGRR). Thin wrapper over Effects.bgr.
 * @param {{red:number,green:number,blue:number}} rgb
 * @returns {number}
 */
function bgr(rgb) {
  return Effects.bgr(rgb);
}
/**
 * Legacy phase input is kept for callers; new animation paths pass explicit elapsed milliseconds.
 *
 * Build the JSON body for Chroma's PUT/POST /keyboard with effect CHROMA_CUSTOM: a 6 x 22 BGR matrix
 * rendered by Effects.frame() — the same renderer the preview uses.
 *
 * @param {string} effect  Legacy effect name (merged into the selection for older callers).
 * @param {string[]} anchors  Anchor switch IDs (merged into the selection for older callers).
 * @param {number} [phase=0]  Old-style animation phase, converted to ms as phase*1000/(180*speed).
 *   Ignored when options.timeMs is given (which every current caller does).
 * @param {object} [options]  The rest of the selection plus:
 *   timeMs        elapsed milliseconds since the session started;
 *   events        recent key presses [{id, at}] (at = ms on the same clock);
 *   feedbackKeys  legacy alternative: switch IDs treated as pressed exactly at `time`.
 * @returns {{effect:'CHROMA_CUSTOM', param:number[][]}}
 */
function createCustomKeyboardFrame(effect, anchors, phase = 0, options = {}) {
  const time = options.timeMs ?? (phase * 1000) / (180 * (options.speed ?? 3.5));
  const events = options.events || [...(options.feedbackKeys || [])].map((id) => ({ id, at: time }));
  return { effect: 'CHROMA_CUSTOM', param: Effects.frame({ ...options, effect, anchors }, time, events) };
}
/**
 * Mouse shares the selected background motion; its generic RGB canvas has 9 rows and 7 columns.
 *
 * Chroma's generic mouse effect CHROMA_CUSTOM2 is a 9 x 7 grid (body, scroll wheel, logo and side
 * strips all live somewhere in it, differently per mouse). Each mouse cell samples the keyboard's
 * background group at a stretched position so motion flows across the mouse like the keyboard:
 *   mouse row 0..8  → keyboard grid row (row * 5 / 8)  = 0..5
 *   mouse col 0..6  → keyboard grid col (col * 21 / 6) = 0..21
 * Reactions are not mirrored (no events are passed).
 *
 * @param {string} effect  Legacy effect name (merged into the selection).
 * @param {number} [phase=0]  Old-style phase; ignored when options.timeMs is set.
 * @param {object} [options]  The selection plus timeMs.
 * @returns {{effect:'CHROMA_CUSTOM2', param:number[][]}}  9 rows x 7 BGR integers.
 */
function createCustomMouseFrame(effect, phase = 0, options = {}) {
  const selection = { ...options, effect },
    time = options.timeMs ?? (phase * 1000) / (180 * (options.speed ?? 3.5));
  // The mouse mirrors the keyboard's BACKGROUND GROUP (base color + motion), not only its motion layer.
  // Sampling only the motion layer made Solid Color / Subtle Keywords / Lights Out send an all-black
  // mouse frame (LL-020). When the background is deliberately dark but anchor keys are lit, the mouse
  // borrows the anchor color so "Noob Deterrent"-style setups still glow on the mouse.
  const groups = Effects.groupsFor(selection);
  const backgroundDark = groups.background.base === 'off' && groups.background.dynamic === 'none';
  const anchorGlow =
    !selection.minimalist &&
    backgroundDark &&
    groups.anchor.keys.length > 0 &&
    groups.anchor.base === 'static'
      ? Effects.parseColor(groups.anchor.color)
      : null;
  const param = Array.from({ length: 9 }, (_, row) =>
    Array.from({ length: 7 }, (_, col) =>
      // sampleAt with no switch ID → the background group (base → dynamic), Keypress-only aware.
      bgr(anchorGlow || Effects.sampleAt(selection, (row * 5) / 8, (col * 21) / 6, time)),
    ),
  );
  return { effect: 'CHROMA_CUSTOM2', param };
}
module.exports = {
  ANCHOR_RGB,
  DEFAULT_ANCHORS,
  EFFECTS,
  PROVIDERS,
  bgr,
  createCustomKeyboardFrame,
  createCustomMouseFrame,
  isSavedProfileSelection,
  validateSelection,
};
