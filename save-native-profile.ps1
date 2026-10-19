# Derive native layers from the owner's vendor exports; create a separate profile and import it.
param([Parameter(Mandatory=$true)][string]$RequestFile,[switch]$BuildOnly)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$plan=Get-Content -Raw -Encoding UTF8 -LiteralPath $RequestFile | ConvertFrom-Json
function Read-Archive([string]$file){
 $zip=[IO.Compression.ZipFile]::OpenRead($file)
 try{$entry=$zip.Entries|Sort-Object Length -Descending|Select-Object -First 1;$reader=New-Object IO.StreamReader($entry.Open());try{[xml]$reader.ReadToEnd()}finally{$reader.Dispose()}}finally{$zip.Dispose()}
}
$doc=Read-Archive $plan.source
$sample=Read-Archive $plan.reactive
$static=$doc.LightingEffects.EffectLayers.EffectLayer | Where-Object Effect -eq 'static' | Select-Object -First 1
$reactive=$sample.LightingEffects.EffectLayers.EffectLayer | Where-Object Effect -eq 'reactive' | Select-Object -First 1
$keyboard=$static.Regions.EffectRegion.Cells.Item | Where-Object {$_.Key.Device.Name -eq 'RAZER BLACKWIDOW ELITE'}
if(-not $keyboard){throw 'The source archive has no BlackWidow Elite region.'}
$native=@($keyboard.Value.ArrayOfDeviceCell.DeviceCell | Where-Object {[long]$_.LedId -lt 10000})
$mapping=@{}
# Native Studio has its own coordinates. Match ordered physical switches only after row counts agree.
for($row=0;$row -lt 6;$row++){
 $physical=@($plan.keys | Where-Object row -eq $row | Sort-Object x)
 $cells=@($native | Where-Object {[int]$_.Row -eq $row} | Sort-Object {[int]$_.Col})
 if($physical.Count -ne $cells.Count){throw "Native row $row does not match the reference keyboard; no profile was generated."}
 for($i=0;$i -lt $physical.Count;$i++){$mapping[$physical[$i].id]=$cells[$i]}
}
$layers=$doc.LightingEffects.EffectLayers
# Existing mouse effects are preserved; the new profile receives independently generated keyboard layers.
foreach($layer in @($layers.EffectLayer)){foreach($region in @($layer.Regions.EffectRegion)){foreach($item in @($region.Cells.Item)){if($item.Key.Device.Name -eq 'RAZER BLACKWIDOW ELITE'){$null=$region.Cells.RemoveChild($item)}}}}
function Add-Layer($template,[string]$name,$cells,[string]$colors){
 $layer=$doc.ImportNode($template,$true);$layer.Name=$name;$region=$layer.Regions.EffectRegion
 $container=$region.SelectSingleNode('Cells');$container.RemoveAll();$item=$doc.ImportNode($keyboard,$true);$array=$item.Value.ArrayOfDeviceCell;$array.RemoveAll()
 foreach($cell in $cells){$null=$array.AppendChild($doc.ImportNode($cell,$true))};$null=$container.AppendChild($item);$region.Colors.InnerXml=$colors;$null=$layers.AppendChild($layer)
}
$groups=@{}
foreach($key in $plan.keys){$rgb=$plan.colors.($key.id);$color="$($rgb.red),$($rgb.green),$($rgb.blue)";if(-not $groups.ContainsKey($color)){$groups[$color]=@()};$groups[$color]+=$mapping[$key.id]}
foreach($color in $groups.Keys){$rgb=$color.Split(',');Add-Layer $static "Lighting Lab - $color" $groups[$color] "<RzColor><Red>$($rgb[0])</Red><Green>$($rgb[1])</Green><Blue>$($rgb[2])</Blue></RzColor>"}
$filler=@($plan.keys | Where-Object {
 $mode=if($_.id -in $plan.settings.anchors){$plan.settings.keywordFeedback}else{$plan.settings.feedback}
 $mode -eq 'reactive' -and $_.id -notin $plan.settings.protectedAnchors -and (-not $plan.settings.protectAnchors -or $_.id -notin $plan.settings.anchors)
} | ForEach-Object {$mapping[$_.id]})
if($filler.Count){
 if($filler.Count){Add-Layer $reactive 'Lighting Lab - white feedback' $filler '<RzColor><Red>255</Red><Green>255</Green><Blue>255</Blue></RzColor><RzColor><IsBlank>true</IsBlank><Alpha>0</Alpha></RzColor>'}
}
$guid=[guid]::NewGuid().ToString();$doc.LightingEffects.Guid=$guid;$doc.LightingEffects.Name=$plan.name
$zip=[IO.Compression.ZipFile]::Open($plan.output,[IO.Compression.ZipArchiveMode]::Create)
try{$entry=$zip.CreateEntry("$guid.xml");$writer=New-Object IO.StreamWriter($entry.Open());try{$doc.Save($writer)}finally{$writer.Dispose()}}finally{$zip.Dispose()}
# The archive is useful even if a vendor chooser requires one manual import step.
$result=@{saved=$true;imported=$false;archive=$plan.output;software='Razer Synapse Studio';detail='Native profile created. In Studio choose Actions > Import, then select this archive. No existing effect was overwritten.'}
if(-not $BuildOnly){try{
 $import=& (Join-Path $PSScriptRoot 'synapse-control.ps1') -Action Import -Archive $plan.output -ProfileName $plan.name
 if($import){$state=$import | Select-Object -Last 1 | ConvertFrom-Json;$result.imported=[bool]$state.imported;$result.detail=$state.detail}
}catch{$result.detail+=' Automatic import was unavailable: '+$_.Exception.Message}}
$result|ConvertTo-Json -Compress
