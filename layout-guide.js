/* =====================================================================================================
 * layout-guide.js — "Identify My Layout": a brand-independent, untimed layout interview.
 * Missing input never proves a key is absent.
 *
 * WHAT IT DOES
 *   When Lighting Lab cannot recognize the keyboard model (or the user thinks the drawing is wrong),
 *   the dialog asks five short questions — numpad? function row? arrows? navigation keys? Enter shape? —
 *   and picks the closest STANDARD reference layout. It never claims a brand, exact geometry, or RGB
 *   capability; it only chooses which reference drawing to show.
 *
 * HOW A STEP IS ANSWERED
 *   - Press steps (numpad, functionRow, arrows): the user presses a qualifying key, which ui.js feeds to
 *     press(); or clicks Yes / No / Not sure, which ui.js feeds to answer() with true / false / 'unknown'.
 *   - Choice steps (navigation, enterShape): a keypress cannot reveal a shape, so the user picks a button.
 *
 * WHY IT IS UNTIMED AND FORGIVING
 *   People asking "why is my keyboard drawn wrong?" often have a broken key. If the numpad Enter does not
 *   register, that must NOT be read as "no numpad" — the board would be redrawn smaller and the user would
 *   lose keys. So:
 *     - there is no timeout;
 *     - broken() records a key as unresponsive WITHOUT answering the step (the user can try another key
 *       from the same feature, e.g. numpad + instead of numpad Enter);
 *     - 'unknown' answers are treated as "assume present" (see result()) and mark the result provisional.
 *
 * DECISION TREE (result())
 *
 *     numpad present (true or unknown)?
 *       ├─ yes → Enter shape is ISO?  ── yes → standard-iso        (full-size ISO, 105 keys)
 *       │                              └─ no  → standard-full-size  (ANSI 104)
 *       └─ no  → function row present (true or unknown)?
 *                ├─ yes → navigation arranged as a compact column? ── yes → standard-75
 *                │                                                └─ no  → standard-tkl (87 keys)
 *                └─ no  → dedicated arrows present (true or unknown)?
 *                         ├─ yes → standard-65 (68 keys)
 *                         └─ no  → standard-60 (61 keys)
 *
 *   Only an explicit `false` ("No ...") removes a feature; `true` and 'unknown' both keep it.
 *
 * WHO LOADS THIS FILE
 *   Browser: <script src="layout-guide.js"> → global `LayoutGuide`. Node (tests): require('./layout-guide.js').
 *   The UMD-style `(function (root) { ... })(globalThis)` wrapper provides both.
 *
 * STATE
 *   The guide is a pure state machine. Every function returns a NEW state object; nothing is mutated:
 *     { index, answers: {stepId: true|false|'unknown'|choice}, brokenKeys: [...], observed: [...], finished }
 *
 * EXPORTED API (LayoutGuide)
 *   steps    the five step definitions (shown in order).
 *   begin    → a fresh state.
 *   step     state → the current step definition (or null when finished).
 *   answer   (state, value) → state with the current step answered and the index advanced.
 *   press    (state, switchId) → {state, accepted}: answers "yes" if the key qualifies for this step.
 *   broken   (state, switchId) → state with that key recorded as unresponsive (step NOT advanced).
 *   result   state → {model, brokenKeys, source, brandDetected, provisional, note}.
 * ===================================================================================================== */
(function (root) {
  'use strict';
  /**
   * Interview steps, in order. Fields:
   *   id           key in state.answers.
   *   title / instruction  text shown in the dialog.
   *   accept       (press steps only) switchId → true if pressing it proves the feature exists.
   *   yes / no     button labels for answering without a keypress.
   *   example      the switch recorded by "This Key Doesn't Work" for this step.
   *   choices      (choice steps only) [value, label] pairs; no keypress can answer these.
   */
  const steps = [
    {
      id: 'numpad',
      title: 'Number pad',
      instruction: 'Press Enter on the number pad. If it is broken, try + or any number-pad digit.',
      // Any numpad switch counts, so one broken numpad key never hides the whole numpad.
      accept: (id) => id.startsWith('NUM_'),
      yes: 'I have a number pad',
      no: 'No number pad',
      example: 'NUM_ENTER',
    },
    {
      id: 'functionRow',
      title: 'Function row',
      instruction: 'Press F8, or another F1–F12 key on a dedicated top row.',
      // F1..F12 only (F13+ exist on some boards but say nothing about a standard top row).
      accept: (id) => /^F([1-9]|1[0-2])$/.test(id),
      yes: 'Dedicated function row',
      no: 'No dedicated function row',
      example: 'F8',
    },
    {
      id: 'arrows',
      title: 'Arrow keys',
      instruction: 'Press a dedicated arrow key. Do not use an Fn combination.',
      accept: (id) => ['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(id),
      yes: 'Dedicated arrow keys',
      no: 'No dedicated arrow keys',
      example: 'RIGHT',
    },
    {
      // A keypress cannot tell a 6-key block (TKL) from a compact column (75%), so the user chooses.
      id: 'navigation',
      title: 'Navigation keys',
      instruction: 'Choose the physical arrangement around Home, Delete, Page Up and Page Down.',
      choices: [
        ['block', 'Separate navigation block'],
        ['column', 'Compact column or shared cluster'],
        ['none', 'No dedicated navigation keys'],
      ],
    },
    {
      // ANSI (US) Enter is one wide row; ISO (Europe) Enter is tall and stepped. Both send the same code.
      id: 'enterShape',
      title: 'Enter key shape',
      instruction: 'A keypress cannot identify this shape. Choose what your main Enter key looks like.',
      choices: [
        ['ansi', 'Wide horizontal Enter'],
        ['iso', 'Tall, stepped Enter'],
      ],
    },
  ];
  /**
   * Start a new interview.
   * @returns {{index:number, answers:object, brokenKeys:string[], observed:string[], finished:boolean}}
   */
  function begin() {
    return { index: 0, answers: {}, brokenKeys: [], observed: [], finished: false };
  }
  /**
   * The step the user is currently on.
   * @param {object} state
   * @returns {object|null} A `steps` entry, or null once every step is answered.
   */
  function step(state) {
    return steps[state.index] || null;
  }
  /**
   * Record an answer for the current step and move to the next one.
   * @param {object} state
   * @param {true|false|'unknown'|string} value  true/false/'unknown' for press steps, a choice value otherwise.
   * @returns {object} New state (unchanged if the interview is already finished).
   * @example answer(begin(), false).answers // → {numpad: false}
   */
  function answer(state, value) {
    const current = step(state);
    if (!current) return state;
    return {
      ...state,
      answers: { ...state.answers, [current.id]: value },
      index: state.index + 1,
      finished: state.index + 1 >= steps.length,
    };
  }
  /**
   * Feed a physical keypress to the current step. A qualifying key answers "yes"; anything else is
   * ignored (so stray presses never move the interview, and Enter on the MAIN cluster does not count
   * as a numpad).
   * @param {object} state
   * @param {string} id  Switch ID from KeyboardPlan.eventKey().
   * @returns {{state:object, accepted:boolean}}  accepted=false → state is returned unchanged.
   */
  function press(state, id) {
    const current = step(state);
    if (!current?.accept?.(id)) return { state, accepted: false };
    return { state: answer({ ...state, observed: [...state.observed, id] }, true), accepted: true };
  }
  /**
   * Record that a key does not register. Deliberately does NOT answer the step: a broken key is not
   * evidence that the feature is missing. Duplicates and empty IDs are dropped.
   * @param {object} state
   * @param {string} id  Usually the step's `example` key.
   * @returns {object} New state with `id` in brokenKeys.
   */
  function broken(state, id) {
    return { ...state, brokenKeys: [...new Set([...state.brokenKeys, id])].filter(Boolean) };
  }
  /**
   * Turn the answers into a reference layout using the decision tree in the file header.
   * @param {object} state  A finished (or partially finished) interview.
   * @returns {{model:string, brokenKeys:string[], source:'guided-layout', brandDetected:false,
   *   provisional:boolean, note:string}}
   *   provisional is true if any answer was 'unknown', or if ISO Enter was chosen without a confirmed
   *   numpad (the catalog has no ISO tenkeyless/compact reference, so the drawing may be off).
   */
  function result(state) {
    const a = state.answers;
    // `!== false` means "true or unknown counts as present" — never shrink the board on uncertainty.
    const model =
      a.numpad !== false
        ? a.enterShape === 'iso'
          ? 'standard-iso'
          : 'standard-full-size'
        : a.functionRow !== false
          ? a.navigation === 'column'
            ? 'standard-75'
            : 'standard-tkl'
          : a.arrows !== false
            ? 'standard-65'
            : 'standard-60';
    return {
      model,
      brokenKeys: [...state.brokenKeys],
      source: 'guided-layout',
      brandDetected: false,
      provisional:
        Object.values(a).some((value) => value === 'unknown') ||
        (a.enterShape === 'iso' && a.numpad !== true),
      note: 'This identifies a reference layout, not a brand, exact geometry, RGB capability, or an operating-system key remap. Review the illustration and adjust Customize View if needed.',
    };
  }
  // Public API — see the file header.
  root.LayoutGuide = { steps, begin, step, answer, press, broken, result };
  // Node (tests) also gets it via module.exports; the browser uses the global.
  if (typeof module !== 'undefined') module.exports = root.LayoutGuide;
})(typeof globalThis !== 'undefined' ? globalThis : window);
