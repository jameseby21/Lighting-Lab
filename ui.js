/* Physical key identities, saved configuration, and shared effect samples drive this editor.
 * Live requests are serialized and coalesced so an older response cannot overwrite a newer edit. */
'use strict';
const K = KeyboardPlan, E = LightingEffects, $ = id => document.getElementById(id);
const STORAGE_KEY = 'lighting-lab-setup-v2';
const ONBOARDING_KEY = 'lighting-lab-onboarding-v1';
let anchors = new Set(K.defaultAnchors), protectedAnchors = new Set(), legends = {}, assignments = [];
let customLayout = null, customBaseModel = 'standard-full-size', manualModel = false;
let deviceStatus = {model:'Unknown keyboard', source:'fallback'}, providerStatus = null;
let serverAvailable = false, providerAvailable = false, liveProviderAvailable = false, pendingSelection = null, applying = false;
let liveUpdateTimer, statusTimer, exportCapabilities = null, capabilityRevision = 0, lastCapabilityKey = '';
let layout, keyElements = new Map(), events = [], lastPreviewFrame = -100;
let previewPaused = matchMedia('(prefers-reduced-motion: reduce)').matches;
let brokenKeys=new Set(),inputAliases={},guideState=null,physicalConfirmed=false,lastAttemptProvider='chroma-sdk';
const GROUP_DEFAULTS={anchor:{base:'static',color:'#ff4fb8',dynamic:'none',reaction:'flame',reactionColor:'#2aa8ff'},background:{base:'off',color:'#8090ae',dynamic:'rainbow-road',reaction:'reactive',reactionColor:'#ffffff'},orientation:{base:'static',color:'#52ddea',dynamic:'none',reaction:'none',reactionColor:'#ffffff'}};
const EFFECT_LABELS={none:'None','rainbow-road':'Rainbow Road','stars-stripes':'Stars & Stripes',matrix:'Matrix',chaos:'Chaos',breathing:'Breathing (Chroma)',spectrum:'Spectrum Cycling (Chroma)',fire:'Fire (Chroma)',starlight:'Starlight (Chroma)',wave:'Wave (Chroma)',aurora:'Aurora',radar:'Radar Sweep',prism:'Prism Flow'};
const REACTION_LABELS={none:'None',reactive:'Reactive / white fade (Chroma)',ripple:'Ripple (Chroma)',waterfall:'Waterfall',flash:'Flash','fading-trail':'Fading trail','rainbow-ripple':'Rainbow ripple',pulse:'Pulse',sparkle:'Sparkle',comet:'Comet trail',flame:'Blue flame'};
let paintMode='anchor',groupKeys={anchor:new Set(anchors),background:new Set(),orientation:new Set(protectedAnchors)},groupSettings=structuredClone(GROUP_DEFAULTS);
function allPhysicalIds(){return Object.keys(K.chromaCoordinates);}
function normalizeGroups(){
  for(const name of E.GROUP_NAMES)groupKeys[name]=new Set([...groupKeys[name]].filter(id=>allPhysicalIds().includes(id)));
  const occupied=new Set([...groupKeys.anchor,...groupKeys.orientation]);
  groupKeys.background=new Set(allPhysicalIds().filter(id=>!occupied.has(id)));
  anchors=new Set(groupKeys.anchor);protectedAnchors=new Set(groupKeys.orientation);
}
function groupPayload(){normalizeGroups();return Object.fromEntries(E.GROUP_NAMES.map(name=>[name,{keys:[...groupKeys[name]],...groupSettings[name]}]));}
// A color pin and a key reaction are separate layers; protecting a keyword is an explicit choice.
const keywordLabel=document.createElement('label');keywordLabel.innerHTML='Keyword Key Reaction<select id="keyword-feedback"><option value="reactive">White fade</option><option value="ripple">Ripple</option><option value="waterfall">Waterfall</option><option value="none">No reaction</option></select>';$('feedback').parentElement.before(keywordLabel);$('feedback').parentElement.firstChild.textContent='Other Key Reaction';$('protect').checked=false;
const identifyButton=document.createElement('button');identifyButton.id='identify-layout';identifyButton.className='quiet';identifyButton.textContent='Identify My Layout';$('pause-preview').before(identifyButton);
const detectionPrompt=document.createElement('p');detectionPrompt.id='layout-prompt';detectionPrompt.className='help';$('board-scroll').before(detectionPrompt);
const groupPanel=document.createElement('section');groupPanel.className='group-panel';groupPanel.innerHTML='<div class="group-heading"><div><p class="eyebrow">LAYERED LIGHTING</p><h2>Choose what each key group does</h2></div><div class="group-actions"><button id="anchor-blue-flame" class="quiet">Blue flame anchor keys</button><button id="preview-apply" class="primary">Apply to keyboard</button></div></div><p class="help">Base lighting, motion, and reactions are independent. Reaction is rendered above dynamic and base lighting.</p><p id="reaction-status" class="help" aria-live="polite">Pick a reaction, then click a key or type below to test it.</p><div id="group-editor" class="group-editor"></div><label class="test-typing">Test typing<input id="test-typing" placeholder="Type here to fire reactions" autocomplete="off"></label>';document.querySelector('.effect-controls').before(groupPanel);
const devicePicker=document.createElement('label');devicePicker.className='device-picker';devicePicker.innerHTML='Connected keyboard<select id="selected-device"></select><small id="device-scope"></small>';$('device-status').after(devicePicker);
$('selection-mode').innerHTML='<option value="test">Test reactions</option><option value="anchor">Paint anchor</option><option value="background">Paint background</option><option value="orientation">Paint orientation</option>';
$('selection-mode').value='anchor';
const issuePanel=document.createElement('details');issuePanel.className='panel';issuePanel.innerHTML='<summary>Key Issues & Workarounds <span>Broken keys, Num Lock, alternate lighting triggers</span></summary><div class="details-content"><label>Problem key<select id="issue-key"></select></label><div class="button-row"><button id="mark-broken" class="quiet">This Key Does Not Register</button><button id="clear-broken" class="quiet">Mark Working</button></div><p id="issue-status" class="help"></p><label>Use this working key instead for lighting reactions<select id="issue-alternate"><option value="">No substitution</option></select></label><button id="issue-use" class="quiet">Set Lighting Substitute</button><p class="help">This changes lighting feedback only. It does not change typing or remap Windows. For a number-pad key, check Num Lock and vendor remapping; a physical fault can need repair or an OS-level remap.</p></div>';document.querySelector('.advanced-grid').prepend(issuePanel);
for(const id of Object.keys(K.chromaCoordinates))for(const target of ['issue-key','issue-alternate']){const option=document.createElement('option');option.value=id;option.textContent=id;$(target).append(option);}
const presets = [
  {name:'Rainbow Road',detail:'A spectrum in motion',swatch:'rainbow',effect:'rainbow-road',feedback:'reactive'},
  {name:'Rainbow Ripple',detail:'Make a little wave',swatch:'ripple',effect:'rainbow-road',feedback:'ripple'},
  {name:'Waterfall',detail:'Light follows your lead',swatch:'waterfall',effect:'ghost',feedback:'waterfall',minimalist:true},
  {name:'Matrix',detail:'Rising neon green bands',swatch:'matrix',effect:'matrix',feedback:'waterfall'},
  {name:'After Dark',detail:'Only light when you type',swatch:'minimal',effect:'ghost',feedback:'reactive',minimalist:true},
  {name:'Stars & Stripes',detail:'Red & white rising bands',swatch:'stripes',effect:'stars-stripes',feedback:'reactive'},
  {name:'Noob Deterrent',detail:'Your chosen anchor keys',swatch:'keywords',effect:'subtle-keywords',feedback:'reactive'},
  {name:'Chaos',detail:'Random color. Random motion.',swatch:'chaos',effect:'chaos',feedback:'reactive'},
  {name:'Color Study',detail:'One color. All yours.',swatch:'solid',effect:'solid',feedback:'reactive'},
  {name:'Aurora',detail:'Slow teal and violet drift',swatch:'aurora',effect:'aurora',feedback:'pulse'},
  {name:'Radar Sweep',detail:'A green scan through the dark',swatch:'radar',effect:'radar',feedback:'sparkle'},
  {name:'Prism Flow',detail:'Clean color movement',swatch:'prism',effect:'prism',feedback:'comet'}
];

/** Return an immutable, complete setup suitable for JSON, live providers, and executable export. */
function configuration() {
  const groups=groupPayload(),backgroundGroup=groups.background,anchorGroup=groups.anchor;
  return {format:'lighting-lab-effect-v1',device:deviceStatus.model,provider:$('provider').value,
    deviceId:$('selected-device').value||undefined,groups,
    effect:backgroundGroup.dynamic==='none'?(backgroundGroup.base==='static'?'solid':'ghost'):backgroundGroup.dynamic,background:backgroundGroup.dynamic,feedback:backgroundGroup.reaction,keywordFeedback:anchorGroup.reaction,reactionLayersVersion:3,
    speed:Number($('speed').value),color:$('color').value,keywordColor:$('color').value,anchorColor:$('color').value,
    mode:$('mode').value,words:words(),physicalInventoryIssues:K.validate(words(),$('numpad').checked),
    placements:structuredClone(assignments),anchors:[...groups.anchor.keys],protectedAnchors:[...groups.orientation.keys],
    legends:{...legends},protectAnchors:$('protect').checked,minimalist:$('minimalist').checked,
    keyboardModel:$('keyboard-model').value,customLayout:customLayout?structuredClone(customLayout):null,
    customBaseModel,manualModel,mouseSync:$('sync-mouse').checked,numpadInventory:$('numpad').checked,
    live:$('live').checked,previewPaused,brokenKeys:[...brokenKeys],inputAliases:{...inputAliases},
    synapseImportable:JSON.stringify([...anchors].sort())===JSON.stringify([...K.defaultAnchors].sort())&&protectedAnchors.size===0};
}
function words() { return $('words').value.split(',').map(word=>word.trim()).filter(Boolean); }
function setStatus(id,message,state='') { $(id).textContent=message;$(id).dataset.state=state; }
function persist() { try { localStorage.setItem(STORAGE_KEY,JSON.stringify(configuration())); } catch { /* Storage-disabled previews still work. */ } }
/** A share link is a browser-only recipe: loading it restores the preview but never contacts hardware. */
function createShareLink(setup,base=location.href){const bytes=new TextEncoder().encode(JSON.stringify(setup));if(bytes.length>6000)throw Error('This setup is too large for a reliable share link. Export Setup JSON instead.');let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);const url=new URL(base);url.hash=`lighting-lab=${btoa(binary)}`;return url.href;}
function readShareLink(hash=location.hash){const encoded=new URLSearchParams(String(hash).replace(/^#/,'')).get('lighting-lab');if(!encoded)return null;try{const binary=atob(encoded),bytes=Uint8Array.from(binary,character=>character.charCodeAt(0));const setup=JSON.parse(new TextDecoder().decode(bytes));if(!setup||typeof setup!=='object'||!Array.isArray(setup.anchors))throw Error('missing anchors');return setup;}catch{throw Error('This Lighting Lab share link is incomplete or invalid.');}}
async function copyText(value){if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);return true;}const field=document.createElement('textarea');field.value=value;field.setAttribute('readonly','');field.style.position='fixed';field.style.opacity='0';document.body.append(field);field.select();const copied=document.execCommand?.('copy')===true;field.remove();return copied;}

/** Restore saved editor state without inferring that an imported layout supports physical RGB. */
function restoreSetup(data) {
  if(!data || typeof data!=='object' || !Array.isArray(data.anchors))throw Error('Choose a Lighting Lab setup JSON containing an anchors array.');
  const setValue=(id,value)=>{if(value!==undefined&&[...$(id).options].some(option=>option.value===String(value)))$(id).value=value;};
  setValue('background',data.effect||data.background);setValue('feedback',data.feedback);setValue('provider',data.provider);setValue('mode',data.mode);
  setValue('keyword-feedback',data.keywordFeedback||'reactive');brokenKeys=new Set(data.brokenKeys||[]);inputAliases={...(data.inputAliases||{})};
  const model=K.modelCatalog.some(item=>item.id===data.keyboardModel)?data.keyboardModel:'standard-full-size';
  $('keyboard-model').value=model;manualModel=data.manualModel!==false;
  if(data.customLayout){const checked=K.layoutForModel('custom',data.customLayout);customLayout=checked.keys;if(model==='custom')$('keyboard-model').value='custom';}
  else customLayout=null;
  customBaseModel=K.modelCatalog.some(item=>item.id===data.customBaseModel)?data.customBaseModel:model;
  // The server still validates physical IDs. Invalid imported values never become markup or executable code.
  anchors=new Set(data.anchors.filter(id=>typeof id==='string'));protectedAnchors=new Set((data.protectedAnchors||[]).filter(id=>typeof id==='string'));
  if(data.groups&&typeof data.groups==='object'){
    for(const name of E.GROUP_NAMES){const imported=data.groups[name]||{};groupKeys[name]=new Set((imported.keys||[]).filter(id=>typeof id==='string'));groupSettings[name]={...GROUP_DEFAULTS[name],...Object.fromEntries(Object.entries(imported).filter(([key])=>key!=='keys'))};}
  }else {groupKeys.anchor=new Set(anchors);groupKeys.orientation=new Set(protectedAnchors);groupSettings.background.dynamic=data.effect||data.background||GROUP_DEFAULTS.background.dynamic;groupSettings.background.reaction=data.feedback||GROUP_DEFAULTS.background.reaction;groupSettings.anchor.reaction=data.keywordFeedback||GROUP_DEFAULTS.anchor.reaction;}
  normalizeGroups();
  legends=data.legends&&typeof data.legends==='object'?data.legends:{};assignments=Array.isArray(data.placements)?data.placements:[];
  if(Array.isArray(data.words))$('words').value=data.words.join(', ');
  if(Number.isFinite(Number(data.speed)))$('speed').value=Math.max(.25,Math.min(6,Number(data.speed)));
  if(/^#[a-f\d]{6}$/i.test(data.color||data.anchorColor||''))$('color').value=data.color||data.anchorColor;
  for(const [id,key]of [['protect','protectAnchors'],['minimalist','minimalist'],['sync-mouse','mouseSync'],['numpad','numpadInventory'],['live','live']])if(typeof data[key]==='boolean')$(id).checked=data[key];
  if(typeof data.previewPaused==='boolean')previewPaused=data.previewPaused;
  if(data.reactionLayersVersion!==2)$('protect').checked=false;
}

/** Propose first-fit word islands only when requested; choosing a preset preserves manual selections. */
function arrange() {
  anchors=new Set();groupKeys.anchor=new Set();legends={};assignments=[];
  const used=K.rows.map(()=>0);
  for(const word of words()){
    const tokens=K.tokens(word),row=used.findIndex((count,index)=>count+tokens.length<=K.rows[index].length);
    if(row<0){assignments.push({word,error:'No contiguous main-cluster row space remains'});continue;}
    const ids=[...K.rows[row]].slice(used[row],used[row]+tokens.length);
    ids.forEach((id,index)=>{anchors.add(id);groupKeys.anchor.add(id);legends[id]=tokens[index];});used[row]+=tokens.length+1;assignments.push({word,switches:ids});
  }
  changed();
}

/** Group controls make the renderer's base, motion, and reaction layers explicit. */
function renderGroupEditor(){
  const editor=$('group-editor');editor.replaceChildren();
  const options=(values,selected,labels={})=>values.map(value=>`<option value="${value}"${value===selected?' selected':''}>${labels[value]||value.replaceAll('-', ' ')}</option>`).join('');
  for(const name of E.GROUP_NAMES){const group=groupSettings[name],card=document.createElement('article');card.className=`group-card ${name}`;card.innerHTML=`<div><b>${name}</b><small>${groupKeys[name].size} keys</small></div><label>Base<select data-group="${name}" data-field="base">${options(['off','static'],group.base,{off:'Off',static:'Static (Chroma)'})}</select></label><label>Dynamic<select data-group="${name}" data-field="dynamic">${options(E.DYNAMIC_EFFECTS,group.dynamic,EFFECT_LABELS)}</select></label><label>Reaction<select data-group="${name}" data-field="reaction">${options(E.REACTIONS,group.reaction,REACTION_LABELS)}</select></label><label>Base color<input data-group="${name}" data-field="color" type="color" value="${group.color}"></label><label>Reaction color<input data-group="${name}" data-field="reactionColor" type="color" value="${group.reactionColor}"></label>`;editor.append(card);}
  editor.querySelectorAll('[data-group]').forEach(control=>control.onchange=()=>{groupSettings[control.dataset.group][control.dataset.field]=control.value;changed(false);});
}
function assignToPaintGroup(id){if(paintMode==='test'){fireReaction(id);return;}const target=groupKeys[paintMode];if(target.has(id)&&paintMode!=='background'){target.delete(id);groupKeys.background.add(id);}else{for(const name of E.GROUP_NAMES)groupKeys[name].delete(id);target.add(id);}normalizeGroups();changed(false);}
function enableBlueAnchorFlame(){groupSettings.anchor.reaction='flame';groupSettings.anchor.reactionColor='#2aa8ff';renderGroupEditor();changed(false);setStatus('reaction-status','Blue flame is now assigned to anchor keys. Click or type an anchor key to test it.','ready');}
function fireReaction(id){if(!id)return;const physicalId=inputAliases[id]||id,selection=configuration(),reaction=E.groupFor(selection,physicalId).reaction;markOnboarding('test');events.push({id:physicalId,at:performance.now()});paintPreview(performance.now());if(reaction==='none'){setStatus('reaction-status','This key group has reactions off. Choose a reaction or use Blue flame anchor keys.','problem');return;}setStatus('reaction-status',physicalId+' preview: '+(REACTION_LABELS[reaction]||reaction)+' is above its base and dynamic layers.','ready');if(!(serverAvailable&&liveProviderAvailable&&$('live').checked)){setStatus('reaction-status',physicalId+' previewed. Turn on Live Connection to send this reaction to the keyboard.','');return;}fetch('/api/key-press',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:physicalId})}).then(async response=>{const result=await response.json().catch(()=>({}));if(!response.ok||result.accepted===false){setStatus('reaction-status',result.reason||'The live reaction was not accepted. Apply the current setup and try again.','problem');return;}setStatus('reaction-status',physicalId+' live '+(REACTION_LABELS[result.mode]||result.mode)+' reached the Chroma session.','ready');}).catch(()=>setStatus('reaction-status','The preview reacted, but the live reaction was not delivered. Apply the current setup and try again.','problem'));}

/** Use physical geometry instead of line wrapping, preserving full-height Enter and numpad identities. */
function renderBoard() {
  layout=K.layoutForModel($('keyboard-model').value,customLayout);
  const unit=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--unit'))||48;
  const gap=5,surface=$('key-surface');surface.replaceChildren();keyElements=new Map();
  surface.style.width=`${layout.width*unit}px`;surface.style.height=`${layout.height*unit}px`;
  $('case-name').textContent=layout.label.toUpperCase();$('key-count').textContent=`${layout.keys.length} switches`;
  $('board').dataset.model=layout.id;
  $('model-note').textContent=[manualModel?'View chosen by you.':'Automatic view.',layout.note||(layout.accuracy==='reference'?'Standard reference layout; casing is schematic.':'Layout illustration; casing is approximate.')].join(' ');
  for(const position of layout.keys){
    const key=document.createElement('button');key.type='button';key.className='key';key.dataset.id=position.id;key.dataset.code=position.code||'';
    key.textContent=$('mode').value==='caps'?(legends[position.id]||position.label):position.label;
    key.style.left=`${position.x*unit}px`;key.style.top=`${position.y*unit}px`;key.style.width=`${position.w*unit-gap}px`;key.style.height=`${position.h*unit-gap}px`;
    key.title=`${position.label} (${position.id})`;key.setAttribute('aria-label',`${position.label} � ${position.id}`);
    key.onclick=()=>{if($('edit-geometry').checked){$('geometry-key').value=position.id;readGeometryFields();return;}assignToPaintGroup(position.id);};
    surface.append(key);keyElements.set(position.id,key);
  }
  // Media buttons and dials help orient the view but have no addressable keyboard LED.
  for(const control of layout.controls||[]){
    const element=document.createElement('div');element.className=`hardware-control ${control.type==='dial'||control.kind==='dial'?'hardware-dial':''}`;element.dataset.controlId=control.id;
    const name=control.title||control.label;element.textContent=control.label;element.setAttribute('role','img');element.setAttribute('aria-label',`${name} � hardware control; no addressable RGB LED`);element.title=`${name} � physical control, no addressable RGB LED`;
    element.style.left=`${control.x*unit}px`;element.style.top=`${control.y*unit}px`;element.style.width=`${(control.w||1)*unit-gap}px`;element.style.height=`${(control.h||1)*unit-gap}px`;surface.append(element);
  }
  const previous=$('geometry-key').value;$('geometry-key').replaceChildren();
  for(const key of layout.keys){const option=document.createElement('option');option.value=key.id;option.textContent=`${key.label} � ${key.id}`;$('geometry-key').append(option);}
  if(layout.keys.some(key=>key.id===previous))$('geometry-key').value=previous;
  readGeometryFields();renderSelection();paintPreview(performance.now());
}
function renderSelection() {
  normalizeGroups();
  for(const [id,key]of keyElements){key.classList.toggle('anchor',groupKeys.anchor.has(id));key.classList.toggle('protected',groupKeys.orientation.has(id));key.setAttribute('aria-pressed',String(paintMode!=='test'&&groupKeys[paintMode]?.has(id)));}
  const visible=new Set(layout.keys.map(key=>key.id));
  $('selection-count').textContent=`${[...anchors].filter(id=>visible.has(id)).length} color � ${[...protectedAnchors].filter(id=>visible.has(id)).length} protected`;
}
function onboardingState(){try{return JSON.parse(localStorage.getItem(ONBOARDING_KEY)||'{}')||{};}catch{return {};}}
/** Keep first-run progress local to this browser; it never becomes device or account telemetry. */
function markOnboarding(step){try{const next={...onboardingState(),[step]:true};localStorage.setItem(ONBOARDING_KEY,JSON.stringify(next));}catch{/* A private-mode preview remains fully usable. */}renderOnboarding();}
function renderOnboarding(){const panel=$('quickstart');if(!panel)return;const state=onboardingState();panel.hidden=state.dismissed===true;if(panel.hidden)return;for(const item of panel.querySelectorAll('[data-onboarding-step]'))item.dataset.complete=String(Boolean(state[item.dataset.onboardingStep]));const completed=['preset','test','apply'].filter(step=>state[step]).length;$('quickstart-status').textContent=completed===3?'You are ready to save a profile or keep customizing.':`${completed} of 3 complete. The preview stays local until you choose Apply.`;}
/** Apply a gallery choice through the same state path as the advanced controls. */
function choosePreset(preset){$('background').value=preset.effect;$('feedback').value=preset.feedback;groupSettings.background.dynamic=preset.effect==='ghost'||preset.effect==='solid'||preset.effect==='subtle-keywords'?'none':preset.effect;groupSettings.background.base=preset.effect==='solid'?'static':'off';groupSettings.background.reaction=preset.feedback;$('minimalist').checked=Boolean(preset.minimalist);markOnboarding('preset');changed(false);}
function renderReadiness(){const states={preview:{state:'ready',text:'The browser preview is ready.'},controller:providerAvailable?{state:'ready',text:'The selected controller can receive a request.'}:{state:'problem',text:'No controllable provider is available yet.'},physical:physicalConfirmed?{state:'ready',text:'A person confirmed the current provider changed the lights.'}:{state:'pending',text:'Awaiting a physical confirmation after Apply.'}};for(const [name,detail]of Object.entries(states)){const item=document.querySelector(`[data-readiness="${name}"]`);item.dataset.state=detail.state;item.querySelector('span').textContent=detail.text;}$('readiness-action').textContent=physicalConfirmed?'Open saved profiles':'Review Apply';}
function renderDetails() {
  renderGroupEditor();renderOnboarding();renderReadiness();
  const pinned=layout.keys.filter(key=>anchors.has(key.id)||protectedAnchors.has(key.id)).length;
  $('layer-warning').textContent=[$('minimalist').checked?'Keypress Only is on: the background is deliberately dark.':'',pinned?`${pinned} of ${layout.keys.length} keys have fixed colors; the background appears on the remaining ${layout.keys.length-pinned}. Clear color anchors to expose more of the effect.`:'','Keyword reactions sit above their fixed colors unless you explicitly protect them.'].filter(Boolean).join(' ');
  $('issue-status').textContent=brokenKeys.size?`Reported unresponsive: ${[...brokenKeys].join(', ')}. These keys remain in the layout.`:'No unresponsive keys recorded.';
  $('speed-value').textContent=`${Number($('speed').value)}�`;
  const issues=K.validate(words(),$('numpad').checked);$('validation').textContent=issues.length?`Physical cap inventory: ${issues.join(' � ')}`:'Cap inventory fits the stated US-legend assumptions. Check actual cap sizes before moving caps.';
  $('placements').replaceChildren();for(const assignment of assignments){const p=document.createElement('p');p.textContent=`${assignment.word} ? ${assignment.error||(assignment.switches||[]).join(' ')}`;$('placements').append(p);}
  for(const [index,preset]of presets.entries())$('preset-gallery').children[index].setAttribute('aria-pressed',String($('background').value===preset.effect&&$('feedback').value===preset.feedback&&$('minimalist').checked===Boolean(preset.minimalist)));
  const selected=configuration();$('recipe').textContent=[`Model view: ${layout.label} (${layout.keys.length} switches)`,`Background: ${selected.effect} � speed ${selected.speed}�`,`On keypress: ${selected.feedback}`,`Color anchors: ${selected.anchors.join(' ')||'(none)'}`,`Protected anchors: ${selected.protectedAnchors.join(' ')||'(none)'}`,`Anchor color: ${selected.anchorColor}`,`Keypress only: ${selected.minimalist?'on':'off'}`,`Live provider: ${selected.provider}`,`Mouse sync: ${selected.mouseSync?'requested; provider support required':'off'}`,'JSON stores the complete setup and customized view.','An executable export reports what the target firmware can actually reproduce.','A browser preview is not physical keyboard validation.'].join('\n');
  $('pause-preview').textContent=previewPaused?'Resume preview':'Pause preview';$('pause-preview').setAttribute('aria-pressed',String(previewPaused));
}
function changed(rebuild=true) { if(rebuild)renderBoard();else renderSelection();renderDetails();persist();paintPreview(performance.now());queueLiveUpdate();refreshExportCapabilities(); }

/** Preview and hardware use the same samples; only the keycap illustration darkens their fill for legibility. */
function paintPreview(time) {
  events=events.filter(event=>time-event.at<2400);const selection=configuration();
  for(const [id,key]of keyElements){const color=E.sample(selection,id,time,events),{red,green,blue}=color;key.dataset.rgb=`${red},${green},${blue}`;key.style.background=`rgb(${Math.round(19+red*.19)},${Math.round(21+green*.19)},${Math.round(29+blue*.19)})`;key.style.borderColor=`rgba(${red},${green},${blue},${Math.max(red,green,blue)>30?.65:.14})`;key.style.boxShadow=`inset 0 -3px 0 rgba(${red},${green},${blue},.65),0 1px 0 #080b10`;key.classList.toggle('pressed',red>220&&green>220&&blue>220);}
}
function animatePreview(time) { if(!previewPaused&&time-lastPreviewFrame>40){paintPreview(time);lastPreviewFrame=time;}requestAnimationFrame(animatePreview); }
document.addEventListener('keydown',event=>{
  if($('layout-guide').open){const response=LayoutGuide.press(guideState,K.eventKey(event)||'');if(response.accepted){event.preventDefault();guideState=response.state;renderGuide();}return;}
  if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)||event.target.isContentEditable||event.ctrlKey||event.metaKey||event.altKey||event.repeat)return;
  const id=K.eventKey(event);if(!id)return;fireReaction(id);
});
$('test-typing').addEventListener('keydown',event=>{if(event.ctrlKey||event.metaKey||event.altKey||event.repeat)return;const id=K.eventKey(event);if(id)fireReaction(id);});

/** A single pending slot keeps only the latest complete setup while a provider call is in flight. */
function queueLiveUpdate(immediate=false) {
  if(!$('live').checked||!serverAvailable||!liveProviderAvailable)return;
  pendingSelection={selection:configuration(),force:false};clearTimeout(liveUpdateTimer);
  liveUpdateTimer=setTimeout(drainLiveUpdates,immediate?0:120);
}
async function drainLiveUpdates() {
  if(applying||!pendingSelection)return;
  applying=true;
  try {
    while(pendingSelection){const {selection,force}=pendingSelection;pendingSelection=null;setStatus('apply-status','Sending settings to your keyboard�');
      try{const response=await fetch('/api/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...selection,force})});const body=await response.json();if(!response.ok)throw Error(body.error||`Live lighting failed (${response.status}).`);lastAttemptProvider=selection.provider;physicalConfirmed=false;$('physical-check').hidden=false;setStatus('apply-status',`${force?'Apply':'Live edit'} acknowledged by ${body.result?.provider||'controller'}. Check your physical keyboard below; visible lighting is not yet confirmed.`,'');}
      catch(error){setStatus('apply-status',`Preview updated; hardware update failed: ${error.message}`,'problem');}
    }
  } finally {applying=false;}
}
async function refreshProviderStatus() {
  try{
    const response=await fetch('/api/status');if(!response.ok)throw Error(`Status request failed (${response.status}).`);
    const data=await response.json(),wasLiveAvailable=liveProviderAvailable;providerStatus=data;serverAvailable=true;deviceStatus=data.device||deviceStatus;
    const picker=$('selected-device'),previousDevice=picker.value,devices=deviceStatus.devices||[deviceStatus];picker.replaceChildren();for(const item of devices){const option=new Option(item.model||item.name||'Keyboard',item.id||item.deviceId||'');picker.append(option);}picker.value=deviceStatus.selectedDeviceId||previousDevice||picker.options[0]?.value||'';$('device-scope').textContent=deviceStatus.controlScope?.detail||'';
    const selectedProvider=$('provider').value,transportAvailable=selectedProvider==='chroma-sdk'?Boolean(data.sdk?.available):Boolean(data.synapse?.available||data.synapse?.uiOpen||Object.values(data.synapse?.installed||{}).some(Boolean));
    const verification=data.controlVerification?.providers?.[selectedProvider],rejected=verification?.status==='rejected';physicalConfirmed=verification?.status==='confirmed';
    providerAvailable=transportAvailable&&!rejected;liveProviderAvailable=selectedProvider==='chroma-sdk'&&providerAvailable;
    $('global-input').checked=Boolean(data.input?.enabled);
    if(!manualModel){const normalized=String(deviceStatus.model||'').toLowerCase().replace(/[^a-z0-9]/g,'');const detected=K.modelCatalog.find(model=>model.id===deviceStatus.modelId||model.id===deviceStatus.keyboardModel||model.label.toLowerCase().replace(/[^a-z0-9]/g,'')===normalized);const next=detected?.id||'standard-full-size';if($('keyboard-model').value!==next){$('keyboard-model').value=next;renderBoard();renderDetails();}}
    const model=`${deviceStatus.model||'Unknown keyboard'} � ${deviceStatus.source||'reported by provider'}`;
    const capability=deviceStatus.guidance||deviceStatus.capability?.reason||'';
    const providerError=selectedProvider==='chroma-sdk'?(data.sdk?.lastError?.message||data.sdk?.error||data.sdk?.active?.mouseSyncError):data.synapse?.error;
    const providerSummary=rejected?'The controller responds, but a physical check showed no lighting change. Automatic live edits are paused; Apply can retest, or save a supported setup in Synapse Studio.':selectedProvider==='synapse-native'&&physicalConfirmed?'Synapse Studio profile control is physically confirmed. Save or load a named profile to change the keyboard.':providerAvailable?'The controller is reachable; physical lighting still needs confirmation.':'Provider unavailable; preview and file saves still work.';
    setStatus('device-status',`${model}. ${providerError?`Provider reports: ${providerError}.`:providerSummary} ${capability}`.trim(),providerAvailable&&!providerError?'ready':'problem');
    $('connection-label').textContent=providerError?'Lighting needs attention':rejected?'Physical control failed':physicalConfirmed?'Lighting confirmed':providerAvailable?'Controller reachable � lights unconfirmed':'Preview � provider unavailable';$('connection-dot').dataset.state=providerError||rejected?'problem':physicalConfirmed?'ready':'';
    $('layout-prompt').textContent=deviceStatus.recognized?'Identify My Layout is available if this illustration needs correction.':'Keyboard model detection is unavailable. Choose Identify My Layout for a guided physical-layout check; broken keys can be skipped without treating them as missing.';
    if(deviceStatus.numpadDecimal){const info=deviceStatus.numpadDecimal;$('hardware-guidance').textContent=`${info.key}: ${info.state}. ${(info.checks||[]).join('; ')}. Workaround: ${info.workaround||'test another numpad key remapping.'}`;}
    if(rejected&&$('live').checked){$('live').checked=false;pendingSelection=null;clearTimeout(liveUpdateTimer);persist();}
    if(liveProviderAvailable&&!wasLiveAvailable)queueLiveUpdate(true);
  }catch(error){serverAvailable=false;providerAvailable=false;physicalConfirmed=false;$('connection-label').textContent='Preview only';$('connection-dot').dataset.state='problem';setStatus('device-status',`No local server connection. Run node server.cjs from the project folder. ${error.message}`,'problem');renderReadiness();}
  refreshExportCapabilities();
}

/** Capability checks carry a revision so a slow response for a previous model cannot enable the wrong export. */
async function refreshExportCapabilities() {
  const model=$('export-target').value,effect=$('background').value,key=`${model}:${effect}`;
  if(exportCapabilities&&key===lastCapabilityKey){renderExportCapability();return;}
  const revision=++capabilityRevision;
  try{const response=await fetch(`/api/export/capabilities?model=${encodeURIComponent(model)}&effect=${encodeURIComponent(effect)}`);if(!response.ok)throw Error('Export capability check unavailable.');const data=await response.json();if(revision!==capabilityRevision)return;exportCapabilities=data;lastCapabilityKey=key;renderExportCapability();}
  catch{if(revision!==capabilityRevision)return;exportCapabilities=null;$('export-executable').disabled=true;$('approximation-option').hidden=true;$('executable-status').textContent='Executable export needs the local server. You can always save the complete setup JSON.';}
}
function renderExportCapability() {
  const capability=exportCapabilities||{},allowed=Boolean(capability.executable??capability.supported);
  const needsApproximation=capability.needsApproximationAcknowledgement===true;
  $('approximation-option').hidden=!needsApproximation;
  const effectAllowed=!Array.isArray(capability.supportedEffects)||capability.supportedEffects.includes($('background').value);
  $('export-executable').disabled=!allowed||!effectAllowed||needsApproximation&&!$('accept-approximation').checked;
  $('executable-status').textContent=[capability.reason,...(capability.limitations||[]),!effectAllowed?'This effect has no supported executable equivalent. Choose Rainbow Road, Matrix, Lights Out, or Subtle Keywords.':'',needsApproximation&&!$('accept-approximation').checked?'Choose the built-in lighting option above to enable this export.':''].filter(Boolean).join(' ');
}
function downloadBlob(blob,name) { const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000); }
function downloadJSON(data,name) { downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),name); }
function saveSetup() { downloadJSON(configuration(),'lighting-lab-setup.json');setStatus('profile-status','Exported a JSON recipe. This does not apply lighting or import a vendor profile.'); }
async function downloadAPI(path,body,fallback) {
  const response=await fetch(path,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
  if(!response.ok){const error=await response.json().catch(()=>({}));throw Error(error.error||`Download failed (${response.status}).`);}
  const filename=response.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1]||fallback;downloadBlob(await response.blob(),filename);
}

/** Keep custom geometry separate from physical lighting IDs so editing a view cannot shift SDK coordinates. */
function readGeometryFields() {
  const selected=layout?.keys.find(key=>key.id===$('geometry-key').value);if(!selected)return;
  $('geometry-label').value=selected.label;for(const field of ['x','y','w','h'])$(`geometry-${field}`).value=selected[field];
  for(const [id,key]of keyElements)key.classList.toggle('geometry-selected',$('edit-geometry').checked&&id===selected.id);
}
function applyGeometry() {
  try{const id=$('geometry-key').value,keys=structuredClone(layout.keys),key=keys.find(item=>item.id===id);key.label=$('geometry-label').value.trim()||key.id;for(const field of ['x','y','w','h'])key[field]=Number($(`geometry-${field}`).value);const validated=K.layoutForModel('custom',keys);if($('keyboard-model').value!=='custom')customBaseModel=$('keyboard-model').value;customLayout=validated.keys;manualModel=true;$('keyboard-model').value='custom';changed();setStatus('geometry-status','Custom view updated. Physical lighting identities are unchanged.','ready');}
  catch(error){setStatus('geometry-status',error.message,'problem');}
}

for(const model of K.modelCatalog){const option=document.createElement('option');option.value=model.id;option.textContent=model.label;$('keyboard-model').append(option);}
if(!K.modelCatalog.some(model=>model.id==='custom')){const option=document.createElement('option');option.value='custom';option.textContent='Custom keyboard view';$('keyboard-model').append(option);}
$('keyboard-model').value='standard-full-size';
presets.forEach(preset=>{const button=document.createElement('button');button.className='preset-card';button.setAttribute('aria-pressed','false');const swatch=document.createElement('span');swatch.className=`preset-swatch swatch-${preset.swatch}`;swatch.setAttribute('aria-hidden','true');const title=document.createElement('b');title.textContent=preset.name;const detail=document.createElement('small');detail.textContent=preset.detail;button.append(swatch,title,detail);button.onclick=()=>choosePreset(preset);$('preset-gallery').append(button);});
$('onboarding-starter').onclick=()=>choosePreset(presets.find(preset=>preset.name==='Rainbow Ripple'));
$('onboarding-test').onclick=()=>{$('selection-mode').value='test';paintMode='test';renderSelection();markOnboarding('test');$('test-typing').focus();};
$('onboarding-apply').onclick=()=>{markOnboarding('apply');$('workspace').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});$('apply').focus();};
$('onboarding-dismiss').onclick=()=>{try{localStorage.setItem(ONBOARDING_KEY,JSON.stringify({...onboardingState(),dismissed:true}));}catch{/* Dismissing is optional convenience only. */}$('quickstart').hidden=true;};
K.alternatives.forEach((candidate,index)=>{const option=document.createElement('option');option.value=index;option.textContent=`${index===0?'Noob Deterrent':`Option ${index}`} � ${candidate.join(' / ')}`;$('candidate').append(option);});
$('words').value=K.alternatives[0].join(', ');
$('background').value='rainbow-road';
try{const shared=readShareLink();if(shared){restoreSetup(shared);setStatus('apply-status','Shared setup loaded into the preview. Review it, then choose Apply yourself if you want hardware changes.','ready');}else{const saved=localStorage.getItem(STORAGE_KEY);if(saved)restoreSetup(JSON.parse(saved));else{const legacyEffect=localStorage.getItem('lighting-lab-effect');if([...$('background').options].some(option=>option.value===legacyEffect)){$('background').value=legacyEffect;groupSettings.background.dynamic=legacyEffect==='ghost'||legacyEffect==='solid'||legacyEffect==='subtle-keywords'?'none':legacyEffect;groupSettings.background.base=legacyEffect==='solid'?'static':'off';}}}}catch(error){setStatus('apply-status',`Saved setup could not be restored: ${error.message}`,'problem');}

$('candidate').onchange=()=>{$('words').value=K.alternatives[Number($('candidate').value)].join(', ');arrange();};
$('words').oninput=()=>{renderDetails();persist();};$('reset').onclick=arrange;
for(const id of ['background','feedback','keyword-feedback','protect','numpad','provider','minimalist','sync-mouse','mode'])$(id).onchange=()=>{if(id==='background'){const effect=$('background').value;groupSettings.background.dynamic=effect==='ghost'||effect==='solid'||effect==='subtle-keywords'?'none':effect;groupSettings.background.base=effect==='solid'?'static':'off';}if(id==='feedback')groupSettings.background.reaction=$('feedback').value;if(id==='keyword-feedback')groupSettings.anchor.reaction=$('keyword-feedback').value;changed(id==='mode');if(id==='provider')refreshProviderStatus();};
$('selection-mode').onchange=()=>{paintMode=$('selection-mode').value;renderSelection();};
for(const id of ['speed','color'])$(id).oninput=()=>changed(false);
$('keyboard-model').onchange=()=>{manualModel=true;$('accept-approximation').checked=false;if($('keyboard-model').value==='custom'&&!customLayout){customLayout=structuredClone(layout.keys);customBaseModel=layout.id;}changed();};
$('selected-device').onchange=async()=>{try{const response=await fetch('/api/device',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:$('selected-device').value})}),body=await response.json();if(!response.ok)throw Error(body.error);deviceStatus=body.device||deviceStatus;setStatus('apply-status','Selected keyboard updated. Apply sends the current setup to the shared Chroma canvas.','ready');refreshProviderStatus();}catch(error){setStatus('apply-status',`Could not select keyboard: ${error.message}`,'problem');}};
$('select-all').onclick=()=>{if(paintMode==='test')return;for(const key of layout.keys){for(const name of E.GROUP_NAMES)groupKeys[name].delete(key.id);groupKeys[paintMode].add(key.id);}normalizeGroups();changed(false);};
$('clear-all').onclick=()=>{if(paintMode==='test')return;groupKeys[paintMode].clear();normalizeGroups();changed(false);};
$('pause-preview').onclick=()=>{previewPaused=!previewPaused;renderDetails();persist();};
$('live').onchange=()=>{persist();if($('live').checked)queueLiveUpdate(true);else{clearTimeout(liveUpdateTimer);pendingSelection=null;setStatus('apply-status','Live changes paused. Current hardware lighting continues; edits affect the preview.');}};
$('connect').onclick=async()=>{await refreshProviderStatus();if(liveProviderAvailable){$('live').checked=true;persist();queueLiveUpdate(true);}else setStatus('apply-status','Live control is not physically available through the selected provider. Apply can retest Chroma; Synapse uses Save as Profile and Load Profile.','problem');};
$('apply').onclick=()=>{
  markOnboarding('apply');
  if($('provider').value!=='chroma-sdk'){
    setStatus('apply-status','Synapse Studio applies saved profiles. Use Save as Profile, then Load Profile, for this provider.','problem');return;
  }
  pendingSelection={selection:configuration(),force:true};clearTimeout(liveUpdateTimer);drainLiveUpdates();
};
$('preview-apply').onclick=()=>$('apply').click();$('anchor-blue-flame').onclick=enableBlueAnchorFlame;
$('save-json').onclick=saveSetup;
$('share-link').onclick=async()=>{try{const link=createShareLink(configuration());const copied=await copyText(link);setStatus('profile-status',copied?'Share link copied. Opening it restores this preview only; the recipient chooses whether to Apply.':'Could not copy this link. Export Setup JSON instead.',copied?'ready':'problem');}catch(error){setStatus('profile-status',error.message,'problem');}};
$('readiness-action').onclick=()=>{if(physicalConfirmed){$('saved-profiles').focus();return;}$('apply').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});$('apply').focus();};
$('export-target').onchange=()=>{$('accept-approximation').checked=false;refreshExportCapabilities();};
$('import-setup').onchange=async event=>{try{restoreSetup(JSON.parse(await event.target.files[0].text()));changed();setStatus('apply-status','Setup loaded. All settings and key selections restored.','ready');}catch(error){setStatus('apply-status',error.message,'problem');}finally{event.target.value='';}};
$('accept-approximation').onchange=renderExportCapability;
$('export-executable').onclick=async()=>{const button=$('export-executable');button.disabled=true;try{await downloadAPI('/api/export/executable',{...configuration(),exportModel:$('export-target').value,acceptApproximation:$('accept-approximation').checked},'lighting-lab-preset.exe');setStatus('apply-status','Preset executable downloaded. Open it on the target Windows PC; it detects a supported keyboard and explains any missing controller.','ready');}catch(error){setStatus('apply-status',error.message,'problem');}finally{renderExportCapability();}};
$('diagnostics').onclick=async()=>{try{await downloadAPI('/api/diagnostics',null,'lighting-lab-diagnostics.json');setStatus('apply-status','Downloaded device, provider, input, and audit diagnostics.','ready');}catch(error){setStatus('apply-status',error.message,'problem');}};
$('global-input').onchange=async()=>{try{const response=await fetch('/api/input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:$('global-input').checked})}),data=await response.json();if(!response.ok)throw Error(data.error||'Global input unavailable.');$('global-input').checked=Boolean(data.enabled);setStatus('apply-status',data.enabled?'Global key feedback is on.':'Global key feedback is off.','ready');}catch(error){$('global-input').checked=false;setStatus('apply-status',error.message,'problem');}};
$('release').onclick=async()=>{$('live').checked=false;pendingSelection=null;clearTimeout(liveUpdateTimer);persist();try{while(applying)await new Promise(resolve=>setTimeout(resolve,50));const response=await fetch('/api/release',{method:'POST'});if(!response.ok)throw Error('Could not release direct control.');setStatus('apply-status','Direct lighting released. Synapse can resume its saved effect.','ready');}catch(error){setStatus('apply-status',error.message,'problem');}};
$('edit-geometry').onchange=readGeometryFields;$('geometry-key').onchange=readGeometryFields;$('geometry-apply').onclick=applyGeometry;
$('geometry-reset').onclick=()=>{$('keyboard-model').value=customBaseModel==='custom'?'standard-full-size':customBaseModel;customLayout=null;manualModel=true;changed();setStatus('geometry-status','Restored the model view.','ready');};
$('geometry-export').onclick=()=>downloadJSON({format:'lighting-lab-view-v1',baseModel:$('keyboard-model').value==='custom'?customBaseModel:$('keyboard-model').value,keys:layout.keys},'lighting-lab-view.json');
$('geometry-import').onchange=async event=>{try{const data=JSON.parse(await event.target.files[0].text()),validated=K.layoutForModel('custom',data.keys||data);customLayout=validated.keys;customBaseModel=data.baseModel||'standard-full-size';manualModel=true;$('keyboard-model').value='custom';changed();setStatus('geometry-status','Custom view loaded.','ready');}catch(error){setStatus('geometry-status',error.message,'problem');}finally{event.target.value='';}};
/** Feedback stays local until a tester explicitly downloads it or opens a GitHub issue draft. */
function feedbackRecord(){return{category:$('feedback-category').value,rating:Number($('feedback-rating').value),note:$('feedback-note').value,createdAt:new Date().toISOString(),device:deviceStatus.model,provider:$('provider').value,effect:configuration().effect,configuration:configuration()};}
function storedFeedback(){try{const value=JSON.parse(localStorage.getItem('lighting-lab-feedback-v1')||'[]');return Array.isArray(value)?value:[];}catch{return [];}}
function feedbackIssueUrl(record){const title=`Lighting Lab feedback: ${record.category}`;const body=[`Rating: ${record.rating}/5`,`Category: ${record.category}`,`Device: ${record.device}`,`Provider: ${record.provider}`,`Effect: ${record.effect}`,'','What happened:',record.note||'(no note supplied)','',`Created locally: ${record.createdAt}`].join('\n');return `https://github.com/jameseby21/Lighting-Lab/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;}
$('feedback-submit').onclick=()=>{try{const existing=storedFeedback();existing.push(feedbackRecord());localStorage.setItem('lighting-lab-feedback-v1',JSON.stringify(existing));$('feedback-development').hidden=true;setStatus('apply-status','Feedback saved only in this browser. Download it or open a GitHub draft when you want to share it.','ready');}catch(error){setStatus('apply-status',`Could not save feedback: ${error.message}`,'problem');}};
$('feedback-export').onclick=()=>downloadJSON(storedFeedback(),'lighting-lab-feedback.json');
$('feedback-github').onclick=()=>window.open(feedbackIssueUrl(feedbackRecord()),'_blank','noopener,noreferrer');
$('feedback-dismiss').onclick=()=>$('feedback-development').hidden=true;
function openFeedback(category='Visual quality'){$('feedback-category').value=category;$('feedback-development').hidden=false;$('feedback-category').focus();}
$('feedback-open').onclick=()=>openFeedback();
$('success-save').onclick=()=>{$('success-next').hidden=true;$('profile-name').focus();$('profile-name').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});};
$('success-feedback').onclick=()=>{$('success-next').hidden=true;openFeedback('Visual quality');};
$('success-dismiss').onclick=()=>{$('success-next').hidden=true;};
// File-picker labels retain a compact appearance without excluding keyboard users.
document.querySelectorAll('label.button[for]').forEach(label=>{label.tabIndex=0;label.setAttribute('role','button');label.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$(label.htmlFor).click();}};});
let lastWindowWidth=innerWidth;addEventListener('resize',()=>{if(Math.abs(lastWindowWidth-innerWidth)>30){lastWindowWidth=innerWidth;renderBoard();}});

/** Layout probing is user-started and untimed. A failed key can be recorded without inferring absence. */
function renderGuide(){
  if(guideState.finished){const result=LayoutGuide.result(guideState);$('keyboard-model').value=result.model;manualModel=true;for(const id of result.brokenKeys)brokenKeys.add(id);changed();$('guide-title').textContent='Review Your Layout';$('guide-progress').textContent='Layout guide complete';$('guide-instruction').textContent=`Showing ${K.modelCatalog.find(m=>m.id===result.model).label}. ${result.note}`;$('guide-choices').replaceChildren();for(const id of ['guide-yes','guide-no','guide-unknown','guide-broken'])$(id).hidden=true;return;}
  const step=LayoutGuide.step(guideState);$('guide-progress').textContent=`Step ${guideState.index+1} of ${LayoutGuide.steps.length}`;$('guide-title').textContent=step.title;$('guide-instruction').textContent=step.instruction;$('guide-note').textContent='No timeout. Skip an unavailable test, or confirm the physical feature by sight.';
  $('guide-choices').replaceChildren();for(const[value,label]of step.choices||[]){const button=document.createElement('button');button.textContent=label;button.onclick=()=>{guideState=LayoutGuide.answer(guideState,value);renderGuide();};$('guide-choices').append(button);}
  $('guide-yes').hidden=$('guide-no').hidden=$('guide-broken').hidden=Boolean(step.choices);$('guide-unknown').hidden=false;$('guide-yes').textContent=step.yes||'Yes';$('guide-no').textContent=step.no||'No';
}
$('identify-layout').onclick=()=>{guideState=LayoutGuide.begin();renderGuide();$('layout-guide').showModal();};
$('guide-close').onclick=()=>$('layout-guide').close();
$('guide-yes').onclick=()=>{guideState=LayoutGuide.answer(guideState,true);renderGuide();};
$('guide-no').onclick=()=>{guideState=LayoutGuide.answer(guideState,false);renderGuide();};
$('guide-unknown').onclick=()=>{guideState=LayoutGuide.answer(guideState,'unknown');renderGuide();};
$('guide-broken').onclick=()=>{const id=LayoutGuide.step(guideState).example;guideState=LayoutGuide.broken(guideState,id);brokenKeys.add(id);persist();$('guide-note').textContent=`Recorded ${id} as unresponsive. Try an alternate key from the instructions, choose the visible feature, or skip. The layout has not been shrunk.`;};
$('mark-broken').onclick=()=>{brokenKeys.add($('issue-key').value);changed(false);};
$('clear-broken').onclick=()=>{brokenKeys.delete($('issue-key').value);changed(false);};
$('issue-use').onclick=()=>{const target=$('issue-key').value,source=$('issue-alternate').value;if(source)inputAliases[source]=target;else for(const key of Object.keys(inputAliases))if(inputAliases[key]===target)delete inputAliases[key];changed(false);};
async function recordControlObservation(visible){
  const response=await fetch('/api/control-verification',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:lastAttemptProvider,visible})}),body=await response.json();
  if(!response.ok)throw Error(body.error||'Physical result could not be recorded.');return body.result;
}
$('confirm-visible').onclick=async()=>{try{await recordControlObservation(true);physicalConfirmed=true;$('physical-check').hidden=true;$('success-next').hidden=false;setStatus('apply-status','Physical lighting change confirmed for this keyboard and provider.','ready');await refreshProviderStatus();}catch(error){setStatus('apply-status',error.message,'problem');}};
$('confirm-unchanged').onclick=async()=>{try{await recordControlObservation(false);physicalConfirmed=false;$('success-next').hidden=true;$('live').checked=false;pendingSelection=null;clearTimeout(liveUpdateTimer);persist();$('physical-check').hidden=true;setStatus('apply-status','Recorded: the controller acknowledged the request, but the physical lights did not change. Live edits are paused for this provider.','problem');await refreshProviderStatus();}catch(error){setStatus('apply-status',error.message,'problem');}};
$('repair-connection').onclick=async()=>{try{setStatus('apply-status','Opening Synapse and restarting this lighting session�');const response=await fetch('/api/repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(configuration())}),body=await response.json();if(!response.ok)throw Error(body.error);physicalConfirmed=false;setStatus('apply-status',body.detail,'problem');}catch(error){setStatus('apply-status',`Repair did not establish physical control: ${error.message}`,'problem');}};
async function refreshProfiles(){try{const response=await fetch(`/api/profiles?effect=${encodeURIComponent($('background').value)}&feedback=${encodeURIComponent($('feedback').value)}`),body=await response.json();if(!response.ok)return;const previous=$('saved-profiles').value;$('saved-profiles').replaceChildren(new Option('Choose a profile',''));for(const item of body.profiles||[])$('saved-profiles').append(new Option(`${item.name} � ${item.software}`,item.id));$('saved-profiles').value=previous;for(const controller of body.controllers||[]){const option=[...$('profile-software').options].find(o=>o.value===controller.id);if(option){option.disabled=!controller.available;option.title=controller.reason;}}}catch{/* Offline previews can still export JSON. */}}
function profileResult(body){
  const loaded=body.loaded;
  setStatus('profile-status',body.activationError?`Profile saved, but not activated: ${body.activationError}`:loaded?.detail||`Saved and loaded �${body.profile.name}� in Lighting Lab. No download was created.`,body.activationError||loaded?.imported===false?'problem':'');
  if(loaded?.archiveDownloadUrl){const link=document.createElement('a');link.href=loaded.archiveDownloadUrl;link.textContent=' Download Native Chroma Profile';link.download='';$('profile-status').append(link);}
}
$('save-profile').onclick=async()=>{const button=$('save-profile');button.disabled=true;try{if($('profile-software').value==='synapse-native'){$('live').checked=false;pendingSelection=null;clearTimeout(liveUpdateTimer);}const response=await fetch('/api/profiles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:$('profile-name').value,software:$('profile-software').value,settings:configuration()})}),body=await response.json();if(!response.ok)throw Error(body.error);profileResult(body);await refreshProfiles();}catch(error){setStatus('profile-status',error.message,'problem');}finally{button.disabled=false;}};
$('load-profile').onclick=async()=>{try{
  if(!$('saved-profiles').value)throw Error('Choose a saved profile first.');
  // Stop pending browser writes so they cannot immediately override the selected native controller.
  $('live').checked=false;pendingSelection=null;clearTimeout(liveUpdateTimer);
  while(applying)await new Promise(resolve=>setTimeout(resolve,20));
  const response=await fetch('/api/profiles/'+encodeURIComponent($('saved-profiles').value)+'/load',{method:'POST'}),body=await response.json();if(!response.ok)throw Error(body.error);
  restoreSetup(body.profile.settings);$('live').checked=body.profile.software==='lighting-lab';$('profile-software').value=body.profile.software;
  renderBoard();renderDetails();persist();paintPreview(performance.now());refreshExportCapabilities();
  $('profile-name').value=body.profile.name;profileResult(body);
}catch(error){setStatus('profile-status',error.message,'problem');}};
for(const label of document.querySelectorAll('label[role="button"]'))label.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();label.click();}};
refreshProfiles();
renderBoard();renderDetails();requestAnimationFrame(animatePreview);refreshProviderStatus();statusTimer=setInterval(refreshProviderStatus,8000);

// App profiles keep their own rule metadata; they always point back to a named saved lighting profile.
let appProfilesState={config:{automatic:true,waitMs:1000,transitionMs:400,rules:[]},runtime:{apps:[],detail:'Checking local app rules.'},profiles:[]};
function appProfileName(id){return appProfilesState.profiles.find(profile=>profile.id===id)?.name||'Missing saved profile';}
function setAppProfileStatus(message,state=''){setStatus('app-profile-status',message,state);}
function renderAppProfiles(){
  const {config,runtime,profiles}=appProfilesState;$('app-profiles-auto').checked=config.automatic!==false;$('app-switch-wait').value=Number(config.waitMs||0)/1000;$('app-switch-transition').value=Number(config.transitionMs||0)/1000;$('app-switch-wait-value').textContent=`${(Number(config.waitMs||0)/1000).toFixed(1)} s`;$('app-switch-transition-value').textContent=`${(Number(config.transitionMs||0)/1000).toFixed(1)} s`;
  $('app-profile-active-title').textContent=runtime.activeId?`A matching app profile is active`:'No app profile is active';$('app-profile-active-detail').textContent=runtime.detail||'No local app state is available yet.';
  const profileSelect=$('app-rule-profile'),previous=profileSelect.value;profileSelect.replaceChildren(new Option(profiles.length?'Choose a saved profile':'Save a Lighting profile first',''));for(const profile of profiles)profileSelect.append(new Option(`${profile.name} � ${profile.software}`,profile.id));profileSelect.value=profiles.some(profile=>profile.id===previous)?previous:'';
  const list=$('app-profile-rule-list');list.replaceChildren();for(const [index,rule] of (config.rules||[]).entries()){
    const card=document.createElement('article');card.className='app-rule';if(runtime.activeId===rule.id)card.dataset.active='true';
    const order=document.createElement('b');order.className='app-rule-order';order.textContent=String(index+1);
    const main=document.createElement('div');const title=document.createElement('strong');title.textContent=rule.name;const description=document.createElement('small');description.textContent=`${rule.executable} � ${rule.condition==='foreground'?'In front':'Running'} ? ${appProfileName(rule.profileId)}`;main.append(title,description);
    const actions=document.createElement('div');actions.className='app-rule-actions';const action=(label,handler,disabled=false)=>{const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent=label;button.disabled=disabled;button.onclick=handler;actions.append(button);};
    action('Test',()=>appProfileAction(`/api/app-profiles/${encodeURIComponent(rule.id)}/test`,{},`Applied �${appProfileName(rule.profileId)}� for this rule.`));action('Up',()=>appProfileAction(`/api/app-profiles/${encodeURIComponent(rule.id)}/move`,{direction:'up'}),index===0);action('Down',()=>appProfileAction(`/api/app-profiles/${encodeURIComponent(rule.id)}/move`,{direction:'down'}),index===config.rules.length-1);action(rule.enabled===false?'Enable':'Disable',()=>appProfileAction(`/api/app-profiles/${encodeURIComponent(rule.id)}/toggle`,{enabled:rule.enabled===false}));action('Delete',()=>appProfileAction(`/api/app-profiles/${encodeURIComponent(rule.id)}/delete`,{}));
    card.append(order,main,actions);list.append(card);
  }
  if(!list.children.length){const empty=document.createElement('p');empty.className='help';empty.textContent='No rules yet. Save a lighting profile, then connect it to an app here.';list.append(empty);}
  const detected=$('app-profile-detected');detected.replaceChildren();for(const app of runtime.apps||[]){const row=document.createElement('div');row.className='app-detected';const name=document.createElement('b');name.textContent=app.executable;const state=document.createElement('span');state.textContent=app.foreground?'In front':app.running?'Running':'Not running';state.dataset.state=app.foreground?'foreground':app.running?'running':'off';row.append(name,state);detected.append(row);}if(!detected.children.length){const empty=document.createElement('p');empty.className='help';empty.textContent=runtime.available===false?'This local server is not running on Windows.':'Add an enabled rule to see its app state here.';detected.append(empty);}
}
async function appProfileAction(route,body,success){try{const response=await fetch(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),data=await response.json();if(!response.ok)throw Error(data.error||'App Profile update failed.');if(data.config)appProfilesState={...appProfilesState,...data};if(success)setAppProfileStatus(success,'ready');await refreshAppProfiles();}catch(error){setAppProfileStatus(error.message,'problem');}}
async function refreshAppProfiles({switchNow=false}={}){try{const response=await fetch(switchNow?'/api/app-profiles/refresh':'/api/app-profiles',{method:switchNow?'POST':'GET',...(switchNow?{headers:{'content-type':'application/json'},body:'{}'}:{})}),data=await response.json();if(!response.ok)throw Error(data.error||'App Profiles is unavailable.');appProfilesState={...appProfilesState,...data};renderAppProfiles();}catch(error){setAppProfileStatus(`Could not read App Profiles: ${error.message}`,'problem');}}
function showAppProfiles(active){const view=$('app-profiles-view'),main=document.querySelector('main');view.hidden=!active;for(const child of main.children){if(child===view)continue;if(active&&!child.hidden){child.dataset.hiddenForAppProfiles='true';child.hidden=true;}else if(!active&&child.dataset.hiddenForAppProfiles==='true'){child.hidden=false;delete child.dataset.hiddenForAppProfiles;}}$('show-lighting').setAttribute('aria-pressed',String(!active));$('show-app-profiles').setAttribute('aria-pressed',String(active));if(active){refreshAppProfiles();view.scrollIntoView({behavior:'smooth',block:'start'});}}
$('show-lighting').onclick=()=>showAppProfiles(false);$('show-app-profiles').onclick=()=>showAppProfiles(true);
$('app-profiles-auto').onchange=()=>appProfileAction('/api/app-profiles/config',{automatic:$('app-profiles-auto').checked,waitMs:Math.round(Number($('app-switch-wait').value)*1000),transitionMs:Math.round(Number($('app-switch-transition').value)*1000)});
for(const [input,output] of [['app-switch-wait','app-switch-wait-value'],['app-switch-transition','app-switch-transition-value']]){$(input).oninput=()=>{$(output).textContent=`${Number($(input).value).toFixed(1)} s`;};$(input).onchange=()=>appProfileAction('/api/app-profiles/config',{automatic:$('app-profiles-auto').checked,waitMs:Math.round(Number($('app-switch-wait').value)*1000),transitionMs:Math.round(Number($('app-switch-transition').value)*1000)});}
$('app-profiles-refresh').onclick=()=>appProfileAction('/api/app-profiles/refresh',{},'Checked the configured app rules now.');
$('app-profile-add').onsubmit=event=>{event.preventDefault();const profileId=$('app-rule-profile').value;if(!profileId){setAppProfileStatus('Save a lighting profile first, then choose it for this app rule.','problem');return;}appProfileAction('/api/app-profiles',{name:$('app-rule-name').value,executable:$('app-rule-executable').value,condition:$('app-rule-condition').value,profileId},'App rule saved.').then(()=>{$('app-rule-name').value='';$('app-rule-executable').value='';});};
refreshAppProfiles();
