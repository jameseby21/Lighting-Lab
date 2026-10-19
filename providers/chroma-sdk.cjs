/* Own one live SDK session with serial frames, explicit failures, and bounded local requests. */
'use strict';
const {createCustomKeyboardFrame,createCustomMouseFrame}=require('../lighting-domain.cjs');
const Plan=require('../core.js');
const Effects=require('../effects.js');
// Preserve the vendor registration identity; rebranding the editor must not create a different app.
const APP_TITLE='Jeby Lighting Lab';
const PERSISTENCE={kind:'temporary-session',survivesLightingLabShutdown:false,requiresLightingLab:true};

/** Injectable I/O and clocks allow animation and stale-session recovery to be checked without RGB hardware. */
function createChromaSdkProvider({fetchImpl=global.fetch,baseUrl='http://localhost:54235/razer/chromasdk',setIntervalImpl=setInterval,clearIntervalImpl=clearInterval,delayImpl=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)),nowImpl=Date.now,requestTimeoutMs=2500}={}){
  let instanceUri,animation,active,lastError=null,lastHeartbeat=0,frames=0,failedFrames=0,repeatedFailures=0,nextRecoveryAt=0,tickPending=false,operation=Promise.resolve();
  // Every device write uses the same queue; slow HTTP must never reorder frames or settings.
  function enqueue(work){const next=operation.then(work);operation=next.catch(()=>undefined);return next;}
  async function request(url,options={},label='Chroma SDK'){
    for(let attempt=0;attempt<6;attempt++){
      try{
        const response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(requestTimeoutMs)});
        const text=await response.text();if(!response.ok)throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0,180)}`);
        let result;try{result=text?JSON.parse(text):{};}catch{throw new Error(`${label} returned invalid JSON.`);}
        if(typeof result.result==='number'&&result.result!==0)throw new Error(`${label} failed with SDK result ${result.result}.`);
        return result;
      }catch(error){
        // A newly assigned listener can lag registration. Retry only that connection-refused race.
        if(String(url)===baseUrl||error?.cause?.code!=='ECONNREFUSED'||attempt===5)throw error;
        await delayImpl(100);
      }
    }
  }
  async function register(){
    if(instanceUri)return instanceUri;
    const result=await request(baseUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:APP_TITLE,description:'Local keyboard and mouse lighting',author:{name:'jeby Labs',contact:'local'},device_supported:['keyboard','mouse'],category:'application'})},'Chroma SDK registration');
    let parsed;try{parsed=new URL(String(result.uri||''));}catch{throw new Error('Chroma SDK registration returned no usable instance URI.');}
    if(parsed.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('Chroma SDK returned a non-loopback or malformed instance URI.');
    instanceUri=parsed.toString().replace(/\/$/,'');lastHeartbeat=nowImpl();return instanceUri;
  }
  async function heartbeat(){if(instanceUri){await request(`${instanceUri}/heartbeat`,{method:'PUT'},'Chroma SDK heartbeat');lastHeartbeat=nowImpl();}}
  async function sendFrame(){
    if(!active||!instanceUri)return;
    const session=active,timeMs=nowImpl()-session.startedAt;
    session.events=session.events.filter(e=>timeMs-e.at<2500);
    const options={...session.selection,timeMs,events:session.events};
    const frame=createCustomKeyboardFrame(options.effect,options.anchors,0,options);
    if(session.explicitActivation){
      // Force Apply uses the documented create -> SetEffect path as well as a fresh registration.
      const created=await request(`${instanceUri}/keyboard`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(frame)},'Chroma SDK keyboard creation');
      if(typeof created.id!=='string')throw new Error('Chroma did not return an effect identifier for explicit Apply.');
      await request(`${instanceUri}/effect`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({id:created.id})},'Chroma SDK effect activation');
      session.effectId=created.id;session.explicitActivation=false;
    }else await request(`${instanceUri}/keyboard`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(frame)},'Chroma SDK keyboard update');
    frames++;lastError=null;repeatedFailures=0;
    if(options.mouseSync&&session.mouseSyncState!=='unavailable'){
      try{
        await request(`${instanceUri}/mouse`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(createCustomMouseFrame(options.effect,0,options))},'Chroma SDK mouse update');
        session.mouseSyncState='active';session.mouseSyncError=null;
      }catch(error){session.mouseSyncState='unavailable';session.mouseSyncError=error.message;}
    }
  }
  async function dropSession(){
    const uri=instanceUri;instanceUri=undefined;
    if(uri)await request(uri,{method:'DELETE'},'Chroma SDK release');
  }
  function ensureAnimation(){
    if(animation!==undefined)return;
    animation=setIntervalImpl(()=>{
      if(!active||tickPending)return;
      tickPending=true;
      return enqueue(async()=>{
        if(!active)return;
        try{
          const newSession=!instanceUri;
          if(newSession)await register();
          if(nowImpl()-lastHeartbeat>=1500)await heartbeat();
          const animated=Effects.isAnimated(active.selection);
          if(animated||active.events.length||newSession)await sendFrame();
        }catch(error){
          failedFrames++;repeatedFailures++;lastError={message:error.message,at:new Date(nowImpl()).toISOString(),stage:'animation'};
          // Keep the selection visible; an unavailable vendor service must not silently restore a preset.
          if(repeatedFailures>=2&&nowImpl()>=nextRecoveryAt){
            nextRecoveryAt=nowImpl()+2000;
            try{await dropSession();}catch(cleanupError){lastError.cleanup=cleanupError.message;}
            // The next tick registers again with the same selection when the vendor service is back.
          }
        }
      }).finally(()=>{tickPending=false;});
    },46);
  }
  async function status(){
    let detail,available=false,serviceError;
    try{detail=await request(baseUrl,{},'Chroma SDK discovery');available=true;}catch(error){serviceError=error.message;}
    return{available,active:active?{effect:active.selection.effect,anchors:active.selection.anchors.length,protectedAnchors:active.selection.protectedAnchors.length,minimalist:active.selection.minimalist,mouseSync:active.mouseSyncState,mouseSyncError:active.mouseSyncError,keyboardModel:active.selection.keyboardModel,feedback:active.selection.feedback,speed:active.selection.speed}:null,persistence:PERSISTENCE,detail,error:serviceError,lastError,frames,failedFrames};
  }
  /** Change settings in the existing session. A genuinely stale session is recreated once, with the same selection. */
  function apply(selection,{force=false}={}){return enqueue(async()=>{
    let releaseWarning;
    if(force){try{await dropSession();}catch(error){releaseWarning=error.message;}lastError=null;}
    const previous=active;
    active={selection:{...selection},startedAt:previous?.startedAt??nowImpl(),events:previous?.events||[],mouseSyncState:selection.mouseSync?'pending':'off',mouseSyncError:null,explicitActivation:force};
    let uri;
    try{
      uri=await register();await sendFrame();
    }catch(firstError){
      lastError={message:firstError.message,at:new Date(nowImpl()).toISOString(),stage:'apply'};
      try{await dropSession();}catch(cleanupError){lastError.cleanup=cleanupError.message;}
      try{uri=await register();await sendFrame();}catch(error){lastError={message:error.message,at:new Date(nowImpl()).toISOString(),stage:'apply'};ensureAnimation();throw error;}
    }
    ensureAnimation();
    return{provider:'chroma-sdk',mode:'temporary-live-control',instance:new URL(uri).pathname,effect:selection.effect,protectedAnchors:selection.protectedAnchors.length,minimalist:selection.minimalist,mouseSync:active.mouseSyncState,mouseSyncError:active.mouseSyncError,releaseWarning,delivery:'sdk-acknowledged',physicalLightingVerified:false};
  });}
  /** Stop queued animation and unregister; DELETE failure is reported instead of claiming release succeeded. */
  function release(){
    if(animation!==undefined)clearIntervalImpl(animation);animation=undefined;
    return enqueue(async()=>{active=undefined;await dropSession();return{released:true};});
  }
  function keyPress(id){return enqueue(async()=>{
    id=active?.selection.inputAliases?.[id]||id;
    if(!active||!Plan.chromaCoordinates[id])return{accepted:false,reason:'no active Direct effect or unknown physical switch'};
    const target=Effects.groupFor(active.selection,id);
    if(target.reaction==='none')return{accepted:false,reason:'feedback disabled for this switch group'};
    active.events.push({id,at:nowImpl()-active.startedAt});if(active.events.length>128)active.events.splice(0,active.events.length-128);
    try{await sendFrame();}catch(error){lastError={message:error.message,at:new Date(nowImpl()).toISOString(),stage:'feedback'};throw error;}
    return{accepted:true,key:id,mode:target.reaction};
  });}
  return{apply,release,status,keyPress};
}
module.exports={createChromaSdkProvider,APP_TITLE};
