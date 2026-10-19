/* Protect honest target capability gates, immutable payload export, and shell-free compilation. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {AL65,createExportManifest,createPresetExecutable,getExportCapabilities} = require('../export.cjs');

const setup = {effect:'rainbow-road',provider:'chroma-sdk',keyboardModel:'yunzii-al65',anchors:['Q','W','NUM_3'],
  protectedAnchors:['ESC'],feedback:'reactive',minimalist:false,mouseSync:true,customLayout:{label:'Brother test'}};

test('AL65 capability advertises a documented built-in approximation without per-key or persistence claims',()=>{
  const capability = getExportCapabilities('yunzii-al65',{effect:'matrix'});
  assert.equal(capability.supported,true);
  assert.equal(capability.exact,false);
  assert.equal(capability.needsApproximationAcknowledgement,true);
  assert.deepEqual(capability.mappedEffect,{id:15,name:'Digital Rain'});
  assert.match(capability.limitations.join(' '),/USB.*wired/);
  assert.match(capability.limitations.join(' '),/power loss.*hardware test/);
  assert.equal(AL65.vendorId,0x4D4B);
  assert.equal(AL65.productId,0x3068);
});

test('unknown native protocols remain gated while portable Razer presets declare their runtime',()=>{
  for (const model of ['standard-full-size','unknown']) {
    const capability = getExportCapabilities(model,setup);
    assert.equal(capability.executable,false,model);
    assert.equal(capability.supported,false,model);
    assert.ok(capability.reason.length>30);
    assert.throws(()=>createExportManifest({...setup,keyboardModel:model},{acceptApproximation:true}),{code:'EXPORT_UNSUPPORTED'});
  }
  for(const model of ['auto','razer-ornata','razer-ornata-v2','razer-ornata-v3','razer-cynosa-chroma']){
    const capability=getExportCapabilities(model,setup);assert.equal(capability.executable,true);assert.equal(capability.mode,'portable-sdk');assert.match(capability.reason,/Chroma runtime/);assert(capability.limitations.some(value=>value.includes('closing')));
  }
});

test('unrepresentable firmware modes never silently become a rainbow',()=>{
  for (const effect of ['chaos','stars-stripes','waterfall','unrecognized','constructor','__proto__','toString']) {
    assert.equal(getExportCapabilities('yunzii-al65',{effect}).supported,false);
    assert.throws(()=>createExportManifest({...setup,effect},{acceptApproximation:true}),{code:'EXPORT_UNSUPPORTED'});
  }
});

test('whole-board approximation needs explicit consent even when the chosen model is AL65',()=>{
  for (const acceptApproximation of [undefined,false,'true',1])
    assert.throws(()=>createExportManifest(setup,{acceptApproximation}),{code:'EXPORT_APPROXIMATION_REQUIRED'});
});

test('manifest preserves every requested setting while reducing only the separately described firmware payload',()=>{
  const before = structuredClone(setup);
  const manifest = createExportManifest(setup,{acceptApproximation:true,now:new Date('2026-10-17T12:00:00Z')});
  assert.deepEqual(manifest.requested,setup);
  assert.deepEqual(setup,before);
  assert.equal(manifest.generatedAt,'2026-10-17T12:00:00.000Z');
  assert.deepEqual(manifest.desired,{brightness:204,mode:7,speed:255,hue:247,saturation:255});
  assert.match(manifest.operation,/backup.*verify.*save/i);
  manifest.requested.anchors.push('E');
  assert.deepEqual(setup,before);
});

test('portable firmware overrides are bounded bytes and cannot override target identity or the allowlisted mode',()=>{
  assert.throws(()=>createExportManifest({...setup,portable:{speed:256}},{acceptApproximation:true}),{code:'EXPORT_INVALID'});
  assert.throws(()=>createExportManifest({...setup,portable:{hue:-1}},{acceptApproximation:true}),{code:'EXPORT_INVALID'});
  assert.throws(()=>createExportManifest({...setup,portable:{brightness:1.5}},{acceptApproximation:true}),{code:'EXPORT_INVALID'});
  const manifest = createExportManifest({...setup,portable:{brightness:64,speed:32,hue:85,saturation:190,mode:255,vendorId:1}},{acceptApproximation:true});
  assert.deepEqual(manifest.desired,{brightness:64,speed:32,hue:85,saturation:190,mode:7});
  assert.equal(manifest.target.vendorId,0x4D4B);
});

test('Solid Color and Subtle Keywords preserve selected hue/saturation while documenting independent firmware speed',()=>{
  for (const effect of ['solid','subtle-keywords']) {
    const blue=createExportManifest({...setup,effect,color:'#0000ff',speed:.25},{acceptApproximation:true});
    assert.equal(blue.desired.mode,1);
    assert.equal(blue.desired.hue,170);
    assert.equal(blue.desired.saturation,255);
    assert.equal(blue.desired.speed,255);
    assert.equal(blue.requested.speed,.25);
    assert.match(blue.settingReduction.speed,/no verified firmware equivalent/);
    const gray=createExportManifest({...setup,effect,keywordColor:'#808080'},{acceptApproximation:true});
    assert.equal(gray.desired.saturation,0);
    assert.throws(()=>createExportManifest({...setup,effect,color:'blue'},{acceptApproximation:true}),{code:'EXPORT_INVALID'});
  }
  const matrix=createExportManifest({...setup,effect:'matrix',color:'#ff0000'},{acceptApproximation:true});
  assert.equal(matrix.desired.hue,85);
  assert.equal(matrix.desired.saturation,255);
});

test('oversized and malformed export payloads fail before compilation',async()=>{
  let called=false;
  const execFileImpl=async()=>{called=true;};
  await assert.rejects(createPresetExecutable({...setup,large:'a'.repeat(65536)},{acceptApproximation:true,execFileImpl}),{code:'EXPORT_INVALID'});
  assert.throws(()=>createExportManifest(null),{code:'EXPORT_INVALID'});
  assert.equal(called,false);
});

test('compiler receives an embedded resource through argument arrays and temporary files are removed',async()=>{
  let resource;
  let compilerArgs;
  const hostileLabel='literal $(command) `powershell` "quotes"; not source code';
  const execFileImpl=async(file,args,options)=>{
    compilerArgs=args;
    assert.equal(file,'compiler path with spaces.exe');
    assert.equal(options.windowsHide,true);
    assert.equal(options.timeout,30000);
    resource=args.find(value=>value.startsWith('/resource:')).slice('/resource:'.length).replace(/,preset\.json$/,'');
    const payload=JSON.parse(await fs.readFile(resource,'utf8'));
    assert.equal(payload.requested.customLayout.label,hostileLabel);
    assert.equal(args.some(arg=>arg.includes(hostileLabel)),false);
    await fs.writeFile(args.find(value=>value.startsWith('/out:')).slice(5),Buffer.from('MZstandalone-test'));
    return {stdout:''};
  };
  const result=await createPresetExecutable({...setup,customLayout:{label:hostileLabel}},
    {acceptApproximation:true,compilerPath:'compiler path with spaces.exe',execFileImpl});
  assert.match(result.filename,/AL65-rainbow-road\.exe$/);
  assert.equal(result.bytes.toString(),'MZstandalone-test');
  assert.equal(result.sha256.length,64);
  assert.equal(path.basename(compilerArgs.at(-1)),'PresetRunner.cs');
  await assert.rejects(fs.stat(path.dirname(resource)),{code:'ENOENT'});
});

test('compile failures and malformed compiler output cannot produce a successful download',async()=>{
  await assert.rejects(createPresetExecutable(setup,{acceptApproximation:true,
    execFileImpl:async()=>{throw new Error('compiler unavailable');}}),{code:'EXPORT_BUILD_FAILED'});
  await assert.rejects(createPresetExecutable(setup,{acceptApproximation:true,
    execFileImpl:async(file,args)=>{await fs.writeFile(args.find(value=>value.startsWith('/out:')).slice(5),'not an executable');}}),{code:'EXPORT_BUILD_FAILED'});
});

test('official AL65 evidence keeps the 68 physical keys and channels used by the runner',async()=>{
  const definition=JSON.parse(await fs.readFile(path.join(__dirname,'..','portable','al65-definition.json'),'utf8'));
  assert.equal(Number(definition.vendorId),AL65.vendorId);
  assert.equal(Number(definition.productId),AL65.productId);
  assert.deepEqual(definition.matrix,{rows:5,cols:15});
  assert.deepEqual(definition.layouts.keymap.map(row=>row.filter(key=>typeof key==='string').length),[15,15,14,14,10]);
  const lighting=definition.menus[0].content.find(menu=>menu.label==='Backlight').content;
  const effect=lighting.find(control=>control.label==='Effect');
  assert.deepEqual(effect.content,['id_qmk_rgb_matrix_effect',3,2]);
  assert.match(effect.options[7],/Rainbow Moving Chevron/);
  assert.match(effect.options[15],/Digital Rain/);
});
