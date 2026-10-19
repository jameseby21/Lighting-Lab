/* A controller profile is a loadable server record, not a renamed JSON download. */
'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const{createProfileStore,profileCapabilities}=require('../profiles.cjs');
test('named profiles preserve editable state and cannot turn names into paths',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lighting-profiles-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const store=createProfileStore(directory);
  const saved=await store.save({name:'../My RGB',settings:{provider:'chroma-sdk',effect:'matrix',anchors:['Q'],brokenKeys:['NUM_DECIMAL'],inputAliases:{NUM_ADD:'NUM_DECIMAL'},words:['HEX'],keywordFeedback:'ripple'}});
  const files=await fs.readdir(directory);assert.equal(files.length,1);assert.equal(files[0],saved.id+'.json');
  assert.equal((await store.list())[0].name,'../My RGB');const loaded=await store.load(saved.id);assert.deepEqual(loaded.settings.words,['HEX']);assert.equal(loaded.settings.keywordFeedback,'ripple');assert.equal(loaded.settings.inputAliases.NUM_ADD,'NUM_DECIMAL');
  await assert.rejects(store.load('../../somewhere'));await assert.rejects(store.save({name:'',settings:{}}));
});
test('native profile capabilities distinguish representable effects from a controller-specific limitation',()=>{
  assert(profileCapabilities({effect:'matrix'},true)[0].exact);assert.equal(profileCapabilities({effect:'matrix'},true)[1].exact,false);
  assert.equal(profileCapabilities({effect:'solid',feedback:'reactive'},true)[1].exact,true);assert.equal(profileCapabilities({},false)[1].available,false);
  assert.equal(profileCapabilities({effect:'solid',feedback:'reactive',keywordFeedback:'ripple'},true)[1].exact,false);
  assert.equal(profileCapabilities({effect:'solid',inputAliases:{NUM_ADD:'NUM_DECIMAL'}},true)[1].exact,false);
  assert.equal(profileCapabilities({effect:'solid',groups:{anchor:{dynamic:'wave',reaction:'reactive'}}},true)[1].exact,false);
});

test('native mapping keeps Studio numpad Enter separate from physical geometry and unsupported setups never invoke it',async t=>{
  const{saveNativeProfile}=require('../synapse-profile.cjs');const{validateSelection}=require('../lighting-domain.cjs');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'native-profile-contract-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let calls=0;
  const execFileImpl=async(_file,args)=>{
    calls++;assert(args.includes('-BuildOnly'));const request=JSON.parse(await fs.readFile(args[args.indexOf('-RequestFile')+1],'utf8'));
    assert.equal(request.keys.find(k=>k.id==='NUM_ENTER').row,5);assert.equal(request.keys.find(k=>k.id==='Q').row,2);
    assert.deepEqual(request.colors.Q,{red:255,green:0,blue:51});return{stdout:JSON.stringify({saved:true,imported:false})};
  };
  const settings=validateSelection({provider:'chroma-sdk',keyboardModel:'razer-blackwidow-elite',effect:'subtle-keywords',anchors:['Q'],feedback:'none',keywordFeedback:'reactive'});
  await saveNativeProfile({id:'test-native',name:'Native test',settings},{directory,buildOnly:true,execFileImpl});assert.equal(calls,1);
  await assert.rejects(saveNativeProfile({id:'invalid',name:'Unsupported',settings:{...settings,keywordFeedback:'ripple'}},{directory,execFileImpl}),/Lighting Lab/);assert.equal(calls,1);
});
