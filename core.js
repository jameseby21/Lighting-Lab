/* =====================================================================================================
 * core.js — the keyboard "map": physical switch identities, Chroma grid coordinates, preview geometry,
 * the keyboard model catalog, browser key-event decoding, and the optional keycap word planner.
 *
 * WHO LOADS THIS FILE
 *   - The browser, via a plain <script src="core.js"> tag in index.html. It must therefore work without
 *     a bundler or module system, and it publishes its API as the global `KeyboardPlan`.
 *   - Node.js, via `require('./core.js')` from effects.js, lighting-domain.cjs, export.cjs, the Chroma
 *     provider and the tests. There it returns the same object through `module.exports`.
 *   Both are handled by the small UMD-style wrapper at the top and bottom of the file:
 *
 *       (function (root) { ...build KeyboardPlan...; root.KeyboardPlan = api;
 *                          if (typeof module !== 'undefined') module.exports = api; })(globalThis);
 *
 *   `root` is `globalThis` (window in a browser, the global object in Node). The function runs once,
 *   immediately, so nothing inside leaks into global scope except `KeyboardPlan` itself.
 *
 * THREE DIFFERENT COORDINATE IDEAS — keep them apart
 *   1. Switch ID (string): the stable name of one physical key, e.g. 'Q', 'ESC', 'NUM_1', 'F12', '`'.
 *      The main-row "1" and the numpad "1" are DIFFERENT switches ('1' vs 'NUM_1'). Every saved setup,
 *      group membership, reaction and API call uses switch IDs.
 *   2. Chroma grid coordinate [row, col]: where Razer's Chroma SDK expects that key's LED in its fixed
 *      6 x 22 "CHROMA_CUSTOM" keyboard matrix. This is a TRANSPORT address, not a picture: e.g. the
 *      letter rows are shifted by different amounts (Q starts at col 2, A at col 2, Z at col 3).
 *      Sketch of the 6 x 22 grid (col 0 = macro column on keyboards that have one):
 *
 *        col:  0    1    2    3 ..   14    15    16    17   18   19   20   21
 *        row0: --  ESC  --   F1 ..  F12   PRT   SCR   PAU   --   --   --   --
 *        row1: M1   `    1    2 ..  BKSP  INS   HOME  PGUP  NUM  /    *    -
 *        row2: M2  TAB   Q    W ..  \     DEL   END   PGDN  7    8    9    +
 *        row3: M3  CAPS  A    S ..  ENTER --    --    --    4    5    6    --
 *        row4: M4  LSHF  ISO  Z ..  RSHF  --    UP    --    1    2    3    NENT
 *        row5: M5  LCTL  LWIN LALT.. RCTL LEFT  DOWN  RIGHT --   0    .    --
 *
 *   3. Preview geometry {x, y, w, h} in KEY UNITS ("u"): 1u = the width of one standard letter key.
 *      Backspace is 2u wide, Space 6.25u, the numpad Enter is 1u wide and 2u tall. The browser multiplies
 *      by a pixel size (--unit in styles.css) to draw the board. Geometry only changes the PICTURE and
 *      distance-based reactions (ripples); it never changes which LED a switch drives.
 *
 * MODEL CATALOG FIELDS (modelCatalog below)
 *   id        stable identifier saved in setups ('razer-blackwidow-elite', 'standard-65', ...).
 *   label     human name for the "Keyboard view" picker.
 *   family    brand family; 'Razer' boards swap the right Win key for Fn.
 *   geometry  which layout builder to use (full-size, ISO, TKL, 75%, 65%, 60%, +media, +macro, custom).
 *   accuracy  how trustworthy the drawing is: 'reference' (a standard layout), 'model-layout' (taken from
 *             the maker's own definition), 'approximate' (close, extra controls drawn but not mapped),
 *             'user-defined' (the Customize view editor).
 *   lighting  what the hardware can actually do: 'per-key', '10-zone', 'via-firmware' (whole-board
 *             built-in modes only), 'provider-required' (no controller implemented yet).
 *   note      honest caveats shown under the preview.
 *
 * CUSTOM LAYOUTS
 *   "Customize view" lets a user move/resize keys. layoutForModel('custom', keys) validates the input,
 *   but switch IDs (and therefore Chroma coordinates) are never invented or re-wired: an unknown or
 *   duplicate ID is rejected outright.
 *
 * KEYBOARD EVENTS
 *   eventKey() maps a browser KeyboardEvent to a switch ID using `event.code` (the physical key) FIRST,
 *   and `event.key` (the produced character) only as a last resort. With NumLock off, numpad "1" types
 *   End, and Shift+1 types "!": reading .key would merge different switches. Reading .code does not.
 *
 * KEYCAP WORD PLANNER (tokens / cap / validate)
 *   An optional novelty: the user writes words (e.g. "HEX", "P[ESC]4R"), Lighting Lab lights those keys
 *   as "word islands" and checks whether a normal keycap set physically contains enough caps to spell
 *   them. tokens() splits a word into caps, cap() maps shifted symbols to the cap that carries them, and
 *   validate() counts supply vs demand.
 *
 * EXPORTED API (KeyboardPlan)
 *   rows               the four main-cluster character rows as strings (number row → bottom letter row).
 *   alternatives       preset word sets for the keycap planner.
 *   modelCatalog       every keyboard view the editor offers (see fields above).
 *   layoutForModel     build fresh {keys, controls, width, height} geometry for a model ID.
 *   eventKey           KeyboardEvent → switch ID (or null).
 *   tokens             word → list of cap tokens.
 *   cap                shifted symbol → the cap that carries it.
 *   validate           word list → list of keycap-supply problems (empty = fine).
 *   chromaCoordinates  switch ID → [row, col] in the Chroma 6 x 22 grid.
 *   defaultAnchors     switch IDs that start as anchors on a fresh setup (currently none).
 * ===================================================================================================== */
(function (root) {
  'use strict';
  // The four main-cluster rows as typed characters, number row first. Every character here is also the
  // switch ID of that key (the backslash string is one character: '\\' in source = \ at runtime).
  // These strings drive both the Chroma coordinates below and the preview geometry in mainKeys().
  const rows = ['`1234567890-=', 'QWERTYUIOP[]\\', "ASDFGHJKL;'", 'ZXCVBNM,./'];
  // Ready-made word sets for the optional keycap word planner (shown in "Keycap word planner").
  // Index 0 is the "Noob Deterrent" set referenced by the UI.
  const alternatives = [
    ['HEX', 'BUG', 'SCRIPT', '42069'],
    ['DVA', 'MECH', 'FIST', 'GLOW', '42069'],
    ['MP40', 'CR7', 'KB9', 'ALI', 'SUN', 'HOE'],
    ['42069', 'EAFC', 'NPR', 'SHIT', 'DUMB'],
  ];
  // Razer RZKEY enumeration: the transport grid differs from physical geometry.
  // https://assets.razerzone.com/dev_portal/REST/html/namespace_chroma_s_d_k_1_1_keyboard.html
  // Each value is [row, col] in the 6-row x 22-column CHROMA_CUSTOM matrix. Keys listed explicitly here
  // are the ones whose position cannot be derived from the `rows` strings (modifiers, navigation,
  // numpad operators, ISO extras, macro column). Letters, digits, F-keys and numpad digits are filled
  // in by the loops right after this object.
  const chromaCoordinates = {
    ESC: [0, 1],
    PRINT: [0, 15],
    SCROLL: [0, 16],
    PAUSE: [0, 17],
    TAB: [2, 1],
    CAPS: [3, 1],
    BACKSPACE: [1, 14],
    ENTER: [3, 14],
    LCTRL: [5, 1],
    LWIN: [5, 2],
    LALT: [5, 3],
    SPACE: [5, 7],
    RALT: [5, 11],
    RWIN: [5, 12],
    // Razer boards put Fn where the right Windows key would be, so both IDs share one LED cell.
    FN: [5, 12],
    MENU: [5, 13],
    RCTRL: [5, 14],
    LSHIFT: [4, 1],
    RSHIFT: [4, 14],
    INSERT: [1, 15],
    HOME: [1, 16],
    PGUP: [1, 17],
    DEL: [2, 15],
    END: [2, 16],
    PGDN: [2, 17],
    UP: [4, 16],
    LEFT: [5, 15],
    DOWN: [5, 16],
    RIGHT: [5, 17],
    NUM_LOCK: [1, 18],
    NUM_DIVIDE: [1, 19],
    NUM_MULTIPLY: [1, 20],
    NUM_SUBTRACT: [1, 21],
    NUM_ADD: [2, 21],
    NUM_ENTER: [4, 21],
    NUM_DECIMAL: [5, 20],
    NUM_0: [5, 19],
    // ISO (European) boards have two extra keys: # beside the tall Enter, and \ beside a short left Shift.
    ISO_HASH: [3, 13],
    ISO_BACKSLASH: [4, 2],
    // Column 0 is the dedicated macro column used by boards such as the BlackWidow V4 (M1-M5).
    MACRO1: [1, 0],
    MACRO2: [2, 0],
    MACRO3: [3, 0],
    MACRO4: [4, 0],
    MACRO5: [5, 0],
  };
  // F1..F12 live on row 0 starting at column 3 (column 2 is an unused gap between Esc and F1).
  for (let i = 1; i <= 12; i++) chromaCoordinates['F' + i] = [0, i + 2];
  // Each character row starts at a different column in Razer's grid — this offset is exactly the
  // "shifted Q/W" bug the project once had: Q is col 2 (not col 1), so lighting [2,1] lights Tab.
  [...rows[0]].forEach((id, i) => (chromaCoordinates[id] = [1, i + 1])); // ` 1 2 ... =  start at col 1
  [...rows[1]].forEach((id, i) => (chromaCoordinates[id] = [2, i + 2])); // Q W E ... \  start at col 2
  [...rows[2]].forEach((id, i) => (chromaCoordinates[id] = [3, i + 2])); // A S D ... '  start at col 2
  [...rows[3]].forEach((id, i) => (chromaCoordinates[id] = [4, i + 3])); // Z X C ... /  start at col 3
  // Numpad digits form a 3x3 block in columns 18-20: 7 8 9 on row 2, 4 5 6 on row 3, 1 2 3 on row 4.
  // For n = 1..9: row = 4 - floor((n-1)/3) climbs as n grows; col = 18 + (n-1) % 3 walks left→right.
  for (let n = 1; n <= 9; n++)
    chromaCoordinates['NUM_' + n] = [4 - Math.floor((n - 1) / 3), 18 + ((n - 1) % 3)];
  // Every keyboard view the editor offers. See the file header for what each field means. The first
  // entry is the fallback used whenever an unknown model ID is requested.
  const modelCatalog = [
    {
      id: 'standard-full-size',
      label: 'Standard full-size · ANSI 104',
      family: 'generic',
      geometry: 'full-size-with-numpad',
      accuracy: 'reference',
    },
    {
      id: 'standard-iso',
      label: 'Standard full-size · ISO 105',
      family: 'generic',
      geometry: 'full-size-iso',
      accuracy: 'reference',
    },
    {
      id: 'standard-tkl',
      label: 'Standard tenkeyless · 87 keys',
      family: 'generic',
      geometry: 'tenkeyless',
      accuracy: 'reference',
    },
    {
      id: 'standard-75',
      label: 'Standard 75% · 84-key reference',
      family: 'generic',
      geometry: '75-percent',
      accuracy: 'reference',
    },
    {
      id: 'standard-65',
      label: 'Standard 65% · 68-key reference',
      family: 'generic',
      geometry: '65-percent',
      accuracy: 'reference',
    },
    {
      id: 'standard-60',
      label: 'Standard 60% · 61 keys',
      family: 'generic',
      geometry: '60-percent',
      accuracy: 'reference',
    },
    {
      id: 'yunzii-al65',
      label: 'YUNZII AL65 · 68 keys',
      family: 'YUNZII',
      geometry: '65-percent',
      accuracy: 'model-layout',
      lighting: 'via-firmware',
      note: 'ANSI layout from the official VIA definition. Wired VIA firmware modes are available; arbitrary per-key colors are not exposed.',
    },
    {
      id: 'razer-ornata',
      label: 'Razer Ornata Chroma',
      family: 'Razer',
      geometry: 'full-size-with-numpad',
      accuracy: 'model-layout',
      lighting: 'per-key',
      note: 'Original Ornata Chroma; choose V2 or V3 explicitly for those models.',
    },
    {
      id: 'razer-ornata-v2',
      label: 'Razer Ornata V2',
      family: 'Razer',
      geometry: 'full-size-media',
      accuracy: 'approximate',
      lighting: 'per-key',
      note: '104 mapped switches plus hardware media controls. Media controls are shown for orientation without separate SDK LED mapping.',
    },
    {
      id: 'razer-ornata-v3',
      label: 'Razer Ornata V3 · 10 RGB zones',
      family: 'Razer',
      geometry: 'full-size-media',
      accuracy: 'approximate',
      lighting: '10-zone',
      note: 'V3 has ten lighting zones; independent per-key anchors and feedback cannot be reproduced on zone hardware.',
    },
    {
      id: 'razer-cynosa-chroma',
      label: 'Razer Cynosa Chroma',
      family: 'Razer',
      geometry: 'full-size-with-numpad',
      accuracy: 'model-layout',
      lighting: 'per-key',
    },
    {
      id: 'razer-blackwidow-elite',
      label: 'Razer BlackWidow Elite',
      family: 'Razer',
      geometry: 'full-size-media',
      accuracy: 'approximate',
      lighting: 'per-key',
      note: '104 mapped switches plus three media buttons and a volume dial. Hardware controls are shown for orientation without separate SDK LED mapping.',
    },
    {
      id: 'razer-blackwidow-v4',
      label: 'Razer BlackWidow V4',
      family: 'Razer',
      geometry: 'full-size-macro',
      accuracy: 'approximate',
      lighting: 'per-key',
      note: 'Five macro keys shown; additional side buttons/dials are not mapped as keyboard LEDs.',
    },
    {
      id: 'logitech-g915',
      label: 'Logitech G915',
      family: 'Logitech',
      geometry: 'full-size-macro',
      accuracy: 'approximate',
      lighting: 'provider-required',
      note: 'Five G keys shown; a compatible provider is required for RGB control.',
    },
    {
      id: 'corsair-k95',
      label: 'Corsair K95 RGB',
      family: 'Corsair',
      geometry: 'full-size-macro',
      accuracy: 'approximate',
      lighting: 'provider-required',
      note: 'Macro/media keys vary by K95 generation; use Customize view for your variant.',
    },
    {
      id: 'steelseries-apex-pro',
      label: 'SteelSeries Apex Pro · full-size',
      family: 'SteelSeries',
      geometry: 'full-size-media',
      accuracy: 'approximate',
      lighting: 'provider-required',
      note: 'Main switches shown; OLED/media controls excluded from the RGB switch map.',
    },
    // Pseudo-model for the "Customize view" editor; its geometry comes from the user, not a builder.
    { id: 'custom', label: 'Customize view', family: 'custom', geometry: 'custom', accuracy: 'user-defined' },
  ];
  // Printed legends for switches whose ID is not already a nice label. Anything missing falls back to the
  // ID itself ('Q', 'F5') or, for numpad keys, the ID without its 'NUM_' prefix ('NUM_7' → '7').
  const labels = {
    ESC: 'Esc',
    BACKSPACE: 'Backspace',
    TAB: 'Tab',
    CAPS: 'Caps',
    ENTER: 'Enter',
    LSHIFT: 'Shift',
    RSHIFT: 'Shift',
    LCTRL: 'Ctrl',
    RCTRL: 'Ctrl',
    LWIN: 'Win',
    RWIN: 'Win',
    LALT: 'Alt',
    RALT: 'Alt',
    SPACE: 'Space',
    FN: 'Fn',
    MENU: 'Menu',
    PRINT: 'PrtSc',
    SCROLL: 'ScrLk',
    PAUSE: 'Pause',
    INSERT: 'Ins',
    HOME: 'Home',
    PGUP: 'PgUp',
    DEL: 'Del',
    END: 'End',
    PGDN: 'PgDn',
    UP: '↑',
    LEFT: '←',
    DOWN: '↓',
    RIGHT: '→',
    NUM_LOCK: 'Num',
    NUM_DIVIDE: '/',
    NUM_MULTIPLY: '*',
    NUM_SUBTRACT: '−', // U+2212 MINUS SIGN, visually distinct from the main-row hyphen.
    NUM_ADD: '+',
    NUM_ENTER: 'Enter',
    NUM_DECIMAL: '.',
    ISO_HASH: '#',
    ISO_BACKSLASH: '\\',
  };
  /**
   * Build one preview key.
   * @param {string} id  Switch ID (must exist in chromaCoordinates for it to light up).
   * @param {number} x   Left edge in key units (1u = one standard key width).
   * @param {number} y   Top edge in key units (rows are 1u tall; the function row sits 1.25u above row 1).
   * @param {number} [w=1] Width in key units.
   * @param {number} [h=1] Height in key units (2 for numpad + and Enter).
   * @returns {{id:string,label:string,x:number,y:number,w:number,h:number}}
   * @example key('BACKSPACE', 13, 1.25, 2) // → {id:'BACKSPACE', label:'Backspace', x:13, y:1.25, w:2, h:1}
   */
  function key(id, x, y, w = 1, h = 1) {
    return { id, label: labels[id] || (id.startsWith('NUM_') ? id.slice(4) : id), x, y, w, h };
  }
  /**
   * Append a left-to-right row of keys, advancing x by each key's width.
   * @param {object[]} keys  Array to push into (mutated).
   * @param {Array<string|[string, number]>} spec  Each entry is a switch ID (1u wide) or [id, widthInUnits].
   *   A string spread like ...'QWE' contributes one 1u key per character.
   * @param {number} y      Row top in key units.
   * @param {number} [x=0]  Starting left edge in key units.
   * @returns {void}
   */
  function addRow(keys, spec, y, x = 0) {
    for (const entry of spec) {
      const [id, w] = Array.isArray(entry) ? entry : [entry, 1];
      keys.push(key(id, x, y, w));
      x += w;
    }
  }
  // The physical number row begins under Escape. Function-key clusters keep their own deliberate gaps.
  /**
   * The five-row main typing cluster (number row through the bottom modifier row) using standard ANSI
   * widths: Tab 1.5u, Caps 1.75u, Enter 2.25u, left Shift 2.25u, right Shift 2.75u, Space 6.25u,
   * bottom modifiers 1.25u each. Every row adds up to 15u.
   * @param {number} [offset=1.25] y of the number row. 1.25 leaves room for a function row (1u + 0.25u gap)
   *   above it; compact boards without an F-row pass 0.
   * @param {number} [xOffset=0] x of the left edge (used when a macro column sits to the left).
   * @returns {object[]} Fresh key objects (callers may mutate them).
   */
  function mainKeys(offset = 1.25, xOffset = 0) {
    const keys = [];
    addRow(keys, [...rows[0], ['BACKSPACE', 2]], offset, xOffset);
    // rows[1].slice(0, -1) drops the trailing backslash so it can be added as a 1.5u key at the end.
    addRow(keys, [['TAB', 1.5], ...rows[1].slice(0, -1), ['\\', 1.5]], offset + 1, xOffset);
    addRow(keys, [['CAPS', 1.75], ...rows[2], ['ENTER', 2.25]], offset + 2, xOffset);
    addRow(keys, [['LSHIFT', 2.25], ...rows[3], ['RSHIFT', 2.75]], offset + 3, xOffset);
    addRow(
      keys,
      [
        ['LCTRL', 1.25],
        ['LWIN', 1.25],
        ['LALT', 1.25],
        ['SPACE', 6.25],
        ['RALT', 1.25],
        ['RWIN', 1.25],
        ['MENU', 1.25],
        ['RCTRL', 1.25],
      ],
      offset + 4,
      xOffset,
    );
    return keys;
  }
  /**
   * Full-size (104-key ANSI) or tenkeyless (87-key) geometry: main cluster + function row + navigation
   * block + arrows, and optionally the numpad.
   * Horizontal landmarks (key units): main cluster 0..15, navigation block 15.5..18.5 (0.5u gap),
   * numpad 19..23 (another 0.5u gap).
   * @param {boolean} [numpad=true] false builds a tenkeyless board.
   * @returns {object[]} Fresh key objects.
   */
  function fullKeys(numpad = true) {
    const keys = mainKeys();
    keys.push(key('ESC', 0, 0));
    // F1 starts at x=2 (a 1u gap after Esc). F-keys come in groups of four with a 0.5u gap between
    // groups, so F5 is at 2 + 4 + 0.5 = 6.5 and F9 at 2 + 8 + 1.0 = 11.
    for (let n = 1; n <= 12; n++) keys.push(key('F' + n, 2 + (n - 1) + Math.floor((n - 1) / 4) * 0.5, 0));
    ['PRINT', 'SCROLL', 'PAUSE'].forEach((id, i) => keys.push(key(id, 15.5 + i, 0)));
    // Two rows of navigation keys aligned with the number row and the Q row (y 1.25 and 2.25).
    [
      ['INSERT', 'HOME', 'PGUP'],
      ['DEL', 'END', 'PGDN'],
    ].forEach((ids, r) => ids.forEach((id, i) => keys.push(key(id, 15.5 + i, 1.25 + r))));
    // Inverted-T arrows: Up sits on the Shift row (y 4.25), Left/Down/Right on the bottom row (y 5.25).
    keys.push(key('UP', 16.5, 4.25));
    ['LEFT', 'DOWN', 'RIGHT'].forEach((id, i) => keys.push(key(id, 15.5 + i, 5.25)));
    if (numpad) {
      ['NUM_LOCK', 'NUM_DIVIDE', 'NUM_MULTIPLY', 'NUM_SUBTRACT'].forEach((id, i) =>
        keys.push(key(id, 19 + i, 1.25)),
      );
      // Same 3x3 digit block as the Chroma grid: 7-9 on y 2.25, 4-6 on y 3.25, 1-3 on y 4.25.
      for (let n = 1; n <= 9; n++)
        keys.push(key('NUM_' + n, 19 + ((n - 1) % 3), 4.25 - Math.floor((n - 1) / 3)));
      // Tall + and Enter (2u high), wide 0 (2u), and the decimal point.
      keys.push(
        key('NUM_ADD', 22, 2.25, 1, 2),
        key('NUM_ENTER', 22, 4.25, 1, 2),
        key('NUM_0', 19, 5.25, 2),
        key('NUM_DECIMAL', 21, 5.25),
      );
    }
    return keys;
  }
  /**
   * 65% geometry (68 keys, e.g. YUNZII AL65): the main cluster with no function row, Esc in place of
   * the backtick, a shortened right Shift, Fn + arrows on the bottom right, and a 1u column of
   * Del / PgUp / PgDn / End down the right edge.
   * @returns {object[]} Fresh key objects starting at y = 0.
   */
  function compactKeys() {
    // Compact boards have no Menu key or right Windows key.
    const keys = mainKeys(0).filter((k) => !['MENU', 'RWIN'].includes(k.id));
    // The top-left key is Esc on a 65% board (backtick moves to an Fn layer).
    Object.assign(
      keys.find((k) => k.id === '`'),
      { id: 'ESC', label: 'Esc' },
    );
    // Right Shift shrinks from 2.75u to 1.75u to make room for the Up arrow.
    Object.assign(
      keys.find((k) => k.id === 'RSHIFT'),
      { w: 1.75 },
    );
    // Right-hand modifiers become 1u keys so Fn and the arrow cluster fit on the bottom row.
    Object.assign(
      keys.find((k) => k.id === 'RALT'),
      { x: 10, w: 1 },
    );
    Object.assign(
      keys.find((k) => k.id === 'RCTRL'),
      { x: 12, w: 1 },
    );
    // Bottom row: RAlt(10) Fn(11) RCtrl(12) Left(13) Down(14) Right(15); Up sits above Down.
    keys.push(
      key('FN', 11, 4),
      key('LEFT', 13, 4),
      key('DOWN', 14, 4),
      key('RIGHT', 15, 4),
      key('UP', 14, 3),
    );
    // A 1u column down the right edge at x = 15: Del (row 0), PgUp, PgDn, End (row 3, right of Up).
    ['DEL', 'PGUP', 'PGDN', 'END'].forEach((id, r) => keys.push(key(id, 15, r)));
    return keys;
  }
  /**
   * Hardware silhouettes improve model recognition without inventing controllable RGB channels.
   * Media buttons and volume dials are drawn so the preview LOOKS like the user's keyboard, but they
   * are marked rgb:false / selectable:false: the Chroma keyboard grid has no LED cell for them.
   * @param {string} modelId  A modelCatalog id.
   * @returns {Array<{id:string,label:string,title:string,x:number,y:number,w:number,h:number,
   *   type:'button'|'dial',rgb:false,selectable:false,description:string}>} Empty for most models.
   */
  function hardwareControls(modelId) {
    const description = 'Physical media control; no separate SDK LED is mapped.';
    /**
     * One inert control in the top-right corner (y≈0, above the numpad).
     * Buttons are drawn 0.85u x 0.7u and nudged down 0.15u to look smaller than keys; dials are a 1u circle.
     */
    function control(id, label, title, x, type = 'button') {
      return {
        id,
        label,
        title,
        x,
        y: type === 'dial' ? 0 : 0.15,
        w: type === 'dial' ? 1 : 0.85,
        h: type === 'dial' ? 1 : 0.7,
        type,
        rgb: false,
        selectable: false,
        description,
      };
    }
    // Elite master guide pp.6,9–10 and Ornata V2 official product/support specify three media buttons plus wheel.
    if (['razer-blackwidow-elite', 'razer-ornata-v2'].includes(modelId))
      return [
        control('HW_PREVIOUS', '⏮', 'Previous track', 19),
        control('HW_PLAY_PAUSE', '▶Ⅱ', 'Play / pause', 20),
        control('HW_NEXT', '⏭', 'Next track', 21),
        control('HW_VOLUME_DIAL', 'Vol', 'Volume dial / press to mute', 22, 'dial'),
      ];
    // Ornata V3 master guide pp.2,5 has four buttons, unlike V2's wheel.
    if (modelId === 'razer-ornata-v3')
      return [
        control('HW_MEDIA', '▶Ⅱ', 'Media: play / pause; multiple presses skip tracks', 19),
        control('HW_MUTE', 'Mute', 'Mute / unmute', 20),
        control('HW_VOLUME_DOWN', '−', 'Volume down', 21),
        control('HW_VOLUME_UP', '+', 'Volume up', 22),
      ];
    return [];
  }
  /**
   * Return fresh unit-based geometry. Custom coordinates change the view, never SDK wiring.
   *
   * Builds the complete drawing for one keyboard model. A NEW object is returned every call, so callers
   * may mutate it freely (the Customize view editor does).
   *
   * @param {string} [id='standard-full-size'] A modelCatalog id. Unknown ids fall back to the first entry.
   * @param {Array|{keys:Array}} [customLayout] Only used when id === 'custom': a list of
   *   {id, x, y, w?, h?, label?}. Limits: 1-150 keys; x 0..40, y 0..20 (key units); w in (0, 10];
   *   h in (0, 3]; every id must be a known switch, and no id may repeat. Labels are cut to 20 characters.
   * @returns {object} The catalog entry spread together with:
   *   keys      Array<{id,label,x,y,w,h,shape?}> — selectable, lightable switches.
   *   controls  Array from hardwareControls() — inert media buttons/dials.
   *   width     right-most edge in key units (used to size the drawing).
   *   height    bottom-most edge in key units.
   *   caseInset 0.5u of padding the UI draws around the keys as the keyboard case.
   * @throws {Error} For invalid custom layouts (message is shown to the user).
   * @example layoutForModel('standard-65').keys.length // → 68
   */
  function layoutForModel(id = 'standard-full-size', customLayout) {
    const model = modelCatalog.find((m) => m.id === id) || modelCatalog[0];
    let keys;
    if (model.id === 'custom' && customLayout) {
      // Accept either a bare key array or a saved "view JSON" object {format, baseModel, keys}.
      const input = Array.isArray(customLayout) ? customLayout : customLayout.keys;
      if (!Array.isArray(input) || input.length < 1 || input.length > 150)
        throw new Error('Custom view needs 1–150 switches.');
      const seen = new Set();
      keys = input.map((k) => {
        if (!chromaCoordinates[k.id] || seen.has(k.id))
          throw new Error('Custom view contains an unknown or duplicate switch.');
        seen.add(k.id);
        if (
          ![k.x, k.y, k.w ?? 1, k.h ?? 1].every(Number.isFinite) ||
          k.x < 0 ||
          k.y < 0 ||
          k.x > 40 ||
          k.y > 20 ||
          (k.w ?? 1) <= 0 ||
          (k.w ?? 1) > 10 ||
          (k.h ?? 1) <= 0 ||
          (k.h ?? 1) > 3
        )
          throw new Error('Custom view coordinates are out of range.');
        return {
          ...key(k.id, k.x, k.y, k.w ?? 1, k.h ?? 1),
          label: String(k.label || labels[k.id] || k.id).slice(0, 20),
        };
      });
    } else if (model.geometry === '60-percent') {
      // 60%: just the main cluster; keys[0] is the backtick, which becomes Esc on these boards.
      keys = mainKeys(0);
      Object.assign(keys[0], { id: 'ESC', label: 'Esc' });
    } else if (model.geometry === '65-percent') keys = compactKeys();
    else if (model.geometry === '75-percent') {
      // 75%: the 65% body shifted down 1.25u, the backtick restored in the top-left, and a tight
      // function row (Esc F1..F12 PrtSc ScrLk Pause, 16 keys side by side with no gaps) on top.
      keys = compactKeys();
      keys.forEach((k) => (k.y += 1.25));
      Object.assign(
        keys.find((k) => k.id === 'ESC'),
        { id: '`', label: '`' },
      );
      ['ESC', ...Array.from({ length: 12 }, (_, i) => 'F' + (i + 1)), 'PRINT', 'SCROLL', 'PAUSE'].forEach(
        (id, i) => keys.push(key(id, i, 0)),
      );
    } else keys = fullKeys(model.geometry !== 'tenkeyless');
    // ISO modifies a full-size board: no ANSI backslash above Enter, a tall stepped Enter (drawn with
    // shape 'iso-enter'), a 1.25u left Shift, and two extra keys (ISO \ beside Shift, # beside Enter).
    if (model.geometry === 'full-size-iso') {
      keys = keys.filter((k) => k.id !== '\\');
      Object.assign(
        keys.find((k) => k.id === 'ENTER'),
        { x: 13.5, y: 2.25, w: 1.5, h: 2, shape: 'iso-enter' },
      );
      Object.assign(
        keys.find((k) => k.id === 'LSHIFT'),
        { w: 1.25 },
      );
      keys.push(key('ISO_BACKSLASH', 1.25, 4.25), key('ISO_HASH', 12.75, 3.25, 0.75));
    }
    // Razer full-size boards print Fn where the right Windows key would be (same Chroma cell [5,12]).
    if (model.family === 'Razer')
      Object.assign(
        keys.find((k) => k.id === 'RWIN'),
        { id: 'FN', label: 'Fn' },
      );
    // Macro boards: shift everything right by 1.25u and add a column of five macro keys (M1..M5),
    // aligned with the number row through the bottom row (y 1.25 .. 5.25).
    if (model.geometry === 'full-size-macro') {
      keys.forEach((k) => (k.x += 1.25));
      for (let i = 1; i <= 5; i++) keys.push(key('MACRO' + i, 0, i + 0.25));
    }
    const controls = hardwareControls(model.id),
      allParts = [...keys, ...controls];
    return {
      ...model,
      keys,
      controls,
      width: Math.max(...allParts.map((k) => k.x + k.w)),
      height: Math.max(...allParts.map((k) => k.y + k.h)),
      caseInset: 0.5,
    };
  }
  // KeyboardEvent.code (physical key position, layout-independent) → switch ID, for every code whose
  // switch ID cannot be derived by a simple pattern. Letters (KeyA), digits (Digit1), numpad digits
  // (Numpad1) and F-keys (F1) are handled by regular expressions in eventKey().
  const eventCodes = {
    Escape: 'ESC',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backspace: 'BACKSPACE',
    Tab: 'TAB',
    CapsLock: 'CAPS',
    Enter: 'ENTER',
    ShiftLeft: 'LSHIFT',
    ShiftRight: 'RSHIFT',
    ControlLeft: 'LCTRL',
    ControlRight: 'RCTRL',
    MetaLeft: 'LWIN',
    MetaRight: 'RWIN',
    AltLeft: 'LALT',
    AltRight: 'RALT',
    Space: 'SPACE',
    ContextMenu: 'MENU',
    PrintScreen: 'PRINT',
    ScrollLock: 'SCROLL',
    Pause: 'PAUSE',
    Insert: 'INSERT',
    Delete: 'DEL',
    Home: 'HOME',
    End: 'END',
    PageUp: 'PGUP',
    PageDown: 'PGDN',
    ArrowUp: 'UP',
    ArrowDown: 'DOWN',
    ArrowLeft: 'LEFT',
    ArrowRight: 'RIGHT',
    NumLock: 'NUM_LOCK',
    NumpadDivide: 'NUM_DIVIDE',
    NumpadMultiply: 'NUM_MULTIPLY',
    NumpadSubtract: 'NUM_SUBTRACT',
    NumpadAdd: 'NUM_ADD',
    NumpadEnter: 'NUM_ENTER',
    NumpadDecimal: 'NUM_DECIMAL',
    IntlBackslash: 'ISO_BACKSLASH',
  };
  /**
   * Resolve physical switches before typed characters so NumLock and Shift cannot merge keys.
   *
   * Order of preference:
   *   1. event.code lookup table (punctuation, modifiers, navigation, numpad operators).
   *   2. event.code patterns: 'KeyQ' → 'Q', 'Digit1' → '1', 'Numpad1' → 'NUM_1', 'F5' → 'F5'.
   *   3. event.key upper-cased, ONLY if it is itself a known switch ID (old browsers / synthetic events).
   * F13-F24 and other keys with no LED in the Chroma grid return null and are ignored by callers.
   *
   * @param {KeyboardEvent|{code?:string,key?:string}} event  A real or synthetic key event.
   * @returns {string|null} Switch ID, or null if this key has no lightable switch.
   * @example eventKey({code:'NumpadDecimal', key:'Delete'}) // → 'NUM_DECIMAL' (NumLock off still maps right)
   */
  function eventKey(event) {
    const code = event?.code || '';
    if (eventCodes[code]) return eventCodes[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3); // 'KeyQ'.slice(3) → 'Q'
    if (/^Digit[0-9]$/.test(code)) return code.slice(5); // 'Digit7'.slice(5) → '7'
    if (/^Numpad[0-9]$/.test(code)) return 'NUM_' + code.slice(6); // 'Numpad7' → 'NUM_7'
    if (/^F([1-9]|1[0-2])$/.test(code)) return code; // F1..F12 only; F13+ have no LED cell
    const id = String(event?.key || '').toUpperCase();
    return chromaCoordinates[id] ? id : null;
  }
  /**
   * Split a planner word into keycap tokens. A bracketed name is one whole cap; everything else is one
   * character per cap. Letters are upper-cased.
   * @param {string} word  e.g. 'P[ESC]4r'
   * @returns {string[]} e.g. ['P', 'ESC', '4', 'R']
   */
  function tokens(word) {
    return (word.toUpperCase().match(/\[[A-Z]+\]|./g) || []).map((x) =>
      x.startsWith('[') ? x.slice(1, -1) : x,
    );
  }
  /**
   * Which physical cap carries a token. Shifted US-layout symbols live on the cap of their unshifted
   * partner ('!' is printed on the '1' cap, '?' on the '/' cap). Anything else is its own cap.
   * @param {string} token  One token from tokens().
   * @returns {string} Cap switch ID.
   * @example cap('!') // → '1'
   */
  function cap(token) {
    return (
      {
        '!': '1',
        '@': '2',
        '#': '3',
        $: '4',
        '%': '5',
        '^': '6',
        '&': '7',
        '*': '8',
        '(': '9',
        ')': '0',
        _: '-',
        '+': '=',
        '{': '[',
        '}': ']',
        '|': '\\',
        ':': ';',
        '"': "'",
        '<': ',',
        '>': '.',
        '?': '/',
        '~': '`',
      }[token] || token
    );
  }
  /**
   * Count real cap supply including independent top-row and numpad numerals.
   *
   * A standard set has ONE cap per letter/symbol. Digits 1-9 and . / * - also exist on the numpad, so
   * when `numpad` is true they have a supply of 2. Three kinds of problem are reported:
   *   - a token whose cap is not a confirmed 1u cap in a normal set ("cap availability/1u size not confirmed");
   *   - a cap needed more times than the set contains;
   *   - a shifted symbol used twice: numpad caps never carry shifted legends, so both uses need the one
   *     main-cluster cap.
   * @param {string[]} words  Planner words (see tokens()).
   * @param {boolean} [numpad=true]  Whether numpad caps count as extra supply.
   * @returns {string[]} De-duplicated human-readable problems; empty when the words fit the cap set.
   */
  function validate(words, numpad = true) {
    const counts = new Map(), // cap ID → times needed
      errors = [],
      mainOnly = new Map(), // cap ID → times needed via a SHIFTED symbol (main cluster only)
      // Caps assumed present and 1u wide in a common US set (Enter/Shift/etc. are not 1u, so excluded).
      available = new Set([
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`-=[]\\;',./",
        'ESC',
        'DEL',
        'HOME',
        'END',
        'INSERT',
        'PGUP',
        'PGDN',
      ]);
    words.forEach((word) =>
      tokens(word).forEach((token) => {
        const id = cap(token);
        counts.set(id, (counts.get(id) || 0) + 1);
        if (token !== id) mainOnly.set(id, (mainOnly.get(id) || 0) + 1);
        if (!available.has(id)) errors.push(`${token}: cap availability/1u size not confirmed`);
      }),
    );
    for (const [id, count] of counts) {
      // Numpad duplicates: 1-9 and . / * -. (The numpad 0 cap is 2u wide, so 0 is not counted twice.)
      const supply = numpad && /^[1-9./*\-]$/.test(id) ? 2 : 1;
      if (count > supply) errors.push(`${id}: needs ${count} physical caps; assumed supply ${supply}`);
      if ((mainOnly.get(id) || 0) > 1)
        errors.push(`${id}: repeated shifted legends require the same main-cluster cap`);
    }
    return [...new Set(errors)];
  }
  // A brand-new setup starts with no anchor keys; the user paints them. (Kept as an export because
  // lighting-domain.cjs and the UI compare against it to detect an "untouched" setup.)
  const defaultAnchors = [];
  // Public API — see the file header for a one-line description of each member.
  root.KeyboardPlan = {
    rows,
    alternatives,
    modelCatalog,
    layoutForModel,
    eventKey,
    tokens,
    cap,
    validate,
    chromaCoordinates,
    defaultAnchors,
  };
  // In Node (CommonJS) also export it; in the browser `module` is undefined and the global is enough.
  if (typeof module !== 'undefined') module.exports = root.KeyboardPlan;
})(typeof globalThis !== 'undefined' ? globalThis : window);
