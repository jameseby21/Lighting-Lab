/* Physical acceptance is durable device/provider evidence, separate from SDK delivery. */
'use strict';
const{test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const{createControlVerificationStore}=require('../control-verification.cjs');

test('owner observations persist independently for each device and provider',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lighting-verification-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'control.json'),store=createControlVerificationStore(file);
  assert.deepEqual((await store.forDevice('razer-blackwidow-elite')).providers,{});
  await store.record({modelId:'razer-blackwidow-elite',provider:'chroma-sdk',visible:false});
  await store.record({modelId:'razer-blackwidow-elite',provider:'synapse-native',visible:true});
  const restored=await createControlVerificationStore(file).forDevice('razer-blackwidow-elite');
  assert.equal(restored.providers['chroma-sdk'].status,'rejected');
  assert.equal(restored.providers['synapse-native'].status,'confirmed');
  assert.equal(restored.providers['chroma-sdk'].source,'owner-observation');
  assert.deepEqual((await store.forDevice('yunzii-al65')).providers,{});
});

test('verification rejects malformed observations and tolerates a corrupt local cache',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lighting-verification-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'control.json'),store=createControlVerificationStore(file);
  await assert.rejects(store.record({modelId:'x',provider:'made-up',visible:true}),/supported/);
  await assert.rejects(store.record({modelId:'x',provider:'chroma-sdk',visible:'yes'}),/whether/);
  await fs.writeFile(file,'{broken','utf8');assert.deepEqual((await store.forDevice('x')).providers,{});
});
