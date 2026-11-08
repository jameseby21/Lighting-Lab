/* =====================================================================================================
 * control-verification.cjs — remembers what a HUMAN saw: "did the real keyboard actually change?"
 *
 * PURPOSE
 *   Persist owner-observed LED results separately from transport acknowledgements.
 *   The Chroma SDK can answer "result: 0 (success)" while the keyboard keeps showing Synapse's own
 *   effect (e.g. Chroma Apps disabled, or another app has priority). So Lighting Lab never treats an
 *   SDK acknowledgement as proof. After Apply, the UI asks "Did your physical keyboard change?" and the
 *   answer ("Yes, I see it" / "No, unchanged") is stored here, per keyboard model and per provider.
 *
 * WHERE IT SITS
 *   server.cjs:
 *     - POST /api/control-verification → record({modelId of the SELECTED keyboard, provider, visible})
 *     - GET  /api/status               → forDevice(modelId) → drives the "Physical lights" readiness
 *       item and the header status ("Lighting confirmed" / "Controller reachable · recheck lights").
 *
 * DISK — <state>/control-verification.json. Example:
 *     {
 *       "version": 1,
 *       "records": {
 *         "razer-blackwidow-elite:chroma-sdk": {
 *           "modelId": "razer-blackwidow-elite", "provider": "chroma-sdk",
 *           "status": "rejected",               // "confirmed" | "rejected"
 *           "observedAt": "2026-10-18T09:12:44.001Z", "source": "owner-observation"
 *         }
 *       }
 *     }
 *   Only the LATEST observation per model+provider is kept (a newer answer overwrites the older one).
 * ===================================================================================================== */
'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
// The only two lighting paths Lighting Lab can drive; anything else is refused before touching disk.
const PROVIDERS = new Set(['chroma-sdk', 'synapse-native']);

/**
 * Create the verification store backed by one JSON file.
 *
 * @param {string} file Absolute path of control-verification.json.
 * @returns {{record:Function, forDevice:Function}}
 */
function createControlVerificationStore(file) {
  /**
   * Read the file, tolerating absence and corruption.
   * @returns {Promise<{version:1, records:object}>} Parsed data, or an empty v1 structure when the file
   *   is missing, unreadable, malformed, or from an unknown version (an observation cache is not worth
   *   blocking the UI over — tests/control-verification.test.cjs covers the corrupt case).
   */
  async function read() {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      return data?.version === 1 && data.records && typeof data.records === 'object'
        ? data
        : { version: 1, records: {} };
    } catch {
      return { version: 1, records: {} };
    }
  }

  /**
   * Record key "<modelId>:<provider>". The model ID is sanitized to letters, digits and dashes so an
   * unexpected value can never produce an odd key.
   * @param {string} modelId core.js model ID (e.g. 'razer-blackwidow-elite').
   * @param {string} provider 'chroma-sdk' | 'synapse-native'.
   * @returns {string}
   */
  function identity(modelId, provider) {
    return `${String(modelId || 'unknown').replace(/[^a-z0-9-]/gi, '_')}:${provider}`;
  }

  /**
   * Store one observation.
   * @param {{modelId:string, provider:string, visible:boolean}} observation `visible:true` = the user
   *   saw the lights change ("confirmed"); `false` = unchanged ("rejected").
   * @returns {Promise<object>} The stored result record.
   * @throws {Error} For an unknown provider or a non-boolean `visible` (e.g. the string "yes").
   * Side effects: creates the parent folder if needed and rewrites the whole JSON file.
   */
  async function record({ modelId, provider, visible }) {
    if (!PROVIDERS.has(provider)) throw new Error('Choose a supported lighting provider.');
    if (typeof visible !== 'boolean') throw new Error('Report whether the physical lights visibly changed.');
    const data = await read(),
      observedAt = new Date().toISOString();
    const result = {
      modelId: String(modelId || 'unknown'),
      provider,
      status: visible ? 'confirmed' : 'rejected',
      observedAt,
      source: 'owner-observation',
    };
    data.records[identity(result.modelId, provider)] = result;
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename (same as app-profiles.cjs): a crash mid-write leaves the previous file intact instead
    // of a truncated one that read() would treat as "no observations at all".
    const temporary = file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fs.rename(temporary, file);
    return result;
  }

  /**
   * Latest observations for one keyboard model, keyed by provider.
   * @param {string} modelId core.js model ID.
   * @returns {Promise<{modelId:string, providers:Object<string, object>}>} `providers` only contains
   *   providers that have an observation; an empty object means "never checked".
   */
  async function forDevice(modelId) {
    const data = await read(),
      providers = {};
    for (const provider of PROVIDERS) {
      const result = data.records[identity(modelId, provider)];
      if (result) providers[provider] = result;
    }
    return { modelId: String(modelId || 'unknown'), providers };
  }
  return { record, forDevice };
}
module.exports = { createControlVerificationStore };
