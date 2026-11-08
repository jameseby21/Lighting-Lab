/* =====================================================================================================
 * profiles.cjs — named, loadable lighting profiles ("Save as Profile" / "Load Profile" / "Delete").
 *
 * PURPOSE
 *   Stores complete editor setups under a human name so they can be re-applied later — by the user
 *   or automatically by App Profiles (app-profiles.cjs rules point at these profile IDs).
 *   Named profiles stay in the chosen controller; a JSON download ("Export Setup JSON") is a separate,
 *   browser-only operation and never goes through this file.
 *
 * WHERE IT SITS
 *   server.cjs creates one store with createProfileStore(<state>/profiles) and serves:
 *     GET  /api/profiles                → list() + profileCapabilities()
 *     POST /api/profiles                → save()   (then activates it)
 *     GET  /api/profiles/<id>           → load()
 *     POST /api/profiles/<id>/load      → load()   (then activates it)
 *     POST /api/profiles/<id>/delete    → remove()
 *   synapse-profile.cjs uses profileCapabilities() to refuse setups Synapse Studio cannot represent.
 *
 * DISK
 *   One file per profile: <state>/profiles/<uuid>.json (state defaults to .artifacts/lighting-lab,
 *   override with LIGHTING_LAB_STATE). Example:
 *     {
 *       "id": "3f0c6a8e-6f0b-4d4e-9d7e-2b1a6c9e0f11",
 *       "name": "Code Focus",
 *       "software": "lighting-lab",              // or "synapse-native"
 *       "updatedAt": "2026-10-20T14:02:11.512Z",
 *       "settings": { "format": "lighting-lab-effect-v1", "effect": "matrix", "groups": {...}, ... }
 *     }
 *   `settings` keeps EVERY field the editor sent (words, legends, custom layout, broken keys, …) with
 *   the validated fields from validateSelection() layered on top, so loading restores the full editor.
 *
 * SECURITY
 *   Profile NAMES never touch the file system. File names are random UUIDs generated here, and every
 *   ID coming back from the browser must match a strict UUID shape before it is joined into a path —
 *   "../../somewhere" can never escape the profiles directory (tests/profiles.test.cjs checks this).
 * ===================================================================================================== */
'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { validateSelection } = require('./lighting-domain.cjs');

/**
 * Which controllers can store this setup, and how faithfully.
 * The local RGB engine can preserve every setting; native support is deliberately per effect.
 *
 * @param {object} [selection={}] Partial or full setup; only effect/feedback/groups/mouseSync/aliases
 *   are inspected (the browser sends just effect + feedback as query parameters).
 * @param {boolean} [nativeAvailable=false] Whether a local Synapse native-profile template exists.
 * @returns {Array<{id:string, label:string, available:boolean, exact:boolean, reason:string}>}
 *   Always two entries: 'lighting-lab' (always available and exact) and 'synapse-native' (exact only
 *   for static/keyword colors with white Reactive or no reaction, no animated groups, no mouse sync and
 *   no lighting substitutes — the subset the BlackWidow Elite Studio template can express).
 * Pure function: no I/O.
 */
function profileCapabilities(selection = {}, nativeAvailable = false) {
  // Any group with motion or a non-white-fade reaction cannot be expressed as a native Studio layer.
  const advancedGroups =
    selection.groups &&
    Object.values(selection.groups).some(
      (group) => group && (group.dynamic !== 'none' || !['none', 'reactive'].includes(group.reaction)),
    );
  return [
    {
      id: 'lighting-lab',
      label: 'Lighting Lab (full setup)',
      available: true,
      exact: true,
      reason: 'Stores a named profile here and loads it into the live lighting engine. No download.',
    },
    {
      id: 'synapse-native',
      label: 'Razer Synapse Studio',
      available: nativeAvailable,
      exact:
        ['solid', 'ghost', 'subtle-keywords'].includes(selection.effect) &&
        ['none', 'reactive'].includes(selection.feedback || 'reactive') &&
        ['none', 'reactive'].includes(selection.keywordFeedback ?? selection.feedback ?? 'reactive') &&
        !advancedGroups &&
        !selection.mouseSync &&
        Object.keys(selection.inputAliases || {}).length === 0,
      reason: nativeAvailable
        ? 'Native static colors and white Reactive are supported. Custom animated modes, Ripple/Waterfall, mouse sync, and alternate input triggers need the Lighting Lab engine.'
        : 'No local native Synapse export template is available. Choose Lighting Lab for the full setup.',
    },
  ];
}

/**
 * Create a profile store rooted at `directory`.
 * Use generated IDs, never profile names, as file paths; all original editor settings survive.
 *
 * @param {string} directory Absolute folder for <uuid>.json files (created on first write/list).
 * @returns {{list:Function, save:Function, load:Function, remove:Function}}
 */
function createProfileStore(directory) {
  /**
   * Summaries of every saved profile, newest first.
   * @param {{includeSettings?:boolean}} [options] includeSettings adds each profile's full `settings`
   *   (used by App Profiles to draw keyboard thumbnails; the default stays lightweight - LL-060).
   * @returns {Promise<Array<{id:string, name:string, software:string, updatedAt:string, settings?:object}>>}
   * Side effect: creates the directory if missing. Malformed files are skipped, never fatal.
   */
  async function list({ includeSettings = false } = {}) {
    await fs.mkdir(directory, { recursive: true });
    const profiles = [];
    // Only UUID-looking JSON files count; native archives (*.ChromaEffects) and stray files are ignored.
    for (const file of await fs.readdir(directory))
      if (/^[a-f0-9-]+\.json$/.test(file)) {
        try {
          const p = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
          const summary = { id: p.id, name: p.name, software: p.software, updatedAt: p.updatedAt };
          if (includeSettings) summary.settings = p.settings;
          profiles.push(summary);
        } catch {
          /* A malformed local file cannot prevent the remaining profiles loading. */
        }
      }
    // ISO timestamps sort correctly as strings; descending = most recently saved first.
    return profiles.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /**
   * Validate and store a NEW profile (saving the same name twice creates two profiles).
   *
   * @param {{name:string, settings:object, software?:'lighting-lab'|'synapse-native'}} input
   * @returns {Promise<object>} The stored record including its new `id`.
   * @throws {Error} For a missing/too-long name (1–80 characters), an unknown controller, or settings
   *   that fail validateSelection() (unknown effect, unknown switch IDs, bad colors, …).
   * Side effect: writes <directory>/<uuid>.json. The 'wx' flag refuses to overwrite an existing file,
   *   so a (practically impossible) UUID collision could never destroy another profile.
   */
  async function save({ name, settings, software = 'lighting-lab' }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80)
      throw new Error('Give the profile a name of 1–80 characters.');
    if (!['lighting-lab', 'synapse-native'].includes(software))
      throw new Error('Choose a supported profile controller.');
    const normalized = validateSelection(settings),
      id = crypto.randomUUID();
    const record = {
      id,
      name: name.trim(),
      software,
      updatedAt: new Date().toISOString(),
      // Keep the editor's extra fields (words, legends, layout…) but let validated values win.
      settings: { ...settings, ...normalized },
    };
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, id + '.json'), JSON.stringify(record, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return record;
  }

  /**
   * IDs are the only thing that ever becomes a file name, and only after this strict UUID-shape check.
   * @param {string} id Profile ID from the browser or an App Profile rule.
   * @returns {string} Absolute path of that profile's JSON file.
   * @throws {Error} 'Choose a saved profile.' for anything that is not 36 hex/dash characters.
   */
  function fileFor(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Choose a saved profile.');
    return path.join(directory, id + '.json');
  }

  /**
   * Read one full profile record.
   * @param {string} id Profile UUID.
   * @returns {Promise<object>} The record exactly as stored.
   * @throws {Error} Friendly "no longer exists" for a missing file; other I/O or JSON errors as-is.
   */
  async function load(id) {
    try {
      return JSON.parse(await fs.readFile(fileFor(id), 'utf8'));
    } catch (error) {
      // Never surface "ENOENT ... D:\path\..." to the browser; it is neither helpful nor private.
      if (error.code === 'ENOENT')
        throw new Error('That saved profile no longer exists. Choose another one.');
      throw error;
    }
  }

  /**
   * Delete one saved profile. Deleting a profile that is already gone is reported, not silently ignored.
   * @param {string} id Profile UUID.
   * @returns {Promise<void>}
   * @throws {Error} Friendly "no longer exists" when the file is already gone; other I/O errors as-is.
   * Side effect: unlinks the JSON file. (server.cjs separately removes any generated native archive.)
   */
  async function remove(id) {
    try {
      await fs.unlink(fileFor(id));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('That saved profile no longer exists.');
      throw error;
    }
  }
  return { list, save, load, remove };
}
module.exports = { profileCapabilities, createProfileStore };
