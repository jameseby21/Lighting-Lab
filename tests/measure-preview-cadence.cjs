// Preview cadence harness: serves the editor from <repoRoot> with a provider-less fixture (no real API, so no
// hardware is touched), opens it in headless Edge, switches to Matrix, and records - in the page, on every
// animation frame - which physical row of a column is lit. Reports per-row dwell and skips.
// Usage: node preview-cadence.cjs <repoRoot> [seconds=12] [model=standard-full-size]
const http = require('http'),
  fs = require('fs'),
  path = require('path'),
  os = require('os');
const { spawn } = require('child_process');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const seconds = Number(process.argv[3] || 12);
const model = process.argv[4] || 'standard-full-size';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const files = ['index.html', 'core.js', 'effects.js', 'layout-guide.js', 'ui.js', 'styles.css'];
(async () => {
  const server = http.createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
    if (files.includes(name)) {
      res.writeHead(200, {
        'content-type': name.endsWith('.js')
          ? 'text/javascript'
          : name.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      });
      return res.end(fs.readFileSync(path.join(root, name)));
    }
    if (name.startsWith('assets/')) {
      const file = path.join(root, name);
      if (fs.existsSync(file)) {
        res.writeHead(200);
        return res.end(fs.readFileSync(file));
      }
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"fixture: no provider"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'll-cadence-'));
  const edge = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].find((f) => fs.existsSync(f));
  const browser = spawn(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try {
        port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      } catch {}
      await wait(100);
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m.result);
        pending.delete(m.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((r) => {
        const id = ++seq;
        pending.set(id, r);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) =>
      (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1400,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      if (await evaluate('typeof configuration==="function"&&document.querySelectorAll(".key").length>50'))
        break;
      await wait(100);
    }
    const result = await evaluate(`(async()=>{
      try{localStorage.clear();}catch{}
      const set=(id,v)=>{const el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event('change'));};
      set('keyboard-model','${model}');set('background','matrix');
      // Physical rows of the drawn layout (top y of each key), and the keys in each row.
      const keys=[...document.querySelectorAll('.key')];const ys=[...new Set(keys.map(k=>parseFloat(k.style.top)))].sort((a,b)=>a-b);
      const rowOf=k=>ys.indexOf(parseFloat(k.style.top));
      const samples=[];const start=performance.now();
      await new Promise(done=>{const tick=now=>{const lit=new Set();for(const k of keys){const [r,g,b]=(k.dataset.rgb||'0,0,0').split(',').map(Number);if(g>200&&r<30)lit.add(rowOf(k));}
        samples.push({at:now-start,rows:[...lit].sort()});if(now-start<${seconds * 1000})requestAnimationFrame(tick);else done();};requestAnimationFrame(tick);});
      return {rows:ys.length,samples};
    })()`);
    const segments = [];
    for (const s of result.samples) {
      const key = s.rows.join(',');
      const last = segments.at(-1);
      if (last && last.key === key) last.end = s.at;
      else segments.push({ key, rows: s.rows, start: s.at, end: s.at });
    }
    let skips = 0,
      multi = 0,
      transitions = 0;
    const dwell = [];
    for (let i = 1; i < segments.length; i++) {
      const a = segments[i - 1],
        b = segments[i];
      if (b.rows.length > 1) multi++;
      if (a.rows.length === 1 && b.rows.length === 1) {
        transitions++;
        if (b.rows[0] - a.rows[0] > 1) skips++;
        dwell.push(b.start - a.start);
      }
    }
    dwell.sort((x, y) => x - y);
    const q = (p) => (dwell.length ? dwell[Math.floor((dwell.length - 1) * p)].toFixed(0) : '-');
    const gaps = result.samples
      .slice(1)
      .map((s, i) => s.at - result.samples[i].at)
      .sort((x, y) => x - y);
    console.log(
      JSON.stringify({
        model,
        physicalRows: result.rows,
        rafGapP50: gaps[Math.floor(gaps.length / 2)]?.toFixed(1),
        transitions,
        skippedRows: skips,
        framesWithTwoRowsLit: multi,
        rowDwellMs: { ideal: 230, min: q(0), p10: q(0.1), p50: q(0.5), p90: q(0.9), max: q(1) },
      }),
    );
    ws.close();
  } finally {
    browser.kill();
    server.close();
    await wait(300);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
})();
