/* Real vendor-UI readback; may navigate/select controls, but never enables apps or writes RGB. */
'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const{execFile}=require('node:child_process'),{promisify}=require('node:util');
const{APP_TITLE}=require('../providers/chroma-sdk.cjs');
async function main(){
  const{stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'../synapse-control.ps1'),'-Action','Inspect','-AppTitle',APP_TITLE],{windowsHide:true,timeout:40000});
  const state=JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(state.connectPanelVerified,true,'The actual Connect panel must load, not only its tab selection.');
  assert.equal(state.appTitle,APP_TITLE);assert.equal(state.appListed,true,'The exact registered identity must be visible.');
  assert.equal(state.masterEnabled,true);assert.equal(state.appEnabled,true);assert.equal(state.physicalLightingVerified,false);
  console.log(JSON.stringify({...state,lightingWrites:0}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
