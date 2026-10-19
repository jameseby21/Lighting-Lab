/* Validate complete settings before providers touch hardware; rendering stays shared with the preview. */
'use strict';
const KeyboardPlan=require('./core.js');
const Effects=require('./effects.js');
const EFFECTS=new Set(Effects.EFFECTS),DYNAMIC_EFFECTS=new Set(Effects.DYNAMIC_EFFECTS),REACTIONS=new Set(Effects.REACTIONS),PROVIDERS=new Set(['synapse-native','chroma-sdk']);
const DEFAULT_ANCHORS=KeyboardPlan.defaultAnchors;
const ANCHOR_RGB={red:255,green:0,blue:51};

/** Normalize only supported configuration fields while rejecting malformed or unknown switch IDs. */
function validateSelection(selection){
  if(!selection||typeof selection!=='object')throw new Error('Provide a lighting configuration.');
  const effect=selection.effect,provider=selection.provider;
  if(!EFFECTS.has(effect))throw new Error('Choose a supported Lighting Lab effect.');
  if(!PROVIDERS.has(provider))throw new Error('Choose a supported control provider.');
  function ids(value,label){
    if(value===undefined)return[];
    if(!Array.isArray(value)||value.length>150)throw new Error(`${label} must be a switch list.`);
    for(const id of value)if(typeof id!=='string'||!KeyboardPlan.chromaCoordinates[id])throw new Error(`No Chroma coordinate is known for ${String(id).slice(0,30)}.`);
    return[...new Set(value)];
  }
  const anchors=ids(selection.anchors,'Keyword selection'),protectedAnchors=ids(selection.protectedAnchors,'Anchor selection');
  const keyboardModel=typeof selection.keyboardModel==='string'?selection.keyboardModel:'standard-full-size';
  if(!KeyboardPlan.modelCatalog.some(m=>m.id===keyboardModel))throw new Error('Choose a keyboard from the model list.');
  const speed=selection.speed===undefined?3.5:selection.speed;
  if(typeof speed!=='number'||!Number.isFinite(speed)||speed<.1||speed>10)throw new Error('Speed must be between 0.1 and 10.');
  const feedback=selection.feedback===undefined?'reactive':selection.feedback;
  if(!REACTIONS.has(feedback))throw new Error('Choose supported key feedback.');
  const keywordFeedback=selection.keywordFeedback??feedback;
  if(!REACTIONS.has(keywordFeedback))throw new Error('Choose supported keyword feedback.');
  const result={effect,provider,anchors,protectedAnchors,keyboardModel,speed,feedback,keywordFeedback,minimalist:Boolean(selection.minimalist),mouseSync:Boolean(selection.mouseSync),protectAnchors:selection.protectAnchors===true};
  result.brokenKeys=ids(selection.brokenKeys,'Unresponsive keys');
  result.inputAliases={};
  if(selection.inputAliases!=null){
    if(typeof selection.inputAliases!=='object'||Array.isArray(selection.inputAliases))throw new Error('Feedback substitutions must be a switch map.');
    for(const[from,to]of Object.entries(selection.inputAliases)){
      ids([from,to],'Feedback substitutions');result.inputAliases[from]=to;
    }
  }
  for(const field of ['color','keywordColor','anchorColor']){
    const value=selection[field]??'#ff0033';if(typeof value!=='string'||!/^#[\da-f]{6}$/i.test(value))throw new Error(`${field} must be a six-digit hex color.`);result[field]=value;
  }
  const seed=selection.seed??17;if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw new Error('Chaos seed must be a 32-bit unsigned integer.');result.seed=seed;
  if(selection.groups!==undefined){
    if(!selection.groups||typeof selection.groups!=='object'||Array.isArray(selection.groups))throw new Error('Lighting groups must be an object.');
    result.groups={};const assigned=new Set();
    for(const name of Effects.GROUP_NAMES){
      const group=selection.groups[name];if(!group||typeof group!=='object'||Array.isArray(group))throw new Error(`Provide the ${name} lighting group.`);
      const keys=ids(group.keys,`${name} group`);for(const id of keys){if(assigned.has(id))throw new Error(`Switch ${id} belongs to more than one lighting group.`);assigned.add(id);}
      if(!['off','static'].includes(group.base))throw new Error(`Choose a base lighting mode for ${name}.`);
      if(!DYNAMIC_EFFECTS.has(group.dynamic))throw new Error(`Choose a supported dynamic effect for ${name}.`);
      if(!REACTIONS.has(group.reaction))throw new Error(`Choose a supported reaction for ${name}.`);
      for(const field of ['color','reactionColor'])if(typeof group[field]!=='string'||!/^#[\da-f]{6}$/i.test(group[field]))throw new Error(`${name} ${field} must be a six-digit hex color.`);
      result.groups[name]={keys,base:group.base,dynamic:group.dynamic,reaction:group.reaction,color:group.color,reactionColor:group.reactionColor};
    }
    result.anchors=result.groups.anchor.keys;result.protectedAnchors=result.groups.orientation.keys;
    result.effect=result.groups.background.dynamic==='none'?(result.groups.background.base==='static'?'solid':'ghost'):result.groups.background.dynamic;
    result.feedback=result.groups.background.reaction;result.keywordFeedback=result.groups.anchor.reaction;
  }
  if(selection.customLayout!=null)result.customLayout=KeyboardPlan.layoutForModel('custom',selection.customLayout);
  return result;
}

// Native-profile matching remains conservative: an empty default is not evidence of a saved vendor profile.
function isSavedProfileSelection(){return false;}
function bgr(rgb){return Effects.bgr(rgb);}
/** Legacy phase input is kept for callers; new animation paths pass explicit elapsed milliseconds. */
function createCustomKeyboardFrame(effect,anchors,phase=0,options={}){
  const time=options.timeMs??phase*1000/(180*(options.speed??3.5));
  const events=options.events||[...(options.feedbackKeys||[])].map(id=>({id,at:time}));
  return{effect:'CHROMA_CUSTOM',param:Effects.frame({...options,effect,anchors},time,events)};
}
/** Mouse shares the selected background motion; its generic RGB canvas has 9 rows and 7 columns. */
function createCustomMouseFrame(effect,phase=0,options={}){
  const selection={...options,effect},time=options.timeMs??phase*1000/(180*(options.speed??3.5));
  const param=Array.from({length:9},(_,row)=>Array.from({length:7},(_,col)=>bgr(Effects.background(selection,row*5/8,col*21/6,time))));
  return{effect:'CHROMA_CUSTOM2',param};
}
module.exports={ANCHOR_RGB,DEFAULT_ANCHORS,EFFECTS,PROVIDERS,bgr,createCustomKeyboardFrame,createCustomMouseFrame,isSavedProfileSelection,validateSelection};
