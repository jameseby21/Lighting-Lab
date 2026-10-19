/* Named profiles stay in the chosen controller; a JSON download is a separate operation. */
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const{validateSelection}=require('./lighting-domain.cjs');

/** The local RGB engine can preserve every setting; native support is deliberately per effect. */
function profileCapabilities(selection={},nativeAvailable=false){
  const advancedGroups=selection.groups&&Object.values(selection.groups).some(group=>group&&(
    group.dynamic!=='none'||!['none','reactive'].includes(group.reaction)));
  return[
    {id:'lighting-lab',label:'Lighting Lab (full setup)',available:true,exact:true,reason:'Stores a named profile here and loads it into the live lighting engine. No download.'},
    {id:'synapse-native',label:'Razer Synapse Studio',available:nativeAvailable,
      exact:['solid','ghost','subtle-keywords'].includes(selection.effect)&&['none','reactive'].includes(selection.feedback||'reactive')&&['none','reactive'].includes(selection.keywordFeedback??selection.feedback??'reactive')&&!advancedGroups&&!selection.mouseSync&&Object.keys(selection.inputAliases||{}).length===0,
      reason:nativeAvailable?'Native static colors and white Reactive are supported. Custom animated modes, Ripple/Waterfall, mouse sync, and alternate input triggers need the Lighting Lab engine.':'No local native Synapse export template is available. Choose Lighting Lab for the full setup.'}
  ];
}

/** Use generated IDs, never profile names, as file paths; all original editor settings survive. */
function createProfileStore(directory){
  async function list(){
    await fs.mkdir(directory,{recursive:true});const profiles=[];
    for(const file of await fs.readdir(directory))if(/^[a-f0-9-]+\.json$/.test(file)){
      try{const p=JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));profiles.push({id:p.id,name:p.name,software:p.software,updatedAt:p.updatedAt});}catch{/* A malformed local file cannot prevent the remaining profiles loading. */}
    }
    return profiles.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  async function save({name,settings,software='lighting-lab'}){
    if(typeof name!=='string'||!name.trim()||name.length>80)throw new Error('Give the profile a name of 1–80 characters.');
    if(!['lighting-lab','synapse-native'].includes(software))throw new Error('Choose a supported profile controller.');
    const normalized=validateSelection(settings),id=crypto.randomUUID();
    const record={id,name:name.trim(),software,updatedAt:new Date().toISOString(),settings:{...settings,...normalized}};
    await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,id+'.json'),JSON.stringify(record,null,2),{encoding:'utf8',flag:'wx'});return record;
  }
  async function load(id){
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new Error('Choose a saved profile.');
    return JSON.parse(await fs.readFile(path.join(directory,id+'.json'),'utf8'));
  }
  return{list,save,load};
}
module.exports={profileCapabilities,createProfileStore};
