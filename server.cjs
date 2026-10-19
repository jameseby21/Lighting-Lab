/* Local Lighting Lab HTTP boundary. Device adapters never receive browser-supplied paths. */
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {spawn,execFile} = require('node:child_process');
const {promisify}=require('node:util');
const {createChromaSdkProvider,APP_TITLE} = require('./providers/chroma-sdk.cjs');
const {validateSelection} = require('./lighting-domain.cjs');
const {detectDevice} = require('./device-profile.cjs');
const {createProfileStore,profileCapabilities} = require('./profiles.cjs');
const {createControlVerificationStore} = require('./control-verification.cjs');

const ROOT = __dirname;
const LEGACY = process.env.LIGHTING_LAB_NATIVE_DIRECTORY || path.join(ROOT, 'docs', 'native');
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/ui.js', ['ui.js', 'text/javascript; charset=utf-8']],
  ['/core.js', ['core.js', 'text/javascript; charset=utf-8']],
  ['/effects.js', ['effects.js', 'text/javascript; charset=utf-8']],
  ['/layout-guide.js', ['layout-guide.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

/** Preserve the optional local native workflow without publishing personal imported archives. */
function nativeBridge() {
  try {
    return require(path.join(LEGACY, 'providers/synapse-native.cjs'))
      .createSynapseNativeProvider({directory: LEGACY});
  } catch {
    return {
      status: async () => ({available: false, uiOpen: false, archives: {}, installed: {},
        guidance: 'Use live Chroma control. Native Studio profiles require a local imported archive.'}),
      apply: async () => { throw new Error('No local Synapse profile is installed. Choose Chroma SDK live control.'); },
    };
  }
}

function respond(response, status, body) {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
  response.end(JSON.stringify(body));
}

/** Bound bodies before parsing; accepting JSON does not authorize file-system or shell arguments. */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128_000) throw new Error('Setup exceeds the 128 KB request limit.');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Expected a setup object.');
  return result;
}

/** Build an isolated server so API tests can exercise real HTTP without touching a keyboard. */
function createLightingLabServer({sdk = createChromaSdkProvider(), synapse = nativeBridge(),
  detectDeviceImpl = detectDevice, exporter, spawnImpl = spawn,
  execFileImpl=promisify(execFile),
  stateDirectory = process.env.LIGHTING_LAB_STATE || path.resolve(ROOT, '.artifacts/lighting-lab'),
} = {}) {
  const auditPath = path.join(stateDirectory, 'audit.jsonl');
  const profiles=createProfileStore(path.join(stateDirectory,'profiles'));
  const controlVerification=createControlVerificationStore(path.join(stateDirectory,'control-verification.json'));
  let inputProcess;
  let inputBuffer = '';
  let devicePromise;
  let deviceAt = 0;
  let selectedDeviceId;
  let deviceValue = {model: 'Detecting keyboard', modelId: 'standard-full-size',
    source: 'detection-pending', recognized: false,
    guidance: 'Checking present Windows keyboard devices; showing a standard full-size view meanwhile.'};
  let nativePromise;
  let nativeAt = 0;
  let pending = Promise.resolve();
  let lastSelection = null;

  /** The SDK adapter uses one generic keyboard canvas; choosing a device controls identity and preview, not an undocumented HID route. */
  function selectedDevice(){
    const devices=Array.isArray(deviceValue.devices)?deviceValue.devices:[];
    const selected=devices.find(device=>device.id===selectedDeviceId)||devices.find(device=>device.id===deviceValue.selectedDeviceId)||deviceValue;
    if(!selectedDeviceId&&selected?.id)selectedDeviceId=selected.id;
    return{...selected,devices,selectedDeviceId:selected?.id||null,
      controlScope:devices.length>1?{independentlyAddressable:false,reason:'Lighting Lab currently sends Chromaâ€™s generic keyboard canvas. Select a keyboard for its model, preview, and saved setup; connected compatible keyboards may receive the same SDK frame.'}:{independentlyAddressable:true,reason:'One present keyboard identity is selected.'}};
  }

  // Export is lazy: browsers without a Windows compiler can still preview and save JSON.
  const exportsModule = () => exporter || require('./export.cjs');
  const serialize = (operation) => {
    const result = pending.then(operation, operation);
    pending = result.catch(() => undefined);
    return result;
  };
  async function audit(record) {
    await fs.mkdir(stateDirectory, {recursive: true});
    await fs.appendFile(auditPath, `${JSON.stringify({timestamp: new Date().toISOString(), ...record})}\n`, 'utf8');
  }
  async function recentAudit() {
    try {
      const raw = await fs.readFile(auditPath, 'utf8');
      return raw.trim().split(/\r?\n/).filter(Boolean).slice(-20).map(JSON.parse);
    } catch { return []; }
  }
  function disableInput() {
    if (inputProcess && !inputProcess.killed) inputProcess.kill();
    inputProcess = undefined;
    inputBuffer = '';
    return {enabled: false};
  }
  function enableInput() {
    if (process.platform !== 'win32') throw new Error('Global key feedback currently requires Windows.');
    if (inputProcess && !inputProcess.killed) return {enabled: true};
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(ROOT, 'global-input.ps1')],
    {cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    inputProcess = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      inputBuffer += chunk;
      const lines = inputBuffer.split(/\r?\n/);
      inputBuffer = lines.pop() || '';
      for (const line of lines) {
        try { sdk.keyPress(JSON.parse(line).key).catch(() => undefined); }
        catch { /* Typed content is never included in diagnostics or the audit trail. */ }
      }
    });
    const ended = () => { if (inputProcess === child) { inputProcess = undefined; inputBuffer = ''; } };
    child.once('error', ended);
    child.once('exit', ended);
    return {enabled: true};
  }
  async function status() {
    const sdkStatus = await sdk.status();
    const now = Date.now();
    if (!nativePromise || now - nativeAt > 15_000) {
      nativeAt = now;
      nativePromise = synapse.status().catch(error => ({available: false, error: error.message}));
    }
    const nativeStatus = await nativePromise;
    if (!devicePromise || now - deviceAt > 60_000) {
      deviceAt = now;
      devicePromise = detectDeviceImpl({sdkAvailable: sdkStatus.available,
        synapseAvailable: nativeStatus.available}).then(device => {
        deviceValue = device;
        if(!selectedDeviceId||!(device.devices||[]).some(item=>item.id===selectedDeviceId))selectedDeviceId=device.selectedDeviceId;
        return device;
      }).catch(error => {
        deviceValue = {...deviceValue, source: 'detection-unavailable', recognized: false,
          guidance: `Automatic detection was unavailable: ${error.message}`};
      });
    }
    // Windows ancestry queries can take seconds. Keep live controls responsive while they finish.
    const device=selectedDevice();
    return {sdk: sdkStatus, synapse: nativeStatus, device,
      controlVerification:await controlVerification.forDevice(device.modelId||'standard-full-size'),
      input: {enabled: Boolean(inputProcess && !inputProcess.killed),
        privacy: 'Key identities stay in memory. No typed text or key history is saved.'},
      selection: lastSelection};
  }
  async function apply(body, auditId) {
    const selection = validateSelection(body);
    await audit({event: 'apply-validated', auditId, selection});
    const previousSelection = lastSelection;
    let result;
    if (selection.provider === 'synapse-native') {
      // Explicit native mode must not silently substitute a different effect or control path.
      result = await synapse.apply(selection);
      await sdk.release();
    } else result = await sdk.apply(selection,{force:body.force===true});
    lastSelection = selection;
    await audit({event: 'apply-completed', auditId, previousSelection, result});
    return {ok: true, auditId, result};
  }

  async function activateProfile(saved,auditId){
    if(saved.software!=='synapse-native')return apply({...saved.settings,provider:'chroma-sdk',force:true},auditId);
    const native=require('./synapse-profile.cjs');
    const archive=path.join(stateDirectory,saved.id+'.ChromaEffects');
    try{await fs.access(archive);}catch{await native.saveNativeProfile(saved,{directory:stateDirectory,buildOnly:true});}
    // Unsupported/native-template failures are discovered before giving up the current live session.
    await sdk.release();lastSelection={...saved.settings,provider:'synapse-native'};
    const loaded=await native.loadNativeProfile(saved,{directory:stateDirectory});
    return{...loaded,archiveDownloadUrl:'/api/profiles/'+saved.id+'/archive'};
  }

  const server = http.createServer(async (request, response) => {
    let auditId;
    try {
      const url = new URL(request.url, 'http://lighting-lab.local');
      // LAN access remains available; arbitrary other websites cannot issue browser mutations.
      const origin = request.headers.origin;
      if (request.method === 'POST' && origin && new URL(origin).host !== request.headers.host) {
        return respond(response, 403, {error: 'Open Lighting Lab directly to change this setup.'});
      }
      if (request.method === 'GET' && url.pathname === '/api/status') return respond(response, 200, await status());
      if(request.method==='POST'&&url.pathname==='/api/device'){
        const body=await readJson(request),devices=Array.isArray(deviceValue.devices)?deviceValue.devices:[];
        const selected=devices.find(device=>device.id===body.id);
        if(!selected)throw new Error('Choose a currently present keyboard.');
        selectedDeviceId=selected.id;auditId=crypto.randomUUID();
        await audit({event:'device-selected',auditId,deviceId:selected.id,modelId:selected.modelId});
        return respond(response,200,{device:selectedDevice()});
      }
      if(request.method==='POST'&&url.pathname==='/api/control-verification'){
        const body=await readJson(request);auditId=crypto.randomUUID();
        await audit({event:'control-verification-started',auditId,requestedPayload:body});
        const result=await controlVerification.record({modelId:deviceValue.modelId||'standard-full-size',provider:body.provider,visible:body.visible});
        await audit({event:'control-verification-recorded',auditId,result});
        return respond(response,200,{ok:true,result});
      }
      if (request.method === 'GET' && url.pathname === '/api/diagnostics') {
        return respond(response, 200, {createdAt: new Date().toISOString(), status: await status(),
          recentAudit: await recentAudit(), deferredIssues: ['LAN client timeout and browser chromweb/401 reports: not yet diagnosed.']});
      }
      if(request.method==='GET'&&url.pathname==='/api/profiles')return respond(response,200,{profiles:await profiles.list(),controllers:profileCapabilities({effect:url.searchParams.get('effect'),feedback:url.searchParams.get('feedback')},Boolean((await synapse.status()).available))});
      const profileRoute=url.pathname.match(/^\/api\/profiles\/([a-f0-9-]{36})(?:\/(load|archive))?$/);
      if(profileRoute){
        const saved=await profiles.load(profileRoute[1]);
        if(request.method==='GET'&&!profileRoute[2])return respond(response,200,saved);
        if(request.method==='GET'&&profileRoute[2]==='archive'){
          if(saved.software!=='synapse-native')return respond(response,404,{error:'This profile belongs to the Lighting Lab engine.'});
          const bytes=await fs.readFile(path.join(stateDirectory,saved.id+'.ChromaEffects'));
          response.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="Lighting-Lab-'+saved.id+'.ChromaEffects"','cache-control':'no-store'});return response.end(bytes);
        }
        if(request.method==='POST'&&profileRoute[2]==='load'){
          auditId=crypto.randomUUID();await audit({event:'profile-load-started',auditId,requestedPayload:saved});
          const loaded=await serialize(()=>activateProfile(saved,auditId));await audit({event:'profile-loaded',auditId,profileId:saved.id,loaded});return respond(response,200,{profile:saved,loaded});
        }
      }
      if(request.method==='POST'&&url.pathname==='/api/profiles'){
        const body=await readJson(request);auditId=crypto.randomUUID();await audit({event:'profile-save-started',auditId,requestedPayload:body});
        const saved=await profiles.save(body);
        let loaded,activationError;
        try{loaded=await serialize(()=>activateProfile(saved,auditId));}catch(error){activationError=error.message;}
        await audit({event:'profile-saved',auditId,profileId:saved.id,software:saved.software,loaded,activationError});
        return respond(response,200,{profile:saved,loaded,activationError});
      }
      if(request.method==='POST'&&url.pathname==='/api/repair'){
        const body=await readJson(request);auditId=crypto.randomUUID();await audit({event:'repair-started',auditId,requestedPayload:body});
        const applied=await serialize(()=>apply({...body,provider:'chroma-sdk',force:true},auditId));
        let controlState,openError,openFailure;
        try{const{stdout}=await execFileImpl('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'synapse-control.ps1'),'-Action','Repair','-AppTitle',APP_TITLE],{windowsHide:true,timeout:40000});controlState=JSON.parse(stdout.trim().split(/\r?\n/).at(-1));}catch(error){openError=String(error.stderr||error.message).trim().split(/\r?\n/)[0].slice(0,600);openFailure={message:error.message,stderr:error.stderr,stdout:error.stdout,code:error.code};}
        const opened=controlState?.connectPanelVerified===true;
        await audit({event:'repair-completed',auditId,opened,openError,openFailure,controlState,applied});
        return respond(response,200,{opened,openError,controlState,applied,physicalLightingVerified:false,detail:opened?controlState.detail:`SDK session restarted, but Synapse Connect could not be verified: ${openError||'no panel readback'}. Physical control remains unresolved.`});
      }
      if (request.method === 'GET' && url.pathname === '/api/export/capabilities') {
        return respond(response, 200, await exportsModule().getExportCapabilities(
          url.searchParams.get('model') || 'standard-full-size',
          {effect: url.searchParams.get('effect') || 'rainbow-road'}));
      }
      if (request.method === 'POST' && url.pathname === '/api/apply') {
        const body = await readJson(request);
        auditId = crypto.randomUUID();
        // Capture unvalidated settings before any provider, compiler, or child process runs.
        await audit({event: 'apply-started', auditId, requestedPayload: body});
        return respond(response, 200, await serialize(() => apply(body, auditId)));
      }
      if (request.method === 'POST' && url.pathname === '/api/export/executable') {
        const body = await readJson(request);
        auditId = crypto.randomUUID();
        await audit({event: 'export-started', auditId, requestedPayload: body});
        const selection = validateSelection(body);
        if (body.exportModel==='yunzii-al65'&&body.acceptApproximation !== true) throw new Error('Confirm the AL65 built-in whole-board lighting option before exporting.');
        const built = await exportsModule().createPresetExecutable({...body, ...selection},
          {targetModel: body.exportModel || 'auto', acceptApproximation: body.acceptApproximation===true});
        await audit({event: 'export-completed', auditId, filename: built.filename,
          sha256: crypto.createHash('sha256').update(built.bytes).digest('hex'), manifest: built.manifest});
        const filename = path.basename(built.filename).replace(/[^A-Za-z0-9_.-]/g, '-');
        response.writeHead(200, {'content-type': 'application/vnd.microsoft.portable-executable',
          'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store'});
        return response.end(built.bytes);
      }
      if (request.method === 'POST' && url.pathname === '/api/key-press') {
        const body = await readJson(request);
        // Global capture already forwards the same key; prevent doubled reactive events.
        if (inputProcess && !inputProcess.killed) return respond(response, 200, {accepted: false, reason: 'global input owns feedback'});
        return respond(response, 200, await sdk.keyPress(String(body.key || '')));
      }
      if (request.method === 'POST' && url.pathname === '/api/input') {
        const body = await readJson(request);
        return respond(response, 200, body.enabled ? enableInput() : disableInput());
      }
      if (request.method === 'POST' && url.pathname === '/api/release') {
        const result = await serialize(() => sdk.release());
        lastSelection = null;
        return respond(response, 200, result);
      }
      if (request.method === 'GET' && STATIC.has(url.pathname)) {
        const [filename, mime] = STATIC.get(url.pathname);
        const content = await fs.readFile(path.join(ROOT, filename));
        response.writeHead(200, {'content-type': mime, 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'});
        return response.end(content);
      }
      respond(response, request.method === 'GET' ? 404 : 405, {error: 'Not found.'});
    } catch (error) {
      if (auditId) await audit({event: 'operation-failed', auditId, error: error.message}).catch(() => undefined);
      if (!response.headersSent) respond(response, 422, {ok: false, auditId, error: error.message});
      else response.end();
    }
  });
  server.shutdown = async () => {
    disableInput();
    await serialize(() => sdk.release()).catch(() => undefined);
    if (server.listening) await new Promise(resolve => server.close(resolve));
  };
  return server;
}

function startLightingLab() {
  const server = createLightingLabServer();
  const port = Number(process.env.LIGHTING_LAB_PORT || 4318);
  const host = process.env.LIGHTING_LAB_HOST || '0.0.0.0';
  server.on('error', error => {
    console.error(`Lighting Lab could not listen on ${host}:${port}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const boundPort = server.address().port;
    const localName = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`Lighting Lab: http://${localName}:${boundPort} (LAN host ${host})`);
    if (host === '0.0.0.0' || host === '::') {
      for (const entries of Object.values(os.networkInterfaces())) for (const address of entries || []) {
        if (address.family === 'IPv4' && !address.internal) console.log(`LAN: http://${address.address}:${boundPort}`);
      }
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.shutdown().finally(() => process.exit(0));
  });
  return server;
}

if (require.main === module) startLightingLab();
module.exports = {createLightingLabServer, startLightingLab};
