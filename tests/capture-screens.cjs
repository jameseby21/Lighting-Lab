// Screenshot harness for visual review: serves the editor with realistic FIXTURE data (no real API, no hardware)
// and captures Simple mode, All controls, App Profiles, and a phone view into <outDir>.
// Usage: node screens.cjs <repoRoot> <outDir>
const http = require('http'),
  fs = require('fs'),
  path = require('path'),
  os = require('os');
const { spawn } = require('child_process');
const [rawRoot, rawOut] = process.argv.slice(2);
const root = path.resolve(rawRoot || path.join(__dirname, '..'));
const out = path.resolve(rawOut || path.join(root, '.artifacts', 'screens'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const K = require(path.join(root, 'core.js'));
const all = Object.keys(K.chromaCoordinates);
const groups = (bg, anchorKeys, anchorColor, reaction) => ({
  anchor: {
    keys: anchorKeys,
    base: 'static',
    color: anchorColor,
    dynamic: 'none',
    reaction,
    reactionColor: '#2aa8ff',
  },
  background: {
    keys: all.filter((id) => !anchorKeys.includes(id) && id !== 'ESC'),
    base: bg === 'solid' ? 'static' : 'off',
    color: '#3b2a7a',
    dynamic: bg === 'solid' ? 'none' : bg,
    reaction: 'ripple',
    reactionColor: '#ffffff',
  },
  orientation: {
    keys: ['ESC'],
    base: 'static',
    color: '#5fd6e8',
    dynamic: 'none',
    reaction: 'none',
    reactionColor: '#ffffff',
  },
});
const profile = (id, name, bg, keys, color, reaction) => ({
  id,
  name,
  software: 'lighting-lab',
  updatedAt: '2026-10-20T00:00:00Z',
  settings: {
    provider: 'chroma-sdk',
    effect: bg,
    keyboardModel: 'standard-full-size',
    speed: 3.5,
    groups: groups(bg, keys, color, reaction),
  },
});
const profiles = [
  profile(
    '11111111-1111-4111-8111-111111111111',
    'My Lighting',
    'chaos',
    ['Q', 'W', 'E', 'R', 'T'],
    '#5b3cff',
    'ripple',
  ),
  profile(
    '22222222-2222-4222-8222-222222222222',
    'Code Focus',
    'solid',
    ['[', ']', ';', "'", 'F', 'J'],
    '#f2b94b',
    'flash',
  ),
  profile(
    '33333333-3333-4333-8333-333333333333',
    'WASD Arena',
    'fire',
    ['W', 'A', 'S', 'D'],
    '#ff2a2a',
    'flame',
  ),
  profile('44444444-4444-4444-8444-444444444444', 'Music Mode', 'spectrum', [], '#ff7ad9', 'pulse'),
];
const rules = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Visual Studio Code',
    executable: 'Code.exe',
    condition: 'foreground',
    profileId: profiles[1].id,
    enabled: true,
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Valorant',
    executable: 'VALORANT.exe',
    condition: 'fullscreen',
    profileId: profiles[2].id,
    enabled: true,
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    name: 'Spotify',
    executable: 'Spotify.exe',
    condition: 'running',
    profileId: profiles[3].id,
    enabled: false,
  },
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    name: '11 pm to 7 am',
    executable: null,
    condition: 'time',
    from: '23:00',
    to: '07:00',
    profileId: profiles[0].id,
    enabled: true,
  },
];
const config = {
  version: 1,
  automatic: true,
  waitMs: 1000,
  transitionMs: 400,
  defaultProfileId: profiles[0].id,
  rules,
};
const runtime = {
  available: true,
  apps: [
    { executable: 'Code.exe', running: true, foreground: true, fullscreen: false },
    { executable: 'VALORANT.exe', running: false, foreground: false, fullscreen: false },
    { executable: 'Spotify.exe', running: true, foreground: false, fullscreen: false },
  ],
  activeId: rules[0].id,
  activeRule: rules[0],
  activeProfileName: 'Code Focus',
  detail: 'Active: Visual Studio Code → Code Focus.',
};
const discoveries = ['Code.exe', 'chrome.exe', 'Discord.exe', 'Spotify.exe', 'EXCEL.EXE', 'obs64.exe'].map(
  (executable, i) => ({ executable, running: true, foreground: i === 0, fullscreen: false }),
);
const json = (res, v) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(v));
};
(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/status')
      return json(res, {
        sdk: { available: true },
        synapse: { available: false },
        device: {
          model: 'Razer BlackWidow Elite',
          modelId: 'razer-blackwidow-elite',
          recognized: true,
          source: 'Windows present-keyboard ancestry',
          devices: [{ id: 'k', model: 'Razer BlackWidow Elite', modelId: 'razer-blackwidow-elite' }],
          selectedDeviceId: 'k',
        },
        controlVerification: { providers: { 'chroma-sdk': { status: 'confirmed' } } },
        input: { enabled: false },
      });
    if (url.pathname === '/api/app-profiles') return json(res, { config, runtime, profiles, discoveries });
    if (url.pathname === '/api/profiles')
      return json(res, { profiles: profiles.map(({ settings, ...p }) => p), controllers: [] });
    if (url.pathname.startsWith('/api/export/capabilities'))
      return json(
        res,
        require(path.join(root, 'export.cjs')).getExportCapabilities('auto', { effect: 'rainbow-road' }),
      );
    if (url.pathname.startsWith('/api/')) return json(res, { ok: true });
    const map = { '/': 'index.html', '/favicon.svg': 'assets/brand/lighting-lab-icon.svg' };
    const name = map[url.pathname] || url.pathname.slice(1);
    const file = path.join(root, name);
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    const type = name.endsWith('.js')
      ? 'text/javascript'
      : name.endsWith('.css')
        ? 'text/css'
        : name.endsWith('.png')
          ? 'image/png'
          : name.endsWith('.svg')
            ? 'image/svg+xml'
            : 'text/html';
    res.writeHead(200, { 'content-type': type });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-screens-'));
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = spawn(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try {
        port = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
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
    const shot = async (name, width, height, mobile = false) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await wait(400);
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64'));
    };
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      if (await evaluate('typeof setUiMode==="function"&&document.querySelectorAll(".key").length>50')) break;
      await wait(100);
    }
    await evaluate('localStorage.clear();document.querySelector(\'[data-id="Q"]\')&&0');
    await send('Page.reload');
    await wait(1500);
    await shot('1-simple-desktop', 1440, 1100);
    await shot('4-simple-phone', 390, 844, true);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      'setUiMode(\'fancy\');document.querySelector(\'.matrix-cell[data-row="background"][data-column="reaction"]\').click();true',
    );
    await shot('2-fancy-desktop', 1440, 1100);
    await evaluate('showAppProfiles(true);true');
    await wait(800);
    await shot('3-app-profiles', 1440, 1100);
    ws.close();
  } finally {
    browser.kill();
    server.close();
    await wait(300);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }
  console.log('screens saved to', out);
})();
