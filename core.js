/* Physical switch identities, preview geometry, and cap inventory shared by browser and providers. */
(function(root) {
  'use strict';
  const rows = ['`1234567890-=', 'QWERTYUIOP[]\\', "ASDFGHJKL;'", 'ZXCVBNM,./'];
  const alternatives = [['HEX','BUG','SCRIPT','42069'], ['DVA','MECH','FIST','GLOW','42069'], ['MP40','CR7','KB9','ALI','SUN','HOE'], ['42069','EAFC','NPR','SHIT','DUMB']];
  // Razer RZKEY enumeration: the transport grid differs from physical geometry.
  // https://assets.razerzone.com/dev_portal/REST/html/namespace_chroma_s_d_k_1_1_keyboard.html
  const chromaCoordinates = {
    ESC:[0,1], PRINT:[0,15], SCROLL:[0,16], PAUSE:[0,17], TAB:[2,1], CAPS:[3,1], BACKSPACE:[1,14], ENTER:[3,14],
    LCTRL:[5,1], LWIN:[5,2], LALT:[5,3], SPACE:[5,7], RALT:[5,11], RWIN:[5,12], FN:[5,12], MENU:[5,13], RCTRL:[5,14],
    LSHIFT:[4,1], RSHIFT:[4,14], INSERT:[1,15], HOME:[1,16], PGUP:[1,17], DEL:[2,15], END:[2,16], PGDN:[2,17],
    UP:[4,16], LEFT:[5,15], DOWN:[5,16], RIGHT:[5,17],
    NUM_LOCK:[1,18], NUM_DIVIDE:[1,19], NUM_MULTIPLY:[1,20], NUM_SUBTRACT:[1,21], NUM_ADD:[2,21], NUM_ENTER:[4,21], NUM_DECIMAL:[5,20], NUM_0:[5,19],
    ISO_HASH:[3,13], ISO_BACKSLASH:[4,2], MACRO1:[1,0], MACRO2:[2,0], MACRO3:[3,0], MACRO4:[4,0], MACRO5:[5,0]
  };
  for(let i=1;i<=12;i++)chromaCoordinates['F'+i]=[0,i+2];
  [...rows[0]].forEach((id,i)=>chromaCoordinates[id]=[1,i+1]);
  [...rows[1]].forEach((id,i)=>chromaCoordinates[id]=[2,i+2]);
  [...rows[2]].forEach((id,i)=>chromaCoordinates[id]=[3,i+2]);
  [...rows[3]].forEach((id,i)=>chromaCoordinates[id]=[4,i+3]);
  for(let n=1;n<=9;n++)chromaCoordinates['NUM_'+n]=[4-Math.floor((n-1)/3),18+(n-1)%3];
  const modelCatalog = [
    {id:'standard-full-size',label:'Standard full-size · ANSI 104',family:'generic',geometry:'full-size-with-numpad',accuracy:'reference'},
    {id:'standard-iso',label:'Standard full-size · ISO 105',family:'generic',geometry:'full-size-iso',accuracy:'reference'},
    {id:'standard-tkl',label:'Standard tenkeyless · 87 keys',family:'generic',geometry:'tenkeyless',accuracy:'reference'},
    {id:'standard-75',label:'Standard 75% · 84-key reference',family:'generic',geometry:'75-percent',accuracy:'reference'},
    {id:'standard-65',label:'Standard 65% · 68-key reference',family:'generic',geometry:'65-percent',accuracy:'reference'},
    {id:'standard-60',label:'Standard 60% · 61 keys',family:'generic',geometry:'60-percent',accuracy:'reference'},
    {id:'yunzii-al65',label:'YUNZII AL65 · 68 keys',family:'YUNZII',geometry:'65-percent',accuracy:'model-layout',lighting:'via-firmware',note:'ANSI layout from the official VIA definition. Wired VIA firmware modes are available; arbitrary per-key colors are not exposed.'},
    {id:'razer-ornata',label:'Razer Ornata Chroma',family:'Razer',geometry:'full-size-with-numpad',accuracy:'model-layout',lighting:'per-key',note:'Original Ornata Chroma; choose V2 or V3 explicitly for those models.'},
    {id:'razer-ornata-v2',label:'Razer Ornata V2',family:'Razer',geometry:'full-size-media',accuracy:'approximate',lighting:'per-key',note:'104 mapped switches plus hardware media controls. Media controls are shown for orientation without separate SDK LED mapping.'},
    {id:'razer-ornata-v3',label:'Razer Ornata V3 · 10 RGB zones',family:'Razer',geometry:'full-size-media',accuracy:'approximate',lighting:'10-zone',note:'V3 has ten lighting zones; independent per-key anchors and feedback cannot be reproduced on zone hardware.'},
    {id:'razer-cynosa-chroma',label:'Razer Cynosa Chroma',family:'Razer',geometry:'full-size-with-numpad',accuracy:'model-layout',lighting:'per-key'},
    {id:'razer-blackwidow-elite',label:'Razer BlackWidow Elite',family:'Razer',geometry:'full-size-media',accuracy:'approximate',lighting:'per-key',note:'104 mapped switches plus three media buttons and a volume dial. Hardware controls are shown for orientation without separate SDK LED mapping.'},
    {id:'razer-blackwidow-v4',label:'Razer BlackWidow V4',family:'Razer',geometry:'full-size-macro',accuracy:'approximate',lighting:'per-key',note:'Five macro keys shown; additional side buttons/dials are not mapped as keyboard LEDs.'},
    {id:'logitech-g915',label:'Logitech G915',family:'Logitech',geometry:'full-size-macro',accuracy:'approximate',lighting:'provider-required',note:'Five G keys shown; a compatible provider is required for RGB control.'},
    {id:'corsair-k95',label:'Corsair K95 RGB',family:'Corsair',geometry:'full-size-macro',accuracy:'approximate',lighting:'provider-required',note:'Macro/media keys vary by K95 generation; use Customize view for your variant.'},
    {id:'steelseries-apex-pro',label:'SteelSeries Apex Pro · full-size',family:'SteelSeries',geometry:'full-size-media',accuracy:'approximate',lighting:'provider-required',note:'Main switches shown; OLED/media controls excluded from the RGB switch map.'},
    {id:'custom',label:'Customize view',family:'custom',geometry:'custom',accuracy:'user-defined'}
  ];
  const labels={ESC:'Esc',BACKSPACE:'Backspace',TAB:'Tab',CAPS:'Caps',ENTER:'Enter',LSHIFT:'Shift',RSHIFT:'Shift',LCTRL:'Ctrl',RCTRL:'Ctrl',LWIN:'Win',RWIN:'Win',LALT:'Alt',RALT:'Alt',SPACE:'Space',FN:'Fn',MENU:'Menu',PRINT:'PrtSc',SCROLL:'ScrLk',PAUSE:'Pause',INSERT:'Ins',HOME:'Home',PGUP:'PgUp',DEL:'Del',END:'End',PGDN:'PgDn',UP:'↑',LEFT:'←',DOWN:'↓',RIGHT:'→',NUM_LOCK:'Num',NUM_DIVIDE:'/',NUM_MULTIPLY:'*',NUM_SUBTRACT:'−',NUM_ADD:'+',NUM_ENTER:'Enter',NUM_DECIMAL:'.',ISO_HASH:'#',ISO_BACKSLASH:'\\'};
  function key(id,x,y,w=1,h=1){return{id,label:labels[id]||(id.startsWith('NUM_')?id.slice(4):id),x,y,w,h};}
  function addRow(keys,spec,y,x=0){for(const entry of spec){const[id,w]=Array.isArray(entry)?entry:[entry,1];keys.push(key(id,x,y,w));x+=w;}}
  // The physical number row begins under Escape. Function-key clusters keep their own deliberate gaps.
  function mainKeys(offset=1.25,xOffset=0){
    const keys=[];
    addRow(keys,[...rows[0],['BACKSPACE',2]],offset,xOffset);
    addRow(keys,[['TAB',1.5],...rows[1].slice(0,-1),['\\',1.5]],offset+1,xOffset);
    addRow(keys,[['CAPS',1.75],...rows[2],['ENTER',2.25]],offset+2,xOffset);
    addRow(keys,[['LSHIFT',2.25],...rows[3],['RSHIFT',2.75]],offset+3,xOffset);
    addRow(keys,[['LCTRL',1.25],['LWIN',1.25],['LALT',1.25],['SPACE',6.25],['RALT',1.25],['RWIN',1.25],['MENU',1.25],['RCTRL',1.25]],offset+4,xOffset);
    return keys;
  }
  function fullKeys(numpad=true){
    const keys=mainKeys();keys.push(key('ESC',0,0));
    for(let n=1;n<=12;n++)keys.push(key('F'+n,2+(n-1)+Math.floor((n-1)/4)*.5,0));
    ['PRINT','SCROLL','PAUSE'].forEach((id,i)=>keys.push(key(id,15.5+i,0)));
    [['INSERT','HOME','PGUP'],['DEL','END','PGDN']].forEach((ids,r)=>ids.forEach((id,i)=>keys.push(key(id,15.5+i,1.25+r))));
    keys.push(key('UP',16.5,4.25));['LEFT','DOWN','RIGHT'].forEach((id,i)=>keys.push(key(id,15.5+i,5.25)));
    if(numpad){
      ['NUM_LOCK','NUM_DIVIDE','NUM_MULTIPLY','NUM_SUBTRACT'].forEach((id,i)=>keys.push(key(id,19+i,1.25)));
      for(let n=1;n<=9;n++)keys.push(key('NUM_'+n,19+(n-1)%3,4.25-Math.floor((n-1)/3)));
      keys.push(key('NUM_ADD',22,2.25,1,2),key('NUM_ENTER',22,4.25,1,2),key('NUM_0',19,5.25,2),key('NUM_DECIMAL',21,5.25));
    }
    return keys;
  }
  function compactKeys(){
    const keys=mainKeys(0).filter(k=>!['MENU','RWIN'].includes(k.id));
    Object.assign(keys.find(k=>k.id==='`'),{id:'ESC',label:'Esc'});
    Object.assign(keys.find(k=>k.id==='RSHIFT'),{w:1.75});
    Object.assign(keys.find(k=>k.id==='RALT'),{x:10,w:1});
    Object.assign(keys.find(k=>k.id==='RCTRL'),{x:12,w:1});
    keys.push(key('FN',11,4),key('LEFT',13,4),key('DOWN',14,4),key('RIGHT',15,4),key('UP',14,3));
    ['DEL','PGUP','PGDN','END'].forEach((id,r)=>keys.push(key(id,15,r)));
    return keys;
  }
  /** Hardware silhouettes improve model recognition without inventing controllable RGB channels. */
  function hardwareControls(modelId){
    const description='Physical media control; no separate SDK LED is mapped.';
    function control(id,label,title,x,type='button'){
      return{id,label,title,x,y:type==='dial'?0:.15,w:type==='dial'?1:.85,h:type==='dial'?1:.7,type,rgb:false,selectable:false,description};
    }
    // Elite master guide pp.6,9–10 and Ornata V2 official product/support specify three media buttons plus wheel.
    if(['razer-blackwidow-elite','razer-ornata-v2'].includes(modelId))return[
      control('HW_PREVIOUS','⏮','Previous track',19),control('HW_PLAY_PAUSE','▶Ⅱ','Play / pause',20),
      control('HW_NEXT','⏭','Next track',21),control('HW_VOLUME_DIAL','Vol','Volume dial / press to mute',22,'dial')
    ];
    // Ornata V3 master guide pp.2,5 has four buttons, unlike V2's wheel.
    if(modelId==='razer-ornata-v3')return[
      control('HW_MEDIA','▶Ⅱ','Media: play / pause; multiple presses skip tracks',19),control('HW_MUTE','Mute','Mute / unmute',20),
      control('HW_VOLUME_DOWN','−','Volume down',21),control('HW_VOLUME_UP','+','Volume up',22)
    ];
    return[];
  }
  /** Return fresh unit-based geometry. Custom coordinates change the view, never SDK wiring. */
  function layoutForModel(id='standard-full-size',customLayout){
    const model=modelCatalog.find(m=>m.id===id)||modelCatalog[0];let keys;
    if(model.id==='custom'&&customLayout){
      const input=Array.isArray(customLayout)?customLayout:customLayout.keys;
      if(!Array.isArray(input)||input.length<1||input.length>150)throw new Error('Custom view needs 1–150 switches.');
      const seen=new Set();keys=input.map(k=>{
        if(!chromaCoordinates[k.id]||seen.has(k.id))throw new Error('Custom view contains an unknown or duplicate switch.');seen.add(k.id);
        if(![k.x,k.y,k.w??1,k.h??1].every(Number.isFinite)||k.x<0||k.y<0||k.x>40||k.y>20||(k.w??1)<=0||(k.w??1)>10||(k.h??1)<=0||(k.h??1)>3)throw new Error('Custom view coordinates are out of range.');
        return{...key(k.id,k.x,k.y,k.w??1,k.h??1),label:String(k.label||labels[k.id]||k.id).slice(0,20)};
      });
    }else if(model.geometry==='60-percent'){keys=mainKeys(0);Object.assign(keys[0],{id:'ESC',label:'Esc'});}
    else if(model.geometry==='65-percent')keys=compactKeys();
    else if(model.geometry==='75-percent'){
      keys=compactKeys();keys.forEach(k=>k.y+=1.25);Object.assign(keys.find(k=>k.id==='ESC'),{id:'`',label:'`'});
      ['ESC',...Array.from({length:12},(_,i)=>'F'+(i+1)),'PRINT','SCROLL','PAUSE'].forEach((id,i)=>keys.push(key(id,i,0)));
    }else keys=fullKeys(model.geometry!=='tenkeyless');
    if(model.geometry==='full-size-iso'){
      keys=keys.filter(k=>k.id!=='\\');Object.assign(keys.find(k=>k.id==='ENTER'),{x:13.5,y:2.25,w:1.5,h:2,shape:'iso-enter'});
      Object.assign(keys.find(k=>k.id==='LSHIFT'),{w:1.25});keys.push(key('ISO_BACKSLASH',1.25,4.25),key('ISO_HASH',12.75,3.25,.75));
    }
    if(model.family==='Razer')Object.assign(keys.find(k=>k.id==='RWIN'),{id:'FN',label:'Fn'});
    if(model.geometry==='full-size-macro'){keys.forEach(k=>k.x+=1.25);for(let i=1;i<=5;i++)keys.push(key('MACRO'+i,0,i+.25));}
    const controls=hardwareControls(model.id),allParts=[...keys,...controls];
    return{...model,keys,controls,width:Math.max(...allParts.map(k=>k.x+k.w)),height:Math.max(...allParts.map(k=>k.y+k.h)),caseInset:.5};
  }
  const eventCodes={Escape:'ESC',Backquote:'`',Minus:'-',Equal:'=',BracketLeft:'[',BracketRight:']',Backslash:'\\',Semicolon:';',Quote:"'",Comma:',',Period:'.',Slash:'/',Backspace:'BACKSPACE',Tab:'TAB',CapsLock:'CAPS',Enter:'ENTER',ShiftLeft:'LSHIFT',ShiftRight:'RSHIFT',ControlLeft:'LCTRL',ControlRight:'RCTRL',MetaLeft:'LWIN',MetaRight:'RWIN',AltLeft:'LALT',AltRight:'RALT',Space:'SPACE',ContextMenu:'MENU',PrintScreen:'PRINT',ScrollLock:'SCROLL',Pause:'PAUSE',Insert:'INSERT',Delete:'DEL',Home:'HOME',End:'END',PageUp:'PGUP',PageDown:'PGDN',ArrowUp:'UP',ArrowDown:'DOWN',ArrowLeft:'LEFT',ArrowRight:'RIGHT',NumLock:'NUM_LOCK',NumpadDivide:'NUM_DIVIDE',NumpadMultiply:'NUM_MULTIPLY',NumpadSubtract:'NUM_SUBTRACT',NumpadAdd:'NUM_ADD',NumpadEnter:'NUM_ENTER',NumpadDecimal:'NUM_DECIMAL',IntlBackslash:'ISO_BACKSLASH'};
  /** Resolve physical switches before typed characters so NumLock and Shift cannot merge keys. */
  function eventKey(event){
    const code=event?.code||'';if(eventCodes[code])return eventCodes[code];
    if(/^Key[A-Z]$/.test(code))return code.slice(3);if(/^Digit[0-9]$/.test(code))return code.slice(5);if(/^Numpad[0-9]$/.test(code))return'NUM_'+code.slice(6);if(/^F([1-9]|1[0-2])$/.test(code))return code;
    const id=String(event?.key||'').toUpperCase();return chromaCoordinates[id]?id:null;
  }
  function tokens(word){return(word.toUpperCase().match(/\[[A-Z]+\]|./g)||[]).map(x=>x.startsWith('[')?x.slice(1,-1):x);}
  function cap(token){return({'!':'1','@':'2','#':'3','$':'4','%':'5','^':'6','&':'7','*':'8','(':'9',')':'0','_':'-','+':'=','{':'[','}':']','|':'\\',':':';','"':"'",'<':',','>':'.','?':'/','~':'`'})[token]||token;}
  /** Count real cap supply including independent top-row and numpad numerals. */
  function validate(words,numpad=true){
    const counts=new Map(),errors=[],mainOnly=new Map(),available=new Set([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`-=[]\\;',./",'ESC','DEL','HOME','END','INSERT','PGUP','PGDN']);
    words.forEach(word=>tokens(word).forEach(token=>{const id=cap(token);counts.set(id,(counts.get(id)||0)+1);if(token!==id)mainOnly.set(id,(mainOnly.get(id)||0)+1);if(!available.has(id))errors.push(`${token}: cap availability/1u size not confirmed`);}));
    for(const[id,count]of counts){const supply=numpad&&/^[1-9./*\-]$/.test(id)?2:1;if(count>supply)errors.push(`${id}: needs ${count} physical caps; assumed supply ${supply}`);if((mainOnly.get(id)||0)>1)errors.push(`${id}: repeated shifted legends require the same main-cluster cap`);}return[...new Set(errors)];
  }
  const defaultAnchors=[];
  root.KeyboardPlan={rows,alternatives,modelCatalog,layoutForModel,eventKey,tokens,cap,validate,chromaCoordinates,defaultAnchors};
  if(typeof module!=='undefined')module.exports=root.KeyboardPlan;
})(typeof globalThis!=='undefined'?globalThis:window);
