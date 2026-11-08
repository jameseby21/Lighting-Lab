/* =====================================================================================================
 * effects.js — THE renderer. Composes base colors, motion, and reactions for both the browser preview
 * and the Chroma frames sent to the real keyboard. Because preview and hardware call the same functions
 * with the same inputs, "what you see on screen" is literally what the keyboard is asked to show.
 *
 * WHO LOADS THIS FILE
 *   - The browser via <script src="effects.js"> (after core.js). It reads the global `KeyboardPlan` and
 *     publishes the global `LightingEffects`.
 *   - Node via require('./effects.js') from lighting-domain.cjs, the Chroma provider, export.cjs and tests.
 *   The UMD-style wrapper `(function (root) { ... })(globalThis)` makes both work: inside Node,
 *   `module.exports` exists, so core.js is require()d; in the browser, core.js already defined
 *   `root.KeyboardPlan`. The API is attached to `root` and, in Node, also returned from module.exports.
 *
 * THE COMPOSITING MODEL (per key, per moment)
 *   Every switch belongs to exactly one of three paint GROUPS: anchor, background, orientation.
 *   Each group has three independent layers, applied bottom to top:
 *
 *     1. base      'off' (black) or 'static' (the group's color)
 *     2. dynamic   an animated effect ('rainbow-road', 'matrix', ...) — REPLACES the base when not 'none'
 *     3. reaction  a key-press overlay ('reactive', 'ripple', ...) — BLENDED on top with an alpha 0..1:
 *                  final = mix(base_or_dynamic, reactionColor, alpha)
 *
 *   `minimalist` ("Keypress only") forces layers 1-2 to black so only reactions show.
 *
 * COLOR FORMATS
 *   Internally colors are {red, green, blue} objects with 0..255 integers. Razer's Chroma REST API wants
 *   each LED as ONE integer in BGR order: blue in the high byte, red in the low byte
 *   (0x00BBGGRR). bgr() does that conversion; pure red is 0x0000FF, pure blue is 0xFF0000.
 *
 * DETERMINISTIC RANDOMNESS
 *   Chaos, Fire, Starlight, Matrix gaps, Flame flicker and Sparkle all need "random" variation, but the
 *   browser preview and the Node server render separately. Math.random() would make them disagree, so
 *   these effects use hash() — 32-bit FNV-1a over a descriptive string such as `${seed}:${row}:${col}`.
 *   Same inputs → same color on both sides. `selection.seed` (default 17) changes the pattern.
 *
 * TIME AND SPEED
 *   `time` is milliseconds since the session (or page) started. `selection.speed` is a multiplier where
 *   3.5 is the baseline "1x" the effects were tuned at (the UI slider runs 0.25-6, the validator allows
 *   0.1-10). Most effects scale with `speed / 3.5`.
 *
 * LEGACY SETUPS
 *   Profiles saved before layered groups existed only have effect / feedback / anchors /
 *   protectedAnchors / colors. legacyGroups() expands them into the same three-group shape so one
 *   compositor handles everything.
 *
 * KEEP IN SYNC
 *   portable/ChromaPreset.cs Fade() re-implements reactionSample() in C# for exported .exe players
 *   (their backgrounds are pre-rendered by frame(), but reactions happen live). When you add or change a
 *   reaction here, change Fade() too.
 *
 * EXPORTED API (LightingEffects)
 *   EFFECTS          every legacy "background effect" name accepted by the validator.
 *   DYNAMIC_EFFECTS  every animated layer a group may use ('none' = no animation).
 *   REACTIONS        every key-press reaction a group may use ('none' = no reaction).
 *   GROUP_NAMES      ['anchor', 'background', 'orientation'].
 *   background       legacy whole-board background sample at a grid point.
 *   groupsFor        selection → normalized {anchor, background, orientation} group settings.
 *   groupFor         selection + switch ID → the group settings that apply to that key.
 *   isAnimated       true if any group has a dynamic layer (the provider must keep sending frames).
 *   sample           selection + switch ID + time (+ events) → {red, green, blue}.
 *   sampleAt         same, but for an explicit Chroma grid row/col (used for cells with no switch).
 *   frame            full 6 x 22 Chroma CHROMA_CUSTOM matrix of BGR integers.
 *   bgr              {red, green, blue} → BGR integer.
 *   parseColor       '#rrggbb' or {red,green,blue} → {red,green,blue} (with fallback).
 *   hue              HSV → {red, green, blue}.
 * ===================================================================================================== */
(function (root) {
  'use strict';
  // Node: load core.js directly. Browser: core.js was loaded by an earlier <script> tag.
  const Plan = typeof module !== 'undefined' && module.exports ? require('./core.js') : root.KeyboardPlan;
  const BLACK = { red: 0, green: 0, blue: 0 },
    WHITE = { red: 255, green: 255, blue: 255 };
  // Legacy whole-board "background effect" names (the Background effect picker and old profiles).
  // 'ghost' = Lights Out, 'subtle-keywords' = only anchors lit, 'solid' = one color,
  // 'waterfall' = an old preset name that now means "dark background" (see legacyGroups).
  const EFFECTS = [
    'ghost',
    'subtle-keywords',
    'rainbow-road',
    'stars-stripes',
    'matrix',
    'chaos',
    'solid',
    'breathing',
    'spectrum',
    'waterfall',
    'fire',
    'starlight',
    'wave',
    'aurora',
    'radar',
    'prism',
  ];
  // Animated layers a group may use. Each name has a case in dynamic() below.
  const DYNAMIC_EFFECTS = [
    'none',
    'rainbow-road',
    'stars-stripes',
    'matrix',
    'chaos',
    'breathing',
    'spectrum',
    'fire',
    'starlight',
    'wave',
    'aurora',
    'radar',
    'prism',
  ];
  // Key-press reactions a group may use. Each name has a branch in reactionSample() below
  // (and in Fade() in portable/ChromaPreset.cs).
  const REACTIONS = [
    'none',
    'reactive',
    'ripple',
    'waterfall',
    'flash',
    'fading-trail',
    'rainbow-ripple',
    'pulse',
    'sparkle',
    'comet',
    'flame',
  ];
  // The three paint groups. Order matters nowhere except display; membership is exclusive per key.
  const GROUP_NAMES = ['anchor', 'background', 'orientation'];
  /**
   * Round and clamp one channel into the 0..255 byte range.
   * @param {number} n Any number (may be fractional or out of range).
   * @returns {number} Integer 0..255.
   */
  function clamp(n) {
    return Math.max(0, Math.min(255, Math.round(n)));
  }
  /**
   * Build a color object with every channel clamped.
   * @param {number} red   0..255 (clamped)
   * @param {number} green 0..255 (clamped)
   * @param {number} blue  0..255 (clamped)
   * @returns {{red:number,green:number,blue:number}}
   */
  function rgb(red, green, blue) {
    return { red: clamp(red), green: clamp(green), blue: clamp(blue) };
  }
  /**
   * Linear blend between two colors.
   * @param {{red,green,blue}} a  Start color (returned when t = 0).
   * @param {{red,green,blue}} b  End color (returned when t = 1).
   * @param {number} t  Blend amount 0..1 (values outside are not clamped, but the result channels are).
   * @returns {{red:number,green:number,blue:number}}
   * @example mix(BLACK, WHITE, 0.5) // → {red:128, green:128, blue:128}
   */
  function mix(a, b, t) {
    return rgb(
      a.red + (b.red - a.red) * t,
      a.green + (b.green - a.green) * t,
      a.blue + (b.blue - a.blue) * t,
    );
  }
  /**
   * HSV → RGB (the standard six-sector conversion).
   * @param {number} h  Hue in degrees; any value, wrapped into 0..360 (so negatives and >360 are fine).
   * @param {number} [s=1] Saturation 0..1 (0 = gray, 1 = vivid).
   * @param {number} [v=1] Value/brightness 0..1.
   * @returns {{red:number,green:number,blue:number}}
   * @example hue(120) // → pure green {red:0, green:255, blue:0}
   */
  function hue(h, s = 1, v = 1) {
    // ((h % 360) + 360) % 360 wraps negative hues too (JS % keeps the sign of the dividend).
    h = ((h % 360) + 360) % 360;
    // c = chroma, x = second-largest component, m = amount added to every channel to reach `v`.
    const c = v * s,
      x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
      m = v - c,
      a =
        h < 60
          ? [c, x, 0]
          : h < 120
            ? [x, c, 0]
            : h < 180
              ? [0, c, x]
              : h < 240
                ? [0, x, c]
                : h < 300
                  ? [x, 0, c]
                  : [c, 0, x];
    return rgb(...a.map((n) => (n + m) * 255));
  }
  /**
   * Accept either a '#rrggbb' string or an {red, green, blue} object and return a clean color object.
   * Anything else (undefined, '#fff', 'red', NaN channels) returns `fallback`.
   * @param {string|{red,green,blue}} value
   * @param {{red,green,blue}} [fallback] Default is the project's signature red #ff0033.
   * @returns {{red:number,green:number,blue:number}}
   * @example parseColor('#2aa8ff') // → {red:42, green:168, blue:255}
   */
  function parseColor(value, fallback = { red: 255, green: 0, blue: 51 }) {
    if (
      value &&
      typeof value === 'object' &&
      ['red', 'green', 'blue'].every((k) => Number.isFinite(value[k]))
    )
      return rgb(value.red, value.green, value.blue);
    if (typeof value === 'string' && /^#[\da-f]{6}$/i.test(value))
      return rgb(
        parseInt(value.slice(1, 3), 16),
        parseInt(value.slice(3, 5), 16),
        parseInt(value.slice(5, 7), 16),
      );
    return fallback;
  }
  /**
   * 32-bit FNV-1a hash of a string: tiny, fast, and identical in every JS engine, which is the whole
   * point — preview and hardware must derive the same "random" values (see file header).
   * @param {*} value  Converted with String(); callers build descriptive keys like 'seed:row:col:tick'.
   * @returns {number} Unsigned 32-bit integer.
   */
  function hash(value) {
    let n = 2166136261; // FNV-1a 32-bit offset basis
    for (const c of String(value)) {
      n ^= c.charCodeAt(0);
      n = Math.imul(n, 16777619); // FNV prime; Math.imul keeps true 32-bit multiplication
    }
    return n >>> 0; // force unsigned
  }
  /**
   * Expand a pre-groups ("legacy") selection into the three-group shape used by the compositor.
   *   anchor      = selection.anchors, static anchor/keyword color, reaction = keywordFeedback.
   *   orientation = selection.protectedAnchors, static anchorColor, no reaction.
   *   background  = every other known switch; static only for 'solid', animated if `effect` is a
   *                 dynamic effect, reaction = feedback.
   * Reaction colors were always white before groups existed.
   * @param {object} selection  A setup without a usable `groups` object.
   * @returns {{anchor:object, background:object, orientation:object}}
   */
  function legacyGroups(selection) {
    const all = Object.keys(Plan.chromaCoordinates),
      anchors = selection.anchors || [],
      orientation = selection.protectedAnchors || [],
      background = all.filter((id) => !anchors.includes(id) && !orientation.includes(id)),
      // 'waterfall' used to be a background preset name; it now means a dark background (the waterfall
      // itself is a REACTION), so treat it as 'ghost' (Lights Out).
      effect = selection.effect === 'waterfall' ? 'ghost' : selection.effect;
    return {
      anchor: {
        keys: anchors,
        base: 'static',
        color: selection.keywordColor || selection.color,
        dynamic: 'none',
        reaction: selection.keywordFeedback || selection.feedback || 'reactive',
        reactionColor: '#ffffff',
      },
      background: {
        keys: background,
        base: effect === 'solid' ? 'static' : 'off',
        color: selection.color,
        dynamic: DYNAMIC_EFFECTS.includes(effect) ? effect : 'none',
        reaction: selection.feedback || 'reactive',
        reactionColor: '#ffffff',
      },
      orientation: {
        keys: orientation,
        base: 'static',
        color: selection.anchorColor || selection.color,
        dynamic: 'none',
        reaction: 'none',
        reactionColor: '#ffffff',
      },
    };
  }
  /**
   * Each switch belongs to one paint group; old profiles expand into the same compositing contract.
   *
   * Normalizes whatever group data a selection carries into safe values: unknown dynamic/reaction names
   * become 'none', any base other than 'static' becomes 'off', missing colors fall back to the selection
   * color, then #ff0033, and reaction colors to white. This is a rendering safety net; the real input
   * validation (which REJECTS bad values) is validateSelection() in lighting-domain.cjs.
   *
   * Note: builds new objects every call. Hot paths call it once per sample, which measured ~1 ms per
   * full frame — acceptable at ~22 fps.
   * @param {object} selection
   * @returns {{anchor:Group, background:Group, orientation:Group}} where Group is
   *   {keys:string[], base:'off'|'static', color:string, dynamic:string, reaction:string, reactionColor:string}
   */
  // Clamp an optional 0..1 strength; anything missing or invalid means full strength (1), so old setups
  // render exactly as before.
  function strength(value) {
    const number = Number(value);
    return value === undefined || value === null || !Number.isFinite(number)
      ? 1
      : Math.max(0, Math.min(1, number));
  }
  function groupsFor(selection) {
    const source =
        selection.groups && typeof selection.groups === 'object' ? selection.groups : legacyGroups(selection),
      groups = {};
    for (const name of GROUP_NAMES) {
      const raw = source[name] || {};
      groups[name] = {
        keys: Array.isArray(raw.keys) ? raw.keys : [],
        base: raw.base === 'static' ? 'static' : 'off',
        color: raw.color || selection.color || '#ff0033',
        dynamic: DYNAMIC_EFFECTS.includes(raw.dynamic) ? raw.dynamic : 'none',
        reaction: REACTIONS.includes(raw.reaction) ? raw.reaction : 'none',
        reactionColor: raw.reactionColor || '#ffffff',
        // Redesign (LL-062): per-layer strength 0..1 and Protect. Defaults reproduce the previous output exactly.
        baseStrength: strength(raw.baseStrength),
        dynamicStrength: strength(raw.dynamicStrength),
        reactionStrength: strength(raw.reactionStrength),
        protect: raw.protect === true, // protected groups ignore reactions started by keys in OTHER groups
        name,
      };
    }
    return groups;
  }
  /**
   * Which group's settings apply to one key. Orientation wins over anchor if a key were ever in both
   * (the validator forbids that), and anything not listed — including grid cells with no switch
   * (`id` undefined) — is background.
   * @param {object} selection
   * @param {string} [id] Switch ID.
   * @returns {object} One normalized group from groupsFor().
   */
  function groupFor(selection, id) {
    const groups = groupsFor(selection);
    if (id && groups.orientation.keys.includes(id)) return groups.orientation;
    if (id && groups.anchor.keys.includes(id)) return groups.anchor;
    return groups.background;
  }
  /**
   * Matrix: which Chroma row (0-5) the single falling green line occupies at `time`, or -1 during a gap.
   *
   * Time is divided into STEPS of 230 ms at baseline speed (shorter when faster). One "cycle" is a line
   * falling through all 6 rows (6 steps) followed by a dark gap of 3-7 steps, the gap length chosen by
   * hash(seed, cycle) so it looks irregular but is identical everywhere. The loop walks cycles until it
   * reaches the cycle containing `step`; it is capped at 256 cycles as a runaway guard.
   * @param {object} selection  Uses speed (default 3.5) and seed (default 17).
   * @param {number} time  Milliseconds.
   * @returns {number} Row index 0..5, or -1 when no row is lit.
   */
  function fallingMatrixRow(selection, time, fallRows = 6) {
    // 230 ms per row at speed 3.5; dividing by (speed / 3.5) makes higher speeds take shorter steps.
    const step = Math.floor(time / (230 / (Math.max(0.1, selection.speed || 3.5) / 3.5))),
      seed = selection.seed ?? 17;
    // The pattern is MATRIX_CYCLES cycles long and then repeats. Each cycle lasts 6 (fall) + 3..7 (gap) steps.
    // Previously the walk simply stopped at cycle 256, so after ~2,816 steps (~11 minutes at speed 3.5) every
    // sample returned -1 and a live Matrix keyboard went permanently dark (ISSUES-LOG LL-051). Wrapping by the
    // period keeps the first 11 minutes byte-identical to before and repeats seamlessly afterwards.
    // fallRows = how many visible rows the line falls through (6 on full-size, 5 on 60/65% boards, so a compact
    // board no longer waits one invisible step at the bottom).
    const starts = matrixCycleStarts(seed, fallRows);
    const period = starts[starts.length - 1];
    const wrapped = ((step % period) + period) % period;
    // Binary search for the cycle containing `wrapped` (starts[i] <= wrapped < starts[i + 1]).
    let low = 0,
      high = starts.length - 2;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= wrapped) low = middle;
      else high = middle - 1;
    }
    const local = wrapped - starts[low]; // steps into the current cycle
    // Steps 0..fallRows-1 of a cycle light those rows (one row per step); later steps are the gap.
    return local < fallRows ? local : -1;
  }
  const MATRIX_CYCLES = 256;
  const matrixStartsCache = new Map();
  /**
   * Prefix sums of Matrix cycle lengths for one seed: starts[c] = first step of cycle c, and the last
   * element is the total period. Cached per seed, so each sample is a binary search instead of a 256-step walk.
   * @param {number} seed
   * @returns {number[]} length MATRIX_CYCLES + 1
   */
  function matrixCycleStarts(seed, fallRows = 6) {
    const cacheKey = `${seed}:${fallRows}`;
    let starts = matrixStartsCache.get(cacheKey);
    if (!starts) {
      starts = [0];
      for (let cycle = 0; cycle < MATRIX_CYCLES; cycle++)
        starts.push(starts[cycle] + fallRows + (3 + (hash(`${seed}:matrix-gap:${cycle}`) % 5)));
      if (matrixStartsCache.size > 64) matrixStartsCache.clear(); // seeds are user-chosen; keep memory bounded
      matrixStartsCache.set(cacheKey, starts);
    }
    return starts;
  }
  /**
   * Render a supported dynamic layer. Sensor-driven Studio effects remain explicitly unavailable.
   *
   * Positions are Chroma GRID coordinates (row 0-5 top→bottom, col 0-21 left→right), so motion follows
   * the LED grid the hardware uses, not the drawn geometry. Effects marked "(Chroma)" in the UI imitate
   * the Synapse effects of the same name; the rest are Lighting Lab originals.
   * @param {string} effect  One of DYNAMIC_EFFECTS (unknown/'none' → black).
   * @param {object} selection  Uses speed (3.5 = baseline) and seed.
   * @param {number} row  Grid row (may be fractional for mouse sampling).
   * @param {number} col  Grid column (may be fractional).
   * @param {number} time  Milliseconds.
   * @param {string} color  The group's '#rrggbb' — used as the accent by Breathing and Starlight.
   * @returns {{red:number,green:number,blue:number}}
   */
  function dynamic(effect, selection, row, col, time, color, physical) {
    const speed = Number.isFinite(selection.speed) ? selection.speed : 3.5,
      seconds = time / 1000,
      accent = parseColor(color);
    // Row-STEPPED effects (Matrix, Stars & Stripes) move one visible row at a time, so they must use the row a
    // person actually sees. `physical` = {row, count} from the drawn layout when sampling a real switch; the
    // Chroma grid row is only a fallback for cells without a switch (and the mouse). On compact boards Esc sits
    // in grid row 0 while the rest of its physical row is grid row 1, so grid rows made the top of the board
    // light in two separate steps (ISSUES-LOG LL-054).
    const stepRow = physical ? physical.row : Math.round(row);
    const stepRows = physical ? physical.count : 6;
    switch (effect) {
      // Rainbow Road: a diagonal rainbow (22° of hue per column, 35° per row) sliding at
      // 180°/s per unit of speed. Note: uses raw `speed` (not speed / 3.5) like most effects.
      case 'rainbow-road':
        return hue(col * 22 + row * 35 + seconds * 180 * speed, 0.9, 0.95);
      // Matrix: one neon-green row falling top→bottom, separated by irregular dark gaps.
      case 'matrix':
        return stepRow === fallingMatrixRow(selection, time, stepRows) ? rgb(0, 240, 45) : BLACK;
      // One rising row at a time alternates red and white; it intentionally differs from the Matrix gap cadence.
      // Stars & Stripes: rows alternate red/white in 1-row bands that drift 1.4 rows/s at baseline.
      case 'stars-stripes': {
        // Positive modulo into 0..2: band < 1 → red, otherwise white.
        const band = (((stepRow + seconds * 1.4 * (speed / 3.5)) % 2) + 2) % 2;
        return band < 1 ? rgb(245, 20, 48) : rgb(242, 245, 255);
      }
      // Chaos: every key independently picks a random color AND a random behavior, re-rolled at its own
      // rate (3-10 times per second at baseline). Deterministic per (seed, row, col, tick).
      case 'chaos': {
        const seed = hash(`${selection.seed ?? 17}:${row}:${col}`), // this key's personal seed
          tick = Math.floor(seconds * (3 + (seed % 8)) * (speed / 3.5)), // re-roll counter
          random = hash(`${seed}:${tick}`),
          mode = random % 5, // which of five behaviors this key shows during this tick
          base = hue(random % 360, 0.7 + (random % 30) / 100, 0.8); // random hue, saturation 0.70-0.99
        if (mode === 0) return (tick + seed) % 3 ? base : BLACK; // blink: off one tick in three
        if (mode === 1) return mix(BLACK, base, (Math.sin(seconds * ((seed % 9) + 2)) + 1) / 2); // breathe
        if (mode === 2) return hue((random % 360) + seconds * ((seed % 150) + 30), 0.85, 1); // spin hue
        if (mode === 3) return mix(base, WHITE, (Math.sin(seconds * 12 + seed) + 1) * 0.15); // shimmer to 30% white
        return base; // steady
      }
      // Breathing (Chroma): the group color fades black → full → black, one cycle every ~3.14 s.
      // Does not scale with speed.
      case 'breathing':
        // Speed scales the pulse like every other effect (identical at the 3.5 default) - LL-052.
        return mix(BLACK, accent, (Math.sin(seconds * 2 * (speed / 3.5)) + 1) / 2);
      // Spectrum Cycling (Chroma): the whole group shows one hue that cycles 65°/s at baseline.
      case 'spectrum':
        return hue(seconds * 65 * (speed / 3.5));
      // Wave (Chroma): a rainbow sweeping across columns (32°/column, slight row tilt) at 100°/s.
      case 'wave':
        return hue(col * 32 - row * 11 + seconds * 100 * (speed / 3.5));
      // Fire (Chroma): each key flickers 12 times per second between deep red and orange
      // (hue 8°-42°) with brightness rising with the hue. Does not scale with speed.
      case 'fire': {
        const noise =
          hash(`${selection.seed ?? 17}:${row}:${col}:${Math.floor(seconds * 12 * (speed / 3.5))}`) % 100;
        return hue(8 + noise * 0.34, 0.95, 0.45 + noise * 0.005);
      }
      // Starlight (Chroma): about one key in 19 twinkles in the group color, re-rolled 3x/s at baseline.
      case 'starlight': {
        const tick = Math.floor(seconds * 3 * (speed / 3.5)),
          spark = hash(`${selection.seed ?? 17}:star:${row}:${col}:${tick}`) % 19;
        return spark === 0 ? accent : BLACK;
      }
      // Aurora: two slow sine waves blend a teal palette (hue 176° + 10°/row) with a violet palette
      // (hue 292° - 8°/col). glow is 0..1. Does not scale with speed.
      case 'aurora': {
        const drift = seconds * (speed / 3.5);
        const glow = (Math.sin(col * 0.8 + drift * 2.3) + Math.sin(row * 1.3 - drift * 1.6) + 2) / 4;
        return mix(hue(176 + row * 10, 0.75, 0.95), hue(292 - col * 8, 0.62, 0.88), glow);
      }
      // Radar Sweep: a slanted bright-green line (leaning 0.7 col per row) sweeps left→right across 24
      // columns at 9 columns/s, with a dimmer green trail within 2.4 columns of it.
      case 'radar': {
        const distance = Math.abs(col - row * 0.7 - ((seconds * 9 * (speed / 3.5)) % 24));
        return distance < 0.8
          ? rgb(20, 255, 110)
          : distance < 2.4
            ? mix(BLACK, rgb(0, 150, 60), (2.4 - distance) / 3)
            : BLACK;
      }
      // Prism Flow: a tighter, slightly pastel rainbow (48°/column) moving at 150°/s at baseline.
      case 'prism':
        return hue((col * 48 + row * 19 + seconds * 150 * (speed / 3.5)) % 360, 0.72, 0.98);
      default:
        return BLACK;
    }
  }
  /**
   * Legacy whole-board background: the selection's single `effect` animated at a grid point, or black
   * in Keypress-only mode. Only used where code still thinks in pre-groups terms.
   * Note: static effects ('solid', 'ghost', 'subtle-keywords') return black here; use sampleAt() when the
   * base color matters (see LL-020 in lighting-domain.cjs).
   * @returns {{red:number,green:number,blue:number}}
   */
  function background(selection, row, col, time) {
    return selection.minimalist
      ? BLACK
      : dynamic(selection.effect, selection, row, col, time, selection.color);
  }
  // model ID → Map(switch ID → preview key). Layout geometry is pure and costly to rebuild per sample.
  const layoutCache = new Map();
  /**
   * Physical position of a switch in KEY UNITS, used so reactions spread by real distance (a ripple
   * from F reaches G and V, even though they sit in different Chroma columns).
   * @param {object} selection  Uses keyboardModel and, for 'custom', customLayout.
   * @param {string} id  Switch ID.
   * @returns {[number, number]|null} [y, centerX] in key units, or null if this model has no such key.
   */
  /**
   * When will a STEPPED effect next change its picture? Matrix moves one row per step, Stars & Stripes flips
   * its bands at fixed intervals, and Starlight re-rolls its twinkles on a tick. Knowing the exact boundary
   * lets the Chroma provider wake up precisely then, instead of noticing the change up to one animation
   * tick late, which made rows look unevenly timed (ISSUES-LOG LL-055).
   * @param {object} selection
   * @param {number} time  Milliseconds (same clock as sample()).
   * @returns {number|null}  The next boundary in ms (> time), or null when no group uses a stepped effect.
   */
  function nextStepAt(selection, time) {
    const k = Math.max(0.1, Number.isFinite(selection.speed) ? selection.speed : 3.5) / 3.5;
    let next = null;
    const consider = (periodMs) => {
      if (!(periodMs > 0)) return;
      const boundary = (Math.floor(time / periodMs) + 1) * periodMs;
      if (next === null || boundary < next) next = boundary;
    };
    if (selection.minimalist) return null;
    for (const group of Object.values(groupsFor(selection))) {
      if (group.dynamic === 'matrix') consider(230 / k);
      else if (group.dynamic === 'stars-stripes') consider(1000 / (1.4 * k));
      else if (group.dynamic === 'starlight') consider(1000 / (3 * k));
    }
    return next;
  }
  const physicalRowsCache = new Map();
  /**
   * The VISIBLE row of a switch in the selected layout, plus how many visible rows that layout has.
   *
   * Rows are derived from the drawn geometry: keys are sorted by their top edge (y, in key units) and a new row
   * starts whenever a key's top is at least 0.75u below the current row's top. That keeps the 0.25u offsets of
   * the main block (e.g. number row at y = 1.25 under an F row at y = 0) in the right row, puts tall keys
   * (numpad +/Enter, ISO Enter) in the row where they start, and works for user-edited custom layouts.
   * @param {object} selection  Uses keyboardModel and (for 'custom') customLayout.
   * @param {string} id
   * @returns {{row:number, count:number} | null}  null when the switch is not drawn in this layout.
   */
  function physicalRowOf(selection, id) {
    const modelId = selection.keyboardModel || 'standard-full-size';
    const custom = modelId === 'custom' && selection.customLayout;
    const input = custom
      ? Array.isArray(selection.customLayout)
        ? selection.customLayout
        : selection.customLayout.keys
      : null;
    // Custom layouts are keyed by their geometry so editing a key re-derives the rows.
    const cacheKey = custom ? 'custom:' + JSON.stringify((input || []).map((k) => [k.id, k.y])) : modelId;
    let info = physicalRowsCache.get(cacheKey);
    if (!info) {
      let keys = [];
      try {
        keys = custom ? input || [] : Plan.layoutForModel(modelId).keys;
      } catch {
        keys = [];
      }
      const sorted = [...keys].sort((a, b) => a.y - b.y);
      const rowOf = new Map();
      let row = -1,
        rowTop = -Infinity;
      for (const key of sorted) {
        if (key.y - rowTop >= 0.75) {
          row++;
          rowTop = key.y;
        }
        rowOf.set(key.id, row);
      }
      info = { rowOf, count: Math.max(1, row + 1) };
      if (physicalRowsCache.size > 32) physicalRowsCache.clear(); // custom edits create new keys; stay bounded
      physicalRowsCache.set(cacheKey, info);
    }
    return info.rowOf.has(id) ? { row: info.rowOf.get(id), count: info.count } : null;
  }
  function pointFor(selection, id) {
    const cacheId = selection.keyboardModel || 'standard-full-size';
    if (cacheId === 'custom' && selection.customLayout) {
      const input = Array.isArray(selection.customLayout)
          ? selection.customLayout
          : selection.customLayout.keys,
        customKey = input?.find((key) => key.id === id);
      return customKey ? [customKey.y, customKey.x + (customKey.w ?? 1) / 2] : null;
    }
    let keys = layoutCache.get(cacheId);
    if (!keys) {
      keys = new Map(Plan.layoutForModel(cacheId).keys.map((key) => [key.id, key]));
      layoutCache.set(cacheId, keys);
    }
    const key = keys.get(id);
    return key ? [key.y, key.x + key.w / 2] : null;
  }
  /**
   * The strongest reaction affecting one key right now, across every recent key press.
   *
   * Which reaction MODE applies:
   *   - Layered setups (selection.groups present): the TARGET key's group decides — e.g. a ripple
   *     started by pressing an anchor key lights background keys with the background group's reaction.
   *   - Legacy setups: the PRESSED key's group decides, and with protectAnchors a press on an anchor
   *     key produces no reaction at all.
   * The reaction COLOR is always the target group's reactionColor (rainbow-ripple computes its own).
   *
   * Distances (dr rows, dc columns) are measured in KEY UNITS from physical geometry when both keys
   * exist in the model's layout, otherwise in Chroma grid cells.
   *
   * MIRRORED IN C#: portable/ChromaPreset.cs Fade(). Keep timings and modes in sync.
   *
   * @param {object} selection
   * @param {object} target  The target key's group (from groupFor).
   * @param {string|undefined} id  Target switch ID (undefined for grid cells with no switch).
   * @param {number} row  Target grid row.
   * @param {number} col  Target grid column.
   * @param {number} time  Milliseconds, same clock as event.at.
   * @param {Array<{id:string, at:number}>} events  Recent key presses (switch ID + press time in ms).
   * @returns {{color:{red,green,blue}, alpha:number}|null}  null when no reaction touches this key.
   */
  function reactionSample(selection, target, id, row, col, time, events) {
    let result = null;
    for (const event of events) {
      const legacy = !selection.groups,
        source = groupFor(selection, event.id),
        mode = legacy
          ? selection.protectAnchors && (selection.anchors || []).includes(event.id)
            ? 'none'
            : source.reaction
          : target.reaction;
      if (mode === 'none') continue;
      // Protect: a protected group still reacts to its own keys, but ignores presses from other groups.
      if (!legacy && target.protect && source.name !== target.name) continue;
      const origin = Plan.chromaCoordinates[event.id];
      if (!origin) continue; // a press on a key with no LED cell cannot be an origin
      const age = time - event.at; // ms since this press
      // 2400 ms is the longest any reaction can last (callers also drop events older than ~2.4-2.5 s).
      if (age < 0 || age > 2400) continue;
      const targetPoint = pointFor(selection, id),
        originPoint = pointFor(selection, event.id),
        // Prefer physical key-unit distances; fall back to grid cells if either key is not in the layout.
        dr = targetPoint && originPoint ? targetPoint[0] - originPoint[0] : row - origin[0],
        dc = targetPoint && originPoint ? targetPoint[1] - originPoint[1] : col - origin[1];
      let alpha = 0;
      // Key-local fades on the pressed key only: Flash 320 ms, Pulse 700 ms, Reactive (white fade) 1300 ms.
      if (mode === 'reactive' || mode === 'flash' || mode === 'pulse') {
        if (dr === 0 && dc === 0)
          alpha = Math.max(0, 1 - age / (mode === 'flash' ? 320 : mode === 'pulse' ? 700 : 1300));
      } else if (mode === 'ripple' || mode === 'rainbow-ripple') {
        // Ripple: an expanding ring. The ring reaches a key 110 ms per key-unit of distance, then that
        // key fades over 450 ms. Far keys are dimmer (1 - distance/18), but never below 35%.
        const distance = Math.hypot(dr, dc),
          elapsed = age - distance * 110;
        if (elapsed >= 0 && elapsed < 450) alpha = (1 - elapsed / 450) * Math.max(0.35, 1 - distance / 18);
      } else if (mode === 'waterfall') {
        // Waterfall: light falls straight DOWN from the pressed key (dr >= 0, within 0.8u sideways),
        // 150 ms per row, each key fading over 420 ms.
        const elapsed = age - dr * 150;
        if (dr >= 0 && Math.abs(dc) <= 0.8 && elapsed >= 0 && elapsed < 420) alpha = 1 - elapsed / 420;
      } else if (mode === 'fading-trail') {
        // Fading trail: runs RIGHT along the same row (|dr| <= 0.5u), 100 ms per key, 700 ms fade.
        const elapsed = age - dc * 100;
        if (Math.abs(dr) <= 0.5 && dc >= 0 && elapsed >= 0 && elapsed < 700) alpha = 1 - elapsed / 700;
      } else if (mode === 'comet') {
        // Comet trail: like fading trail but slower (120 ms per key) with a longer 900 ms tail.
        const elapsed = age - dc * 120;
        if (Math.abs(dr) <= 0.5 && dc >= 0 && elapsed >= 0 && elapsed < 900) alpha = 1 - elapsed / 900;
      }
      // Flame is deliberately key-local: every RGB keyboard can show a vivid blue flare without requiring neighboring LEDs.
      // It fades over 950 ms while its brightness flickers between 72% and 100% every 70 ms.
      else if (mode === 'flame') {
        if (dr === 0 && dc === 0 && age < 950) {
          const flicker = 0.72 + (hash(`${event.id}:${Math.floor(age / 70)}`) % 29) / 100;
          alpha = Math.max(0, (1 - age / 950) * flicker);
        }
      } else if (mode === 'sparkle') {
        // Sparkle: anywhere on the board, roughly one key in nine twinkles per 100 ms tick for 700 ms.
        const sparkle = hash(`${event.id}:${id}:${Math.floor(age / 100)}`) % 9;
        if (age < 700 && sparkle === 0) alpha = 1 - age / 700;
      }
      if (alpha > 0) {
        const color =
            mode === 'rainbow-ripple'
              ? // Hue advances with time and distance so the ring shows a moving rainbow.
                hue((age + Math.hypot(dr, dc) * 40) / 7, 0.9, 1)
              : parseColor(target.reactionColor, WHITE),
          // Reaction strength scales how far the reaction blends over the layers below.
          candidate = { color, alpha: alpha * target.reactionStrength };
        // Overlapping presses do not add up; the strongest one wins.
        if (!result || candidate.alpha > result.alpha) result = candidate;
      }
    }
    return result;
  }
  /**
   * Final color at one Chroma grid cell: base → dynamic → reaction (see file header).
   * @param {object} selection
   * @param {number} row  Grid row 0-5 (fractional allowed, e.g. mouse sampling).
   * @param {number} col  Grid column 0-21 (fractional allowed).
   * @param {number} time  Milliseconds.
   * @param {Array<{id:string, at:number}>} [events=[]]  Recent key presses.
   * @param {string} [id]  Switch ID at this cell; omitted for cells with no switch (they use background).
   * @returns {{red:number,green:number,blue:number}}
   */
  function sampleAt(selection, row, col, time, events = [], id) {
    const target = groupFor(selection, id);
    // Layer 1: base (black in Keypress-only mode).
    // Base strength dims the static color toward black (100% = the chosen color).
    let base = selection.minimalist
      ? BLACK
      : target.base === 'static'
        ? mix(BLACK, parseColor(target.color), target.baseStrength)
        : BLACK;
    // Layer 2: dynamic blends over the base by its strength (100% = replaces the base, as before).
    if (!selection.minimalist && target.dynamic !== 'none')
      base = mix(
        base,
        dynamic(
          target.dynamic,
          selection,
          row,
          col,
          time,
          target.color,
          id ? physicalRowOf(selection, id) : null,
        ),
        target.dynamicStrength,
      );
    // Layer 3: reaction blended on top (still visible in Keypress-only mode — that is the point of it).
    const reaction = reactionSample(selection, target, id, row, col, time, events);
    return reaction ? mix(base, reaction.color, reaction.alpha) : base;
  }
  /**
   * Final color of one physical switch (the preview uses this for every drawn key).
   * @param {object} selection
   * @param {string} id  Switch ID; unknown IDs are black.
   * @param {number} time  Milliseconds.
   * @param {Array<{id:string, at:number}>} [events=[]]
   * @returns {{red:number,green:number,blue:number}}
   */
  function sample(selection, id, time, events = []) {
    const pos = Plan.chromaCoordinates[id];
    return pos ? sampleAt(selection, pos[0], pos[1], time, events, id) : BLACK;
  }
  /**
   * Color object → Chroma integer, BGR byte order (0x00BBGGRR).
   * @param {{red:number,green:number,blue:number}} c
   * @returns {number}
   * @example bgr({red:255, green:0, blue:0}) // → 255 (0x0000FF)
   */
  function bgr(c) {
    return c.red | (c.green << 8) | (c.blue << 16);
  }
  /**
   * One complete keyboard frame for Chroma's CHROMA_CUSTOM effect: 6 rows x 22 columns of BGR ints.
   * Pass 1 fills every cell as background (cells without a switch still get a sensible color, e.g. on
   * keyboards whose LED layout differs slightly). Pass 2 overwrites each known switch's cell with its own
   * group-aware sample. Where two IDs share a cell (RWIN/FN), the later one in key order wins.
   * @param {object} selection
   * @param {number} time  Milliseconds.
   * @param {Array<{id:string, at:number}>} [events=[]]
   * @returns {number[][]} matrix[row][col]
   */
  function frame(selection, time, events = []) {
    const matrix = Array.from({ length: 6 }, (_, row) =>
      Array.from({ length: 22 }, (_, col) => bgr(sampleAt(selection, row, col, time, events))),
    );
    for (const id of Object.keys(Plan.chromaCoordinates)) {
      const p = Plan.chromaCoordinates[id];
      matrix[p[0]][p[1]] = bgr(sample(selection, id, time, events));
    }
    return matrix;
  }
  /**
   * Whether this setup changes over time without key presses. The Chroma provider uses this to decide
   * whether it must keep streaming frames (~22 fps) or can send one frame and idle.
   * @param {object} selection
   * @returns {boolean}
   */
  function isAnimated(selection) {
    return Object.values(groupsFor(selection)).some((group) => group.dynamic !== 'none');
  }
  // Public API — see the file header for a one-line description of each member.
  root.LightingEffects = {
    EFFECTS,
    DYNAMIC_EFFECTS,
    REACTIONS,
    GROUP_NAMES,
    background,
    groupsFor,
    groupFor,
    isAnimated,
    nextStepAt,
    physicalRowOf,
    sample,
    sampleAt,
    frame,
    bgr,
    parseColor,
    hue,
  };
  // Node (CommonJS) also gets it as the module's export; the browser uses the global.
  if (typeof module !== 'undefined') module.exports = root.LightingEffects;
})(typeof globalThis !== 'undefined' ? globalThis : window);
