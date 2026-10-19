/* App Profile rules remain deterministic: input validation, first-match priority, and safe local persistence. */
'use strict';
const{test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const{normalizeConfig,normalizeRule,resolveRule,createAppProfileStore}=require('../app-profiles.cjs');
const profileA='11111111-1111-4111-8111-111111111111',profileB='22222222-2222-4222-8222-222222222222';
test('app profile rules reject paths and resolve the first enabled matching saved profile',()=>{
  assert.throws(()=>normalizeRule({name:'Unsafe',executable:'C:\\Games\\game.exe',condition:'running',profileId:profileA}),/file name/);
  const config=normalizeConfig({automatic:true,rules:[{name:'Foreground Code',executable:'Code.exe',condition:'foreground',profileId:profileA},{name:'Code fallback',executable:'Code.exe',condition:'running',profileId:profileB}]});
  const rule=resolveRule(config,[{executable:'Code.exe',running:true,foreground:true}],new Set([profileA,profileB]));assert.equal(rule.profileId,profileA);
  assert.equal(resolveRule(config,[{executable:'Code.exe',running:true,foreground:false}],new Set([profileB])).profileId,profileB);
  assert.equal(resolveRule({...config,automatic:false},[{executable:'Code.exe',running:true,foreground:true}],new Set([profileA,profileB])),null);
});
test('app profile store writes a bounded portable config',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lighting-app-profiles-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createAppProfileStore(directory);const saved=await store.save({automatic:true,waitMs:1200,transitionMs:500,rules:[{name:'Code',executable:'Code.exe',condition:'foreground',profileId:profileA}]});
  assert.equal(saved.rules.length,1);assert.equal((await store.load()).waitMs,1200);assert.equal((await fs.stat(path.join(directory,'app-profiles.json'))).isFile(),true);
});
