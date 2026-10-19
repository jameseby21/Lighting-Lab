/* A brand-independent, untimed layout interview. Missing input never proves a key is absent. */
(function(root){
  'use strict';
  const steps=[
    {id:'numpad',title:'Number pad',instruction:'Press Enter on the number pad. If it is broken, try + or any number-pad digit.',accept:id=>id.startsWith('NUM_'),yes:'I have a number pad',no:'No number pad',example:'NUM_ENTER'},
    {id:'functionRow',title:'Function row',instruction:'Press F8, or another F1–F12 key on a dedicated top row.',accept:id=>/^F([1-9]|1[0-2])$/.test(id),yes:'Dedicated function row',no:'No dedicated function row',example:'F8'},
    {id:'arrows',title:'Arrow keys',instruction:'Press a dedicated arrow key. Do not use an Fn combination.',accept:id=>['UP','DOWN','LEFT','RIGHT'].includes(id),yes:'Dedicated arrow keys',no:'No dedicated arrow keys',example:'RIGHT'},
    {id:'navigation',title:'Navigation keys',instruction:'Choose the physical arrangement around Home, Delete, Page Up and Page Down.',choices:[['block','Separate navigation block'],['column','Compact column or shared cluster'],['none','No dedicated navigation keys']]},
    {id:'enterShape',title:'Enter key shape',instruction:'A keypress cannot identify this shape. Choose what your main Enter key looks like.',choices:[['ansi','Wide horizontal Enter'],['iso','Tall, stepped Enter']]}
  ];
  function begin(){return{index:0,answers:{},brokenKeys:[],observed:[],finished:false};}
  function step(state){return steps[state.index]||null;}
  function answer(state,value){const current=step(state);if(!current)return state;return{...state,answers:{...state.answers,[current.id]:value},index:state.index+1,finished:state.index+1>=steps.length};}
  function press(state,id){const current=step(state);if(!current?.accept?.(id))return{state,accepted:false};return{state:answer({...state,observed:[...state.observed,id]},true),accepted:true};}
  function broken(state,id){return{...state,brokenKeys:[...new Set([...state.brokenKeys,id])].filter(Boolean)};}
  function result(state){
    const a=state.answers;
    const model=a.numpad!==false?(a.enterShape==='iso'?'standard-iso':'standard-full-size'):a.functionRow!==false?(a.navigation==='column'?'standard-75':'standard-tkl'):a.arrows!==false?'standard-65':'standard-60';
    return{model,brokenKeys:[...state.brokenKeys],source:'guided-layout',brandDetected:false,
      provisional:Object.values(a).some(value=>value==='unknown')||(a.enterShape==='iso'&&a.numpad!==true),
      note:'This identifies a reference layout, not a brand, exact geometry, RGB capability, or an operating-system key remap. Review the illustration and adjust Customize View if needed.'};
  }
  root.LayoutGuide={steps,begin,step,answer,press,broken,result};
  if(typeof module!=='undefined')module.exports=root.LayoutGuide;
})(typeof globalThis!=='undefined'?globalThis:window);
