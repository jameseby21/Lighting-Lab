/* Compose base colors, motion, and reactions for both browser preview and Chroma frames. */
(function(root){
  'use strict';
  const Plan=typeof module!=='undefined'&&module.exports?require('./core.js'):root.KeyboardPlan;
  const BLACK={red:0,green:0,blue:0},WHITE={red:255,green:255,blue:255};
  const EFFECTS=['ghost','subtle-keywords','rainbow-road','stars-stripes','matrix','chaos','solid','breathing','spectrum','waterfall','fire','starlight','wave','aurora','radar','prism'];
  const DYNAMIC_EFFECTS=['none','rainbow-road','stars-stripes','matrix','chaos','breathing','spectrum','fire','starlight','wave','aurora','radar','prism'];
  const REACTIONS=['none','reactive','ripple','waterfall','flash','fading-trail','rainbow-ripple','pulse','sparkle','comet'];
  const GROUP_NAMES=['anchor','background','orientation'];
  function clamp(n){return Math.max(0,Math.min(255,Math.round(n)));}
  function rgb(red,green,blue){return{red:clamp(red),green:clamp(green),blue:clamp(blue)};}
  function mix(a,b,t){return rgb(a.red+(b.red-a.red)*t,a.green+(b.green-a.green)*t,a.blue+(b.blue-a.blue)*t);}
  function hue(h,s=1,v=1){h=((h%360)+360)%360;const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c,a=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];return rgb(...a.map(n=>(n+m)*255));}
  function parseColor(value,fallback={red:255,green:0,blue:51}){if(value&&typeof value==='object'&&['red','green','blue'].every(k=>Number.isFinite(value[k])))return rgb(value.red,value.green,value.blue);if(typeof value==='string'&&/^#[\da-f]{6}$/i.test(value))return rgb(parseInt(value.slice(1,3),16),parseInt(value.slice(3,5),16),parseInt(value.slice(5,7),16));return fallback;}
  function hash(value){let n=2166136261;for(const c of String(value)){n^=c.charCodeAt(0);n=Math.imul(n,16777619);}return n>>>0;}
  function legacyGroups(selection){
    const all=Object.keys(Plan.chromaCoordinates),anchors=selection.anchors||[],orientation=selection.protectedAnchors||[],background=all.filter(id=>!anchors.includes(id)&&!orientation.includes(id)),effect=selection.effect==='waterfall'?'ghost':selection.effect;
    return{anchor:{keys:anchors,base:'static',color:selection.keywordColor||selection.color,dynamic:'none',reaction:selection.keywordFeedback||selection.feedback||'reactive',reactionColor:'#ffffff'},background:{keys:background,base:effect==='solid'?'static':'off',color:selection.color,dynamic:DYNAMIC_EFFECTS.includes(effect)?effect:'none',reaction:selection.feedback||'reactive',reactionColor:'#ffffff'},orientation:{keys:orientation,base:'static',color:selection.anchorColor||selection.color,dynamic:'none',reaction:'none',reactionColor:'#ffffff'}};
  }
  /** Each switch belongs to one paint group; old profiles expand into the same compositing contract. */
  function groupsFor(selection){const source=selection.groups&&typeof selection.groups==='object'?selection.groups:legacyGroups(selection),groups={};for(const name of GROUP_NAMES){const raw=source[name]||{};groups[name]={keys:Array.isArray(raw.keys)?raw.keys:[],base:raw.base==='static'?'static':'off',color:raw.color||selection.color||'#ff0033',dynamic:DYNAMIC_EFFECTS.includes(raw.dynamic)?raw.dynamic:'none',reaction:REACTIONS.includes(raw.reaction)?raw.reaction:'none',reactionColor:raw.reactionColor||'#ffffff'};}return groups;}
  function groupFor(selection,id){const groups=groupsFor(selection);if(id&&groups.orientation.keys.includes(id))return groups.orientation;if(id&&groups.anchor.keys.includes(id))return groups.anchor;return groups.background;}
  function fallingMatrixRow(selection,time){const step=Math.floor(time/(230/(Math.max(.1,selection.speed||3.5)/3.5))),seed=selection.seed??17;let cursor=0,cycle=0;while(cursor+6+(3+hash(`${seed}:matrix-gap:${cycle}`)%5)<=step&&cycle<256){cursor+=6+(3+hash(`${seed}:matrix-gap:${cycle}`)%5);cycle++;}const local=step-cursor;return local>=0&&local<6?local:-1;}
  /** Render a supported dynamic layer. Sensor-driven Studio effects remain explicitly unavailable. */
  function dynamic(effect,selection,row,col,time,color){
    const speed=Number.isFinite(selection.speed)?selection.speed:3.5,seconds=time/1000,accent=parseColor(color);
    switch(effect){
      case 'rainbow-road':return hue(col*22+row*35+seconds*180*speed,.9,.95);
      case 'matrix':return row===fallingMatrixRow(selection,time)?rgb(0,240,45):BLACK;
      // One rising row at a time alternates red and white; it intentionally differs from the Matrix gap cadence.
      case 'stars-stripes':{const band=((row+seconds*1.4*(speed/3.5))%2+2)%2;return band<1?rgb(245,20,48):rgb(242,245,255);}
      case 'chaos':{const seed=hash(`${selection.seed??17}:${row}:${col}`),tick=Math.floor(seconds*(3+(seed%8))*(speed/3.5)),random=hash(`${seed}:${tick}`),mode=random%5,base=hue(random%360,.7+(random%30)/100,.8);if(mode===0)return(tick+seed)%3?base:BLACK;if(mode===1)return mix(BLACK,base,(Math.sin(seconds*(seed%9+2))+1)/2);if(mode===2)return hue(random%360+seconds*(seed%150+30),.85,1);if(mode===3)return mix(base,WHITE,(Math.sin(seconds*12+seed)+1)*.15);return base;}
      case 'breathing':return mix(BLACK,accent,(Math.sin(seconds*2)+1)/2);
      case 'spectrum':return hue(seconds*65*(speed/3.5));
      case 'wave':return hue(col*32-row*11+seconds*100*(speed/3.5));
      case 'fire':{const noise=hash(`${selection.seed??17}:${row}:${col}:${Math.floor(seconds*12)}`)%100;return hue(8+noise*.34,.95,.45+noise*.005);}
      case 'starlight':{const tick=Math.floor(seconds*3*(speed/3.5)),spark=hash(`${selection.seed??17}:star:${row}:${col}:${tick}`)%19;return spark===0?accent:BLACK;}
      case 'aurora':{const glow=(Math.sin(col*.8+seconds*2.3)+Math.sin(row*1.3-seconds*1.6)+2)/4;return mix(hue(176+row*10,.75,.95),hue(292-col*8,.62,.88),glow);}
      case 'radar':{const distance=Math.abs((col-row*.7)-((seconds*9*(speed/3.5))%24));return distance<.8?rgb(20,255,110):distance<2.4?mix(BLACK,rgb(0,150,60),(2.4-distance)/3):BLACK;}
      case 'prism':return hue((col*48+row*19+seconds*150*(speed/3.5))%360,.72,.98);
      default:return BLACK;
    }
  }
  function background(selection,row,col,time){return selection.minimalist?BLACK:dynamic(selection.effect,selection,row,col,time,selection.color);}
  const layoutCache=new Map();
  function pointFor(selection,id){const cacheId=selection.keyboardModel||'standard-full-size';if(cacheId==='custom'&&selection.customLayout){const input=Array.isArray(selection.customLayout)?selection.customLayout:selection.customLayout.keys,customKey=input?.find(key=>key.id===id);return customKey?[customKey.y,customKey.x+(customKey.w??1)/2]:null;}let keys=layoutCache.get(cacheId);if(!keys){keys=new Map(Plan.layoutForModel(cacheId).keys.map(key=>[key.id,key]));layoutCache.set(cacheId,keys);}const key=keys.get(id);return key?[key.y,key.x+key.w/2]:null;}
  function reactionSample(selection,target,id,row,col,time,events){
    let result=null;for(const event of events){const legacy=!selection.groups,source=groupFor(selection,event.id),mode=legacy?(selection.protectAnchors&&(selection.anchors||[]).includes(event.id)?'none':source.reaction):target.reaction;if(mode==='none')continue;const origin=Plan.chromaCoordinates[event.id];if(!origin)continue;const age=time-event.at;if(age<0||age>2400)continue;const targetPoint=pointFor(selection,id),originPoint=pointFor(selection,event.id),dr=targetPoint&&originPoint?targetPoint[0]-originPoint[0]:row-origin[0],dc=targetPoint&&originPoint?targetPoint[1]-originPoint[1]:col-origin[1];let alpha=0;
      if(mode==='reactive'||mode==='flash'||mode==='pulse'){if(dr===0&&dc===0)alpha=Math.max(0,1-age/(mode==='flash'?320:mode==='pulse'?700:1300));}
      else if(mode==='ripple'||mode==='rainbow-ripple'){const distance=Math.hypot(dr,dc),elapsed=age-distance*110;if(elapsed>=0&&elapsed<450)alpha=(1-elapsed/450)*Math.max(.35,1-distance/18);}
      else if(mode==='waterfall'){const elapsed=age-dr*150;if(dr>=0&&Math.abs(dc)<=.8&&elapsed>=0&&elapsed<420)alpha=1-elapsed/420;}
      else if(mode==='fading-trail'){const elapsed=age-dc*100;if(Math.abs(dr)<=.5&&dc>=0&&elapsed>=0&&elapsed<700)alpha=1-elapsed/700;}
      else if(mode==='comet'){const elapsed=age-dc*120;if(Math.abs(dr)<=.5&&dc>=0&&elapsed>=0&&elapsed<900)alpha=1-elapsed/900;}
      else if(mode==='sparkle'){const sparkle=hash(`${event.id}:${id}:${Math.floor(age/100)}`)%9;if(age<700&&sparkle===0)alpha=1-age/700;}
      if(alpha>0){const color=mode==='rainbow-ripple'?hue((age+Math.hypot(dr,dc)*40)/7,.9,1):parseColor(target.reactionColor,WHITE),candidate={color,alpha};if(!result||candidate.alpha>result.alpha)result=candidate;}
    }return result;
  }
  function sampleAt(selection,row,col,time,events=[],id){const target=groupFor(selection,id);let base=selection.minimalist?BLACK:(target.base==='static'?parseColor(target.color):BLACK);if(!selection.minimalist&&target.dynamic!=='none')base=dynamic(target.dynamic,selection,row,col,time,target.color);const reaction=reactionSample(selection,target,id,row,col,time,events);return reaction?mix(base,reaction.color,reaction.alpha):base;}
  function sample(selection,id,time,events=[]){const pos=Plan.chromaCoordinates[id];return pos?sampleAt(selection,pos[0],pos[1],time,events,id):BLACK;}
  function bgr(c){return c.red|(c.green<<8)|(c.blue<<16);}
  function frame(selection,time,events=[]){const matrix=Array.from({length:6},(_,row)=>Array.from({length:22},(_,col)=>bgr(sampleAt(selection,row,col,time,events))));for(const id of Object.keys(Plan.chromaCoordinates)){const p=Plan.chromaCoordinates[id];matrix[p[0]][p[1]]=bgr(sample(selection,id,time,events));}return matrix;}
  function isAnimated(selection){return Object.values(groupsFor(selection)).some(group=>group.dynamic!=='none');}
  root.LightingEffects={EFFECTS,DYNAMIC_EFFECTS,REACTIONS,GROUP_NAMES,background,groupsFor,groupFor,isAnimated,sample,sampleAt,frame,bgr,parseColor,hue};
  if(typeof module!=='undefined')module.exports=root.LightingEffects;
})(typeof globalThis!=='undefined'?globalThis:window);
