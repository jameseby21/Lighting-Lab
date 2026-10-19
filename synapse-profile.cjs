/* Native-profile adapter uses local vendor exports; it never writes Synapse's private database. */
'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const{execFile}=require('node:child_process');
const{promisify}=require('node:util');
const Plan=require('./core.js'),Effects=require('./effects.js');
const{profileCapabilities}=require('./profiles.cjs');

/** Materialize a native archive from observed XML, then import it through the visible vendor UI. */
async function saveNativeProfile(profile,{directory,buildOnly=false,execFileImpl=promisify(execFile)}={}){
  const selection=profile.settings,cap=profileCapabilities(selection,true).find(c=>c.id==='synapse-native');
  if(!cap.exact)throw new Error(cap.reason+' Choose Lighting Lab to save the complete animated setup.');
  if(selection.keyboardModel!=='razer-blackwidow-elite')throw new Error('Native Studio export currently has a verified BlackWidow Elite template only. Choose Lighting Lab for this keyboard.');
  const legacy=process.env.LIGHTING_LAB_NATIVE_DIRECTORY||path.join(__dirname,'docs','native');
  const output=path.join(directory,profile.id+'.ChromaEffects'),requestFile=path.join(directory,profile.id+'-native-request.json');
  // This observed native template puts the tall numpad Enter LED on its lower row.
  // Physical preview geometry and SDK coordinates remain independent of Studio's LED placement.
  const keys=Plan.layoutForModel(selection.keyboardModel).keys.map(key=>({id:key.id,row:key.id==='NUM_ENTER'?5:Math.round(key.y===0?0:key.y-.25),x:key.x}));
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(requestFile,JSON.stringify({name:profile.name,source:path.join(legacy,'synapse-both.ChromaEffects'),reactive:path.join(legacy,'reactive-painted.ChromaEffects'),output,keys,settings:selection,colors:Object.fromEntries(keys.map(k=>[k.id,Effects.sample(selection,k.id,0)]))}),'utf8');
  const{stdout}=await execFileImpl('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'save-native-profile.ps1'),'-RequestFile',requestFile,...(buildOnly?['-BuildOnly']:[])],{windowsHide:true,timeout:35000,maxBuffer:256000});
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
module.exports={saveNativeProfile};

/** Re-select a saved native archive without rebuilding or overwriting it. */
async function loadNativeProfile(profile,{directory,execFileImpl=promisify(execFile)}={}){
  const archive=path.join(directory,profile.id+'.ChromaEffects');await fs.access(archive);
  try{
    const{stdout}=await execFileImpl('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'synapse-control.ps1'),'-Action','Select','-ProfileName',profile.name],{windowsHide:true,timeout:35000,maxBuffer:256000});
    return{saved:true,archive,...JSON.parse(stdout.trim().split(/\r?\n/).at(-1))};
  }catch(error){return{saved:true,archive,imported:false,detail:'Native archive saved. In Studio select the imported profile. Automatic selection could not be verified: '+String(error.stderr||error.message).slice(0,500)};}
}
module.exports.loadNativeProfile=loadNativeProfile;
