/* =====================================================================================================
 * providers/chroma-sdk.cjs — the live Razer Chroma SDK provider ("Chroma SDK · live effects").
 *
 * PURPOSE
 *   Owns exactly ONE live lighting session with Razer's locally installed Chroma SDK REST service and
 *   streams per-key frames to it. Everything Lighting Lab shows on a real Razer keyboard in "live" mode
 *   goes through this file.
 *
 * WHERE IT SITS
 *   server.cjs creates one provider with createChromaSdkProvider() and calls:
 *     - apply(selection, {force})  for /api/apply, profile loads and App Profile switches,
 *     - keyPress(id)               for /api/key-press and the opt-in global keyboard hook,
 *     - status()                   for /api/status (polled by the browser every ~8 s),
 *     - release()                  for /api/release ("Return to Synapse") and on server shutdown.
 *   Frames are produced by lighting-domain.cjs (createCustomKeyboardFrame / createCustomMouseFrame),
 *   which wraps effects.js — the SAME renderer the browser preview uses, so preview == keyboard.
 *
 * DISK
 *   Nothing. The session lives only in memory; lighting stops when Lighting Lab stops (see PERSISTENCE).
 *
 * EXTERNAL SYSTEM: the Razer Chroma SDK REST service (installed with Razer Synapse), lifecycle:
 *   1. Register:   POST http://localhost:54235/razer/chromasdk  {title, description, author, ...}
 *                  → {"sessionid": 123, "uri": "http://localhost:<new port>/chromasdk"}
 *                  The SDK opens a brand-new listener on a new port for this session.
 *   2. Heartbeat:  PUT  <uri>/heartbeat   at least every ~1.5 s here. The SDK drops a session that has
 *                  been silent for roughly 15 s, after which the keyboard returns to Synapse's effect.
 *   3. Frames:     PUT  <uri>/keyboard {effect:"CHROMA_CUSTOM", param: 6 rows × 22 cols of BGR ints}
 *                  (BGR = red | green<<8 | blue<<16). Mouse: PUT <uri>/mouse {effect:"CHROMA_CUSTOM2",
 *                  param: 9 rows × 7 cols}.
 *   4. Explicit Apply ("force"): POST <uri>/keyboard creates a stored effect and returns {id}; then
 *                  PUT <uri>/effect {id} activates it. This documented create → SetEffect path is used
 *                  after a fresh registration to make Lighting Lab the visible owner again.
 *   5. Release:    DELETE <uri>  unregisters; Synapse resumes its own saved lighting.
 *   Docs: https://assets.razerzone.com/dev_portal/REST/html/index.html
 *
 * ORDERING GUARANTEE
 *   All SDK writes (settings changes, animation frames, key-press frames, release) go through ONE
 *   promise queue, enqueue(). A slow HTTP request therefore can never let an older frame or older
 *   setting land after a newer one.
 *
 * TESTABILITY
 *   fetch, timers, sleep and clock are injectable, so tests/engine.test.cjs drives animation, stale
 *   sessions and failures without any Razer hardware.
 * ===================================================================================================== */
'use strict';
const { createCustomKeyboardFrame, createCustomMouseFrame } = require('../lighting-domain.cjs');
const Plan = require('../core.js');
const Effects = require('../effects.js');
// Preserve the vendor registration identity; rebranding the editor must not create a different app.
// Synapse lists Chroma apps by this exact title in its "Chroma Apps" panel, and the user's enable/priority
// choices are stored against it. synapse-control.ps1 (Repair / check-connect) also looks it up by name.
// Changing this string would silently create a "new" app that is disabled or low-priority by default.
const APP_TITLE = 'Jeby Lighting Lab';
// Reported verbatim by status() so the UI can explain that live effects are not saved to the keyboard.
// Animation pacing. The tick is fast (23 ms) but cheap: identical frames are skipped, so a request only goes out
// when the picture changes, and changed frames are at least MIN_FRAME_GAP_MS apart (~25 fps cap). Measured
// before this change (46 ms tick, every frame + mouse + heartbeat sent): Matrix rows stayed lit 141-302 ms
// instead of 230 ms (ISSUES-LOG LL-055).
const TICK_MS = 23;
// Longest allowed crossfade between profiles (App Profiles "Crossfade between profiles" slider max).
const MAX_TRANSITION_MS = 10_000;

/**
 * Per-cell linear blend of two Chroma BGR integer matrices (keyboard 6x22 or mouse 9x7).
 * @param {number[][]} from  Frame of the OLD selection.
 * @param {number[][]} to    Frame of the NEW selection, same shape.
 * @param {number} t         0 = all old, 1 = all new.
 * @returns {number[][]}
 */
function blendMatrices(from, to, t) {
  return to.map((row, r) =>
    row.map((target, c) => {
      const source = from[r]?.[c] ?? 0;
      let out = 0;
      for (let shift = 0; shift <= 16; shift += 8) {
        const a = (source >> shift) & 255,
          b = (target >> shift) & 255;
        out |= Math.round(a + (b - a) * t) << shift;
      }
      return out;
    }),
  );
}
const MIN_FRAME_GAP_MS = 40;
const PERSISTENCE = {
  kind: 'temporary-session',
  survivesLightingLabShutdown: false,
  requiresLightingLab: true,
};

/**
 * Create the live Chroma provider. Injectable I/O and clocks allow animation and stale-session recovery
 * to be checked without RGB hardware.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl=global.fetch] HTTP client (tests pass a fake).
 * @param {string} [options.baseUrl] SDK discovery/registration endpoint (default port 54235).
 * @param {Function} [options.setIntervalImpl=setInterval] Timer used for the 46 ms animation tick.
 * @param {Function} [options.clearIntervalImpl=clearInterval] Matching timer cancel.
 * @param {(ms:number)=>Promise<void>} [options.delayImpl] Sleep used between ECONNREFUSED retries.
 * @param {()=>number} [options.nowImpl=Date.now] Clock for animation time, heartbeats and backoff.
 * @param {number} [options.requestTimeoutMs=2500] Per-request abort timeout; a hung SDK call must not
 *   freeze the queue forever.
 * @returns {{apply:Function, release:Function, status:Function, keyPress:Function}} The provider API.
 */
function createChromaSdkProvider({
  fetchImpl = global.fetch,
  baseUrl = 'http://localhost:54235/razer/chromasdk',
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = Date.now,
  requestTimeoutMs = 2500,
} = {}) {
  // Precise step wake-ups need real timers; tests that drive ticks by hand inject a fake interval.
  const preciseWake = setIntervalImpl === setInterval;
  // --- Session state (all private to this closure) ------------------------------------------------
  // instanceUri       per-session SDK URI from registration; undefined = not registered.
  // animation         interval handle of the 46 ms tick; undefined = not animating.
  // active            current session: {selection, startedAt, events, mouseSyncState, mouseSyncError,
  //                   explicitActivation, effectId}; undefined after release().
  // lastError         most recent failure {message, at, stage[, cleanup]} for /api/status; null when healthy.
  // lastHeartbeat     clock value of the last successful registration/heartbeat.
  // frames            count of accepted keyboard frames (diagnostics; tests/check-live.cjs asserts it grows).
  // failedFrames      lifetime count of failed animation ticks.
  // repeatedFailures  consecutive failures; reset by any accepted frame. Drives stale-session recovery.
  // nextRecoveryAt    earliest time another recovery (session drop) may happen — a 2 s backoff.
  // tickPending       true while an animation tick is queued/running, so ticks never pile up.
  // operation         tail of the single write queue (see enqueue()).
  let instanceUri,
    animation,
    active,
    lastError = null,
    lastHeartbeat = 0,
    frames = 0,
    failedFrames = 0,
    repeatedFailures = 0,
    nextRecoveryAt = 0,
    tickPending = false,
    operation = Promise.resolve(),
    // Frame pacing (see sendFrame): when the last keyboard frame went out, and a smoothed estimate of how long
    // a Chroma REST call takes on this PC (measured ~16.6 ms p50 on the dev machine; starts at that value).
    lastFrameSentAt = 0,
    rerunTick = false,
    stepWake,
    stepWakeAt = 0,
    latencyEstimate = 16;

  /**
   * Run `work` after every previously queued SDK operation has settled (success OR failure).
   * Every device write uses the same queue; slow HTTP must never reorder frames or settings.
   *
   * @template T
   * @param {() => Promise<T>} work Async operation that talks to the SDK.
   * @returns {Promise<T>} Settles with `work`'s own result or error, so callers still see failures.
   * Side effect: extends the queue tail. The tail swallows errors so one failure cannot poison the queue.
   */
  function enqueue(work) {
    const next = operation.then(work);
    operation = next.catch(() => undefined);
    return next;
  }

  /**
   * One JSON request to the SDK with a timeout, HTTP/JSON/SDK-result validation and a narrow retry.
   *
   * @param {string} url Absolute SDK URL.
   * @param {RequestInit} [options] fetch options (method, headers, body).
   * @param {string} [label] Human-readable operation name used in error messages.
   * @returns {Promise<object>} Parsed JSON body (`{}` for an empty body).
   * @throws {Error} On timeout, non-2xx HTTP, invalid JSON, or a non-zero SDK `result` code (Razer's
   *   REST API reports many failures as HTTP 200 with `{"result": <error code>}`, so that field must be
   *   checked explicitly — otherwise failures would look like success).
   */
  async function request(url, options = {}, label = 'Chroma SDK') {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(requestTimeoutMs) });
        const text = await response.text();
        if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0, 180)}`);
        let result;
        try {
          result = text ? JSON.parse(text) : {};
        } catch {
          throw new Error(`${label} returned invalid JSON.`);
        }
        if (typeof result.result === 'number' && result.result !== 0)
          throw new Error(`${label} failed with SDK result ${result.result}.`);
        return result;
      } catch (error) {
        // A newly assigned listener can lag registration. Retry only that connection-refused race.
        // Registration returns a URI on a NEW port, and the SDK sometimes opens that listener a few
        // milliseconds later than it answers; the first PUT then gets ECONNREFUSED. That one race is
        // retried up to 5 times, 100 ms apart. Everything else fails immediately, and the base URL is
        // never retried — refusing there simply means the Chroma SDK service is not running.
        if (String(url) === baseUrl || error?.cause?.code !== 'ECONNREFUSED' || attempt === 5) throw error;
        await delayImpl(100);
      }
    }
  }

  /**
   * Register this app with the Chroma SDK (once per session) and remember the instance URI.
   *
   * @returns {Promise<string>} The per-session base URI, without a trailing slash.
   * @throws {Error} If registration fails or the SDK hands back an unusable / non-loopback URI.
   * Side effects: sets `instanceUri` and resets the heartbeat clock.
   */
  async function register() {
    if (instanceUri) return instanceUri;
    const result = await request(
      baseUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: APP_TITLE,
          description: 'Local keyboard and mouse lighting',
          author: { name: 'jeby Labs', contact: 'local' },
          device_supported: ['keyboard', 'mouse'],
          category: 'application',
        }),
      },
      'Chroma SDK registration',
    );
    let parsed;
    try {
      parsed = new URL(String(result.uri || ''));
    } catch {
      throw new Error('Chroma SDK registration returned no usable instance URI.');
    }
    // Every later request (frames, heartbeats, DELETE) goes to this URI, so it must be plain-http
    // loopback with no credentials, query or fragment. A tampered or unexpected response can therefore
    // never redirect lighting traffic (or the session DELETE) to another machine.
    if (
      parsed.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('Chroma SDK returned a non-loopback or malformed instance URI.');
    instanceUri = parsed.toString().replace(/\/$/, '');
    lastHeartbeat = nowImpl(); // Registration itself counts as activity for the session timeout.
    return instanceUri;
  }

  /**
   * Keep the session alive. Without a heartbeat the SDK expires the session after ~15 s of silence.
   * @returns {Promise<void>}
   * @throws {Error} When the heartbeat request fails (usually an expired session).
   */
  async function heartbeat() {
    if (instanceUri) {
      await request(`${instanceUri}/heartbeat`, { method: 'PUT' }, 'Chroma SDK heartbeat');
      lastHeartbeat = nowImpl();
    }
  }

  /**
   * Render and send ONE keyboard frame (plus the mouse frame when mouse sync is on) for "now".
   * Must only be called from inside enqueue().
   *
   * @returns {Promise<void>} Resolves silently when there is no active session or no registration.
   * @throws {Error} When the keyboard request fails (mouse failures are absorbed, see below).
   * Side effects: prunes expired key-press events, bumps `frames`, clears `lastError` and
   *   `repeatedFailures` on success, updates mouse sync state.
   */
  /**
   * Crossfade progress for a session at a given clock time.
   * @param {object} session  The active session (may carry `fade: {from, startedAt, durationMs}`).
   * @param {number} now  Clock value (nowImpl() units).
   * @returns {number|null}  null when no fade is running; otherwise 0..1 (1 = finished, send the pure new frame).
   */
  function fadeProgress(session, now) {
    if (!session?.fade) return null;
    const { startedAt, durationMs } = session.fade;
    return Math.max(0, Math.min(1, (now - startedAt) / durationMs));
  }

  async function sendFrame({ immediate = true } = {}) {
    if (!active || !instanceUri) return false;
    // Animation time is relative to when the selection first became active, so live edits keep the
    // same phase instead of restarting every effect from frame zero. The frame is rendered for the moment
    // it will actually reach the LEDs (now + measured REST latency), not the moment we start sending it.
    const session = active,
      startedSending = nowImpl(),
      timeMs = startedSending - session.startedAt + Math.round(latencyEstimate);
    // Reactions last at most ~2.4 s (see effects.js); keep a small margin and forget older presses.
    session.events = session.events.filter((e) => timeMs - e.at < 2500);
    const options = { ...session.selection, timeMs, events: session.events };
    const frame = createCustomKeyboardFrame(options.effect, options.anchors, 0, options);
    // Crossfade (ISSUES-LOG LL-061): while an automatic App Profile switch is fading, blend every cell from
    // the OLD selection's frame to the NEW one, both rendered at the same animation time, so motion keeps
    // going on both sides of the fade. Progress is measured at display time like the frame itself.
    const progress = fadeProgress(session, startedSending + latencyEstimate);
    if (progress !== null) {
      const from = { ...session.fade.from, timeMs, events: session.events };
      frame.param = blendMatrices(
        createCustomKeyboardFrame(from.effect, from.anchors, 0, from).param,
        frame.param,
        progress,
      );
    }
    // Pacing (ISSUES-LOG LL-055). Animation ticks pass immediate:false:
    //  - an identical frame is never re-sent (Matrix only changes once per row, so most ticks are free and
    //    the row change itself goes out within one 23 ms tick of its boundary instead of queueing behind
    //    redundant requests);
    //  - changed frames are spaced at least MIN_FRAME_GAP_MS apart so continuous effects can't flood Chroma.
    // Apply, key presses and new sessions pass immediate:true and always send.
    const frameKey = frame.param.map((row) => row.join(',')).join(';');
    if (!immediate && !session.explicitActivation) {
      if (frameKey === session.lastFrameKey) return false;
      if (startedSending - lastFrameSentAt < MIN_FRAME_GAP_MS) return false;
    }
    if (session.explicitActivation) {
      // Force Apply uses the documented create -> SetEffect path as well as a fresh registration.
      const created = await request(
        `${instanceUri}/keyboard`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(frame) },
        'Chroma SDK keyboard creation',
      );
      if (typeof created.id !== 'string')
        throw new Error('Chroma did not return an effect identifier for explicit Apply.');
      await request(
        `${instanceUri}/effect`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: created.id }),
        },
        'Chroma SDK effect activation',
      );
      session.effectId = created.id;
      session.explicitActivation = false; // Only the first frame after a forced Apply uses create+set.
    }
    // Normal path: PUT replaces the current custom frame immediately (no stored effect).
    else
      await request(
        `${instanceUri}/keyboard`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(frame) },
        'Chroma SDK keyboard update',
      );
    frames++;
    lastError = null;
    repeatedFailures = 0;
    session.lastFrameKey = frameKey;
    // The fade is over only once a frame at (or past) full progress has actually been delivered; a frame
    // skipped by pacing keeps the fade alive so the final, pure-new frame is guaranteed to go out.
    if (session.fade && progress === 1) session.fade = null;
    lastFrameSentAt = startedSending;
    // Exponential moving average of how long a frame takes to land (used for display-time rendering above).
    latencyEstimate = latencyEstimate * 0.8 + Math.min(200, nowImpl() - startedSending) * 0.2;
    // The mouse never delays the keyboard: its frame goes out on the NEXT tick (see sendMouseFrame).
    if (options.mouseSync && session.mouseSyncState !== 'unavailable') session.mouseDue = true;
    return true;
  }

  /**
   * Send the mouse frame (CHROMA_CUSTOM2, 9x7) if mouse sync is on and the mouse picture changed.
   * Best-effort: a missing/incompatible mouse marks sync 'unavailable' for this session (shown in the UI)
   * but never fails the keyboard. Must only be called from inside enqueue().
   * @returns {Promise<boolean>} whether a request was made.
   */
  async function sendMouseFrame() {
    const session = active;
    if (!session || !instanceUri || !session.mouseDue || session.mouseSyncState === 'unavailable')
      return false;
    session.mouseDue = false;
    const options = {
      ...session.selection,
      timeMs: nowImpl() - session.startedAt + Math.round(latencyEstimate),
      events: session.events,
    };
    const mouse = createCustomMouseFrame(options.effect, 0, options);
    const mouseProgress = fadeProgress(session, nowImpl() + latencyEstimate);
    if (mouseProgress !== null && session.fade) {
      const from = { ...session.fade.from, timeMs: options.timeMs, events: session.events };
      mouse.param = blendMatrices(
        createCustomMouseFrame(from.effect, 0, from).param,
        mouse.param,
        mouseProgress,
      );
    }
    const mouseKey = mouse.param.map((row) => row.join(',')).join(';');
    if (mouseKey === session.lastMouseKey) return false;
    try {
      await request(
        `${instanceUri}/mouse`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mouse) },
        'Chroma SDK mouse update',
      );
      session.lastMouseKey = mouseKey;
      session.mouseSyncState = 'active';
      session.mouseSyncError = null;
    } catch (error) {
      session.mouseSyncState = 'unavailable';
      session.mouseSyncError = error.message;
    }
    return true;
  }

  /**
   * Forget the current registration and ask the SDK to delete it.
   * The URI is cleared BEFORE the request, so even a failed DELETE leaves us ready to register afresh.
   * @returns {Promise<void>}
   * @throws {Error} When the DELETE request fails (callers record it as a cleanup/release warning).
   */
  async function dropSession() {
    const uri = instanceUri;
    instanceUri = undefined;
    if (uri) await request(uri, { method: 'DELETE' }, 'Chroma SDK release');
  }

  /**
   * Start the 46 ms (~22 fps) animation tick if it is not already running.
   *
   * Each tick (queued through enqueue, never overlapping thanks to `tickPending`):
   *   1. re-registers if the session was dropped (recovery),
   *   2. sends a heartbeat if ≥1.5 s have passed,
   *   3. sends a frame only when something can change: an animated effect, a pending reaction, or a
   *      brand-new session that needs its first (possibly static) frame. Static setups therefore cost
   *      nothing but heartbeats.
   * Failure handling: after 2 consecutive failures — and at most once every 2 s (backoff) — the session
   * is dropped so the next tick registers a fresh one with the SAME selection. This recovers from an
   * expired SDK session or a restarted Synapse without the user doing anything.
   * @returns {void}
   */
  function ensureAnimation() {
    if (animation !== undefined) return;
    animation = setIntervalImpl(() => runTick(), TICK_MS);
  }

  /**
   * One animation tick (see ensureAnimation). Runs from the regular interval AND from the precise
   * step-boundary wake-up. If a tick is already running, the request is remembered (rerunTick) and executed
   * as soon as the running one finishes, so a boundary is never silently swallowed by an overlapping tick.
   * @returns {Promise<void>|undefined}
   */
  function runTick() {
    if (!active) return;
    if (tickPending) {
      rerunTick = true;
      return;
    }
    tickPending = true;
    return enqueue(async () => {
      if (!active) return; // release() may have run while this tick waited in the queue.
      try {
        const newSession = !instanceUri;
        if (newSession) await register();
        // A running crossfade streams frames like any animation until its last frame is delivered (LL-061).
        const animated = Effects.isAnimated(active.selection) || Boolean(active.fade);
        // At most ONE keyboard request per tick, and nothing else in front of it, so row changes land on time.
        let sent = false;
        if (newSession) sent = await sendFrame({ immediate: true });
        else if (animated || active.events.length) sent = await sendFrame({ immediate: false });
        // Housekeeping only on ticks that did not send a keyboard frame. A heartbeat that is badly overdue
        // (> 3 s; the SDK expires sessions after ~15 s) goes out regardless.
        const heartbeatAge = nowImpl() - lastHeartbeat;
        if ((!sent && heartbeatAge >= 1500) || heartbeatAge >= 3000) await heartbeat();
        else if (!sent) await sendMouseFrame();
      } catch (error) {
        failedFrames++;
        repeatedFailures++;
        lastError = { message: error.message, at: new Date(nowImpl()).toISOString(), stage: 'animation' };
        // Keep the selection visible; an unavailable vendor service must not silently restore a preset.
        if (repeatedFailures >= 2 && nowImpl() >= nextRecoveryAt) {
          nextRecoveryAt = nowImpl() + 2000;
          try {
            await dropSession();
          } catch (cleanupError) {
            lastError.cleanup = cleanupError.message;
          }
          // The next tick registers again with the same selection when the vendor service is back.
        }
      }
    }).finally(() => {
      tickPending = false;
      scheduleStepWake();
      if (rerunTick) {
        rerunTick = false;
        runTick();
      }
    });
  }

  /**
   * Stepped effects (Matrix rows, stripe flips, starlight twinkles) change at exactly known times. Arm a
   * one-shot timer for the next boundary minus the expected request latency, so the new frame lands on the
   * LEDs right at the boundary instead of up to one tick later (ISSUES-LOG LL-055). Only active with real
   * timers: tests that drive ticks by hand inject setIntervalImpl and get fully deterministic behavior.
   * @returns {void}
   */
  function scheduleStepWake() {
    if (!preciseWake || !active || animation === undefined) return;
    const session = active;
    const elapsed = nowImpl() - session.startedAt;
    const boundary = Effects.nextStepAt(session.selection, elapsed + latencyEstimate);
    if (boundary === null) return;
    const delay = Math.max(0, boundary - elapsed - latencyEstimate + 1);
    if (stepWake && stepWakeAt <= nowImpl() + delay) return; // an earlier wake-up is already armed
    clearTimeout(stepWake);
    stepWakeAt = nowImpl() + delay;
    stepWake = setTimeout(() => {
      stepWake = undefined;
      runTick();
    }, delay);
    stepWake.unref?.();
  }

  /**
   * Report SDK reachability and the current session for /api/status.
   * Performs a GET on the discovery URL (no registration, no lighting change).
   *
   * @returns {Promise<{available:boolean, active:object|null, persistence:object, detail:object|undefined,
   *   error:string|undefined, lastError:object|null, frames:number, failedFrames:number}>}
   *   `available` means the SDK service answered — NOT that the LEDs visibly changed. Physical
   *   confirmation is tracked separately by control-verification.cjs.
   * Never throws: discovery failures become `available:false` plus `error`.
   */
  async function status() {
    let detail,
      available = false,
      serviceError;
    try {
      detail = await request(baseUrl, {}, 'Chroma SDK discovery');
      available = true;
    } catch (error) {
      serviceError = error.message;
    }
    return {
      available,
      active: active
        ? {
            effect: active.selection.effect,
            anchors: active.selection.anchors.length,
            protectedAnchors: active.selection.protectedAnchors.length,
            minimalist: active.selection.minimalist,
            mouseSync: active.mouseSyncState,
            mouseSyncError: active.mouseSyncError,
            keyboardModel: active.selection.keyboardModel,
            feedback: active.selection.feedback,
            speed: active.selection.speed,
            // Present only while an App Profile crossfade is running (LL-061).
            transition: active.fade
              ? {
                  fromEffect: active.fade.from.effect,
                  toEffect: active.selection.effect,
                  durationMs: active.fade.durationMs,
                  progress: fadeProgress(active, nowImpl()),
                }
              : null,
          }
        : null,
      persistence: PERSISTENCE,
      detail,
      error: serviceError,
      lastError,
      frames,
      failedFrames,
    };
  }

  /**
   * Change settings in the existing session. A genuinely stale session is recreated once, with the same
   * selection.
   *
   * @param {object} selection A setup already validated by lighting-domain.cjs validateSelection().
   * @param {{force?: boolean, transitionMs?: number}} [options] `force: true` = explicit "Apply": drop the
   *   old registration, register fresh and use the create → SetEffect path. `false` (live edits, App Profile
   *   switches) reuses the current session for a seamless change. `transitionMs` (0..10 000, clamped) > 0
   *   crossfades from the previous selection to this one over that many ms (automatic App Profile switches
   *   only; ignored when forcing or when nothing was active - ISSUES-LOG LL-061).
   * @returns {Promise<object>} Delivery report: `delivery:'sdk-acknowledged'` and
   *   `physicalLightingVerified:false` — the SDK accepting a frame does not prove the LEDs changed.
   * @throws {Error} If both the first attempt and the single re-registration attempt fail. Even then the
   *   animation tick is started, so the session keeps retrying in the background with this selection.
   * Side effects: replaces `active`; preserves the animation phase (`startedAt`) and in-flight
   *   reactions from the previous selection so edits do not visually "jump".
   */
  function apply(selection, { force = false, transitionMs = 0 } = {}) {
    // Clamp: a crossfade is 0..10 s; anything non-numeric means "no fade".
    const fadeMs = Math.max(
      0,
      Math.min(MAX_TRANSITION_MS, Number.isFinite(Number(transitionMs)) ? Number(transitionMs) : 0),
    );
    return enqueue(async () => {
      let releaseWarning;
      if (force) {
        // An expired session may not be deletable; record why, but still continue with a fresh one.
        try {
          await dropSession();
        } catch (error) {
          releaseWarning = error.message;
        }
        lastError = null;
      }
      const previous = active;
      active = {
        selection: { ...selection },
        startedAt: previous?.startedAt ?? nowImpl(),
        events: previous?.events || [],
        mouseSyncState: selection.mouseSync ? 'pending' : 'off',
        mouseSyncError: null,
        explicitActivation: force,
        // Crossfade only between two live (non-forced) selections: a forced Apply starts a fresh session,
        // and there is nothing to fade FROM on the very first apply. A fade that interrupts another fade
        // starts from the previous TARGET selection (the in-between blend is not reconstructed).
        fade:
          fadeMs > 0 && previous && !force
            ? { from: { ...previous.selection }, startedAt: nowImpl(), durationMs: fadeMs }
            : null,
      };
      let uri;
      try {
        uri = await register();
        await sendFrame();
      } catch (firstError) {
        // The cached registration may have expired (Synapse restarted, laptop slept…). Retry ONCE with
        // a brand-new registration before reporting failure.
        lastError = { message: firstError.message, at: new Date(nowImpl()).toISOString(), stage: 'apply' };
        try {
          await dropSession();
        } catch (cleanupError) {
          lastError.cleanup = cleanupError.message;
        }
        try {
          uri = await register();
          await sendFrame();
        } catch (error) {
          lastError = { message: error.message, at: new Date(nowImpl()).toISOString(), stage: 'apply' };
          ensureAnimation();
          throw error;
        }
      }
      ensureAnimation();
      return {
        provider: 'chroma-sdk',
        mode: 'temporary-live-control',
        instance: new URL(uri).pathname,
        effect: selection.effect,
        protectedAnchors: selection.protectedAnchors.length,
        minimalist: selection.minimalist,
        mouseSync: active.mouseSyncState,
        mouseSyncError: active.mouseSyncError,
        releaseWarning,
        delivery: 'sdk-acknowledged',
        physicalLightingVerified: false,
      };
    });
  }

  /**
   * Stop queued animation and unregister; DELETE failure is reported instead of claiming release
   * succeeded. After this, Synapse shows its own saved lighting again.
   *
   * @returns {Promise<{released:true}>}
   * @throws {Error} If the SDK DELETE fails (the local session is forgotten regardless).
   * Side effects: clears the animation interval immediately; clears `active` inside the queue so any
   *   frame already queued before release finishes first and nothing is sent afterwards.
   */
  function release() {
    if (animation !== undefined) clearIntervalImpl(animation);
    animation = undefined;
    clearTimeout(stepWake);
    stepWake = undefined;
    return enqueue(async () => {
      active = undefined;
      await dropSession();
      return { released: true };
    });
  }

  /**
   * Record a physical key press and immediately send a frame that shows its reaction.
   *
   * @param {string} id Physical switch ID from core.js (e.g. 'Q', 'NUM_ENTER'). Never a typed character.
   * @returns {Promise<{accepted:true, key:string, mode:string}|{accepted:false, reason:string}>}
   *   `accepted:false` (not an error) when nothing is active, the ID is unknown, or the key's group
   *   has reactions turned off.
   * @throws {Error} When the frame request fails (also recorded in `lastError` with stage 'feedback').
   * Side effects: appends to `active.events` (bounded to the latest 128 presses).
   */
  function keyPress(id) {
    return enqueue(async () => {
      // "Lighting substitutes": a working key can fire the reaction of a broken one (Key Issues panel).
      id = active?.selection.inputAliases?.[id] || id;
      if (!active || !Plan.chromaCoordinates[id])
        return { accepted: false, reason: 'no active Direct effect or unknown physical switch' };
      const target = Effects.groupFor(active.selection, id);
      if (target.reaction === 'none')
        return { accepted: false, reason: 'feedback disabled for this switch group' };
      // Store only the switch identity and a relative timestamp — no text, no history beyond ~2.5 s.
      active.events.push({ id, at: nowImpl() - active.startedAt });
      if (active.events.length > 128) active.events.splice(0, active.events.length - 128);
      try {
        await sendFrame();
      } catch (error) {
        lastError = { message: error.message, at: new Date(nowImpl()).toISOString(), stage: 'feedback' };
        throw error;
      }
      return { accepted: true, key: id, mode: target.reaction };
    });
  }
  return { apply, release, status, keyPress };
}
module.exports = { createChromaSdkProvider, APP_TITLE };
