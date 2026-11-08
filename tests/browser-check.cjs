/*
 * Real-browser acceptance check (`npm run test:browser`). NOT part of `npm test`; CI runs it separately.
 *
 * What it does: starts a FAKE Lighting Lab HTTP server (an in-process fixture that imitates every /api
 * route), launches headless Microsoft Edge / Chrome with a throwaway profile, drives the real index.html
 * + ui.js over the Chrome DevTools Protocol, and asserts ~80 behaviors: full 104-key rendering, presets,
 * paint modes, effect samples, reactions, model switching, export gating, profiles save/load/delete,
 * App Profiles discovery, Apply/confirm flow, request serialization ("latest edit wins"), persistence
 * across reloads, and phone-width reflow. It also guards every served file against mojibake.
 *
 * Needs: Edge or Chrome installed (or LIGHTING_LAB_BROWSER=path\to\browser.exe).
 * Writes: screenshots to .artifacts/browser/ (or LIGHTING_LAB_SCREENSHOT_DIR).
 * Real lighting: NEVER changed. The page only ever talks to the fixture server.
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const appRoot = path.resolve(__dirname, '..'),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function readDevToolsPort(portFile) {
  let lastError;
  for (let i = 0; i < 100; i++) {
    try {
      const value = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (value) return value;
    } catch (error) {
      lastError = error;
      if (error.code !== 'EBUSY' && error.code !== 'EPERM' && error.code !== 'ENOENT') throw error;
    }
    await wait(100);
  }
  throw lastError || Error('Browser did not expose a readable DevTools port.');
}

/** Exercise rendered geometry, interaction, persistence, and request ordering using Edge CDP. */
async function main() {
  // Every served text file must stay clean UTF-8. An earlier PowerShell round trip silently turned "·", "×" and "→" in
  // ui.js into U+FFFD (docs/appforge/ISSUES-LOG.md LL-001) while this guard only covered index.html.
  for (const served of ['index.html', 'ui.js', 'core.js', 'effects.js', 'layout-guide.js', 'styles.css'])
    assert(
      !/[ÂÃ]|â€|\ufffd/.test(fs.readFileSync(path.join(appRoot, served), 'utf8')),
      served + ' must remain UTF-8 without mojibake after editor/PowerShell round trips.',
    );
  const edge = [
    process.env.LIGHTING_LAB_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ]
    .filter(Boolean)
    .find((file) => fs.existsSync(file));
  assert(edge, 'Install Edge/Chromium or set LIGHTING_LAB_BROWSER to run browser acceptance checks.');
  const state = {
    requests: [],
    keys: [],
    concurrent: 0,
    maxConcurrent: 0,
    model: 'unrecognized-board',
    downloads: [],
    profiles: [],
    verification: {},
    discoveries: [],
    appProfiles: { automatic: true, waitMs: 1000, transitionMs: 400, rules: [] },
  };
  const json = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    if (url.pathname === '/api/status')
      return json(response, {
        device: { model: 'Unrecognized keyboard', modelId: state.model, source: 'test fixture' },
        sdk: { available: true },
        synapse: { installed: {}, archives: {} },
        input: { enabled: false },
        controlVerification: { modelId: state.model, providers: state.verification },
      });
    if (url.pathname === '/api/apply') {
      state.requests.push(body);
      state.concurrent++;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      await wait(180);
      state.concurrent--;
      return json(response, { result: { provider: 'chroma-sdk', detail: 'Isolated provider fixture' } });
    }
    if (url.pathname === '/api/key-press') {
      state.keys.push(body);
      return json(response, { ok: true });
    }
    if (url.pathname === '/api/control-verification') {
      state.verification[body.provider] = {
        provider: body.provider,
        status: body.visible ? 'confirmed' : 'rejected',
        source: 'owner-observation',
      };
      return json(response, { ok: true, result: state.verification[body.provider] });
    }
    if (url.pathname === '/api/export/capabilities')
      return json(
        response,
        require('../export.cjs').getExportCapabilities(url.searchParams.get('model'), {
          effect: url.searchParams.get('effect'),
        }),
      );
    if (url.pathname === '/api/app-profiles' && request.method === 'GET')
      return json(response, {
        config: state.appProfiles,
        runtime: {
          available: true,
          apps: state.appProfiles.rules.map((rule) => ({
            executable: rule.executable,
            running: false,
            foreground: false,
          })),
          detail: 'No configured app rule currently matches.',
        },
        profiles: state.profiles,
        discoveries: state.discoveries,
      });
    if (url.pathname === '/api/app-profiles/discover' && request.method === 'POST') {
      state.discoveries = [{ executable: 'Code.exe', running: true, foreground: true }];
      return json(response, {
        config: state.appProfiles,
        runtime: { available: true, apps: [], detail: 'Visible apps listed.' },
        profiles: state.profiles,
        discoveries: state.discoveries,
      });
    }
    if (url.pathname === '/api/app-profiles' && request.method === 'POST') {
      const rule = { ...body, id: 'app-rule' };
      state.appProfiles = { ...state.appProfiles, rules: [...state.appProfiles.rules, rule] };
      return json(response, {
        config: state.appProfiles,
        runtime: { available: true, apps: [], detail: 'Rule saved.' },
      });
    }
    if (url.pathname === '/api/app-profiles/config' && request.method === 'POST') {
      state.appProfiles = { ...state.appProfiles, ...body };
      return json(response, {
        config: state.appProfiles,
        runtime: { available: true, apps: [], detail: 'Switching preferences saved.' },
      });
    }
    if (url.pathname === '/api/app-profiles/refresh' && request.method === 'POST')
      return json(response, {
        config: state.appProfiles,
        runtime: {
          available: true,
          apps: state.appProfiles.rules.map((rule) => ({
            executable: rule.executable,
            running: false,
            foreground: false,
          })),
          detail: 'No configured app rule currently matches.',
        },
      });
    if (/^\/api\/app-profiles\/app-rule\/(toggle|delete|move|test)$/.test(url.pathname)) {
      const action = url.pathname.split('/').at(-1);
      if (action === 'delete') state.appProfiles = { ...state.appProfiles, rules: [] };
      if (action === 'toggle')
        state.appProfiles = {
          ...state.appProfiles,
          rules: state.appProfiles.rules.map((rule) => ({ ...rule, enabled: body.enabled !== false })),
        };
      if (action === 'test') return json(response, { profile: state.profiles[0], loaded: { ok: true } });
      return json(response, {
        config: state.appProfiles,
        runtime: { available: true, apps: [], detail: 'Rule updated.' },
      });
    }
    if (url.pathname === '/api/profiles' && request.method === 'GET')
      return json(response, {
        profiles: state.profiles,
        controllers: [
          { id: 'lighting-lab', available: true },
          { id: 'synapse-native', available: false },
        ],
      });
    if (url.pathname === '/api/profiles' && request.method === 'POST') {
      const profile = { ...body, id: 'test-profile' };
      state.profiles.push(profile);
      return json(response, { profile, loaded: { ok: true } });
    }
    if (url.pathname === '/api/profiles/test-profile/delete' && request.method === 'POST') {
      state.profiles = state.profiles.filter((profile) => profile.id !== 'test-profile');
      return json(response, { ok: true, deleted: 'test-profile', profiles: state.profiles });
    }
    if (url.pathname === '/api/profiles/test-profile') return json(response, state.profiles[0]);
    if (url.pathname === '/api/profiles/test-profile/load')
      return json(response, { profile: state.profiles[0], loaded: { ok: true } });
    if (url.pathname === '/api/export/executable') {
      state.downloads.push(body);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="test-preset.exe"',
      });
      return response.end('MZ-fixture');
    }
    if (url.pathname === '/api/release' || url.pathname === '/api/input')
      return json(response, { enabled: body.enabled || false });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'core.js', 'effects.js', 'layout-guide.js', 'ui.js', 'styles.css'].includes(name)) {
      response.writeHead(404);
      return response.end();
    }
    response.writeHead(200, {
      'content-type': name.endsWith('.js')
        ? 'application/javascript'
        : name.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    });
    response.end(fs.readFileSync(path.join(appRoot, name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lighting-lab-browser-'));
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
    { windowsHide: true, stdio: 'ignore' },
  );
  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await wait(100);
    assert(fs.existsSync(portFile), 'Browser must expose its local debugging port.');
    const port = await readDevToolsPort(portFile),
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    ws = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let sequence = 0;
    const pending = new Map(),
      exceptions = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const action = pending.get(message.id);
        pending.delete(message.id);
        message.error ? action.reject(message.error) : action.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown')
        exceptions.push(message.params.exceptionDetails);
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.navigate', { url: address });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (
        await evaluate(
          'typeof configuration === "function" && document.querySelectorAll(".key").length===104',
        )
      ) {
        ready = true;
        break;
      }
      await wait(100);
    }
    assert(
      ready,
      `Full ANSI keyboard must render 104 editable switches. Browser exceptions: ${JSON.stringify(exceptions)}`,
    );
    await wait(450);
    await send('Runtime.evaluate', { expression: 'document.querySelector("[data-id=Q]").focus()' });
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'q',
      code: 'KeyQ',
      windowsVirtualKeyCode: 81,
    });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'q',
      code: 'KeyQ',
      windowsVirtualKeyCode: 81,
    });
    assert(
      // The white flash only stays above the "pressed" threshold for ~200 ms, which a loaded CI machine can miss
      // between keyDown and this evaluate. What this check guards is that a focused key button does not swallow
      // the event, so a recorded Q reaction event also passes. (The flash itself is asserted again below.)
      await evaluate(
        'document.querySelector("[data-id=Q]").classList.contains("pressed")||events.some(event=>event.id==="Q")',
      ),
      `Focused key button must not swallow physical keyboard feedback: ${await evaluate('JSON.stringify({events,selection:configuration(),rgb:document.querySelector("[data-id=Q]").dataset.rgb})')}`,
    );
    await wait(1400);
    const checks = await evaluate(`(async()=>{
      const checks=[],check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name)},byId=id=>document.getElementById(id),change=(id,value)=>{byId(id).value=value;byId(id).dispatchEvent(new Event('change'))},pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      // Simple mode (LL-063): new visitors see the live keyboard and the looks gallery, nothing else.
      const shown=id=>getComputedStyle(byId(id)).display!=='none'&&byId(id).getBoundingClientRect().height>0;
      check(document.body.dataset.mode==='simple'&&shown('board-scroll')&&shown('preset-gallery')&&!shown('workspace')&&!shown('quickstart')&&shown('expand-fancy'),'new visitors start in Simple mode: keyboard and looks only');
      const anchorsBefore=configuration().anchors.length;document.querySelector('[data-id="Q"]').click();check(events.some(event=>event.id==='Q')&&configuration().anchors.length===anchorsBefore,'in Simple mode clicking a key fires its reaction instead of painting');
      byId('mode-toggle').click();check(document.body.dataset.mode==='fancy'&&shown('workspace')&&shown('quickstart')&&!shown('expand-fancy')&&localStorage.getItem('lighting-lab-mode-v1')==='fancy','All controls reveals the full editor and is remembered');
      check(byId('keyboard-model').value==='standard-full-size','unknown model falls back to full ANSI');
      check(configuration().effect==='rainbow-road'&&configuration().speed===3.5,'fresh setup starts with visible Rainbow Road at 350 percent speed');
      check(document.querySelectorAll('.key').length===104,'all 104 physical switches render');
      check(!byId('quickstart').hidden&&document.querySelectorAll('#preset-gallery button').length===12,'first-run guide and twelve click-only presets render');
      byId('onboarding-starter').click();check(configuration().effect==='rainbow-road'&&configuration().feedback==='ripple','starter guide applies a complete gallery preset');
      byId('onboarding-test').click();check(document.activeElement===byId('test-typing')&&JSON.parse(localStorage.getItem('lighting-lab-onboarding-v1')).test,'starter guide opens a safe preview reaction test');
      const shared=createShareLink(configuration());check(readShareLink(new URL(shared).hash).effect===configuration().effect&&shared.includes('#lighting-lab='),'share links round-trip the preview recipe without applying it');check(document.querySelector('[data-readiness="preview"]').dataset.state==='ready'&&document.querySelector('[data-readiness="physical"]').dataset.state==='pending','readiness separates preview from unconfirmed physical lights');
      change('selection-mode','anchor');byId('anchor-blue-flame').click();check(configuration().groups.anchor.reaction==='flame'&&configuration().groups.anchor.reactionColor==='#2aa8ff','Blue flame action assigns a visible anchor reaction');const q=document.querySelector('[data-id="Q"]'),one=document.querySelector('[data-id="1"]'),num=document.querySelector('[data-id="NUM_1"]');
      check(q&&one&&num&&one!==num,'main numerals and numpad keys have unique identities');
      const main=q.getBoundingClientRect(),pad=num.getBoundingClientRect();check(pad.left>main.right&&pad.top<main.top+200,'numpad stays beside main cluster');
      check(byId('board-scroll').scrollWidth<=byId('board-scroll').clientWidth+2,'full keyboard fits wide desktop window');
      change('keyboard-model','razer-blackwidow-elite');check(document.querySelectorAll('.hardware-control').length===4&&document.querySelector('.hardware-dial')&&document.querySelectorAll('.key').length===104,'Elite shows three inert media buttons and dial beside 104 RGB switches');check([...document.querySelectorAll('.hardware-control')].every(control=>control.getAttribute('aria-label').includes('no addressable RGB LED')&&control.tagName!=='BUTTON'),'media controls disclose their non-addressable lighting status');change('keyboard-model','standard-full-size');
      for(const id of ['ESC','F12','TAB','CAPS','ENTER','LCTRL','SPACE','UP','DEL','NUM_ENTER','NUM_DECIMAL'])check(Boolean(document.querySelector('[data-id="'+id+'"]')),'editable '+id+' exists');
      byId('clear-all').click();check(configuration().anchors.length===0,'clear removes anchors');
      document.querySelector('[data-id="NUM_1"]').click();check(configuration().anchors.includes('NUM_1')&&!configuration().anchors.includes('1'),'numpad selection does not select main digit');
      byId('select-all').click();check(configuration().anchors.length===104,'select all includes every switch');byId('clear-all').click();
      change('selection-mode','orientation');document.querySelector('[data-id="ESC"]').click();check(configuration().protectedAnchors.includes('ESC'),'orientation anchor selectable');change('selection-mode','anchor');
      change('background','matrix');check([...document.querySelectorAll('.key')].some(key=>{const rgb=key.dataset.rgb.split(',').map(Number);return rgb[1]>180&&rgb[0]===0;}),'Matrix shows neon green in shared frame samples');
      change('background','stars-stripes');check([...document.querySelectorAll('.key')].some(key=>key.dataset.rgb.startsWith('245,20,48')),'Stripes uses red row bands');
      change('background','chaos');const colors=new Set([...document.querySelectorAll('.key')].map(key=>key.dataset.rgb));check(colors.size>10,'Chaos assigns independent varied key colors');
      change('background','rainbow-road');check(!byId('background').selectedOptions[0].textContent.toLowerCase().includes('chaos'),'Rainbow Road has no chaos label');
      change('feedback','reactive');document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyQ',key:'q',bubbles:true}));check(document.querySelector('[data-id="Q"]').classList.contains('pressed'),'white feedback is above rainbow at Q');check(!document.querySelector('[data-id="W"]').classList.contains('pressed'),'physical Q does not shift to W');
      await pause(1400);check(!document.querySelector('[data-id="Q"]').classList.contains('pressed'),'white feedback fades');
      document.dispatchEvent(new KeyboardEvent('keydown',{code:'NumpadDecimal',key:'Delete',bubbles:true}));check(document.querySelector('[data-id="NUM_DECIMAL"]').classList.contains('pressed'),'NumLock off decimal uses physical numpad identity');
      byId('minimalist').checked=true;byId('minimalist').dispatchEvent(new Event('change'));check(document.querySelector('[data-id="F1"]').dataset.rgb==='0,0,0','keypress-only mode blacks out background');byId('minimalist').checked=false;byId('minimalist').dispatchEvent(new Event('change'));
      change('keyboard-model','yunzii-al65');check(document.querySelectorAll('.key').length===68&&!document.querySelector('[data-id="NUM_1"]'),'AL65 switches to compact 68-key view');await pause(200);
      check(!byId('export-executable').disabled,'auto-detecting portable player is independent of selected preview');change('export-target','yunzii-al65');await pause(200);
      check(byId('export-executable').disabled,'firmware approximation requires explicit opt-in');byId('accept-approximation').checked=true;byId('accept-approximation').dispatchEvent(new Event('change'));check(!byId('export-executable').disabled,'AL65 firmware export enables after opt-in');
      change('background','chaos');await pause(200);check(byId('export-executable').disabled,'unsupported Chaos cannot export misleading AL65 approximation');change('background','matrix');await pause(200);
      change('keyboard-model','razer-ornata-v3');check(document.querySelectorAll('.key').length===104,'Ornata V3 retains complete view');check(byId('model-note').textContent.includes('ten lighting zones'),'zone hardware limitation is explicit');
      change('keyboard-model','yunzii-al65');await refreshProviderStatus();check(byId('keyboard-model').value==='yunzii-al65','provider polling preserves manually chosen model');
      byId('view-editor').open=true;byId('edit-geometry').checked=true;document.querySelector('[data-id="Q"]').click();check(byId('geometry-key').value==='Q','geometry mode selects physical switch for editing');byId('geometry-x').value='2';byId('geometry-apply').click();check(configuration().keyboardModel==='custom'&&configuration().customLayout.find(key=>key.id==='Q').x===2,'custom view geometry saves without changing identity');
      change('keyboard-model','standard-full-size');byId('edit-geometry').checked=false;change('background','matrix');byId('speed').value='4';byId('speed').dispatchEvent(new Event('input'));await pause(150);change('background','stars-stripes');change('background','chaos');await pause(650);
      const before=configuration();let captured;const originalCreate=URL.createObjectURL;URL.createObjectURL=blob=>{captured=blob;return originalCreate(blob)};byId('save-json').click();const saved=JSON.parse(await captured.text());URL.createObjectURL=originalCreate;check(saved.effect===before.effect&&saved.speed===before.speed&&Array.isArray(saved.customLayout),'JSON export captures full configuration separately from Apply');
      check(configuration().protectAnchors===false,'keywords react above their fixed base colors by default');change('keyword-feedback','ripple');check(configuration().keywordFeedback==='ripple'&&configuration().feedback==='reactive','keyword and other-key reaction choices remain independent');
      byId('identify-layout').click();check(byId('layout-guide').open,'layout guide always available');byId('guide-broken').click();check(configuration().brokenKeys.includes('NUM_ENTER')&&guideState.index===0,'unresponsive probe records issue without shrinking layout');document.dispatchEvent(new KeyboardEvent('keydown',{code:'NumpadAdd',key:'+',bubbles:true}));check(guideState.index===1,'alternate numpad key advances physical guide');byId('guide-yes').click();byId('guide-yes').click();byId('guide-choices').children[0].click();byId('guide-choices').children[0].click();check(configuration().keyboardModel==='standard-full-size','guided features choose full reference layout without brand inference');byId('guide-close').click();
      byId('profile-name').value='Browser Test';byId('save-profile').click();await pause(300);check(byId('saved-profiles').options.length===2&&byId('profile-status').textContent.includes('No download'),'named Save Profile stores a loadable setup without downloading');
      change('background','ghost');byId('saved-profiles').value='test-profile';byId('load-profile').click();await pause(400);check(configuration().effect==='chaos'&&byId('live').checked,'Load Profile restores the stored setup using its saved controller');
      byId('show-app-profiles').click();await pause(250);check(!byId('app-profiles-view').hidden&&byId('app-rule-profile').options.length===2,'App Profiles opens with saved lighting profiles available to rules');byId('app-profiles-discover').click();await pause(250);document.querySelector('#app-profile-discoveries button').click();check(byId('app-rule-executable').value==='Code.exe','running-app discovery can populate a new rule without guessing its executable');byId('app-rule-name').value='Browser Code';byId('app-rule-executable').value='Code.exe';byId('app-rule-profile').value='test-profile';byId('app-profile-add').dispatchEvent(new Event('submit',{cancelable:true}));await pause(250);check(byId('app-profile-rule-list').textContent.includes('Browser Code')&&byId('app-profile-rule-list').textContent.includes('Code.exe'),'App Profiles saves a named executable rule without duplicating lighting configuration');byId('show-lighting').click();check(byId('app-profiles-view').hidden&&!byId('workspace').hidden,'Lighting navigation restores the existing editor');
      byId('live').checked=false;byId('live').dispatchEvent(new Event('change'));change('background','solid');byId('apply').click();await pause(450);check(byId('apply-status').textContent.includes('not yet confirmed'),'Apply reports controller acknowledgement without claiming visible lights');byId('confirm-unchanged').click();await pause(250);byId('connect').click();await pause(250);check(byId('live').checked&&byId('connection-label').textContent==='Controller reachable · recheck lights','an unchanged observation stays visible and Reconnect can resume a reachable live controller');await recordControlObservation(true);await refreshProviderStatus();byId('confirm-visible').click();await pause(250);check(!byId('success-next').hidden,'confirmed physical lighting offers optional save or feedback next steps');byId('success-feedback').click();check(!byId('feedback-development').hidden&&byId('feedback-category').value==='Visual quality','success feedback opens the lightweight local form');byId('feedback-note').value='Browser feedback record';byId('feedback-submit').click();const savedFeedback=JSON.parse(localStorage.getItem('lighting-lab-feedback-v1'));check(savedFeedback.at(-1).note==='Browser feedback record'&&feedbackIssueUrl(savedFeedback.at(-1)).includes('github.com/jameseby21/Lighting-Lab/issues/new'),'feedback stays local until an explicit GitHub draft or download');change('provider','synapse-native');byId('apply').click();check(byId('apply-status').textContent.includes('Save as Profile'),'Apply explains the Synapse profile workflow instead of silently switching providers');change('provider','chroma-sdk');byId('live').checked=true;byId('live').dispatchEvent(new Event('change'));
      document.querySelector('[data-paint="orientation"]').click();check(paintMode==='orientation'&&byId('selection-mode').value==='orientation'&&document.querySelector('[data-paint="orientation"]').getAttribute('aria-pressed')==='true','paint pills switch what a key click paints');document.querySelector('[data-paint="anchor"]').click();const bgChip=document.querySelector('[data-preview-group="background"]');const dynamicBefore=configuration().groups.background.dynamic;bgChip.click();await pause(80);const bgKey=[...document.querySelectorAll('.key')].find(key=>!configuration().anchors.includes(key.dataset.id)&&!configuration().protectedAnchors.includes(key.dataset.id));check(bgKey.dataset.rgb==='0,0,0'&&bgChip.getAttribute('aria-pressed')==='false'&&configuration().groups.background.dynamic===dynamicBefore,'preview chips hide a group in the preview without changing the setup');bgChip.click();byId('workspace').scrollIntoView();document.querySelector('.matrix-cell[data-row="background"][data-column="reaction"]').click();check(byId('inspector-title').textContent==='Background · Reaction'&&byId('inspector-link').textContent.includes('Background only'),'a matrix cell opens that group and layer in the inspector');byId('inspector-search').value='spark';byId('inspector-search').dispatchEvent(new Event('input'));check(byId('inspector-options').children.length===1,'inspector search filters the options');byId('inspector-options').children[0].click();check(configuration().groups.background.reaction==='sparkle'&&configuration().groups.anchor.reaction!=='sparkle','choosing an option changes only the selected group');byId('inspector-search').value='';byId('inspector-search').dispatchEvent(new Event('input'));byId('inspector-strength').value='50';byId('inspector-strength').dispatchEvent(new Event('input'));check(configuration().groups.background.reactionStrength===0.5,'the inspector strength slider sets the layer strength');document.querySelectorAll('.matrix-head .link-all')[1].click();check(byId('inspector-link').textContent.startsWith('Linked'),'Link all targets every group for that layer');[...byId('inspector-options').children].find(option=>option.dataset.option==='aurora').click();check(['anchor','background','orientation'].every(name=>configuration().groups[name].dynamic==='aurora'),'a linked edit applies to all groups at once');document.querySelectorAll('.protect-toggle')[0].click();check(configuration().groups.anchor.protect===true&&byId('protect').checked,'the matrix Protect toggle protects a group and syncs the shortcut checkbox');document.querySelectorAll('.protect-toggle')[0].click();byId('show-app-profiles').click();await pause(250);check(byId('app-try-chips').querySelector('button')&&byId('app-profile-gallery').querySelector('.profile-card canvas'),'App Profiles shows Try-it chips and a saved-profile gallery with thumbnails');byId('app-try-chips').querySelector('button').click();check(byId('app-active-caption').textContent.startsWith('Preview only'),'Try it simulates a rule without touching hardware');byId('app-rule-condition').value='time';byId('app-rule-condition').dispatchEvent(new Event('change'));check(!byId('app-rule-time').hidden&&byId('app-rule-executable-label').hidden,'a Time of day rule asks for a time window instead of an app');byId('app-rule-condition').value='foreground';byId('app-rule-condition').dispatchEvent(new Event('change'));check(byId('app-default-profile').options.length>=2,'Everything else can use a default profile');byId('show-lighting').click();
      const snapshot=configuration();snapshot.keyboardModel='yunzii-al65';snapshot.effect='matrix';snapshot.groups.background.dynamic='matrix';restoreSetup(snapshot);changed();check(configuration().keyboardModel==='yunzii-al65'&&configuration().effect==='matrix','saved setup restores model and effect');
      byId('pause-preview').click();check(byId('pause-preview').getAttribute('aria-pressed')==='true','motion preview can be paused');
      const beforeHostile=configuration(),hostile=configuration();hostile.groups.anchor.color='#000000"><img id="xss-probe" src=x onerror="window.__xss=1">';hostile.groups.anchor.reactionColor='javascript:alert(1)';hostile.groups.background.dynamic='<b>bad</b>';restoreSetup(hostile);changed(false);await pause(100);check(!document.getElementById('xss-probe')&&!window.__xss&&configuration().groups.anchor.color==='#ff4fb8'&&configuration().groups.background.dynamic==='rainbow-road','imported setups cannot inject markup through group colors or effect names');restoreSetup(beforeHostile);changed(false);
      const realConfirm=window.confirm;window.confirm=()=>true;byId('saved-profiles').value='test-profile';byId('delete-profile').click();await pause(300);window.confirm=realConfirm;check(![...byId('saved-profiles').options].some(option=>option.value==='test-profile')&&byId('profile-status').textContent.startsWith('Deleted'),'a saved profile can be deleted from the picker after confirmation');
      return checks;
    })()`);
    checks.unshift('button focus preserves physical-key feedback');
    await wait(500);
    assert.equal(state.maxConcurrent, 1, 'Live apply requests must be serialized.');
    assert.equal(state.requests.at(-1).effect, 'matrix', 'Latest configuration wins after rapid edits.');
    assert(
      state.requests.some((request) => request.force === true && request.effect === 'solid'),
      'Apply forces a device update even with Live disabled.',
    );
    assert(
      state.keys.some((key) => key.key === 'Q') && state.keys.some((key) => key.key === 'NUM_DECIMAL'),
      'Physical key IDs reach API.',
    );
    checks.push(
      'live request concurrency is one',
      'latest edit wins',
      'physical key IDs reach API',
      'Apply works with Live disabled',
    );
    await evaluate(
      `document.getElementById('accept-approximation').checked=true;document.getElementById('accept-approximation').dispatchEvent(new Event('change'));document.getElementById('export-executable').click()`,
    );
    await wait(300);
    assert.equal(state.downloads.length, 1);
    assert.equal(state.downloads[0].exportModel, 'yunzii-al65');
    assert.equal(state.downloads[0].acceptApproximation, true);
    checks.push('EXE export sends target model and explicit approximation acceptance');
    await send('Page.reload');
    await wait(500);
    assert.equal(await evaluate('document.getElementById("keyboard-model").value'), 'yunzii-al65');
    checks.push('manual model persists across reload');
    const savedSetup = await evaluate('localStorage.getItem("lighting-lab-setup-v2")');
    await evaluate(
      'localStorage.removeItem("lighting-lab-setup-v2");localStorage.setItem("lighting-lab-effect","ghost")',
    );
    await send('Page.reload');
    await wait(500);
    assert.equal(await evaluate('configuration().effect'), 'ghost');
    checks.push('legacy effect-only storage migrates when complete setup is absent');
    await evaluate(
      `localStorage.setItem('lighting-lab-setup-v2',${JSON.stringify(savedSetup)});localStorage.removeItem('lighting-lab-effect')`,
    );
    await send('Page.reload');
    await wait(500);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await wait(200);
    assert(
      await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),
      'Phone page must not overflow horizontally.',
    );
    assert(
      await evaluate(
        'document.getElementById("board-scroll").scrollWidth > document.getElementById("board-scroll").clientWidth',
      ),
      'Keyboard geometry scrolls inside its own phone viewport.',
    );
    checks.push('phone page reflows and keyboard scrolls inside viewport');
    assert.deepEqual(exceptions, [], 'No uncaught browser errors.');
    const output = process.env.LIGHTING_LAB_SCREENSHOT_DIR || path.resolve(appRoot, '.artifacts/browser');
    fs.mkdirSync(output, { recursive: true });
    for (const [name, width, height, mobile, model] of [
      ['desktop', 1440, 1700, false, 'razer-blackwidow-elite'],
      ['phone', 390, 844, true, 'yunzii-al65'],
    ]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await evaluate(
        `document.getElementById('keyboard-model').value='${model}';document.getElementById('keyboard-model').dispatchEvent(new Event('change'))`,
      );
      await wait(150);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
    }
    console.log(`Passed ${checks.length} actual-browser checks against isolated provider fixtures.`);
    console.log(checks.map((name) => `  ✓ ${name}`).join('\n'));
  } finally {
    if (ws) ws.close();
    browser.kill();
    await new Promise((resolve) => server.close(resolve));
    await wait(300);
    // Only remove the exact temporary directory allocated by this test, never a browser's real profile.
    if (
      path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) &&
      path.basename(profile).startsWith('lighting-lab-browser-')
    ) {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        console.warn(`Temporary browser profile still in use: ${profile}`);
      }
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
