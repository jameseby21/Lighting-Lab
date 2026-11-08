/*
 * =====================================================================================================
 * server.cjs - the local Lighting Lab HTTP server and API boundary
 * =====================================================================================================
 *
 * WHAT THIS FILE IS
 *   A dependency-free Node.js (22+) HTTP server. It serves the browser editor (index.html, ui.js, ...)
 *   and exposes a small JSON API that is the ONLY way the browser can affect hardware. Everything that
 *   talks to a keyboard, mouse, Razer Synapse, PowerShell, or the C# compiler sits behind this file.
 *
 *   Start it with `node server.cjs [--open] [--lan]` or by double-clicking "Start Lighting Lab.cmd".
 *   Tests import createLightingLabServer() instead and inject fake devices, so the real HTTP stack can be
 *   exercised without touching RGB hardware.
 *
 * WHERE IT SITS IN THE ARCHITECTURE
 *
 *     Browser (index.html + ui.js, using core.js/effects.js for the live preview)
 *        |  fetch('/api/...')  (JSON only; same-origin)
 *        v
 *     server.cjs  <-- you are here: validation, audit trail, serialization, routing
 *        |-- providers/chroma-sdk.cjs   live Razer Chroma REST session (frames, reactions, heartbeat)
 *        |-- lighting-domain.cjs        validateSelection(): the single gate for every lighting setup
 *        |-- device-profile.cjs         read-only Windows keyboard identity detection (PowerShell)
 *        |-- profiles.cjs               named saved setups (one JSON file per profile, UUID file names)
 *        |-- app-profiles.cjs           App Profiles rules: "when Code.exe is in front, use profile X"
 *        |-- control-verification.cjs  what the HUMAN said: "yes, my keyboard changed" / "no"
 *        |-- synapse-profile.cjs        optional native Synapse Studio profile build/import/select
 *        |-- export.cjs                 "Download .exe": compiles a portable preset player (csc.exe)
 *        `-- PowerShell helpers         app-profile-monitor.ps1 (which apps run), global-input.ps1
 *                                       (opt-in global key reactions), synapse-control.ps1 (Synapse UI)
 *
 * ROUTE TABLE  (HW = can change physical lighting or start a hardware-facing process)
 *
 *   Method Path                                   HW  Purpose
 *   ------ -------------------------------------- --- -----------------------------------------------
 *   GET    /, /index.html, /ui.js, /core.js,      no  Static allowlist (STATIC map). Nothing else on disk
 *          /effects.js, /layout-guide.js,             is reachable: no directory listing, no traversal.
 *          /styles.css
 *   GET    /api/status                            no  SDK + Synapse availability, detected keyboards,
 *                                                     human verification results, global-input state.
 *   POST   /api/device                            no  Choose which detected keyboard the editor targets
 *                                                     (identity/preview only; Chroma routing is shared).
 *   POST   /api/control-verification             no  Record the human's "did the lights change?" answer.
 *   POST   /api/activity                          no  Privacy-bounded UI action trail (allowlisted keys).
 *   GET    /api/diagnostics                       no  Status + last 100 audit records, for bug reports.
 *   GET    /api/app-profiles                      no  Rules, live app states, saved profiles (+settings), discoveries.
 *   POST   /api/app-profiles/discover             no  User-started list of visible desktop apps.
 *   POST   /api/app-profiles/config               no  Automatic on/off, wait, crossfade, default ("Everything else").
 *   POST   /api/app-profiles                      no  Add an app or time-of-day rule (profile must exist).
 *   POST   /api/app-profiles/:id/toggle|delete|move no Edit one rule.
 *   POST   /api/app-profiles/:id/update           no  Inline edit: name/condition/executable/from/to/profile/enabled.
 *   POST   /api/app-profiles/:id/test             YES Activate that rule's profile right now.
 *   POST   /api/app-profiles/refresh              YES Evaluate rules now; may switch profiles.
 *   GET    /api/profiles[?settings=1]             no  List saved profiles + which controllers can store them.
 *   GET    /api/profiles/:id                      no  One saved profile (full settings).
 *   GET    /api/profiles/:id/archive              no  Download a generated .ChromaEffects (native only).
 *   POST   /api/profiles/:id/load                 YES Activate a saved profile.
 *   POST   /api/profiles/:id/delete               no  Delete a saved profile (+ its native archive).
 *   POST   /api/profiles                          YES Save a new profile, then activate it.
 *   POST   /api/repair                            YES Force a fresh Chroma session, then open/verify
 *                                                     Synapse's Chroma Apps panel via UI automation.
 *   GET    /api/export/capabilities               no  What "Download .exe" can reproduce for a target.
 *   POST   /api/export/executable                 no* Compile and download a preset .exe (*runs csc.exe,
 *                                                     never runs the result).
 *   POST   /api/apply                             YES Send a setup to the keyboard (live edit or Apply).
 *   POST   /api/key-press                         YES Fire one reaction on the live session.
 *   POST   /api/input                             YES Start/stop the opt-in global keyboard listener.
 *   POST   /api/release                           YES End the Chroma session; Synapse resumes control.
 *
 * STATE ON DISK  (default .artifacts/lighting-lab/, override with LIGHTING_LAB_STATE; git-ignored)
 *   audit.jsonl                 Append-only JSON-lines trail of every request that matters. Rotated to
 *   audit.1.jsonl               audit.1.jsonl past 2 MB (AUDIT_MAX_BYTES); one old generation is kept.
 *   profiles/<uuid>.json        Saved profiles. Names are data, never file names.
 *   app-profiles.json           App Profiles rules + preferences (written via temp file + rename).
 *   control-verification.json   Human "lights changed / unchanged" answers per keyboard model + provider.
 *   <uuid>.ChromaEffects        Generated native Synapse archives (native profiles only).
 *
 * SECURITY MODEL  (this server can drive hardware and start PowerShell, so it is deliberately strict)
 *   - Binds 127.0.0.1 by default: only this PC can reach it and Windows shows no firewall prompt.
 *     `--lan` (or LIGHTING_LAB_HOST) opts into every interface for phone/tablet use (LL-012).
 *   - Host header guard (isAllowedHost): blocks DNS-rebinding pages that point a foreign domain at us.
 *   - Origin check: a POST carrying another site's Origin is refused, so other web pages cannot drive
 *     the keyboard even though the API has no login.
 *   - readJson() caps bodies at 128 KB and only accepts a JSON object.
 *   - Static files come from a fixed allowlist of 12 URL paths (7 page files + 5 brand images, see STATIC);
 *     there is no directory serving. Profile IDs and rule IDs must be UUID-shaped before they
 *     touch a path; no browser-supplied string ever becomes a file path or shell text. Child processes
 *     are started with argument arrays (execFile/spawn), never a shell command line.
 *   - Privacy: typed text, key history, window titles and command lines are never stored or returned.
 *
 * THE serialize() INVARIANT
 *   Every operation that can change lighting (apply, profile activation, repair, release, app-profile
 *   switches) runs through serialize(): a single promise chain, so operations finish in the order they
 *   started. A slow older request can therefore never overwrite a newer one, and a failure does not
 *   block the queue (the chain swallows rejections; the caller still sees its own error).
 * =====================================================================================================
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createChromaSdkProvider, APP_TITLE } = require('./providers/chroma-sdk.cjs');
const { validateSelection } = require('./lighting-domain.cjs');
const { detectDevice } = require('./device-profile.cjs');
const { createProfileStore, profileCapabilities } = require('./profiles.cjs');
const { createAppProfileStore, resolveRule, APP_CONDITIONS } = require('./app-profiles.cjs');
const { createControlVerificationStore } = require('./control-verification.cjs');

// ===== Module-level constants =====================================================================

/** The project folder. Static files and PowerShell helpers are resolved relative to this, never to cwd. */
const ROOT = __dirname;
/** audit.jsonl is rotated to audit.1.jsonl once it grows past this many bytes (keeps the trail bounded). */
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Optional folder holding the owner's private native Synapse templates/adapter. It is NOT shipped in the
 * repository; when absent, nativeBridge() falls back to a stub that explains native profiles are unavailable.
 */
const LEGACY = process.env.LIGHTING_LAB_NATIVE_DIRECTORY || path.join(ROOT, 'docs', 'native');
/**
 * The complete list of files the browser may fetch: URL path -> [file in ROOT, Content-Type].
 * Anything not listed here is a 404, which keeps server source, audit logs and backups private.
 */
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/ui.js', ['ui.js', 'text/javascript; charset=utf-8']],
  ['/core.js', ['core.js', 'text/javascript; charset=utf-8']],
  ['/effects.js', ['effects.js', 'text/javascript; charset=utf-8']],
  ['/layout-guide.js', ['layout-guide.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  // Brand assets (header icon, favicon, footer co-branding). Each one is listed explicitly - there is no
  // folder serving, so "/assets/brand/../server.cjs" and any unlisted file stay 404.
  ['/favicon.svg', ['assets/brand/lighting-lab-icon.svg', 'image/svg+xml']],
  ['/assets/brand/lighting-lab-icon.svg', ['assets/brand/lighting-lab-icon.svg', 'image/svg+xml']],
  ['/assets/brand/jebylabs-mark.svg', ['assets/brand/jebylabs-mark.svg', 'image/svg+xml']],
  [
    '/assets/brand/ja-insights-wordmark-dark.png',
    ['assets/brand/ja-insights-wordmark-dark.png', 'image/png'],
  ],
  [
    '/assets/brand/ja-insights-wordmark-light.png',
    ['assets/brand/ja-insights-wordmark-light.png', 'image/png'],
  ],
]);

// ===== Small HTTP helpers =========================================================================

/**
 * Load the optional native Synapse provider from LEGACY, or return a harmless stand-in.
 *
 * Why: the native workflow depends on personal vendor exports that must not be published, so the public
 * repository runs without it. The stand-in reports `available: false` (so the UI greys out native options)
 * and refuses apply() with an actionable message instead of crashing.
 *
 * @returns {{status: () => Promise<object>, apply: (selection: object) => Promise<object>}}
 */
function nativeBridge() {
  try {
    // require() of a path under LEGACY: an env-configured local folder, never browser input.
    return require(path.join(LEGACY, 'providers/synapse-native.cjs')).createSynapseNativeProvider({
      directory: LEGACY,
    });
  } catch {
    // No local native provider: same interface, always "unavailable".
    return {
      status: async () => ({
        available: false,
        uiOpen: false,
        archives: {},
        installed: {},
        guidance: 'Use live Chroma control. Native Studio profiles require a local imported archive.',
      }),
      apply: async () => {
        throw new Error('No local Synapse profile is installed. Choose Chroma SDK live control.');
      },
    };
  }
}

/**
 * Send a JSON response.
 *
 * Headers: `no-store` because every answer describes live hardware state that must never be served from
 * a browser cache; `nosniff` so a browser never reinterprets JSON as script or HTML.
 *
 * @param {http.ServerResponse} response
 * @param {number} status HTTP status code (200, 403, 404, 405, 422...).
 * @param {unknown} body Any JSON-serializable value.
 */
function respond(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

/**
 * Read a request body as one JSON object, with a hard size cap.
 *
 * The cap is enforced WHILE streaming (before buffering everything), so a huge upload cannot exhaust
 * memory. Accepting JSON here does not mean trusting it: each route still validates its own fields, and
 * nothing parsed here is ever used as a file path or shell argument.
 *
 * @param {http.IncomingMessage} request
 * @returns {Promise<object>} The parsed object. An empty body is treated as `{}`.
 * @throws {Error} Over 128 KB, malformed JSON, or a non-object (array, string, null). The request handler
 *   turns any throw into a 422 response.
 */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128_000) throw new Error('Setup exceeds the 128 KB request limit.');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  // Arrays and primitives are valid JSON but never a valid setup; refuse them early.
  if (!result || Array.isArray(result) || typeof result !== 'object')
    throw new Error('Expected a setup object.');
  return result;
}

// ===== App Profiles: Windows process probe =========================================================

/**
 * Normalize one JSON report from app-profile-monitor.ps1 into the shape the rule engine expects.
 *
 * Only the LAST non-empty line is parsed: PowerShell can print warnings or a profile banner first, and the
 * script always prints its JSON report last.
 *
 * @param {string|Buffer} text Raw stdout (one-shot run) or one line (watch mode).
 * @returns {{apps: Array<{executable: string, running: boolean, foreground: boolean}>, checkedAt: string,
 *   scope: string}}
 * @throws {SyntaxError} When the last line is not JSON (callers catch this).
 */
function parseAppReport(text) {
  const report = JSON.parse(String(text).trim().split(/\r?\n/).at(-1));
  return {
    apps: Array.isArray(report.apps) ? report.apps : [],
    checkedAt: report.checkedAt || new Date().toISOString(),
    scope: report.scope || 'configured-rules',
  };
}

/**
 * Windows app probe used by App Profiles.
 *
 * - `probe(names)` answers "is each configured executable running / in front?". To avoid starting a new
 *   powershell.exe every second (~0.5 s CPU each, measured), it keeps ONE long-lived `-Watch` child per
 *   distinct rule set and returns its latest line. Until the watcher's first line arrives (or if it dies),
 *   it falls back to a one-shot run so a caller never waits on a stale answer.
 * - `probe([], {discover: true})` is the user-started "Find running apps" list; always one-shot.
 * - `probe.stop()` kills the watcher on server shutdown.
 *
 * Names travel as ONE comma-joined argument: PowerShell's -File binding drops extra space-separated
 * values for a [string[]] parameter, which previously meant only the first rule was ever checked (LL-010).
 *
 * @param {Function} execFileImpl promisified execFile (injected so tests never start PowerShell).
 * @param {Function} [spawnImpl] child_process.spawn (injected for the same reason).
 * @param {{now?: () => number, staleMs?: number}} [options] Clock and freshness window (3 s: three watcher
 *   ticks may be missed before we stop trusting the cached answer).
 * @returns {Function & {stop: () => void}} The probe function described above.
 */
function createWindowsAppProbe(execFileImpl, spawnImpl = spawn, { now = Date.now, staleMs = 3_000 } = {}) {
  const script = path.join(ROOT, 'app-profile-monitor.ps1');
  // -NoProfile: ignore the user's PowerShell profile (speed + predictability).
  // -ExecutionPolicy Bypass: applies to this one process only; it lets our bundled script run on PCs
  // whose policy blocks unsigned scripts, without changing any machine setting.
  const baseArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  let watcher; // { key, child, latest, at, buffer }
  let stopped = false; // After server shutdown no new watcher may start (an in-flight poll could race it).

  /** Kill the current watcher process (if any) and forget it. Safe to call repeatedly. */
  function stopWatcher() {
    if (watcher?.child && !watcher.child.killed) watcher.child.kill();
    watcher = undefined;
  }

  /**
   * Replace any existing watcher with one that reports on `key` (the sorted, comma-joined rule names).
   * The watcher prints one JSON line per second; we keep only the latest parsed line and its arrival time.
   *
   * @param {string} key e.g. "Code.exe,Spotify.exe". Already validated rule names, so commas are safe.
   */
  function startWatcher(key) {
    stopWatcher();
    // stderr is ignored: the script reports through stdout JSON only, and a full stderr pipe could stall it.
    const child = spawnImpl(
      'powershell.exe',
      [...baseArgs, '-Watch', '-IntervalMs', '1000', '-AppNames', key],
      {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    // `state` is captured by the closures below, so a late event from an OLD watcher can never overwrite
    // the current one (each closure only touches its own state object).
    const state = { key, child, latest: undefined, at: 0, buffer: '' };
    watcher = state;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      // stdout arrives in arbitrary chunks; keep the trailing partial line in `buffer` until it completes.
      state.buffer += chunk;
      const lines = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        try {
          state.latest = parseAppReport(line);
          state.at = now();
        } catch {
          /* A partial or malformed line is skipped; the next tick replaces it. */
        }
      }
    });
    // If the watcher dies (or PowerShell is missing), forget it; the next probe() starts a new one and
    // answers with a one-shot run meanwhile. Only clear it if it is still the CURRENT watcher.
    const ended = () => {
      if (watcher === state) watcher = undefined;
    };
    child.once('error', ended);
    child.once('exit', ended);
  }

  /**
   * Run app-profile-monitor.ps1 once and parse its report.
   * @param {string[]} args Extra script arguments, e.g. ['-Discover'] or ['-AppNames', 'Code.exe'].
   * @returns {Promise<object>} Parsed report (see parseAppReport). Rejects after 5 s.
   */
  async function oneShot(args) {
    const { stdout } = await execFileImpl('powershell.exe', [...baseArgs, ...args], {
      windowsHide: true,
      timeout: 5_000,
    });
    return parseAppReport(stdout);
  }

  /**
   * The probe itself (see the function-level comment above).
   * @param {string[]} executableNames Enabled rule executables, e.g. ['Code.exe'].
   * @param {{discover?: boolean}} [options] discover:true lists visible desktop apps instead.
   * @returns {Promise<object>} Parsed report.
   */
  async function probe(executableNames, { discover = false } = {}) {
    // Discovery is rare and user-started, so it never uses (or disturbs) the watcher.
    if (discover) return oneShot(['-Discover']);
    const names = Array.isArray(executableNames) ? executableNames : [];
    if (names.length === 0) {
      // No rules to watch: release the watcher process instead of idling it.
      stopWatcher();
      return { apps: [], checkedAt: new Date().toISOString(), scope: 'configured-rules' };
    }
    // Sorting + de-duplicating makes the key order-independent, so ['B','A'] reuses the watcher for ['A','B'].
    const key = [...new Set(names)].sort((a, b) => a.localeCompare(b)).join(',');
    if (!stopped && watcher?.key !== key) startWatcher(key);
    // Fresh watcher output is free (no process start). Otherwise fall back to one blocking one-shot run.
    if (watcher?.latest && now() - watcher.at <= staleMs) return watcher.latest;
    return oneShot(['-AppNames', key]);
  }
  /** Permanently stop: kill the watcher and refuse to start another (called by server.shutdown()). */
  probe.stop = () => {
    stopped = true;
    stopWatcher();
  };
  return probe;
}

// ===== Request security helpers ===================================================================

/**
 * DNS-rebinding guard. A malicious web page can point its own domain at 127.0.0.1; the browser then sends
 * that domain in the Host header while treating the request as same-origin. Lighting Lab is only ever
 * opened by IP address, "localhost", or this PC's own name, so any other Host is refused.
 * Extra names can be allowed with LIGHTING_LAB_ALLOWED_HOSTS="name1,name2".
 *
 * @param {string|undefined} hostHeader The raw Host header, e.g. "localhost:4318" or "[::1]:4318".
 * @param {string} [extraHosts] Comma-separated additional hostnames (defaults to the environment variable).
 * @returns {boolean} true when the request may proceed.
 */
function isAllowedHost(hostHeader, extraHosts = process.env.LIGHTING_LAB_ALLOWED_HOSTS || '') {
  if (!hostHeader) return true; // HTTP/1.0 tools (curl --http1.0) omit Host; browsers always send it.
  let hostname;
  try {
    // Let the URL parser split host from port and normalize case/IPv6 brackets instead of hand-parsing.
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false; // Unparseable Host header: refuse rather than guess.
  }
  // An attacker can make a domain RESOLVE to 127.0.0.1, but cannot make the browser send an IP literal or
  // "localhost" as the Host for their own domain - so these are safe to accept.
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[')) return true; // IPv4 / IPv6 literal
  // This PC's own name (e.g. http://DESKTOP-ABC:4318 or DESKTOP-ABC.local from a phone) plus opt-in extras.
  const machine = os.hostname().toLowerCase();
  const allowed = new Set([
    machine,
    `${machine}.local`,
    ...String(extraHosts)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  ]);
  return allowed.has(hostname);
}

// ===== The server factory =========================================================================

/**
 * Build (but do not start) a Lighting Lab HTTP server.
 *
 * Every hardware-facing dependency is a parameter with a real default. Production calls this with no
 * arguments; tests pass fakes so the real HTTP routing, validation, audit and serialization code runs
 * against an in-memory "keyboard". All state lives in this closure, so several servers can run side by
 * side (one per test) without sharing anything.
 *
 * @param {object} [deps]
 * @param {object} [deps.sdk] Live lighting provider: {status, apply, release, keyPress} (chroma-sdk.cjs).
 * @param {object} [deps.synapse] Native Synapse provider: {status, apply} (see nativeBridge()).
 * @param {Function} [deps.detectDeviceImpl] Keyboard identity detection (device-profile.cjs).
 * @param {object} [deps.exporter] export.cjs replacement; loaded lazily when omitted.
 * @param {Function} [deps.spawnImpl] child_process.spawn (global input listener, app watcher).
 * @param {Function} [deps.execFileImpl] promisified execFile (Synapse repair, one-shot app probe).
 * @param {Function} [deps.appProbe] App Profiles probe (see createWindowsAppProbe).
 * @param {string} [deps.platform] Defaults to process.platform; Windows-only features check this.
 * @param {string} [deps.stateDirectory] Where profiles, rules and the audit trail are stored.
 * @returns {http.Server & {shutdown: () => Promise<void>}} Call .listen() to start, .shutdown() to stop
 *   cleanly (stops polling and child processes and releases the Chroma session).
 */
function createLightingLabServer({
  sdk = createChromaSdkProvider(),
  synapse = nativeBridge(),
  detectDeviceImpl = detectDevice,
  exporter,
  spawnImpl = spawn,
  execFileImpl = promisify(execFile),
  appProbe = createWindowsAppProbe(execFileImpl, spawnImpl),
  platform = process.platform,
  stateDirectory = process.env.LIGHTING_LAB_STATE || path.resolve(ROOT, '.artifacts/lighting-lab'),
} = {}) {
  // ----- Persistent stores (files under stateDirectory) -----
  const auditPath = path.join(stateDirectory, 'audit.jsonl');
  const profiles = createProfileStore(path.join(stateDirectory, 'profiles'));
  const appProfileStore = createAppProfileStore(stateDirectory);
  const controlVerification = createControlVerificationStore(
    path.join(stateDirectory, 'control-verification.json'),
  );

  // ----- In-memory runtime state (lost on restart by design) -----
  /** The opt-in global keyboard listener (global-input.ps1) while it runs; undefined when off. */
  let inputProcess;
  /** Partial stdout line from the listener, completed by the next chunk. */
  let inputBuffer = '';
  /** In-flight or last keyboard detection, plus when it started (re-detected at most once per 60 s). */
  let devicePromise;
  let deviceAt = 0;
  /** Which detected keyboard the user picked (POST /api/device). Survives re-detection if still present. */
  let selectedDeviceId;
  /** Latest detection result. Starts as a placeholder so /api/status answers instantly on first load. */
  let deviceValue = {
    model: 'Detecting keyboard',
    modelId: 'standard-full-size',
    source: 'detection-pending',
    recognized: false,
    guidance: 'Checking present Windows keyboard devices; showing a standard full-size view meanwhile.',
  };
  /** Cached Synapse status (refreshed at most every 15 s; it can involve slow UI/process checks). */
  let nativePromise;
  let nativeAt = 0;
  /** Tail of the serialize() queue: every hardware operation chains onto this promise. */
  let pending = Promise.resolve();
  /** The last setup successfully applied (reported by /api/status so the UI and check-live can restore it). */
  let lastSelection = null;
  /**
   * App Profiles runtime:
   *  - appProfileTimer:     the 1 s polling interval (started when the server starts listening, LL-011).
   *  - appSwitchCandidate:  {id, at} the rule that just started matching; it must keep matching for
   *                         config.waitMs before we switch (debounces quick alt-tabs).
   *  - activeAppProfileId:  the rule whose profile is currently applied (cleared when nothing matches).
   */
  let appProfileTimer, appSwitchCandidate, activeAppProfileId;
  // What the App Profiles page shows as "Active now": the rule that last switched the lighting and its profile.
  let activeAppRule = null,
    activeAppProfileName = null;
  /** Result of the last user-started "Find running apps" (names + running/foreground flags only). */
  let discoveredApps = [];
  /** What the App Profiles page shows as "Active now" / "Detected for your rules". */
  let appProfileState = {
    available: platform === 'win32',
    apps: [],
    detail:
      platform === 'win32'
        ? 'No app rules configured.'
        : 'App Profiles requires Windows on the computer running Lighting Lab.',
  };

  // ===== Device detection ==========================================================================

  /**
   * The keyboard the editor is currently targeting, plus the full device list and an honest control scope.
   *
   * The SDK adapter uses one generic keyboard canvas; choosing a device controls identity and preview, not
   * an undocumented HID route. With several keyboards present we therefore say `independentlyAddressable:
   * false`: every compatible Razer keyboard may show the same frame.
   *
   * Resolution order: the user's pick, then detection's recommended default, then the single detection
   * result itself (older detectors return one device without a `devices` list).
   *
   * @returns {object} Device fields + {devices, selectedDeviceId, controlScope}.
   */
  function selectedDevice() {
    const devices = Array.isArray(deviceValue.devices) ? deviceValue.devices : [];
    const selected =
      devices.find((device) => device.id === selectedDeviceId) ||
      devices.find((device) => device.id === deviceValue.selectedDeviceId) ||
      deviceValue;
    // Remember the implicit default so it stays stable even if detection later reorders devices.
    if (!selectedDeviceId && selected?.id) selectedDeviceId = selected.id;
    return {
      ...selected,
      devices,
      selectedDeviceId: selected?.id || null,
      controlScope:
        devices.length > 1
          ? {
              independentlyAddressable: false,
              reason:
                'Lighting Lab currently sends Chroma’s generic keyboard canvas. Select a keyboard for its model, preview, and saved setup; connected compatible keyboards may receive the same SDK frame.',
            }
          : { independentlyAddressable: true, reason: 'One present keyboard identity is selected.' },
    };
  }

  // ===== Core plumbing: export loader, serialization queue, audit trail ===========================

  /**
   * Lazily load export.cjs (or the injected fake). Lazy because export only matters for "Download .exe";
   * browsers without a Windows compiler can still preview and save JSON, and startup stays fast.
   */
  const exportsModule = () => exporter || require('./export.cjs');
  /**
   * Run `operation` after every previously queued operation has settled (see "THE serialize() INVARIANT"
   * in the file header). `.then(operation, operation)` means a failed predecessor does not cancel the
   * next one; `pending` swallows rejections so one error cannot poison the queue, while the returned
   * promise still rejects for its own caller.
   *
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const serialize = (operation) => {
    const result = pending.then(operation, operation);
    pending = result.catch(() => undefined);
    return result;
  };
  /**
   * Append one record to audit.jsonl (with a timestamp), rotating the file first if it is too large.
   *
   * The audit trail is how a confusing hardware report gets diagnosed after the fact: it records what was
   * requested, what was validated, and what the provider answered. It never contains typed text.
   *
   * @param {object} record Usually {event, auditId, ...details}.
   */
  async function audit(record) {
    await fs.mkdir(stateDirectory, { recursive: true });
    // Keep the trail bounded: past AUDIT_MAX_BYTES the current file becomes audit.1.jsonl (one generation kept).
    try {
      if ((await fs.stat(auditPath)).size > AUDIT_MAX_BYTES)
        await fs.rename(auditPath, path.join(stateDirectory, 'audit.1.jsonl'));
    } catch {
      /* No file yet, or a rename raced another write: appending below still works. */
    }
    // One JSON object per line ("JSON Lines"): appendable, greppable, and a torn last line breaks only itself.
    await fs.appendFile(
      auditPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`,
      'utf8',
    );
  }
  /**
   * The newest audit records, oldest first, for /api/diagnostics.
   * @param {number} [limit=100] Clamped to 1..500.
   * @returns {Promise<object[]>} [] when there is no audit file yet (or it cannot be parsed).
   */
  async function recentAudit(limit = 100) {
    const count = Math.max(1, Math.min(500, limit));
    const linesOf = async (file) => {
      try {
        return (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
      } catch {
        return [];
      }
    };
    // Right after a rotation the current file is nearly empty, so top up from the previous generation.
    let lines = await linesOf(auditPath);
    if (lines.length < count)
      lines = [...(await linesOf(path.join(stateDirectory, 'audit.1.jsonl'))), ...lines];
    return lines.slice(-count).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return []; // A torn last line (crash mid-append) must not hide every other record.
      }
    });
  }
  /**
   * Sanitize a browser "activity" record before it is written to the audit trail.
   *
   * UI telemetry is local, bounded, and deliberately excludes typed text, notes, and key history: only an
   * allowlisted set of detail keys survives, and string values must be short and made of safe characters
   * (no free text can slip through as a value).
   *
   * @param {{action?: string, detail?: object}} input Raw POST body.
   * @returns {{action: string, detail: object}}
   * @throws {Error} When `action` is not a short lowercase kebab-case identifier (becomes a 422).
   */
  function normalizeClientActivity(input = {}) {
    const action = String(input.action || '').trim();
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(action)) throw new Error('Invalid local activity action.');
    // Every key the UI is allowed to report. Anything else (e.g. a "note") is silently dropped.
    const allowed = new Set([
      'control',
      'effect',
      'model',
      'provider',
      'state',
      'outcome',
      'category',
      'rating',
      'mode',
      'force',
    ]);
    const detail = {};
    for (const [key, value] of Object.entries(input.detail || {})) {
      if (!allowed.has(key)) continue;
      if (typeof value === 'boolean' || typeof value === 'number') detail[key] = value;
      // Strings: <=120 chars of letters, digits, space and _.:#- only (enough for "#ff0033" or "rainbow-road").
      else if (typeof value === 'string' && value.length <= 120 && /^[ A-Za-z0-9_.:#-]+$/.test(value))
        detail[key] = value;
    }
    return { action, detail };
  }

  // ===== Global key feedback (opt-in, Windows only) ================================================

  /**
   * Stop the global keyboard listener, if running.
   * @returns {{enabled: false}} The new state, returned directly to the browser.
   */
  function disableInput() {
    if (inputProcess && !inputProcess.killed) inputProcess.kill();
    inputProcess = undefined;
    inputBuffer = '';
    return { enabled: false };
  }
  /**
   * Start global-input.ps1: a low-level keyboard hook that prints one `{"key":"Q"}` line per physical key
   * press anywhere in Windows, so reactions also fire while you type in other apps.
   *
   * Privacy: the helper emits switch identities only (never characters or text). Each line is forwarded
   * straight to sdk.keyPress() and then dropped; nothing is buffered beyond the current partial line,
   * stored, or audited. The listener is memory-only and stops with the server (and is off after restart).
   *
   * @returns {{enabled: true}} Idempotent: calling it while already running starts nothing new.
   * @throws {Error} On non-Windows platforms.
   */
  function enableInput() {
    if (platform !== 'win32') throw new Error('Global key feedback currently requires Windows.');
    if (inputProcess && !inputProcess.killed) return { enabled: true };
    const child = spawnImpl(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'global-input.ps1')],
      { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    inputProcess = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      // Same line-assembly pattern as the app watcher: keep the unfinished tail for the next chunk.
      inputBuffer += chunk;
      const lines = inputBuffer.split(/\r?\n/);
      inputBuffer = lines.pop() || '';
      for (const line of lines) {
        try {
          // Fire-and-forget: a rejected reaction (no live session yet) must not crash the listener.
          sdk.keyPress(JSON.parse(line).key).catch(() => undefined);
        } catch {
          /* Typed content is never included in diagnostics or the audit trail. */
        }
      }
    });
    // If the helper exits on its own (crash, PowerShell missing), report "off" instead of a stale "on".
    const ended = () => {
      if (inputProcess === child) {
        inputProcess = undefined;
        inputBuffer = '';
      }
    };
    child.once('error', ended);
    child.once('exit', ended);
    return { enabled: true };
  }

  // ===== Status, apply and profile activation ======================================================

  /**
   * Everything the UI polls (every 8 s) to draw its connection badge, device picker and Ready check.
   *
   * Speed matters because this is polled: the Chroma check is a single fast local HTTP call, Synapse status
   * is cached for 15 s, and keyboard detection (a PowerShell PnP walk that can take seconds) runs at most
   * every 60 s IN THE BACKGROUND - the answer uses whatever detection result is already known.
   *
   * @returns {Promise<object>} {sdk, synapse, device, controlVerification, input, selection}
   */
  async function status() {
    const sdkStatus = await sdk.status();
    const now = Date.now();
    // 15 s cache: Synapse status is slow-changing and can be expensive to query.
    if (!nativePromise || now - nativeAt > 15_000) {
      nativeAt = now;
      nativePromise = synapse.status().catch((error) => ({ available: false, error: error.message }));
    }
    const nativeStatus = await nativePromise;
    // 60 s window: keyboards are rarely hot-plugged, and the PnP ancestry walk is the slowest call here.
    // `devicePromise` doubles as an in-flight guard, so concurrent polls never start overlapping probes.
    // Note: it is deliberately NOT awaited below.
    if (!devicePromise || now - deviceAt > 60_000) {
      deviceAt = now;
      devicePromise = detectDeviceImpl({
        sdkAvailable: sdkStatus.available,
        synapseAvailable: nativeStatus.available,
      })
        .then((device) => {
          deviceValue = device;
          // Keep the user's pick if that keyboard is still present; otherwise adopt detection's default.
          if (!selectedDeviceId || !(device.devices || []).some((item) => item.id === selectedDeviceId))
            selectedDeviceId = device.selectedDeviceId;
          return device;
        })
        .catch((error) => {
          // Keep the last known identity but say clearly that detection is unavailable right now.
          deviceValue = {
            ...deviceValue,
            source: 'detection-unavailable',
            recognized: false,
            guidance: `Automatic detection was unavailable: ${error.message}`,
          };
        });
    }
    // Windows ancestry queries can take seconds. Keep live controls responsive while they finish.
    const device = selectedDevice();
    return {
      sdk: sdkStatus,
      synapse: nativeStatus,
      device,
      // Human answers are keyed by keyboard MODEL + provider, so they survive restarts and re-plugging.
      controlVerification: await controlVerification.forDevice(device.modelId || 'standard-full-size'),
      input: {
        enabled: Boolean(inputProcess && !inputProcess.killed),
        privacy: 'Key identities stay in memory. No typed text or key history is saved.',
      },
      selection: lastSelection,
    };
  }
  /**
   * Validate a setup and hand it to the chosen provider. Callers must run this inside serialize().
   *
   * - provider 'chroma-sdk': live Chroma session. `force: true` (the Apply button, profile loads, repair)
   *   drops and re-registers the session and uses Chroma's create -> SetEffect path; `force: false` (live
   *   edits while you drag sliders) just updates the existing session, which is much smoother.
   * - provider 'synapse-native': hands the setup to the native provider, then releases the live session so
   *   Synapse's own profile can show (otherwise our live frames would keep overriding it).
   *
   * The result is an SDK *acknowledgement*, not proof the LEDs changed; the UI asks the human to confirm.
   *
   * @param {object} body Raw request body (may include `force`).
   * @param {string} auditId Correlates the audit records of this one request.
   * @returns {Promise<{ok: true, auditId: string, result: object}>}
   * @throws {Error} Validation or provider failure (the handler audits it and answers 422).
   */
  async function apply(body, auditId, { transitionMs = 0 } = {}) {
    // validateSelection() is the single gate: unknown effects, providers, switch IDs or colors throw here,
    // before any provider sees the data.
    const selection = validateSelection(body);
    await audit({ event: 'apply-validated', auditId, selection });
    const previousSelection = lastSelection;
    let result;
    if (selection.provider === 'synapse-native') {
      // Explicit native mode must not silently substitute a different effect or control path.
      result = await synapse.apply(selection);
      await sdk.release();
    }
    // Only a literal true forces. transitionMs > 0 only comes from automatic App Profile switches (crossfade).
    else result = await sdk.apply(selection, { force: body.force === true, transitionMs });
    lastSelection = selection; // Only after success: a failed apply must not be reported as current.
    await audit({ event: 'apply-completed', auditId, previousSelection, result });
    return { ok: true, auditId, result };
  }

  /**
   * Make a saved profile the current lighting. Callers must run this inside serialize().
   *
   * - Lighting Lab profiles replay their saved settings through apply() on the live Chroma session.
   * - Native Synapse profiles: make sure the .ChromaEffects archive exists (build it if needed - this is
   *   also where an unsupported setup fails, BEFORE we give up the live session), release the live session,
   *   then ask Synapse (UI automation) to select the profile by name.
   *
   * @param {object} saved A profile record from profiles.cjs ({id, name, software, settings}).
   * @param {string} auditId
   * @param {{force?: boolean}} [options] force:false lets automatic App Profile switches reuse the session.
   * @returns {Promise<object>} apply() result, or the native load result + an archive download URL.
   */
  async function activateProfile(saved, auditId, { force = true, transitionMs = 0 } = {}) {
    // Whatever provider was active when the profile was saved, Lighting Lab profiles play via Chroma.
    if (saved.software !== 'synapse-native')
      return apply({ ...saved.settings, provider: 'chroma-sdk', force }, auditId, { transitionMs });
    // Loaded lazily: only native-profile users need the Synapse adapter.
    const native = require('./synapse-profile.cjs');
    // File name comes from the profile's server-generated UUID, never from its user-chosen name.
    const archive = path.join(stateDirectory, saved.id + '.ChromaEffects');
    try {
      await fs.access(archive);
    } catch {
      // No archive yet (e.g. state folder copied without it): rebuild it without importing.
      await native.saveNativeProfile(saved, { directory: stateDirectory, buildOnly: true });
    }
    // Unsupported/native-template failures are discovered before giving up the current live session.
    await sdk.release();
    lastSelection = { ...saved.settings, provider: 'synapse-native' };
    const loaded = await native.loadNativeProfile(saved, { directory: stateDirectory });
    return { ...loaded, archiveDownloadUrl: '/api/profiles/' + saved.id + '/archive' };
  }

  // ===== App Profiles: rule evaluation and polling =================================================

  /**
   * Evaluate App Profiles rules once and, when allowed, switch profiles.
   *
   * Resolve configured app rules locally, then reuse normal profile activation and its audit trail.
   *
   * State machine for one matching rule (all within this function, one call per poll):
   *   1. A rule starts matching            -> remember it as appSwitchCandidate {id, at}; report "waiting".
   *   2. It still matches after waitMs     -> activate its profile (serialized), mark it active.
   *   3. It is already the active rule      -> nothing to do (no re-apply every second).
   *   4. Nothing matches any more           -> forget candidate AND active rule; lighting stays as it is.
   *
   * @param {{allowSwitch?: boolean}} [options] allowSwitch:false (page reads, rule edits) only reports state;
   *   it never changes lighting. The 1 s poller and POST /api/app-profiles/refresh use allowSwitch:true.
   * @returns {Promise<{config: object, runtime: object}>} The saved config and the live state for the UI.
   */
  async function refreshAppProfiles({ allowSwitch = true } = {}) {
    const config = await appProfileStore.load();
    // Only enabled APP rules are probed (time rules have no executable); duplicates are probed once.
    const names = [
      ...new Set(
        config.rules
          .filter((rule) => rule.enabled && APP_CONDITIONS.has(rule.condition) && rule.executable)
          .map((rule) => rule.executable),
      ),
    ];
    // Time rules and the "Everything else" default are evaluated even with zero app rules (LL-060).
    const hasWork = config.rules.some((rule) => rule.enabled) || Boolean(config.defaultProfileId);
    if (platform !== 'win32') {
      appProfileState = {
        available: false,
        apps: [],
        detail: 'App Profiles requires Windows on the computer running Lighting Lab.',
      };
      return { config, runtime: appProfileState };
    }
    // Automatic switching off, or nothing to evaluate: do not even start PowerShell.
    if (!config.automatic || !hasWork) {
      appSwitchCandidate = undefined;
      appProfileState = {
        available: true,
        apps: [],
        activeRule: null,
        activeProfileName: null,
        detail: config.automatic ? 'No enabled app rules configured.' : 'Automatic switching is off.',
      };
      return { config, runtime: appProfileState };
    }
    try {
      // Re-shape the probe report into exactly one entry per rule name (case-insensitive, like Windows),
      // with strict booleans: a missing app is simply "not running, not in front, not full screen".
      // With only time rules / a default profile, PowerShell is not started at all.
      const report = names.length ? await appProbe(names) : { apps: [], checkedAt: new Date().toISOString() },
        apps = names.map((executable) => {
          const found =
            (report.apps || []).find(
              (item) => String(item.executable).toLowerCase() === executable.toLowerCase(),
            ) || {};
          return {
            executable,
            running: found.running === true,
            foreground: found.foreground === true,
            fullscreen: found.fullscreen === true,
          };
        });
      // resolveRule: first enabled rule (top to bottom) whose condition matches AND whose profile still
      // exists; otherwise the "Everything else" default profile (synthetic rule id 'default'), or null.
      const summaries = await profiles.list(),
        candidate = resolveRule(config, apps, new Set(summaries.map((profile) => profile.id)));
      appProfileState = {
        available: true,
        apps,
        checkedAt: report.checkedAt || new Date().toISOString(),
        candidateId: candidate?.id || null,
        activeId: activeAppProfileId || null,
        activeRule: activeAppRule,
        activeProfileName: activeAppProfileName,
        detail: candidate ? `Matched ${candidate.name}.` : 'No configured app rule currently matches.',
      };
      if (!allowSwitch || !candidate) {
        appSwitchCandidate = undefined;
        // Nothing matches any more (the app closed or lost focus). Lighting deliberately stays as it is, but we
        // forget which rule was active so that coming BACK to that app applies its profile again - even if the
        // user changed the lighting by hand in between.
        if (allowSwitch && !candidate) {
          activeAppProfileId = undefined;
          activeAppRule = null;
          activeAppProfileName = null;
        }
        return {
          config,
          runtime: {
            ...appProfileState,
            activeId: activeAppProfileId || null,
            activeRule: activeAppRule,
            activeProfileName: activeAppProfileName,
          },
        };
      }
      // Step 3: already applied - never re-apply every second (it would fight manual edits and flicker).
      if (activeAppProfileId === candidate.id) return { config, runtime: appProfileState };
      // Step 1: a new rule just started matching; start its waitMs countdown.
      if (appSwitchCandidate?.id !== candidate.id) {
        appSwitchCandidate = { id: candidate.id, at: Date.now() };
        appProfileState.detail = `Matched ${candidate.name}; waiting ${config.waitMs} ms before switching.`;
        return { config, runtime: appProfileState };
      }
      // Still inside the wait window: keep waiting (the next poll checks again).
      if (Date.now() - appSwitchCandidate.at < config.waitMs) return { config, runtime: appProfileState };
      // Step 2: the match held for waitMs - switch. Audited like any other profile activation.
      const saved = await profiles.load(candidate.profileId),
        auditId = crypto.randomUUID();
      await audit({
        event: 'app-profile-switch-started',
        auditId,
        ruleId: candidate.id,
        profileId: saved.id,
      });
      // Automatic switches reuse the live Chroma session (force:false) so alt-tabbing does not re-register the
      // app with Synapse each time, which can flash the keyboard. Manual Test/Load still force a fresh session.
      // They also crossfade over the configured transitionMs ("Crossfade between profiles", LL-061).
      const loaded = await serialize(() =>
        activateProfile(saved, auditId, { force: false, transitionMs: config.transitionMs }),
      );
      activeAppProfileId = candidate.id;
      activeAppRule = {
        id: candidate.id,
        name: candidate.name,
        condition: candidate.condition,
        profileId: candidate.profileId,
      };
      activeAppProfileName = saved.name;
      appProfileState = {
        ...appProfileState,
        activeId: candidate.id,
        activeRule: activeAppRule,
        activeProfileName: activeAppProfileName,
        detail: `Active: ${candidate.name} → ${saved.name}.`,
      };
      await audit({
        event: 'app-profile-switched',
        auditId,
        ruleId: candidate.id,
        profileId: saved.id,
        loaded,
      });
    } catch (error) {
      // Probe or activation failed (PowerShell blocked, profile file unreadable, SDK refused...). Report it
      // on the App Profiles page instead of throwing: the poller must keep running and retry next second.
      appProfileState = {
        ...appProfileState,
        available: false,
        detail: `App Profile check failed: ${error.message}`,
      };
    }
    return { config, runtime: appProfileState };
  }
  /** True while a poll's refreshAppProfiles() is still running (prevents overlapping polls). */
  let appPollInFlight = false;
  /**
   * Start the 1 s App Profiles poller once (idempotent; Windows only).
   *
   * Started when the server begins listening (LL-011) and again defensively by rule/config edits. The timer
   * is unref()'d so it never keeps the Node process alive on its own.
   */
  function ensureAppProfilePolling() {
    if (appProfileTimer || platform !== 'win32') return;
    appProfileTimer = setInterval(() => {
      // A profile activation can take longer than one tick; never stack overlapping checks.
      if (appPollInFlight) return;
      appPollInFlight = true;
      refreshAppProfiles()
        .catch(() => undefined)
        .finally(() => {
          appPollInFlight = false;
        });
    }, 1000);
    appProfileTimer.unref?.();
  }

  // ===== The request handler =======================================================================
  //
  // One async handler, routes checked top to bottom. Conventions used by every route:
  //   - A route that can change hardware or saved state gets an `auditId` (UUID) BEFORE doing work, so any
  //     failure is recorded as `operation-failed` against the same ID in the catch block at the bottom.
  //   - Any thrown Error becomes HTTP 422 {ok:false, auditId, error} - the message is written for people.
  //   - Hardware changes go through serialize().

  const server = http.createServer(async (request, response) => {
    let auditId;
    try {
      // The base URL is a placeholder: only pathname/searchParams are used; the real host is in headers.
      const url = new URL(request.url, 'http://lighting-lab.local');

      // ----- Security gates (apply to every request, including static files) -----
      if (!isAllowedHost(request.headers.host)) {
        return respond(response, 403, {
          error:
            'Open Lighting Lab by localhost, IP address, or this PC name (see LIGHTING_LAB_ALLOWED_HOSTS).',
        });
      }
      // LAN access remains available; arbitrary other websites cannot issue browser mutations.
      // Browsers attach Origin to cross-site POSTs; if it is present it must match the host being addressed.
      // (No Origin = a non-browser client such as the check scripts, which is allowed.)
      const origin = request.headers.origin;
      // "Origin: null" (sandboxed iframe, file:// page) cannot be parsed as a URL; treat it as foreign (403)
      // instead of letting `new URL` throw into a confusing 422.
      const originHost = (() => {
        try {
          return new URL(origin).host;
        } catch {
          return null;
        }
      })();
      if (request.method === 'POST' && origin && originHost !== request.headers.host) {
        return respond(response, 403, { error: 'Open Lighting Lab directly to change this setup.' });
      }

      // ===== Status and device selection =====

      // GET /api/status - polled by the UI every 8 s; read-only.
      if (request.method === 'GET' && url.pathname === '/api/status')
        return respond(response, 200, await status());
      // POST /api/device {id} - choose which present keyboard the editor describes (identity/preview/
      // verification key). Only IDs from the latest detection are accepted.
      if (request.method === 'POST' && url.pathname === '/api/device') {
        const body = await readJson(request),
          devices = Array.isArray(deviceValue.devices) ? deviceValue.devices : [];
        const selected = devices.find((device) => device.id === body.id);
        if (!selected) throw new Error('Choose a currently present keyboard.');
        selectedDeviceId = selected.id;
        auditId = crypto.randomUUID();
        await audit({ event: 'device-selected', auditId, deviceId: selected.id, modelId: selected.modelId });
        return respond(response, 200, { device: selectedDevice() });
      }
      // ===== Human verification, activity trail and diagnostics =====

      // POST /api/control-verification {provider, visible} - the "Yes, I see it" / "No, unchanged" buttons.
      // Kept separate from SDK results on purpose: an SDK "OK" does not prove the LEDs changed.
      if (request.method === 'POST' && url.pathname === '/api/control-verification') {
        const body = await readJson(request);
        auditId = crypto.randomUUID();
        // Audit the raw payload first, so even a rejected (malformed) observation leaves a trace.
        await audit({ event: 'control-verification-started', auditId, requestedPayload: body });
        // Record against the SAME keyboard that /api/status reports (the selected one), not the first detected.
        const result = await controlVerification.record({
          modelId: selectedDevice().modelId || 'standard-full-size',
          provider: body.provider,
          visible: body.visible,
        });
        await audit({ event: 'control-verification-recorded', auditId, result });
        return respond(response, 200, { ok: true, result });
      }
      // POST /api/activity {action, detail} - sanitized UI action trail (see normalizeClientActivity).
      // No auditId: these are high-volume breadcrumbs, not operations that can fail half-way.
      if (request.method === 'POST' && url.pathname === '/api/activity') {
        const activity = normalizeClientActivity(await readJson(request));
        await audit({ event: 'client-action', activity });
        return respond(response, 200, { ok: true });
      }
      // GET /api/diagnostics - the "Download diagnostics" button: status + recent audit, for bug reports.
      if (request.method === 'GET' && url.pathname === '/api/diagnostics') {
        return respond(response, 200, {
          createdAt: new Date().toISOString(),
          status: await status(),
          recentAudit: await recentAudit(100),
          recordScope:
            'Lighting Lab records local UI actions, requests, provider results, and feedback metadata. It excludes typed text, feedback notes, window titles, command lines, and key history.',
          deferredIssues: ['LAN client timeout and browser chromweb/401 reports: not yet diagnosed.'],
        });
      }
      // ===== App Profiles =====

      // GET /api/app-profiles - everything the App Profiles page draws. Read-only (allowSwitch:false).
      if (request.method === 'GET' && url.pathname === '/api/app-profiles') {
        const state = await refreshAppProfiles({ allowSwitch: false });
        return respond(response, 200, {
          config: state.config,
          runtime: state.runtime,
          // Full settings so the page can draw keyboard thumbnails of each saved profile (LL-060).
          profiles: await profiles.list({ includeSettings: true }),
          discoveries: discoveredApps,
        });
      }
      // POST /api/app-profiles/discover - "Find running apps": a user-started list of visible desktop apps
      // so people can pick "Code.exe" instead of guessing executable names.
      if (request.method === 'POST' && url.pathname === '/api/app-profiles/discover') {
        if (platform !== 'win32')
          throw new Error('Running-app discovery requires Windows on the computer running Lighting Lab.');
        const report = await appProbe([], { discover: true });
        // Defensive re-shaping: at most 40 entries, strict booleans, only string names reach the browser.
        discoveredApps = (report.apps || [])
          .filter((app) => typeof app.executable === 'string')
          .slice(0, 40)
          .map((app) => ({
            executable: app.executable,
            running: app.running === true,
            foreground: app.foreground === true,
            fullscreen: app.fullscreen === true,
          }));
        auditId = crypto.randomUUID();
        // Only the COUNT is audited - the list of apps someone runs is nobody's business but theirs.
        await audit({
          event: 'app-profile-discovery',
          auditId,
          count: discoveredApps.length,
          scope: report.scope || 'visible-desktop-apps',
        });
        const state = await refreshAppProfiles({ allowSwitch: false });
        return respond(response, 200, {
          config: state.config,
          runtime: state.runtime,
          // Full settings so the page can draw keyboard thumbnails of each saved profile (LL-060).
          profiles: await profiles.list({ includeSettings: true }),
          discoveries: discoveredApps,
        });
      }
      // POST /api/app-profiles/config {automatic, waitMs, transitionMs, defaultProfileId?} - switching
      // preferences. app-profiles.cjs normalizes/clamps the values (0..10 000 ms) when saving.
      // defaultProfileId ("Everything else"): omitted = unchanged, null = none, a UUID = that saved profile,
      // which must exist right now (LL-060).
      if (request.method === 'POST' && url.pathname === '/api/app-profiles/config') {
        const body = await readJson(request);
        const changesDefault = Object.hasOwn(body, 'defaultProfileId');
        if (changesDefault && body.defaultProfileId !== null && body.defaultProfileId !== '')
          await profiles.load(body.defaultProfileId);
        const config = await appProfileStore.update((current) => ({
          ...current,
          automatic: body.automatic ?? current.automatic,
          waitMs: body.waitMs ?? current.waitMs,
          transitionMs: body.transitionMs ?? current.transitionMs,
          defaultProfileId: changesDefault ? body.defaultProfileId || null : current.defaultProfileId,
        }));
        ensureAppProfilePolling();
        const state = await refreshAppProfiles({ allowSwitch: false });
        return respond(response, 200, {
          config,
          runtime: state.runtime,
          profiles: await profiles.list({ includeSettings: true }),
        });
      }
      // POST /api/app-profiles {name, condition, profileId, executable | from+to} - add a rule at the bottom.
      // App rules (running/foreground/fullscreen) need an executable; time rules need from/to "HH:MM".
      if (request.method === 'POST' && url.pathname === '/api/app-profiles') {
        const body = await readJson(request);
        // The rule must point at a profile that exists right now (throws a friendly error otherwise).
        // The rule body itself is validated by normalizeRule() inside appProfileStore.update().
        await profiles.load(body.profileId);
        const config = await appProfileStore.update((current) => ({
          ...current,
          rules: [...current.rules, body],
        }));
        ensureAppProfilePolling();
        const state = await refreshAppProfiles({ allowSwitch: false });
        return respond(response, 200, {
          config,
          runtime: state.runtime,
          profiles: await profiles.list({ includeSettings: true }),
        });
      }
      // POST /api/app-profiles/:ruleId/(toggle|delete|move|test|update) - per-rule actions.
      // The ID must be UUID-shaped (36 chars of hex and dashes) before it is even looked up.
      //   update {name?, condition?, executable?, from?, to?, profileId?, enabled?} - inline editing from the
      //   rules table (LL-060). Fields are merged into the stored rule and the result re-validated as a whole,
      //   so e.g. switching to "time" requires from/to and drops the executable.
      const appProfileRoute = url.pathname.match(
        /^\/api\/app-profiles\/([a-f0-9-]{36})\/(toggle|delete|move|test|update)$/,
      );
      if (request.method === 'POST' && appProfileRoute) {
        const [, ruleId, action] = appProfileRoute,
          body = await readJson(request),
          current = await appProfileStore.load(),
          index = current.rules.findIndex((rule) => rule.id === ruleId);
        if (index < 0) throw new Error('Choose a saved app rule.');
        // "Test": apply this rule's profile now, regardless of which apps are running (force:true default).
        if (action === 'test') {
          const saved = await profiles.load(current.rules[index].profileId);
          auditId = crypto.randomUUID();
          const loaded = await serialize(() => activateProfile(saved, auditId));
          await audit({ event: 'app-profile-tested', auditId, ruleId, profileId: saved.id, loaded });
          return respond(response, 200, { profile: saved, loaded });
        }
        // A changed target profile must exist right now (friendly "no longer exists" error otherwise).
        if (action === 'update' && body.profileId !== undefined) await profiles.load(body.profileId);
        // Edit a copy of the rule list; the store validates and writes it atomically (temp file + rename).
        // `index` was found before update() re-loads the file - fine for a single local user.
        const config = await appProfileStore.update((config) => {
          const rules = [...config.rules];
          // Re-find the rule in the freshly loaded config: an index computed before this read could point at
          // a different rule if another tab changed the list in between.
          const index = rules.findIndex((rule) => rule.id === ruleId);
          if (index < 0) throw new Error('Choose a saved app rule.');
          if (action === 'toggle') rules[index] = { ...rules[index], enabled: body.enabled !== false };
          if (action === 'update') {
            // Only these fields may change; the id stays. normalizeRule() (inside save) re-validates the merge.
            const changes = {};
            for (const field of ['name', 'condition', 'executable', 'from', 'to', 'profileId', 'enabled'])
              if (body[field] !== undefined) changes[field] = body[field];
            rules[index] = { ...rules[index], ...changes, id: rules[index].id };
          }
          if (action === 'delete') rules.splice(index, 1);
          // Move one step up/down, clamped at the ends. Rule order = priority (first match wins).
          if (action === 'move') {
            const target = Math.max(
              0,
              Math.min(rules.length - 1, index + (body.direction === 'up' ? -1 : 1)),
            );
            const [rule] = rules.splice(index, 1);
            rules.splice(target, 0, rule);
          }
          return { ...config, rules };
        });
        ensureAppProfilePolling();
        const state = await refreshAppProfiles({ allowSwitch: false });
        return respond(response, 200, {
          config,
          runtime: state.runtime,
          profiles: await profiles.list({ includeSettings: true }),
        });
      }
      // POST /api/app-profiles/refresh - "Check now": evaluate rules immediately and allow a switch.
      if (request.method === 'POST' && url.pathname === '/api/app-profiles/refresh') {
        const state = await refreshAppProfiles();
        return respond(response, 200, state);
      }

      // ===== Saved profiles =====

      // GET /api/profiles?effect=&feedback= - list profiles, plus which controllers could store THIS setup
      // (the native Synapse option is disabled for effects it cannot represent).
      if (request.method === 'GET' && url.pathname === '/api/profiles')
        return respond(response, 200, {
          // Lightweight by default; ?settings=1 adds each profile's full settings (thumbnails).
          profiles: await profiles.list({ includeSettings: url.searchParams.get('settings') === '1' }),
          controllers: profileCapabilities(
            { effect: url.searchParams.get('effect'), feedback: url.searchParams.get('feedback') },
            Boolean((await synapse.status()).available),
          ),
        });
      // /api/profiles/:id[/(load|archive|delete)] - one saved profile. The UUID-shaped ID is the only part
      // of the URL that ever becomes a file name (and profiles.cjs re-checks it).
      const profileRoute = url.pathname.match(
        /^\/api\/profiles\/([a-f0-9-]{36})(?:\/(load|archive|delete))?$/,
      );
      if (profileRoute) {
        // Loading first means every sub-route answers "no longer exists" consistently for unknown IDs.
        const saved = await profiles.load(profileRoute[1]);
        // POST .../delete - remove the profile (and its native archive, if any).
        if (request.method === 'POST' && profileRoute[2] === 'delete') {
          auditId = crypto.randomUUID();
          await audit({ event: 'profile-delete-started', auditId, profileId: saved.id, name: saved.name });
          await profiles.remove(saved.id);
          // A generated native archive belongs to this profile only; remove it too (missing is fine).
          await fs.rm(path.join(stateDirectory, saved.id + '.ChromaEffects'), { force: true });
          // App rules that pointed here stay visible as "Missing saved profile" so the user can re-point them;
          // resolveRule already refuses to switch to a profile that no longer exists.
          await audit({ event: 'profile-deleted', auditId, profileId: saved.id });
          return respond(response, 200, { ok: true, deleted: saved.id, profiles: await profiles.list() });
        }
        // GET /api/profiles/:id - the full record (used by the UI to restore an editable setup).
        if (request.method === 'GET' && !profileRoute[2]) return respond(response, 200, saved);
        // GET .../archive - download the generated .ChromaEffects for manual import into Synapse Studio.
        if (request.method === 'GET' && profileRoute[2] === 'archive') {
          if (saved.software !== 'synapse-native')
            return respond(response, 404, { error: 'This profile belongs to the Lighting Lab engine.' });
          const bytes = await fs.readFile(path.join(stateDirectory, saved.id + '.ChromaEffects'));
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="Lighting-Lab-' + saved.id + '.ChromaEffects"',
            'cache-control': 'no-store',
          });
          return response.end(bytes);
        }
        // POST .../load - activate the profile (forced fresh session for Lighting Lab profiles).
        if (request.method === 'POST' && profileRoute[2] === 'load') {
          auditId = crypto.randomUUID();
          await audit({ event: 'profile-load-started', auditId, requestedPayload: saved });
          const loaded = await serialize(() => activateProfile(saved, auditId));
          await audit({ event: 'profile-loaded', auditId, profileId: saved.id, loaded });
          return respond(response, 200, { profile: saved, loaded });
        }
      }
      // POST /api/profiles {name, software, settings} - save a NEW profile, then activate it.
      if (request.method === 'POST' && url.pathname === '/api/profiles') {
        const body = await readJson(request);
        auditId = crypto.randomUUID();
        await audit({ event: 'profile-save-started', auditId, requestedPayload: body });
        // save() validates the settings and writes <uuid>.json; a bad setup throws here (422).
        const saved = await profiles.save(body);
        let loaded, activationError;
        try {
          loaded = await serialize(() => activateProfile(saved, auditId));
        } catch (error) {
          // The profile IS saved even if the keyboard could not be reached right now - report both facts
          // (200 + activationError) rather than a failure that would make people save it twice.
          activationError = error.message;
        }
        await audit({
          event: 'profile-saved',
          auditId,
          profileId: saved.id,
          software: saved.software,
          loaded,
          activationError,
        });
        return respond(response, 200, { profile: saved, loaded, activationError });
      }
      // ===== Repair =====

      // POST /api/repair <setup> - "Retry Chroma Connection":
      //   1. Force a brand-new Chroma session with the current setup (re-registers the app).
      //   2. Drive Synapse's UI (synapse-control.ps1 -Action Repair) to open the Chroma Apps panel, switch the
      //      master toggle and this app ON if they are off, and READ BACK their state.
      // The answer never claims the lights changed (physicalLightingVerified:false); only the human can.
      if (request.method === 'POST' && url.pathname === '/api/repair') {
        const body = await readJson(request);
        auditId = crypto.randomUUID();
        await audit({ event: 'repair-started', auditId, requestedPayload: body });
        const applied = await serialize(() =>
          apply({ ...body, provider: 'chroma-sdk', force: true }, auditId),
        );
        let controlState, openError, openFailure;
        try {
          // 40 s timeout: Synapse may need to start and render its window before automation can find it.
          const { stdout } = await execFileImpl(
            'powershell.exe',
            [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              path.join(ROOT, 'synapse-control.ps1'),
              '-Action',
              'Repair',
              '-AppTitle',
              APP_TITLE,
            ],
            { windowsHide: true, timeout: 40000 },
          );
          controlState = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); // Last line = the JSON report.
        } catch (error) {
          // Short first line for the UI; the complete stderr/stdout goes to the audit trail for diagnosis.
          openError = String(error.stderr || error.message)
            .trim()
            .split(/\r?\n/)[0]
            .slice(0, 600);
          openFailure = {
            message: error.message,
            stderr: error.stderr,
            stdout: error.stdout,
            code: error.code,
          };
        }
        // "Opened" means the panel was actually read back - starting the Synapse process is not enough.
        const opened = controlState?.connectPanelVerified === true;
        await audit({
          event: 'repair-completed',
          auditId,
          opened,
          openError,
          openFailure,
          controlState,
          applied,
        });
        return respond(response, 200, {
          opened,
          openError,
          controlState,
          applied,
          physicalLightingVerified: false,
          detail: opened
            ? controlState.detail
            : `SDK session restarted, but Synapse Connect could not be verified: ${openError || 'no panel readback'}. Physical control remains unresolved.`,
        });
      }
      // ===== Live lighting and export =====

      // GET /api/export/capabilities?model=&effect= - can "Download .exe" reproduce this, and how exactly?
      // Pure calculation in export.cjs; never probes or touches a device.
      if (request.method === 'GET' && url.pathname === '/api/export/capabilities') {
        return respond(
          response,
          200,
          await exportsModule().getExportCapabilities(url.searchParams.get('model') || 'standard-full-size', {
            effect: url.searchParams.get('effect') || 'rainbow-road',
          }),
        );
      }
      // POST /api/apply <setup> [+ force:true] - the main hardware path. The UI calls it for live edits
      // (force false, coalesced to the latest edit) and for the Apply button (force true).
      if (request.method === 'POST' && url.pathname === '/api/apply') {
        const body = await readJson(request);
        auditId = crypto.randomUUID();
        // Capture unvalidated settings before any provider, compiler, or child process runs.
        // Why before validation: when a setup is REJECTED, the audit still shows exactly what was asked
        // for, which is the evidence needed to understand "I clicked Apply and nothing happened".
        await audit({ event: 'apply-started', auditId, requestedPayload: body });
        return respond(response, 200, await serialize(() => apply(body, auditId)));
      }
      // POST /api/export/executable <setup> + {exportModel, acceptApproximation} - compile and download a
      // portable preset player. The server compiles (csc.exe) but NEVER runs the produced .exe.
      if (request.method === 'POST' && url.pathname === '/api/export/executable') {
        const body = await readJson(request);
        auditId = crypto.randomUUID();
        await audit({ event: 'export-started', auditId, requestedPayload: body });
        const selection = validateSelection(body);
        // AL65 firmware export is a whole-board approximation; the user must explicitly accept that loss.
        if (body.exportModel === 'yunzii-al65' && body.acceptApproximation !== true)
          throw new Error('Confirm the AL65 built-in whole-board lighting option before exporting.');
        // {...body, ...selection}: keep every extra field the user sent (embedded verbatim for --inspect),
        // but let the validated values win for anything validateSelection() normalized.
        const built = await exportsModule().createPresetExecutable(
          { ...body, ...selection },
          { targetModel: body.exportModel || 'auto', acceptApproximation: body.acceptApproximation === true },
        );
        await audit({
          event: 'export-completed',
          auditId,
          filename: built.filename,
          sha256: crypto.createHash('sha256').update(built.bytes).digest('hex'),
          manifest: built.manifest,
        });
        // Header-safe download name: basename only, and nothing that could break the quoted header value.
        const filename = path.basename(built.filename).replace(/[^A-Za-z0-9_.-]/g, '-');
        response.writeHead(200, {
          'content-type': 'application/vnd.microsoft.portable-executable',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        });
        return response.end(built.bytes);
      }
      // POST /api/key-press {key} - fire one reaction from a key pressed IN THE BROWSER (preview typing).
      // Not audited and not serialized: reactions are frequent, tiny, and the provider queues them itself.
      if (request.method === 'POST' && url.pathname === '/api/key-press') {
        const body = await readJson(request);
        // Global capture already forwards the same key; prevent doubled reactive events.
        // (With global input on, typing in the browser would otherwise trigger every reaction twice:
        // once from the Windows hook and once from the page.)
        if (inputProcess && !inputProcess.killed)
          return respond(response, 200, { accepted: false, reason: 'global input owns feedback' });
        return respond(response, 200, await sdk.keyPress(String(body.key || '')));
      }
      // POST /api/input {enabled} - turn the opt-in global keyboard listener on or off.
      // Only the on/off state is audited, never any key.
      if (request.method === 'POST' && url.pathname === '/api/input') {
        const body = await readJson(request),
          result = body.enabled ? enableInput() : disableInput();
        auditId = crypto.randomUUID();
        await audit({ event: 'global-input-changed', auditId, enabled: result.enabled });
        return respond(response, 200, result);
      }
      // POST /api/release - "Return to Synapse": end our Chroma session so Synapse's own effect resumes.
      // Serialized so it cannot be overtaken by an apply that was queued before it.
      if (request.method === 'POST' && url.pathname === '/api/release') {
        const result = await serialize(() => sdk.release());
        lastSelection = null;
        return respond(response, 200, result);
      }

      // ===== Static files and fallthrough =====

      // Only the STATIC allowlist is served. Files are re-read on every request (no cache) so editing the
      // UI and reloading the page just works during development.
      if (request.method === 'GET' && STATIC.has(url.pathname)) {
        const [filename, mime] = STATIC.get(url.pathname);
        const content = await fs.readFile(path.join(ROOT, filename));
        response.writeHead(200, {
          'content-type': mime,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return response.end(content);
      }
      // Unknown GET -> 404; any other unknown method/path -> 405.
      respond(response, request.method === 'GET' ? 404 : 405, { error: 'Not found.' });
    } catch (error) {
      // One error path for every route: record the failure against the request's auditId (if it had one),
      // then answer 422 with a human-readable message. Audit failures here are swallowed so a full disk
      // cannot turn a clear error into a hung request.
      if (auditId)
        await audit({ event: 'operation-failed', auditId, error: error.message }).catch(() => undefined);
      if (!response.headersSent) respond(response, 422, { ok: false, auditId, error: error.message });
      else response.end(); // Headers already sent (mid-download): just close the response.
    }
  });
  // Saved App Profile rules must keep working after a reboot without anyone opening the App Profiles page,
  // so polling starts with the server (previously it only started after a settings change - LL-011).
  server.once('listening', () => ensureAppProfilePolling());
  /**
   * Clean shutdown (Ctrl+C, SIGTERM, or a test's teardown), in dependency order:
   * stop polling -> kill the app watcher -> stop the global key listener -> release the Chroma session
   * (queued behind any in-flight apply, so we never release mid-write) -> stop accepting connections.
   * Releasing matters: it hands the keyboard back to Synapse instead of leaving a frozen last frame.
   */
  server.shutdown = async () => {
    if (appProfileTimer) clearInterval(appProfileTimer);
    appProbe.stop?.(); // Optional chaining: injected test probes may not have stop().
    disableInput();
    await serialize(() => sdk.release()).catch(() => undefined);
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  };
  return server;
}

// ===== Command-line startup helpers ===============================================================

/**
 * Open a URL in the user's default browser without a shell string (no quoting/injection surface).
 *
 * Windows uses `cmd /c start "" <url>` (the empty "" is start's window-title argument, required so the
 * URL is not mistaken for a title). Failures only print the URL; the server keeps running regardless.
 *
 * @param {string} url
 * @param {{platform?: string, spawnImpl?: Function}} [options] Injectable for tests.
 */
function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  // The URL is built from our own host + port, but it is about to become part of a command line, so only
  // plain URL characters are accepted; anything else just prints the address for the user to click.
  if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+\/?$/.test(url)) {
    console.log(`Open ${url} in your browser.`);
    return;
  }
  // Windows: `start` needs an empty "" title argument before the URL. Passing '""' as a normal argv element
  // made Node escape it to "\"\"" (verified with `echo`), giving start a garbage title. With verbatim
  // arguments cmd receives exactly:  start "" "http://localhost:4318"
  const [command, args, extra] =
    platform === 'win32'
      ? ['cmd.exe', [`/d /s /c "start "" "${url}""`], { windowsVerbatimArguments: true }]
      : platform === 'darwin'
        ? ['open', [url], {}]
        : ['xdg-open', [url], {}];
  try {
    // detached + unref: the browser must not be tied to (or keep alive) the server process.
    const child = spawnImpl(command, args, { stdio: 'ignore', detached: true, windowsHide: true, ...extra });
    child.on?.('error', () => console.log(`Open ${url} in your browser.`));
    child.unref?.();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

/**
 * True when something answering like Lighting Lab already owns the port (second double-click case).
 *
 * "Like Lighting Lab" = /api/status returns JSON with both `sdk` and `device` keys. Any other program on
 * the port (or a timeout after 1.5 s) yields false, so we print the "port is used by another program" hint.
 *
 * @param {string} url Base URL such as "http://127.0.0.1:4318".
 * @returns {Promise<boolean>}
 */
async function isLightingLabAt(url) {
  try {
    const response = await fetch(url + '/api/status', { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return Boolean(body && 'sdk' in body && 'device' in body);
  } catch {
    return false;
  }
}

/**
 * Command-line entry point (`node server.cjs [--open] [--lan]`).
 *   --open  open the editor in the default browser once the server is really listening.
 *   --lan   listen on every network interface so a phone/tablet on the same Wi-Fi can use the editor.
 * Environment: LIGHTING_LAB_PORT (default 4318), LIGHTING_LAB_HOST (overrides --lan), LIGHTING_LAB_STATE.
 *
 * The default bind is 127.0.0.1 (this PC only). Binding 0.0.0.0 makes Windows Defender Firewall show an
 * "allow access" prompt on first run and exposes keyboard control to everyone on the network, which is the
 * wrong default for a tool anyone can download (LL-012). LAN use is one flag away.
 *
 * @param {string[]} [argv] Command-line flags (defaults to the real process arguments).
 * @returns {http.Server} The listening (or failed-to-listen) server.
 */
function startLightingLab(argv = process.argv.slice(2)) {
  const open = argv.includes('--open');
  const lan = argv.includes('--lan');
  const server = createLightingLabServer();
  // LIGHTING_LAB_PORT=0 asks the OS for any free port (the launcher test uses this).
  const port = Number(process.env.LIGHTING_LAB_PORT || 4318);
  const host = process.env.LIGHTING_LAB_HOST || (lan ? '0.0.0.0' : '127.0.0.1');
  // "Wildcard" = listening on every interface (IPv4 or IPv6 any-address).
  const wildcard = host === '0.0.0.0' || host === '::';
  // The URL a PERSON should open: "localhost" is friendlier than 127.0.0.1 or 0.0.0.0.
  const localUrl = `http://${wildcard || host === '127.0.0.1' ? 'localhost' : host}:${port}`;
  // Listen failures arrive as an 'error' event, not an exception.
  server.on('error', async (error) => {
    if (error.code === 'EADDRINUSE') {
      // The most common "it didn't start" report is simply a second launch. Detect that and be helpful.
      if (await isLightingLabAt(`http://127.0.0.1:${port}`)) {
        console.log(`Lighting Lab is already running at ${localUrl} - using that copy.`);
        if (open) openBrowser(localUrl);
        // Exit 0: from the user's point of view nothing failed. Nothing else keeps this process alive
        // (the poller only starts on 'listening'), so it exits by itself.
        process.exitCode = 0;
        return;
      }
      console.error(
        `Port ${port} is used by another program. Close it, or start Lighting Lab on another port:\n` +
          `  set LIGHTING_LAB_PORT=4319 && node server.cjs --open`,
      );
    } else console.error(`Lighting Lab could not listen on ${host}:${port}: ${error.message}`);
    process.exitCode = 1;
  });
  // Probe BEFORE binding (LL-065). Windows lets a new 127.0.0.1:4318 listener coexist with an older copy that
  // bound 0.0.0.0:4318 (the pre-0.3.0 default), so EADDRINUSE never fires and two Lighting Labs end up streaming
  // frames to the same keyboard - which shows up as stutters and skipped Matrix rows. If anything on this port
  // already answers like Lighting Lab, reuse it instead of starting a second copy.
  const listen = () => server.listen(port, host, onListening);
  if (port === 0) listen();
  else
    isLightingLabAt(`http://127.0.0.1:${port}`).then((running) => {
      if (!running) return listen();
      console.log(
        `Lighting Lab is already running at ${localUrl} - using that copy. (To restart it, close its window first.)`,
      );
      if (open) openBrowser(localUrl);
      process.exitCode = 0;
    });
  function onListening() {
    // With port 0 the real port is only known now; patch it into the friendly URL.
    const boundPort = server.address().port;
    const url = localUrl.replace(`:${port}`, `:${boundPort}`);
    // First line: the exact bound address (tests and scripts parse it). Second: the friendly URL for people.
    console.log(
      `Lighting Lab: http://${wildcard ? 'localhost' : host}:${boundPort}${wildcard ? ' (all network interfaces)' : ''}`,
    );
    console.log(
      `Open ${url} in your browser. Keep this window open while you use Lighting Lab; Ctrl+C stops it.`,
    );
    if (wildcard) {
      // Print every non-loopback IPv4 address so a phone user can type one in. (Printing an address does
      // not prove it is reachable: Windows Firewall or Wi-Fi client isolation can still block it.)
      for (const entries of Object.values(os.networkInterfaces()))
        for (const address of entries || []) {
          if (address.family === 'IPv4' && !address.internal)
            console.log(`LAN: http://${address.address}:${boundPort}  (phones/tablets on the same network)`);
        }
    } else console.log('Tip: start with --lan to use the editor from a phone on the same Wi-Fi.');
    if (open) openBrowser(url);
  }
  // Ctrl+C in the launcher window (SIGINT) or a service manager (SIGTERM): release the keyboard first,
  // then exit, so Synapse gets control back instead of a frozen last frame.
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      server.shutdown().finally(() => process.exit(0));
    });
  return server;
}

// Run only when executed directly (`node server.cjs`); tests `require()` this file without starting it.
if (require.main === module) startLightingLab();
// Public surface: the factory and CLI entry point, plus helpers exported for focused unit tests.
module.exports = {
  createLightingLabServer,
  startLightingLab,
  createWindowsAppProbe,
  isAllowedHost,
  openBrowser,
};
