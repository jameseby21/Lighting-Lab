/* Read-only identity detection keeps present-device evidence distinct from RGB-provider availability. */
'use strict';
const{execFile}=require('node:child_process');
const{promisify}=require('node:util');
const Plan=require('./core.js');
const numpadDecimal={state:'needs-user-test',key:'NUM_DECIMAL',checks:['toggle Num Lock and test again','test the key in Windows keyboard input','inspect vendor remapping','compare another USB/HID port'],workaround:'Remap a spare numpad key to decimal; a failed switch or PCB needs physical inspection.'};
const fallback={model:'Standard full-size keyboard with numpad',modelId:'standard-full-size',source:'fallback',recognized:false,geometry:'full-size-with-numpad'};

/** Match precise model descriptions and USB identifiers; a generic vendor name is not a model match. */
function identify(names){
  const text=names.join(' ');
  // Variant suffixes can change key count or RGB zoning; prefix similarity must not claim support.
  const patterns=[['yunzii-al65',/\bAL65\b|VID_4D4B&PID_3068/i],['razer-ornata-v3',/ornata\s*v3\b(?!\s*(?:x\b|tkl\b|tenkeyless\b))/i],['razer-ornata-v2',/ornata\s*v2\b/i],['razer-ornata',/ornata\s+chroma\b/i],['razer-cynosa-chroma',/cynosa\s+chroma\b/i],['razer-blackwidow-elite',/blackwidow\s+elite\b/i],['razer-blackwidow-v4',/blackwidow\s+v4\b(?!\s*(?:75|mini\b|tkl\b))/i],['logitech-g915',/\bg915\b(?!\s*(?:tkl\b|x\b))/i],['corsair-k95',/\bk95\b/i],['steelseries-apex-pro',/apex\s+pro\b(?!\s*(?:tkl\b|mini\b))/i]];
  const match=patterns.find(([,pattern])=>pattern.test(text));return match?Plan.modelCatalog.find(m=>m.id===match[0]):undefined;
}
/** Keep every present keyboard distinct so a shared PC can choose its editor identity deliberately. */
function toDevice(item,index,baseline){
  const names=(item?.names||[]).map(String),model=identify(names),id=String(item?.id||`keyboard-${index}`).slice(0,260);
  return{...baseline,id,model:model?.label||String(item?.name||names[0]||`Keyboard ${index+1}`),modelId:model?.id||'standard-full-size',recognized:Boolean(model),
    geometry:model?.geometry||'full-size-with-numpad',accuracy:model?.accuracy||'reference',lighting:model?.lighting,
    source:model?'Windows present-keyboard ancestry':'Windows present-keyboard enumeration',deviceState:'present',
    guidance:model?.note||(model?'RGB support still needs a visual test.':'Exact model variant was not identified. Choose a preview model.')};
}

/** Walk only present keyboard parents; registry fallback must never mistake a disconnected historical device for presence. */
async function detectDevice({execFileImpl=promisify(execFile),sdkAvailable=false,synapseAvailable=false,platform=process.platform}={}){
  const reachable=sdkAvailable||synapseAvailable;
  const baseline={...fallback,rgbCapability:reachable?'provider-reachable':'unknown',deviceState:'unknown',numpadDecimal};
  if(platform!=='win32')return{...baseline,source:'unsupported-platform',guidance:'Automatic keyboard identity detection is currently available on Windows. Choose your preview model manually.'};
  // Some PnP properties exist as error/empty records without Data. Tolerant property access keeps other identity evidence usable.
  const script=`$ErrorActionPreference='Stop'; $devices=@(Get-PnpDevice -PresentOnly -Class Keyboard); $out=@(); foreach($device in $devices){ $names=@($device.FriendlyName); $instanceId=$device.InstanceId; $id=$instanceId; for($depth=0;$depth -lt 4 -and $id;$depth++){ $names+=$id; $path='HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\'+$id; $entry=Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue; if($entry){$names+=@($entry.FriendlyName,$entry.DeviceDesc)}; $properties=@(Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc','DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue); $names+=@($properties | Where-Object KeyName -eq 'DEVPKEY_Device_BusReportedDeviceDesc' | ForEach-Object {$_.Data}); $parent=($properties | Where-Object KeyName -eq 'DEVPKEY_Device_Parent' | Select-Object -First 1); $id=$parent.Data }; $out+=@{id=$instanceId;name=$device.FriendlyName;names=@($names | Where-Object {$_})} }; ConvertTo-Json -InputObject @($out) -Depth 4 -Compress`;
  try{
    const{stdout}=await execFileImpl('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',script],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});
    const value=JSON.parse(stdout||'[]'),items=Array.isArray(value)?value:[value];
    const devices=items.map((item,index)=>toDevice(typeof item==='string'?{name:item,names:[item]}:item,index,baseline));
    const selected=devices.find(device=>device.recognized)||devices[0];
    if(selected)return{...selected,devices,selectedDeviceId:selected.id,
      guidance:devices.length>1?`${devices.length} keyboards are present. Choose the one you are editing; SDK routing capability is shown separately.`:selected.guidance};
    return{...baseline,devices:[],selectedDeviceId:null,source:'Windows present-keyboard enumeration',deviceState:'not-detected',guidance:'Windows returned no present keyboards. Check the USB connection; exact RGB capability remains unknown.'};
  }catch(error){
    return{...baseline,source:'detection-unavailable',detectionError:error.killed?'Windows keyboard enumeration exceeded its 20-second limit.':String(error.stderr||error.message).split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0,300),guidance:'Automatic model detection was unavailable. Use Identify My Layout for a guided physical-layout check, including broken keys.'};
  }
}
module.exports={detectDevice,fallback,identify};
