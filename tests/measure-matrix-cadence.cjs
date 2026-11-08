// Matrix cadence harness: drives the REAL providers/chroma-sdk.cjs with a fake Chroma REST service whose latency
// follows the distribution measured on the dev PC (p50 ~16.6 ms, occasional ~57 ms), and records every keyboard
// frame at the moment it would reach the LEDs. Reports how long each Matrix row stayed lit and how often the falling
// line skipped a row or stalled. Usage: node matrix-cadence.cjs <repoRoot> [mouseSync=0|1] [seconds=20]
const path = require('path');
// Defaults to this repository; pass another checkout (e.g. an older version) to compare before/after.
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const mouseSync = process.argv[3] === '1';
const seconds = Number(process.argv[4] || 20);
const { createChromaSdkProvider } = require(path.join(root, 'providers/chroma-sdk.cjs'));
const { validateSelection } = require(path.join(root, 'lighting-domain.cjs'));
const Plan = require(path.join(root, 'core.js'));

// Latency model: Windows HTTP timer quantum dominates (~15.6 ms); 4% of calls hit ~45-60 ms.
const latency = () => (Math.random() < 0.04 ? 45 + Math.random() * 15 : 15 + Math.random() * 3);
const frames = [];
let requests = 0;
const t0 = performance.now();
const fetchImpl = async (url, options = {}) => {
  requests++;
  await new Promise((resolve) => setTimeout(resolve, latency()));
  const method = options.method || 'GET';
  let body = {};
  if (String(url).endsWith('/razer/chromasdk') && method === 'POST')
    body = { uri: 'http://localhost:54236/chromasdk', sessionid: 1 };
  else if (String(url).endsWith('/keyboard')) {
    const frame = JSON.parse(options.body);
    // The line is lit where green is high and red is zero; read rows down column 3 (keys 2 / W / S / X region).
    const rows = frame.param.map((row) => (row[3] >> 8) & 255);
    const lit = rows.findIndex((green) => green > 200);
    frames.push({ at: performance.now() - t0, lit });
    if (method === 'POST') body = { id: 'effect-1', result: 0 };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ result: 0, ...body }) };
};

(async () => {
  const sdk = createChromaSdkProvider({ fetchImpl });
  const selection = validateSelection({
    provider: 'chroma-sdk',
    effect: 'matrix',
    anchors: [],
    speed: 3.5,
    mouseSync,
    keyboardModel: 'standard-full-size',
  });
  await sdk.apply(selection, { force: true });
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  await sdk.release();
  // Collapse consecutive frames that show the same row into "dwell" segments.
  const segments = [];
  for (const frame of frames) {
    const last = segments.at(-1);
    if (last && last.lit === frame.lit) last.end = frame.at;
    else segments.push({ lit: frame.lit, start: frame.at, end: frame.at });
  }
  const dwell = [];
  let skips = 0,
    stalls = 0,
    transitions = 0;
  for (let i = 1; i < segments.length; i++) {
    const previous = segments[i - 1],
      current = segments[i];
    if (previous.lit >= 0 && current.lit >= 0) {
      transitions++;
      if (current.lit - previous.lit > 1) skips++;
      const held = current.start - previous.start;
      dwell.push(held);
      if (held > 230 * 1.4) stalls++;
    }
  }
  // Lateness of each row change vs. its ideal 230 ms boundary (phase taken from the median residual).
  const changeTimes = segments
    .slice(1)
    .filter((s) => s.lit >= 0)
    .map((s) => s.start);
  const residuals = changeTimes.map((at) => ((at % 230) + 230) % 230).sort((a, b) => a - b);
  const phase = residuals[Math.floor(residuals.length / 2)] || 0;
  const late = changeTimes
    .map((at) => {
      let r = (((at - phase) % 230) + 230) % 230;
      if (r > 115) r -= 230;
      return r;
    })
    .sort((a, b) => a - b);
  globalThis.latenessMs = {
    p10: late[Math.floor(late.length * 0.1)]?.toFixed(0),
    p50: late[Math.floor(late.length / 2)]?.toFixed(0),
    p90: late[Math.floor(late.length * 0.9)]?.toFixed(0),
    spread: (late.at(-1) - late[0]).toFixed(0),
  };
  dwell.sort((a, b) => a - b);
  const q = (p) => (dwell.length ? dwell[Math.floor((dwell.length - 1) * p)].toFixed(0) : '-');
  const gaps = frames
    .slice(1)
    .map((f, i) => f.at - frames[i].at)
    .sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      mouseSync,
      seconds,
      framesDelivered: frames.length,
      requests,
      frameGapMs: {
        p50: gaps[Math.floor(gaps.length / 2)]?.toFixed(1),
        p90: gaps[Math.floor(gaps.length * 0.9)]?.toFixed(1),
        max: gaps.at(-1)?.toFixed(1),
      },
      rowTransitions: transitions,
      latenessMs: globalThis.latenessMs,
      skippedRows: skips,
      stalls_over_1_4x: stalls,
      rowDwellMs: { ideal: 230, min: q(0), p10: q(0.1), p50: q(0.5), p90: q(0.9), max: q(1) },
    }),
  );
})();
