/* Persist owner-observed LED results separately from transport acknowledgements. */
'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const PROVIDERS=new Set(['chroma-sdk','synapse-native']);

function createControlVerificationStore(file){
  async function read(){
    try{
      const data=JSON.parse(await fs.readFile(file,'utf8'));
      return data?.version===1&&data.records&&typeof data.records==='object'?data:{version:1,records:{}};
    }catch{return{version:1,records:{}};}
  }
  function identity(modelId,provider){return `${String(modelId||'unknown').replace(/[^a-z0-9-]/gi,'_')}:${provider}`;}
  async function record({modelId,provider,visible}){
    if(!PROVIDERS.has(provider))throw new Error('Choose a supported lighting provider.');
    if(typeof visible!=='boolean')throw new Error('Report whether the physical lights visibly changed.');
    const data=await read(),observedAt=new Date().toISOString();
    const result={modelId:String(modelId||'unknown'),provider,status:visible?'confirmed':'rejected',observedAt,source:'owner-observation'};
    data.records[identity(result.modelId,provider)]=result;
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,JSON.stringify(data,null,2)+'\n','utf8');
    return result;
  }
  async function forDevice(modelId){
    const data=await read(),providers={};
    for(const provider of PROVIDERS){const result=data.records[identity(modelId,provider)];if(result)providers[provider]=result;}
    return{modelId:String(modelId||'unknown'),providers};
  }
  return{record,forDevice};
}
module.exports={createControlVerificationStore};
