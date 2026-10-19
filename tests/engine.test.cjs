/* Regression checks reproduce layout, coordinate, animation, and provider failures without writing hardware. */
'use strict';
const{test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const Plan=require('../core.js'),Effects=require('../effects.js');
const{validateSelection,createCustomKeyboardFrame}=require('../lighting-domain.cjs');
const{createChromaSdkProvider}=require('../providers/chroma-sdk.cjs');
const{detectDevice,identify}=require('../device-profile.cjs');
const settings=extra=>validateSelection({effect:'rainbow-road',provider:'chroma-sdk',anchors:[],...extra});
const rgbToBgr=Effects.bgr;

test('QWERT aligns with the official SDK enumeration rather than lighting WERTY',()=>{
  for(const[id,col]of[...('QWERT')].map((id,i)=>[id,i+2]))assert.deepEqual(Plan.chromaCoordinates[id],[2,col]);
  assert.deepEqual(Plan.chromaCoordinates['1'],[1,2]);
  assert.deepEqual(Plan.chromaCoordinates.Z,[4,3]);
  assert.deepEqual(Plan.chromaCoordinates.NUM_1,[4,18]);
  const frame=createCustomKeyboardFrame('ghost',['Q','W','E','R','T']).param;
  assert.equal(frame[2][1],0);assert.equal(frame[2][2],0x3300ff);assert.equal(frame[2][7],0);
});

test('layouts expose every main switch, function key, navigation key and independent numpad',()=>{
  const expected={'standard-full-size':104,'standard-iso':105,'standard-tkl':87,'standard-75':84,'standard-65':68,'standard-60':61,'yunzii-al65':68};
  for(const[id,count]of Object.entries(expected)){
    const layout=Plan.layoutForModel(id);assert.equal(layout.keys.length,count,id);
    assert.equal(new Set(layout.keys.map(k=>k.id)).size,count,id);
    assert(layout.keys.every(k=>Plan.chromaCoordinates[k.id]&&k.x>=0&&k.y>=0&&k.x+k.w<=layout.width&&k.y+k.h<=layout.height));
    // Absolute unit geometry keeps the numpad beside the alphas instead of wrapping below them.
    for(let i=0;i<layout.keys.length;i++)for(let j=i+1;j<layout.keys.length;j++){
      const a=layout.keys[i],b=layout.keys[j];assert(!(a.x<b.x+b.w-.001&&a.x+a.w>b.x+.001&&a.y<b.y+b.h-.001&&a.y+a.h>b.y+.001),`${id}: ${a.id} overlaps ${b.id}`);
    }
  }
  const full=Plan.layoutForModel();assert(full.keys.find(k=>k.id==='NUM_7').x>full.keys.find(k=>k.id==='ENTER').x);
  assert.equal(Plan.layoutForModel('unrecognized').id,'standard-full-size');
  assert.equal(Plan.layoutForModel('razer-ornata-v3').lighting,'10-zone');
});

test('full-size preview aligns the number row with Escape while preserving function-cluster gaps',()=>{
  const keys=Plan.layoutForModel('standard-full-size').keys,byId=id=>keys.find(key=>key.id===id);
  assert.equal(byId('`').x,byId('ESC').x);
  assert(byId('F1').x>byId('ESC').x+1,'Escape keeps its physical gap before F1');
  assert(byId('F5').x-byId('F4').x>1,'function clusters retain their deliberate gap');
});

test('physical browser events distinguish numpad, shifted characters, controls and ISO switches',()=>{
  assert.equal(Plan.eventKey({code:'Digit1',key:'!'}),'1');
  assert.equal(Plan.eventKey({code:'Numpad1',key:'End'}),'NUM_1');
  assert.equal(Plan.eventKey({code:'NumpadDecimal',key:'Delete'}),'NUM_DECIMAL');
  assert.equal(Plan.eventKey({code:'NumpadEnter',key:'Enter'}),'NUM_ENTER');
  assert.equal(Plan.eventKey({code:'Enter',key:'Enter'}),'ENTER');
  assert.equal(Plan.eventKey({code:'IntlBackslash',key:'\\'}),'ISO_BACKSLASH');
  assert.deepEqual(Plan.validate(['33']),[]);
  assert(Plan.validate(['333']).length);
});

test('media silhouettes reflect documented model hardware without becoming fake RGB switches',()=>{
  for(const id of ['razer-blackwidow-elite','razer-ornata-v2','razer-ornata-v3']){
    const layout=Plan.layoutForModel(id);assert.equal(layout.keys.length,104);assert.equal(layout.controls.length,4);
    assert.equal(new Set([...layout.keys,...layout.controls].map(part=>part.id)).size,108);
    for(const control of layout.controls){
      assert.equal(control.rgb,false);assert.equal(control.selectable,false);assert.equal(Plan.chromaCoordinates[control.id],undefined);
      assert(control.x>=0&&control.y>=0&&control.x+control.w<=layout.width&&control.y+control.h<=layout.height);
      for(const part of [...layout.keys,...layout.controls].filter(other=>other.id!==control.id)){
        assert(!(control.x<part.x+part.w&&control.x+control.w>part.x&&control.y<part.y+part.h&&control.y+control.h>part.y),`${id}: ${control.id} overlaps ${part.id}`);
      }
    }
    assert.equal(layout.controls.filter(control=>control.type==='dial').length,id==='razer-ornata-v3'?0:1);
  }
  assert.deepEqual(Plan.layoutForModel('standard-full-size').controls,[]);
  assert.throws(()=>settings({anchors:['HW_VOLUME_DIAL']}),/No Chroma coordinate/);
});

test('custom view validates geometry while retaining stable transport coordinates',()=>{
  const custom=Plan.layoutForModel('custom',[{id:'Q',label:'Custom Q',x:2,y:1,w:1,h:1}]);
  assert.equal(custom.keys[0].label,'Custom Q');assert.deepEqual(Plan.chromaCoordinates.Q,[2,2]);
  assert.throws(()=>Plan.layoutForModel('custom',[{id:'Q',x:-1,y:0}]));
  assert.throws(()=>Plan.layoutForModel('custom',[{id:'Q',x:0,y:0},{id:'Q',x:1,y:0}]));
});

test('custom geometry edits update feedback paths even though the model ID and SDK coordinates stay unchanged',()=>{
  const config=keys=>settings({keyboardModel:'custom',customLayout:keys,feedback:'waterfall',minimalist:true});
  const inline=config([{id:'Q',x:0,y:0},{id:'A',x:0,y:1}]);
  const moved=config([{id:'Q',x:0,y:0},{id:'A',x:5,y:1}]);
  const events=[{id:'Q',at:0}];
  assert.equal(rgbToBgr(Effects.sample(inline,'A',150,events)),0xffffff);
  assert.equal(rgbToBgr(Effects.sample(moved,'A',150,events)),0);
  assert.equal(Effects.frame(moved,150,events)[3][2],0);
  assert.deepEqual(Plan.chromaCoordinates.A,[3,2]);
  const ripple={...moved,feedback:'ripple'};
  assert.equal(rgbToBgr(Effects.sample(ripple,'A',120,events)),0);
  assert(rgbToBgr(Effects.sample(ripple,'A',570,events))>0);
});

test('Matrix uses one falling green row with deterministic dark spacing; stripes use one rising alternating row',()=>{
  const matrix=settings({effect:'matrix'}),start=Effects.frame(matrix,0),later=Effects.frame(matrix,1500);
  assert.notDeepEqual(start,later,'matrix advances');
  assert(start.filter(row=>row[2]===0x2df000).length<=1,'only one Matrix row is bright');
  assert(Effects.frame(matrix,3000).some(row=>row[2]===0),'Matrix includes dark spacing between lines');
  const stripes=settings({effect:'stars-stripes'}),stripeStart=Effects.frame(stripes,0),stripeLater=Effects.frame(stripes,800);
  assert.notDeepEqual(stripeStart,stripeLater,'stripes rise');assert.notEqual(stripeStart[0][2],stripeStart[1][2]);assert.equal(stripeStart[0][2],stripeStart[2][2]);
  assert(Effects.sample(matrix,'F1',0).green>200);
});

test('Lighting Lab originals extend the native-style catalog with distinct rendered motion and reactions',()=>{
  for(const effect of ['aurora','radar','prism'])assert(Effects.EFFECTS.includes(effect),effect);
  for(const reaction of ['pulse','sparkle','comet','flame'])assert(Effects.REACTIONS.includes(reaction),reaction);
  const base=settings({effect:'aurora'}),radar=settings({effect:'radar'}),prism=settings({effect:'prism'});
  assert.notDeepEqual(Effects.frame(base,400),Effects.frame(radar,400));assert.notDeepEqual(Effects.frame(base,400),Effects.frame(prism,400));
  assert(rgbToBgr(Effects.sample(settings({feedback:'pulse',minimalist:true}),'Q',0,[{id:'Q',at:0}]))>0);
});

test('white feedback stays above rainbow, slowly fades, and minimalist still reacts',()=>{
  const s=settings(),events=[{id:'Q',at:0}];
  assert.deepEqual(Effects.sample(s,'Q',0,events),{red:255,green:255,blue:255});
  const middle=Effects.sample(s,'Q',650,events),base=Effects.sample(s,'Q',650);
  assert(middle.red>=base.red&&middle.green>=base.green&&middle.blue>=base.blue);assert.notDeepEqual(middle,base);
  assert.deepEqual(Effects.sample(s,'Q',1300,events),Effects.sample(s,'Q',1300));
  const minimal=settings({minimalist:true});assert.equal(rgbToBgr(Effects.sample(minimal,'Q',0)),0);
  assert.equal(rgbToBgr(Effects.sample(minimal,'Q',0,events)),0xffffff);
  assert.equal(Effects.frame(s,650,events)[2][2],rgbToBgr(middle));
});

test('anchor protection is configurable and feedback is an animated ring or descending trail',()=>{
  const protectedSelection=settings({anchors:['Q'],protectedAnchors:['W'],protectAnchors:true});
  const events=[{id:'Q',at:0}];assert.equal(rgbToBgr(Effects.sample(protectedSelection,'Q',0,events)),0x3300ff);
  assert.equal(rgbToBgr(Effects.sample({...protectedSelection,protectAnchors:false},'Q',0,events)),0xffffff);
  assert.equal(rgbToBgr(Effects.sample({...protectedSelection,protectAnchors:false},'W',0,[{id:'W',at:0}])),0x3300ff);
  const ripple=settings({feedback:'ripple',minimalist:true});assert.equal(rgbToBgr(Effects.sample(ripple,'W',0,events)),0);
  assert(rgbToBgr(Effects.sample(ripple,'W',110,events))>0);
  const waterfall=settings({feedback:'waterfall',minimalist:true});assert.equal(rgbToBgr(Effects.sample(waterfall,'A',0,events)),0);
  assert.equal(rgbToBgr(Effects.sample(waterfall,'A',150,events)),0xffffff);
  assert.equal(rgbToBgr(Effects.sample(waterfall,'Z',300,events)),0xffffff);
  assert.equal(rgbToBgr(Effects.sample(waterfall,'P',300,events)),0);
});

test('Chaos is per-key deterministic random behavior distinct from Rainbow Road',()=>{
  const selection=settings({effect:'chaos'}),first=Effects.frame(selection,777);
  assert.deepEqual(first,Effects.frame(selection,777));assert.notDeepEqual(first,Effects.frame(selection,999));
  assert.notDeepEqual(first,Effects.frame(settings(),777));assert.notEqual(first[2][2],first[2][3]);
  assert.equal(settings().speed,3.5);assert.throws(()=>settings({speed:Infinity}));assert.throws(()=>settings({anchors:'Q'}));
});

function fakeSdk(){
  let now=0,running=0,maxConcurrent=0,handler,failResult=0,failFetch=false,failDelete=false;
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    running++;maxConcurrent=Math.max(maxConcurrent,running);calls.push({url:String(url),...options});
    await new Promise(resolve=>setTimeout(resolve,1));running--;
    if(failFetch)throw new Error('local SDK unavailable');
    if(failDelete&&options.method==='DELETE')throw new Error('stale session cannot be deleted');
    const body=options.method==='POST'?(String(url).endsWith('/keyboard')?{id:'test-effect',result:failResult}:{uri:'http://localhost:54321/session',result:0}):{result:failResult};
    return{ok:true,status:200,text:async()=>JSON.stringify(body)};
  };
  const provider=createChromaSdkProvider({fetchImpl,nowImpl:()=>now,setIntervalImpl:fn=>{handler=fn;return 1;},clearIntervalImpl:()=>{handler=undefined;}});
  return{provider,calls,setTime:value=>{now=value;},tick:async()=>{await handler?.();},setResult:value=>{failResult=value;},setUnavailable:value=>{failFetch=value;},setDeleteFailure:value=>{failDelete=value;},max:()=>maxConcurrent};
}

test('live edits reuse one registration and Matrix/stripes both continue rendering',async()=>{
  const f=fakeSdk();await f.provider.apply(settings({effect:'matrix'}));
  f.setTime(1600);await f.tick();await f.provider.apply(settings({effect:'stars-stripes'}));f.setTime(3200);await f.tick();
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,0);
  const frames=f.calls.filter(c=>c.url.endsWith('/keyboard'));assert.equal(frames.length,4);assert.notEqual(frames[0].body,frames[1].body);
  assert(f.calls.some(c=>c.url.endsWith('/heartbeat')));assert.equal(f.max(),1);
  await f.provider.release();assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
});

test('slow frames never overlap and SDK nonzero results surface instead of being swallowed',async()=>{
  const f=fakeSdk();await f.provider.apply(settings());
  await Promise.all([f.provider.keyPress('Q'),f.provider.apply(settings({effect:'matrix'})),f.tick()]);assert.equal(f.max(),1);
  f.setResult(5);f.setTime(2000);await f.tick();const status=await f.provider.status();
  assert.match(status.lastError.message,/SDK result 5/);assert.equal(status.active.effect,'matrix');assert(status.failedFrames>0);
  f.setResult(0);await f.provider.release();
});

test('request timeout is bounded and bad registration URIs are rejected',async()=>{
  let signal;
  const provider=createChromaSdkProvider({fetchImpl:async(_url,options)=>{signal=options.signal;return{ok:true,status:200,text:async()=>JSON.stringify({result:0,uri:'http://outside.invalid/session'})};}});
  await assert.rejects(provider.apply(settings()),/non-loopback/);assert(signal instanceof AbortSignal);
  await provider.release();
});

test('an expired session is reopened after repeated animation failures without changing effects',async()=>{
  const f=fakeSdk();await f.provider.apply(settings({effect:'matrix'}));
  f.setResult(5);f.setTime(2000);await f.tick();f.setTime(4000);await f.tick();
  f.setResult(0);f.setTime(6000);await f.tick();
  assert.equal(f.calls.filter(call=>call.method==='POST').length,2);
  const state=await f.provider.status();assert.equal(state.active.effect,'matrix');assert.equal(state.lastError,null);
  await f.provider.release();
});

test('reopening a static session redraws its saved colors even without a new key press',async()=>{
  const f=fakeSdk();await f.provider.apply(settings({effect:'subtle-keywords',anchors:['Q']}));
  f.setResult(5);f.setTime(2000);await f.tick();f.setTime(4000);await f.tick();
  f.setResult(0);f.setTime(6000);await f.tick();
  const frames=f.calls.filter(call=>call.url.endsWith('/keyboard'));assert.equal(frames.length,2);
  assert.equal(JSON.parse(frames.at(-1).body).param[2][2],0x3300ff);
  await f.provider.release();
});

test('device identity uses present ancestry and denied enumeration remains unknown',async()=>{
  const device=await detectDevice({platform:'win32',sdkAvailable:true,execFileImpl:async(_file,args)=>{
    // Missing optional PnP Data records must not abort all present-device identification.
    assert(!args.at(-1).includes('-ExpandProperty Data'));
    return{stdout:JSON.stringify([{names:['HID Keyboard Device','USB\\VID_4D4B&PID_3068']}] )};
  }});
  assert.equal(device.modelId,'yunzii-al65');assert.equal(device.deviceState,'present');
  const denied=await detectDevice({platform:'win32',execFileImpl:async()=>{throw new Error('access denied');}});
  assert.equal(denied.recognized,false);assert.equal(denied.deviceState,'unknown');assert.match(denied.detectionError,/denied/);
  const ambiguous=await detectDevice({platform:'win32',sdkAvailable:true,execFileImpl:async()=>({stdout:'["Razer Ornata"]'})});
  assert.equal(ambiguous.recognized,false);assert.equal(ambiguous.modelId,'standard-full-size');
});

test('present keyboard detection preserves every identity and chooses a recognized default',async()=>{
  const detected=await detectDevice({platform:'win32',sdkAvailable:true,execFileImpl:async()=>({stdout:JSON.stringify([{id:'HID\\Razer',name:'Razer BlackWidow Elite',names:['Razer BlackWidow Elite']},{id:'HID\\AL65',name:'YUNZII AL65',names:['YUNZII AL65']}])})});
  assert.equal(detected.devices.length,2);assert.equal(detected.selectedDeviceId,'HID\\Razer');assert.equal(detected.devices[1].modelId,'yunzii-al65');
});

test('unsupported model variants cannot inherit full-size layouts or another variants RGB zoning',()=>{
  for(const name of ['Logitech G915 TKL','SteelSeries Apex Pro Mini','SteelSeries Apex Pro TKL','Razer Ornata V3 X','Razer BlackWidow V4 75%'])assert.equal(identify([name]),undefined,name);
  assert.equal(identify(['Logitech G915']).id,'logitech-g915');
  assert.equal(identify(['SteelSeries Apex Pro']).id,'steelseries-apex-pro');
  assert.equal(identify(['Razer Ornata V3']).lighting,'10-zone');
});

test('keyword reactions override fixed colors by default and can differ from other-key reactions',()=>{
  const s=settings({anchors:['Q'],feedback:'waterfall',keywordFeedback:'reactive',minimalist:true});
  assert.equal(s.protectAnchors,false);
  assert.equal(rgbToBgr(Effects.sample(s,'Q',0,[{id:'Q',at:0}])),0xffffff);
  assert.equal(rgbToBgr(Effects.sample(s,'A',150,[{id:'Q',at:0}])),0);
  assert.equal(rgbToBgr(Effects.sample(s,'S',150,[{id:'W',at:0}])),0xffffff);
  const muted=settings({anchors:['Q'],feedback:'reactive',keywordFeedback:'none'});
  assert.equal(rgbToBgr(Effects.sample(muted,'Q',0,[{id:'Q',at:0}])),0x3300ff);
});

test('group settings independently compose anchor, background, and orientation layers',()=>{
  const selection=settings({groups:{anchor:{keys:['Q'],base:'static',color:'#ff00aa',dynamic:'none',reaction:'flash',reactionColor:'#ffffff'},background:{keys:['W','E'],base:'off',color:'#000000',dynamic:'matrix',reaction:'waterfall',reactionColor:'#00ffff'},orientation:{keys:['ESC'],base:'static',color:'#00ffcc',dynamic:'none',reaction:'ripple',reactionColor:'#ffffff'}}});
  assert.equal(rgbToBgr(Effects.sample(selection,'Q',0)),0xaa00ff);
  assert.equal(rgbToBgr(Effects.sample(selection,'Q',0,[{id:'Q',at:0}])),0xffffff);
  assert.equal(rgbToBgr(Effects.sample(selection,'ESC',0)),0xccff00);
  const flame={...selection,groups:{...selection.groups,anchor:{...selection.groups.anchor,reaction:'flame',reactionColor:'#2aa8ff'}}};
  const flare=Effects.sample(flame,'Q',0,[{id:'Q',at:0}]);
  assert(flare.blue>flare.red&&flare.blue>flare.green,'blue flame sits above a fixed anchor color');
  assert.equal(rgbToBgr(Effects.sample(flame,'Q',1000,[{id:'Q',at:0}])),0xaa00ff,'blue flame returns to the anchor base after its fade');
  assert.equal(Effects.isAnimated(selection),true);
});

test('explicit Apply registers afresh and uses create then SetEffect without claiming visible LEDs',async()=>{
  const f=fakeSdk();await f.provider.apply(settings());
  assert.equal(JSON.parse(f.calls.find(call=>call.method==='POST').body).title,'Jeby Lighting Lab');
  const result=await f.provider.apply(settings({effect:'matrix'}),{force:true});
  assert(f.calls.some(call=>call.method==='DELETE'));
  assert(f.calls.some(call=>call.url.endsWith('/keyboard')&&call.method==='POST'));
  assert(f.calls.some(call=>call.url.endsWith('/effect')&&call.method==='PUT'&&JSON.parse(call.body).id==='test-effect'));
  assert.equal(result.physicalLightingVerified,false);assert.equal(result.delivery,'sdk-acknowledged');await f.provider.release();
});

test('a working alternate key can trigger feedback for an unresponsive physical key without typing remaps',async()=>{
  const f=fakeSdk();await f.provider.apply(settings({brokenKeys:['NUM_DECIMAL'],inputAliases:{NUM_ADD:'NUM_DECIMAL'}}));
  const result=await f.provider.keyPress('NUM_ADD');assert.equal(result.key,'NUM_DECIMAL');
  assert.throws(()=>settings({inputAliases:{missing:'Q'}}),/coordinate/);await f.provider.release();
});

test('force Apply can replace an undeletable expired session while preserving the cleanup warning',async()=>{
  const f=fakeSdk();await f.provider.apply(settings());f.setDeleteFailure(true);
  const result=await f.provider.apply(settings({effect:'matrix'}),{force:true});
  assert.match(result.releaseWarning,/stale session/);assert.equal(result.effect,'matrix');
  f.setDeleteFailure(false);await f.provider.release();
});

test('native import finds the real named Studio tab before requiring Studio content',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../synapse-control.ps1'),'utf8');
  assert(source.includes("$_.Current.Name -eq 'STUDIO' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem"));
  assert(source.indexOf("Current.Name -eq 'STUDIO'")<source.indexOf("'Studio Actions'"));
  assert.match(source,/if\(-not \$studioContent\)/);
  assert(source.includes("$_.Current.Name -eq 'Open' -and $_.Current.ClassName -eq '#32770'"));
  assert(source.includes("$_.Current.AutomationId -eq '1148' -and $_.Current.ClassName -eq 'Edit'"));
  assert.match(source,/SendText.*0x000C/);assert.match(source,/SendAction.*0x00F5/);
  assert.match(source,/ScreenToClient/);assert.match(source,/SendAction\(\$mainHandle,0x0201/);assert.match(source,/SendAction\(\$mainHandle,0x0202/);
  assert.match(source,/candidate\.TryGetCurrentPattern\(\[System\.Windows\.Automation\.SelectionItemPattern\]/);
  assert.match(source,/combo\.TryGetCurrentPattern\(\[System\.Windows\.Automation\.SelectionPattern\]/);
  assert.match(source,/ValidateSet\('Open','Import','Select','Inspect','Repair'\)/);
  assert(source.indexOf("AutomationId -eq 'ExpanderButton'")<source.indexOf("Current.Name -eq 'CONNECT'"),'open Studio effect flyouts must close before CONNECT navigation');
  assert.match(source,/effectToggle\.Current\.ToggleState -eq \[System\.Windows\.Automation\.ToggleState\]::On/);
  const adapter=fs.readFileSync(path.resolve(__dirname,'../synapse-profile.cjs'),'utf8');
  assert(adapter.includes("'-Action','Select','-ProfileName',profile.name"));
  const synapseControl=fs.readFileSync(path.resolve(__dirname,'../synapse-control.ps1'),'utf8');
  assert(synapseControl.includes("ById $window 'btnChromaApp'"));
  assert(synapseControl.includes('Selecting CONNECT alone leaves that panel closed'));
});
