/* App Profiles map an explicitly named Windows executable to an existing Lighting Lab profile. */
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const CONDITIONS=new Set(['running','foreground']);
const EXECUTABLE=/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,123}\.exe$/i;
const EMPTY={version:1,automatic:true,waitMs:1000,transitionMs:400,rules:[]};
/** Validate rule data before it reaches storage or a Windows child-process argument. */
function normalizeRule(input={}){
  const name=String(input.name||'').trim(),executable=String(input.executable||'').trim();
  if(!name||name.length>80)throw new Error('Give the app rule a name of 1–80 characters.');
  if(!EXECUTABLE.test(executable)||/[\\/]/.test(executable))throw new Error('Use an executable file name such as Code.exe, without a path.');
  if(!CONDITIONS.has(input.condition))throw new Error('Choose Running or In front for the app condition.');
  if(typeof input.profileId!=='string'||!/^[a-f0-9-]{36}$/.test(input.profileId))throw new Error('Choose a saved Lighting Lab profile.');
  return {id:typeof input.id==='string'&&/^[a-f0-9-]{36}$/.test(input.id)?input.id:crypto.randomUUID(),name,executable,condition:input.condition,profileId:input.profileId,enabled:input.enabled!==false};
}
/** Keep global switching preferences bounded and independent from individual rules. */
function normalizeConfig(input={}){
  const rawRules=Array.isArray(input.rules)?input.rules:[];
  if(rawRules.length>25)throw new Error('App Profiles supports up to 25 rules.');
  const ids=new Set(),rules=rawRules.map(normalizeRule);
  for(const rule of rules){if(ids.has(rule.id))throw new Error('Each app rule must have a unique ID.');ids.add(rule.id);}
  const clamp=(value,fallback)=>Math.max(0,Math.min(10_000,Number.isFinite(Number(value))?Math.round(Number(value)):fallback));
  return {version:1,automatic:input.automatic!==false,waitMs:clamp(input.waitMs,1000),transitionMs:clamp(input.transitionMs,400),rules};
}
/** First enabled matching rule wins; missing profiles never become automatic switches. */
function resolveRule(config,appStates=[],profileIds=new Set()){
  if(!config.automatic)return null;
  const states=new Map(appStates.map(state=>[String(state.executable||'').toLowerCase(),state]));
  return config.rules.find(rule=>{const state=states.get(rule.executable.toLowerCase());return rule.enabled&&profileIds.has(rule.profileId)&&Boolean(state?.[rule.condition]);})||null;
}
/** A tiny JSON store keeps rules portable, reviewable, and separate from the saved lighting setup files. */
function createAppProfileStore(directory){
  const file=path.join(directory,'app-profiles.json');
  async function load(){try{return normalizeConfig(JSON.parse(await fs.readFile(file,'utf8')));}catch(error){if(error.code==='ENOENT')return structuredClone(EMPTY);throw error;}}
  async function save(config){const normalized=normalizeConfig(config);await fs.mkdir(directory,{recursive:true});const temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(normalized,null,2),'utf8');await fs.rename(temporary,file);return normalized;}
  async function update(change){const current=await load();return save(change(current));}
  return {load,save,update};
}
module.exports={CONDITIONS,normalizeRule,normalizeConfig,resolveRule,createAppProfileStore};
