/* Exercise real HTTP and audit ordering with fake devices; never alter physical lighting. */
'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createLightingLabServer} = require('../server.cjs');

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-api-'));
  const calls = [];
  const sdk = {
    status: async () => ({available: true}),
    apply: async selection => { calls.push(selection); return {provider: 'chroma-sdk', effect: selection.effect}; },
    release: async () => ({released: true}),
    keyPress: async key => ({accepted: true, key}),
  };
  const server = createLightingLabServer({sdk,
    synapse: {status: async () => ({available: false, archives: {}, installed: {}})},
    detectDeviceImpl: async () => ({model: 'Standard full-size', recognized: false}),
    stateDirectory: directory, ...overrides});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.shutdown(); await fs.rm(directory, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {server, base, directory, calls, sdk,
    post: (route, body) => fetch(base + route, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})};
}
const setup = {effect: 'matrix', provider: 'chroma-sdk', anchors: ['Q'], keyboardModel: 'standard-full-size'};

test('captures every requested field before device mutation, including rejected requests', async t => {
  let directory;
  const f = await fixture(t, {sdk: {
    status: async () => ({available: true}), release: async () => ({}),
    apply: async () => {
      const audit = await fs.readFile(path.join(directory, 'audit.jsonl'), 'utf8');
      assert.equal(JSON.parse(audit.split('\n')[0]).requestedPayload.extra.userChoice, 42);
      return {provider: 'chroma-sdk'};
    },
  }});
  directory = f.directory;
  const result = await f.post('/api/apply', {...setup, extra: {userChoice: 42}});
  assert.equal(result.status, 200);
  const invalid = await f.post('/api/apply', {...setup, effect: 'does-not-exist'});
  assert.equal(invalid.status, 422);
  const records = (await fs.readFile(path.join(directory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(records.some(record => record.requestedPayload?.effect === 'does-not-exist'));
  assert.equal(records.at(-1).event, 'operation-failed');
});

test('all switches and independent numpad IDs reach the API without alpha-only filtering', async t => {
  const f = await fixture(t);
  for (const id of ['Q', 'ESC', 'F12', 'NUM_1', 'NUM_DECIMAL', 'ENTER']) {
    const response = await f.post('/api/apply', {...setup, anchors: [id]});
    assert.equal(response.status, 200, `${id}: ${await response.text()}`);
  }
});

test('serializes simultaneous live edits so old requests cannot finish after newer ones', async t => {
  const completed = [];
  const f = await fixture(t, {sdk: {status: async () => ({available: true}), release: async () => ({}),
    apply: async selection => {
      if (selection.effect === 'matrix') await new Promise(resolve => setTimeout(resolve, 30));
      completed.push(selection.effect);
      return {effect: selection.effect};
    }}});
  const first = f.post('/api/apply', setup);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = f.post('/api/apply', {...setup, effect: 'rainbow-road'});
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.deepEqual(completed, ['matrix', 'rainbow-road']);
});

test('static allowlist excludes source, private audit files, traversal and local backups', async t => {
  const f = await fixture(t);
  for (const route of ['/server.cjs', '/audit.jsonl', '/lighting-lab-audit.jsonl', '/README.md', '/%2e%2e/AGENTS.md']) {
    assert.equal((await fetch(f.base + route)).status, 404, route);
  }
  assert.equal((await fetch(f.base + '/')).status, 200);
  assert.equal((await fetch(f.base + '/api/status')).status, 200);
});

test('executable is a download and cannot bypass explicit approximation consent', async t => {
  let builds = 0;
  const f = await fixture(t, {exporter: {
    getExportCapabilities: model => ({model, supported: true, exact: false}),
    createPresetExecutable: async (_selection, options) => {
      builds++;
      assert.equal(options.targetModel, 'yunzii-al65');
      return {filename: 'AL65-preset.exe', bytes: Buffer.from('MZ-fake-test-only'), manifest: {exact: false}};
    },
  }});
  const rejected = await f.post('/api/export/executable', {...setup, exportModel: 'yunzii-al65'});
  assert.equal(rejected.status, 422);
  assert.equal(builds, 0);
  const built = await f.post('/api/export/executable', {...setup, exportModel: 'yunzii-al65', acceptApproximation: true});
  assert.equal(built.status, 200);
  assert.match(built.headers.get('content-disposition'), /AL65-preset.exe/);
  assert.equal(await built.text(), 'MZ-fake-test-only');
  assert.equal(builds, 1);
});

test('foreign browser origins cannot change the host keyboard', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/api/apply', {method: 'POST',
    headers: {origin: 'http://another-site.invalid', 'content-type': 'application/json'},
    body: JSON.stringify(setup)});
  assert.equal(response.status, 403);
  assert.equal(f.calls.length, 0);
});

test('physical control observations persist separately from accepted SDK requests',async t=>{
  const f=await fixture(t,{detectDeviceImpl:async()=>({model:'Razer BlackWidow Elite',modelId:'razer-blackwidow-elite',recognized:true})});
  await fetch(f.base+'/api/status');await new Promise(resolve=>setImmediate(resolve));
  const rejected=await f.post('/api/control-verification',{provider:'chroma-sdk',visible:false});assert.equal(rejected.status,200);
  const confirmed=await f.post('/api/control-verification',{provider:'synapse-native',visible:true});assert.equal(confirmed.status,200);
  const status=await(await fetch(f.base+'/api/status')).json();
  assert.equal(status.controlVerification.providers['chroma-sdk'].status,'rejected');
  assert.equal(status.controlVerification.providers['synapse-native'].status,'confirmed');
  assert.equal((await f.post('/api/control-verification',{provider:'unknown',visible:true})).status,422);
  const audit=(await fs.readFile(path.join(f.directory,'audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert(audit.some(record=>record.event==='control-verification-started'&&record.requestedPayload.visible===false));
});

test('slow device enumeration cannot block live status or trigger overlapping probes', async t => {
  let resolveDevice, probes = 0;
  const f = await fixture(t, {detectDeviceImpl: () => {
    probes++;
    return new Promise(resolve => { resolveDevice = resolve; });
  }});
  const first = await fetch(f.base + '/api/status', {signal: AbortSignal.timeout(2000)});
  assert.equal((await first.json()).device.source, 'detection-pending');
  await fetch(f.base + '/api/status');
  assert.equal(probes, 1);
  resolveDevice({model: 'Razer BlackWidow Elite', modelId: 'razer-blackwidow-elite', recognized: true});
  await new Promise(resolve => setImmediate(resolve));
  const updated = await (await fetch(f.base + '/api/status')).json();
  assert.equal(updated.device.modelId, 'razer-blackwidow-elite');
  assert.equal(updated.device.recognized, true);
});

test('a shared PC can select among detected keyboards without claiming undocumented SDK routing',async t=>{
  const f=await fixture(t,{detectDeviceImpl:async()=>({model:'Razer BlackWidow Elite',modelId:'razer-blackwidow-elite',id:'razer',selectedDeviceId:'razer',devices:[{id:'razer',model:'Razer BlackWidow Elite',modelId:'razer-blackwidow-elite',recognized:true},{id:'al65',model:'YUNZII AL65',modelId:'yunzii-al65',recognized:true}]})});
  await fetch(f.base+'/api/status');await new Promise(resolve=>setImmediate(resolve));
  const changed=await f.post('/api/device',{id:'al65'});assert.equal(changed.status,200);assert.equal((await changed.json()).device.selectedDeviceId,'al65');
  const status=await(await fetch(f.base+'/api/status')).json();assert.equal(status.device.modelId,'yunzii-al65');assert.equal(status.device.controlScope.independentlyAddressable,false);
});

test('Apply forwards forced activation independently from live state and profiles preserve full editor settings',async t=>{
  const applied=[];
  const f=await fixture(t,{sdk:{status:async()=>({available:true}),release:async()=>({}),apply:async(selection,options)=>{applied.push({selection,options});return{delivery:'sdk-acknowledged',physicalLightingVerified:false};}}});
  assert.equal((await f.post('/api/apply',{...setup,force:true,live:false})).status,200);
  assert.equal(applied[0].options.force,true);
  const response=await f.post('/api/profiles',{name:'My Matrix',software:'lighting-lab',settings:{...setup,words:['JAMES'],keywordFeedback:'waterfall',brokenKeys:['NUM_DECIMAL']}});
  const saved=await response.json();assert.equal(response.status,200);assert.equal(saved.activationError,undefined);
  const loaded=await(await fetch(f.base+'/api/profiles/'+saved.profile.id)).json();
  assert.deepEqual(loaded.settings.words,['JAMES']);assert.equal(loaded.settings.keywordFeedback,'waterfall');assert.deepEqual(loaded.settings.brokenKeys,['NUM_DECIMAL']);
  const listed=await(await fetch(f.base+'/api/profiles')).json();assert.equal(listed.profiles.length,1);assert.equal(listed.controllers[1].available,false);
  const reloaded=await(await f.post('/api/profiles/'+saved.profile.id+'/load',{})).json();assert.equal(reloaded.profile.name,'My Matrix');assert.equal(applied.at(-1).options.force,true);
  assert.equal((await fetch(f.base+'/api/profiles/'+saved.profile.id+'/archive')).status,404);
  assert.equal((await fetch(f.base+'/layout-guide.js')).status,200);
});

test('a saved profile remains editable when its device activation fails',async t=>{
  const f=await fixture(t,{sdk:{status:async()=>({available:false}),release:async()=>({}),apply:async()=>{throw Error('Controller unavailable');}}});
  const response=await f.post('/api/profiles',{name:'Kept',settings:setup});const body=await response.json();
  assert.equal(response.status,200);assert.match(body.activationError,/Controller unavailable/);
  assert.equal((await(await fetch(f.base+'/api/profiles/'+body.profile.id)).json()).name,'Kept');
  const records=(await fs.readFile(path.join(f.directory,'audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).activationError,'Controller unavailable');
});

test('auto-detecting executable export needs no unrelated AL65 approximation consent',async t=>{
  let target;
  const f=await fixture(t,{exporter:{createPresetExecutable:async(selection,options)=>{target=options.targetModel;assert.equal(selection.keywordFeedback,'ripple');return{filename:'Auto.exe',bytes:Buffer.from('MZ'),manifest:{}};}}});
  assert.equal((await f.post('/api/export/executable',{...setup,keywordFeedback:'ripple'})).status,200);assert.equal(target,'auto');
});

test('repair reports the actual Connect panel and exact app state instead of claiming process launch established control',async t=>{
  const steps=[];
  const f=await fixture(t,{sdk:{status:async()=>({available:true}),release:async()=>({}),apply:async(_selection,options)=>{assert(options.force);steps.push('registered');return{physicalLightingVerified:false};}},execFileImpl:async(_file,args)=>{
    assert.equal(args[args.indexOf('-Action')+1],'Repair');assert.equal(args[args.indexOf('-AppTitle')+1],'Jeby Lighting Lab');assert.deepEqual(steps,['registered']);
    return{stdout:JSON.stringify({opened:true,connectPanelVerified:true,masterEnabled:true,appListed:false,detail:'Exact app not listed; takeover unresolved.'})};
  }});
  const body=await(await f.post('/api/repair',setup)).json();assert.equal(body.opened,true);assert.equal(body.controlState.appListed,false);assert.equal(body.physicalLightingVerified,false);assert.match(body.detail,/unresolved/);
  const audit=(await fs.readFile(path.join(f.directory,'audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(audit.at(-1).controlState.appListed,false);
});

test('a failed Synapse launch or navigation cannot become a successful repair message',async t=>{
  const stderr='Connect panel timeout\n'+'details'.repeat(200)+'\ncomplete error tail';
  const f=await fixture(t,{execFileImpl:async()=>{throw Object.assign(Error('Connect panel timeout'),{stderr,stdout:'helper output',code:1});}});
  const body=await(await f.post('/api/repair',setup)).json();assert.equal(body.opened,false);assert.match(body.detail,/could not be verified/);assert.match(body.openError,/timeout/);
  const records=(await fs.readFile(path.join(f.directory,'audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(records.at(-1).openFailure.stderr,stderr);assert.equal(records.at(-1).openFailure.stdout,'helper output');
});

test('app profile API switches only an explicit matching saved profile after ordered rule evaluation',async t=>{
  let present=false;
  const f=await fixture(t,{platform:'win32',appProbe:async names=>({apps:names.map(executable=>({executable,running:present,foreground:present})),checkedAt:'2026-10-19T00:00:00.000Z'})});
  const saved=await (await f.post('/api/profiles',{name:'Code Focus',software:'lighting-lab',settings:{...setup,effect:'matrix'}})).json();
  const rule={name:'Visual Studio Code',executable:'Code.exe',condition:'foreground',profileId:saved.profile.id};
  assert.equal((await f.post('/api/app-profiles/config',{automatic:true,waitMs:0,transitionMs:400})).status,200);
  assert.equal((await f.post('/api/app-profiles',rule)).status,200);
  present=true;
  const first=await(await f.post('/api/app-profiles/refresh',{})).json();assert.match(first.runtime.detail,/waiting 0 ms/);
  const switched=await(await f.post('/api/app-profiles/refresh',{})).json();assert.match(switched.runtime.detail,/Active: Visual Studio Code/);
  assert.equal(f.calls.at(-1).effect,'matrix');
  const listed=await(await fetch(f.base+'/api/app-profiles')).json();assert.equal(listed.config.rules[0].executable,'Code.exe');assert.equal(listed.runtime.apps[0].foreground,true);
  const missing=await f.post('/api/app-profiles',{...rule,profileId:'33333333-3333-4333-8333-333333333333'});assert.equal(missing.status,422);
});
