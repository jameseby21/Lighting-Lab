/* =====================================================================================================
 * app-profiles.cjs — App Profiles rules: "when Code.exe is in front, use my 'Code Focus' lighting".
 *
 * PURPOSE
 *   App Profiles map a condition (an explicitly named Windows executable, or a time of day) to an existing
 *   Lighting Lab profile. This module holds the pure rule logic (validation + "which rule wins?") and a
 *   tiny JSON store. It never looks at running processes itself — that is app-profile-monitor.ps1, driven
 *   by server.cjs (createWindowsAppProbe) — and it never copies lighting settings: a rule only stores the
 *   ID of a profile saved through profiles.cjs.
 *
 * WHERE IT SITS
 *   server.cjs:
 *     - refreshAppProfiles() (every second while the server runs on Windows) loads the config, asks the
 *       probe about the enabled app rules' executables, then calls resolveRule() to pick a candidate;
 *     - /api/app-profiles* routes add, update, toggle, move, delete and test rules through the store.
 *
 * DISK — <state>/app-profiles.json (state defaults to .artifacts/lighting-lab). Example:
 *     {
 *       "version": 1,
 *       "automatic": true,          // master switch ("Automatic switching")
 *       "waitMs": 1000,             // a match must persist this long before switching (debounce)
 *       "transitionMs": 400,        // crossfade length for automatic switches (Chroma provider, LL-061)
 *       "defaultProfileId": null,   // "Everything else" profile, or null = leave lighting as it is
 *       "rules": [
 *         { "id": "5b1d…-uuid", "name": "Code Focus", "executable": "Code.exe",
 *           "condition": "foreground",            // or "running" / "fullscreen"
 *           "profileId": "3f0c…-uuid", "enabled": true },
 *         { "id": "9a2e…-uuid", "name": "Night", "executable": null,
 *           "condition": "time", "from": "23:00", "to": "07:00",   // wraps past midnight
 *           "profileId": "77c1…-uuid", "enabled": true }
 *       ]
 *     }
 *   Writes are atomic: JSON goes to app-profiles.json.tmp first and is then renamed over the real
 *   file, so a crash or power loss mid-write can never leave a half-written config behind.
 *
 * RULE SEMANTICS (ISSUES-LOG LL-060)
 *   Rules are evaluated top to bottom; the FIRST enabled rule whose condition is true AND whose profile
 *   still exists wins. Conditions:
 *     running    - a process with that executable name exists;
 *     foreground - that process owns the window in front;
 *     fullscreen - that process owns the window in front AND the window covers its whole monitor
 *                  (games, presentations, full-screen video); reported by app-profile-monitor.ps1;
 *     time       - the PC's local clock is inside [from, to). No executable. Windows may wrap midnight
 *                  ("23:00"→"07:00"); from === to means "all day".
 *   When nothing matches, the optional defaultProfileId ("Everything else") applies; without one the
 *   lighting is left exactly as it is (never "reset").
 * ===================================================================================================== */
'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
// "running" = any process with that name exists; "foreground" = that process owns the window in front;
// "fullscreen" = it owns the window in front and that window covers its monitor; "time" = clock window.
const CONDITIONS = new Set(['running', 'foreground', 'fullscreen', 'time']);
// The conditions that are about an app (and therefore need an executable name).
const APP_CONDITIONS = new Set(['running', 'foreground', 'fullscreen']);
// A bare executable file name: starts with a letter/digit, then letters, digits, space, dot, underscore
// or dash, ending in .exe (max 128 chars). Commas are deliberately NOT allowed, because server.cjs joins
// rule names with commas into one PowerShell argument. The same pattern is enforced again inside
// app-profile-monitor.ps1, so nothing else can ever reach a child-process command line.
const EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,123}\.exe$/i;
// 24-hour "HH:MM", 00:00 through 23:59.
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
// Rule and profile IDs are UUIDs (crypto.randomUUID shape).
const UUID = /^[a-f0-9-]{36}$/;
// Defaults used when no config file exists yet (fresh install).
const EMPTY = {
  version: 1,
  automatic: true,
  waitMs: 1000,
  transitionMs: 400,
  defaultProfileId: null,
  rules: [],
};

/**
 * Validate one rule. Validate rule data before it reaches storage or a Windows child-process argument.
 *
 * @param {{id?:string, name?:string, executable?:string|null, condition?:string, from?:string, to?:string,
 *   profileId?:string, enabled?:boolean}} [input={}] Rule as sent by the browser or read from disk.
 * @returns {{id:string, name:string, executable:string|null,
 *   condition:'running'|'foreground'|'fullscreen'|'time', from?:string, to?:string,
 *   profileId:string, enabled:boolean}} A clean rule. A missing/invalid `id` gets a fresh UUID (new rule);
 *   `enabled` defaults to true. App rules carry `executable`; time rules carry `executable: null` plus
 *   `from`/`to` ("HH:MM", 24-hour). Fields that do not belong to the condition are dropped, so switching a
 *   rule from an app condition to "time" (or back) through the update route leaves no stale data behind.
 * @throws {Error} For an empty/long name (1–80 chars), an app rule whose executable is not a bare *.exe
 *   name (paths such as C:\Games\game.exe are refused), a time rule without valid HH:MM times, an unknown
 *   condition, or a non-UUID profileId.
 * Note: this does NOT check that the profile exists — server.cjs does that when a rule is added or
 *   updated, and resolveRule() ignores rules whose profile was deleted later.
 */
function normalizeRule(input = {}) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new Error('Give the app rule a name of 1–80 characters.');
  if (!CONDITIONS.has(input.condition))
    throw new Error('Choose Running, In front, Full screen or Time of day for the rule condition.');
  if (typeof input.profileId !== 'string' || !UUID.test(input.profileId))
    throw new Error('Choose a saved Lighting Lab profile.');
  const id = typeof input.id === 'string' && UUID.test(input.id) ? input.id : crypto.randomUUID();
  const enabled = input.enabled !== false;
  if (input.condition === 'time') {
    // Time-of-day rules are about the clock, not an app: no executable is stored (null), only the window.
    const from = String(input.from || '').trim(),
      to = String(input.to || '').trim();
    if (!CLOCK.test(from) || !CLOCK.test(to))
      throw new Error(
        'Give the time rule a start and end time as HH:MM (24-hour), for example 23:00 to 07:00.',
      );
    return { id, name, executable: null, condition: 'time', from, to, profileId: input.profileId, enabled };
  }
  const executable = String(input.executable || '').trim();
  if (!EXECUTABLE.test(executable) || /[\\/]/.test(executable))
    throw new Error('Use an executable file name such as Code.exe, without a path.');
  return { id, name, executable, condition: input.condition, profileId: input.profileId, enabled };
}
/**
 * Validate a whole config. Keep global switching preferences bounded and independent from individual rules.
 *
 * @param {object} [input={}] Config from disk or a merged update.
 * @returns {{version:1, automatic:boolean, waitMs:number, transitionMs:number,
 *   defaultProfileId:string|null, rules:object[]}}
 *   `automatic` is on unless explicitly false; waitMs/transitionMs are rounded and clamped to 0–10 000 ms
 *   (non-numbers fall back to 1000 / 400); defaultProfileId is null or a UUID.
 * @throws {Error} For more than 25 rules, any invalid rule (see normalizeRule), duplicate rule IDs, or a
 *   malformed defaultProfileId.
 */
function normalizeConfig(input = {}) {
  const rawRules = Array.isArray(input.rules) ? input.rules : [];
  // 25 keeps the per-second probe cheap and the PowerShell argument short.
  if (rawRules.length > 25) throw new Error('App Profiles supports up to 25 rules.');
  const ids = new Set(),
    rules = rawRules.map(normalizeRule);
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new Error('Each app rule must have a unique ID.');
    ids.add(rule.id);
  }
  const clamp = (value, fallback) =>
    Math.max(0, Math.min(10_000, Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback));
  // "Everything else" profile: null (leave lighting alone) or a profile UUID. Whether that profile still
  // exists is checked by server.cjs on save and by resolveRule() at switch time.
  const defaultProfileId =
    input.defaultProfileId === undefined || input.defaultProfileId === null || input.defaultProfileId === ''
      ? null
      : input.defaultProfileId;
  if (defaultProfileId !== null && (typeof defaultProfileId !== 'string' || !UUID.test(defaultProfileId)))
    throw new Error('Choose a saved Lighting Lab profile for "Everything else", or none.');
  return {
    version: 1,
    automatic: input.automatic !== false,
    waitMs: clamp(input.waitMs, 1000),
    transitionMs: clamp(input.transitionMs, 400),
    defaultProfileId,
    rules,
  };
}
/**
 * Is a local clock time inside a rule's [from, to) window?
 * @param {string} from "HH:MM"
 * @param {string} to "HH:MM"
 * @param {Date} [now=new Date()] Uses the PC's LOCAL time (what the person sees on their taskbar clock).
 * @returns {boolean} from === to → always true ("all day"); from < to → a same-day window; from > to →
 *   the window wraps midnight, e.g. 23:00→07:00 contains 23:30 and 06:59 but not 07:00 or 12:00.
 */
function timeWindowContains(from, to, now = new Date()) {
  const minutes = (text) => {
    const [hours, mins] = String(text).split(':').map(Number);
    return hours * 60 + mins;
  };
  const start = minutes(from),
    end = minutes(to),
    current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}
/**
 * Pick the rule that should be active right now.
 * First enabled matching rule wins; missing profiles never become automatic switches.
 *
 * @param {{automatic:boolean, rules:object[], defaultProfileId?:string|null}} config A normalized config.
 * @param {Array<{executable:string, running:boolean, foreground:boolean, fullscreen?:boolean}>}
 *   [appStates=[]] Probe results.
 * @param {Set<string>} [profileIds=new Set()] IDs of profiles that currently exist on disk.
 * @param {Date} [now=new Date()] Clock used by time rules (injectable for tests).
 * @returns {object|null} The winning rule; when nothing matches but the default profile exists, the
 *   synthetic rule {id:'default', name:'Everything else', condition:'default', profileId, enabled:true};
 *   otherwise null (automatic off, or nothing matches and no usable default).
 * Pure function. Executable names compare case-insensitively ("code.exe" matches "Code.exe"), like Windows.
 *
 * Example: rules [A: Code.exe foreground → Focus, B: Code.exe running → Calm]. With VS Code open but
 * behind the browser, A fails (not foreground) and B wins → Calm. Bring VS Code to the front → A wins.
 */
function resolveRule(config, appStates = [], profileIds = new Set(), now = new Date()) {
  if (!config.automatic) return null;
  const states = new Map(appStates.map((state) => [String(state.executable || '').toLowerCase(), state]));
  const match = config.rules.find((rule) => {
    if (!rule.enabled || !profileIds.has(rule.profileId)) return false;
    if (rule.condition === 'time') return timeWindowContains(rule.from, rule.to, now);
    const state = states.get(String(rule.executable || '').toLowerCase());
    // state[rule.condition] reads state.running, state.foreground or state.fullscreen.
    return APP_CONDITIONS.has(rule.condition) && Boolean(state?.[rule.condition]);
  });
  if (match) return match;
  // "Everything else" row of the UI: only when it points at a profile that still exists.
  if (config.defaultProfileId && profileIds.has(config.defaultProfileId))
    return {
      id: 'default',
      name: 'Everything else',
      condition: 'default',
      profileId: config.defaultProfileId,
      enabled: true,
    };
  return null;
}
/**
 * Create the config store.
 * A tiny JSON store keeps rules portable, reviewable, and separate from the saved lighting setup files.
 *
 * @param {string} directory State folder; the file is <directory>/app-profiles.json.
 * @returns {{load:Function, save:Function, update:Function}}
 */
function createAppProfileStore(directory) {
  const file = path.join(directory, 'app-profiles.json');
  /**
   * Read and validate the config.
   * @returns {Promise<object>} Normalized config; a fresh copy of the defaults if the file is missing.
   * @throws {Error} If the file exists but is unreadable, not JSON, or fails validation (deliberately
   *   loud: silently replacing a hand-edited config with defaults would lose the user's rules).
   */
  async function load() {
    try {
      return normalizeConfig(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(EMPTY);
      throw error;
    }
  }
  /**
   * Validate and atomically persist a config.
   * @param {object} config Proposed config.
   * @returns {Promise<object>} The normalized config that was written.
   * @throws {Error} On validation or I/O failure (the existing file is untouched in both cases).
   * Side effects: creates the directory; writes app-profiles.json.tmp then renames it over the real file.
   */
  async function save(config) {
    const normalized = normalizeConfig(config);
    await fs.mkdir(directory, { recursive: true });
    // Atomic replace: rename() swaps the complete new file in, so readers see old or new, never partial.
    const temporary = file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(normalized, null, 2), 'utf8');
    await fs.rename(temporary, file);
    return normalized;
  }
  /**
   * Read-modify-write helper used by every /api/app-profiles mutation.
   * @param {(current:object)=>object} change Pure function returning the next config. It may throw to
   *   abort (e.g. "rule not found"); nothing is written in that case.
   * @returns {Promise<object>} The saved, normalized config.
   * Note: not locked across processes; one Lighting Lab server is assumed per state folder.
   */
  async function update(change) {
    const current = await load();
    return save(change(current));
  }
  return { load, save, update };
}
module.exports = {
  CONDITIONS,
  APP_CONDITIONS,
  normalizeRule,
  normalizeConfig,
  resolveRule,
  timeWindowContains,
  createAppProfileStore,
};
