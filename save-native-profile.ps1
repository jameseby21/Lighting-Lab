# =====================================================================================================
# save-native-profile.ps1 - build a Razer Synapse Studio profile (.ChromaEffects) from a Lighting Lab setup.
#
# Who runs it
#   synapse-profile.cjs saveNativeProfile(), when the user chooses "Save in: Razer Synapse Studio":
#       powershell.exe -NoProfile -ExecutionPolicy Bypass -File save-native-profile.ps1 -RequestFile <json> [-BuildOnly]
#   The request JSON (written by Node into the Lighting Lab state folder) contains:
#     name      profile name to show in Studio
#     source    a REAL Studio export used as the XML template (synapse-both.ChromaEffects; static layers)
#     reactive  a REAL Studio export that contains a "reactive" layer to copy (reactive-painted.ChromaEffects)
#     output    where to write the new archive (<profile id>.ChromaEffects)
#     keys      the keyboard's physical switches with a Studio row and an x position
#     colors    the color each switch shows at time 0 (sampled from effects.js)
#     settings  the validated Lighting Lab settings (anchors, feedback modes, ...)
#   The template archives are private local files (LIGHTING_LAB_NATIVE_DIRECTORY or docs/native); they are
#   NOT in the repository, so on a fresh clone this path reports "No local native Synapse export template".
#
# Output contract
#   The LAST line of stdout is compressed JSON:
#     {saved, imported, archive, software, detail}
#   saved=true means the archive was written. imported=true only if synapse-control.ps1 read back that
#   Studio selected the new profile. Callers must never treat "saved" as "visible on the keyboard".
#
# Safety rules
#   * Never edits Synapse's private database or any existing profile: it writes a NEW archive with a NEW GUID
#     and imports it through Studio's own visible Import dialog (or leaves it for a manual import).
#   * Fails BEFORE writing anything if the template's LED rows do not match the expected keyboard layout,
#     so keys can never be painted onto the wrong LEDs.
#   * Currently verified only for the Razer BlackWidow Elite template (synapse-profile.cjs enforces this).
#   * -BuildOnly skips the UI import step entirely (used for re-loading and for tests).
# =====================================================================================================
param([Parameter(Mandatory=$true)][string]$RequestFile,[switch]$BuildOnly)
$ErrorActionPreference='Stop'
# ZipFile lives in System.IO.Compression.FileSystem; a .ChromaEffects file is a zip with one XML document.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$plan=Get-Content -Raw -Encoding UTF8 -LiteralPath $RequestFile | ConvertFrom-Json
# Read-Archive: open a .ChromaEffects zip and parse its largest entry (the effect XML) into an [xml] document.
function Read-Archive([string]$file){
 $zip=[IO.Compression.ZipFile]::OpenRead($file)
 try{$entry=$zip.Entries|Sort-Object Length -Descending|Select-Object -First 1;$reader=New-Object IO.StreamReader($entry.Open());try{[xml]$reader.ReadToEnd()}finally{$reader.Dispose()}}finally{$zip.Dispose()}
}
# --- 1. Load the two templates and find the pieces we copy -------------------------------------------
# $doc becomes the NEW profile (it is modified in memory and saved under a new name/GUID at the end).
$doc=Read-Archive $plan.source
$sample=Read-Archive $plan.reactive
# One static layer and one reactive layer serve as XML templates for every layer we generate.
$static=$doc.LightingEffects.EffectLayers.EffectLayer | Where-Object Effect -eq 'static' | Select-Object -First 1
$reactive=$sample.LightingEffects.EffectLayers.EffectLayer | Where-Object Effect -eq 'reactive' | Select-Object -First 1
# The keyboard's cell list inside the static layer: this is the device + LED inventory for the BlackWidow Elite.
$keyboard=$static.Regions.EffectRegion.Cells.Item | Where-Object {$_.Key.Device.Name -eq 'RAZER BLACKWIDOW ELITE'}
if(-not $keyboard){throw 'The source archive has no BlackWidow Elite region.'}
# LED ids of 10000+ are non-key LEDs (logo/underglow style); only real switches are mapped.
$native=@($keyboard.Value.ArrayOfDeviceCell.DeviceCell | Where-Object {[long]$_.LedId -lt 10000})
# --- 2. Map Lighting Lab switch IDs to Studio cells, row by row ----------------------------------------
# $mapping: Lighting Lab switch id -> the Studio DeviceCell XML node for that LED.
$mapping=@{}
# Native Studio has its own coordinates. Match ordered physical switches only after row counts agree.
# Within each of the 6 rows, physical keys sorted left-to-right (x) pair with Studio cells sorted by column.
for($row=0;$row -lt 6;$row++){
 $physical=@($plan.keys | Where-Object row -eq $row | Sort-Object x)
 $cells=@($native | Where-Object {[int]$_.Row -eq $row} | Sort-Object {[int]$_.Col})
 # A count mismatch means the template is a different keyboard/layout: stop before generating anything.
 if($physical.Count -ne $cells.Count){throw "Native row $row does not match the reference keyboard; no profile was generated."}
 for($i=0;$i -lt $physical.Count;$i++){$mapping[$physical[$i].id]=$cells[$i]}
}
# --- 3. Clear the template's keyboard cells (keep everything else, e.g. mouse layers) -----------------
$layers=$doc.LightingEffects.EffectLayers
# Existing mouse effects are preserved; the new profile receives independently generated keyboard layers.
foreach($layer in @($layers.EffectLayer)){foreach($region in @($layer.Regions.EffectRegion)){foreach($item in @($region.Cells.Item)){if($item.Key.Device.Name -eq 'RAZER BLACKWIDOW ELITE'){$null=$region.Cells.RemoveChild($item)}}}}
# Add-Layer: clone a template layer, rename it, give it exactly $cells (keyboard LEDs) and the $colors XML,
# and append it to the new profile.
function Add-Layer($template,[string]$name,$cells,[string]$colors){
 $layer=$doc.ImportNode($template,$true);$layer.Name=$name;$region=$layer.Regions.EffectRegion
 $container=$region.SelectSingleNode('Cells');$container.RemoveAll();$item=$doc.ImportNode($keyboard,$true);$array=$item.Value.ArrayOfDeviceCell;$array.RemoveAll()
 foreach($cell in $cells){$null=$array.AppendChild($doc.ImportNode($cell,$true))};$null=$container.AppendChild($item);$region.Colors.InnerXml=$colors;$null=$layers.AppendChild($layer)
}
# --- 4. One static layer per distinct color ------------------------------------------------------------
# Group switches by their "r,g,b" color so a mostly-one-color setup becomes a few layers, not 104.
$groups=@{}
foreach($key in $plan.keys){$rgb=$plan.colors.($key.id);$color="$($rgb.red),$($rgb.green),$($rgb.blue)";if(-not $groups.ContainsKey($color)){$groups[$color]=@()};$groups[$color]+=$mapping[$key.id]}
foreach($color in $groups.Keys){$rgb=$color.Split(',');Add-Layer $static "Lighting Lab - $color" $groups[$color] "<RzColor><Red>$($rgb[0])</Red><Green>$($rgb[1])</Green><Blue>$($rgb[2])</Blue></RzColor>"}
# --- 5. Optional white "reactive" layer on top -----------------------------------------------------------
# A key gets white reactive feedback if its group's mode is 'reactive' (anchors use keywordFeedback, others
# use feedback), it is not an orientation key, and anchors are not protected from reactions.
$filler=@($plan.keys | Where-Object {
 $mode=if($_.id -in $plan.settings.anchors){$plan.settings.keywordFeedback}else{$plan.settings.feedback}
 $mode -eq 'reactive' -and $_.id -notin $plan.settings.protectedAnchors -and (-not $plan.settings.protectAnchors -or $_.id -notin $plan.settings.anchors)
} | ForEach-Object {$mapping[$_.id]})
# (The inner duplicate Count check is redundant but harmless.)
if($filler.Count){
 # Two colors: white on press, then fade to blank (transparent) - Studio's own reactive format.
 if($filler.Count){Add-Layer $reactive 'Lighting Lab - white feedback' $filler '<RzColor><Red>255</Red><Green>255</Green><Blue>255</Blue></RzColor><RzColor><IsBlank>true</IsBlank><Alpha>0</Alpha></RzColor>'}
}
# --- 6. Give the profile its own identity and write the archive -----------------------------------------
# A fresh GUID guarantees Studio imports this as a NEW profile instead of overwriting the template's one.
$guid=[guid]::NewGuid().ToString();$doc.LightingEffects.Guid=$guid;$doc.LightingEffects.Name=$plan.name
# ZipArchiveMode::Create fails if the output already exists, so an earlier archive is never overwritten.
$zip=[IO.Compression.ZipFile]::Open($plan.output,[IO.Compression.ZipArchiveMode]::Create)
try{$entry=$zip.CreateEntry("$guid.xml");$writer=New-Object IO.StreamWriter($entry.Open());try{$doc.Save($writer)}finally{$writer.Dispose()}}finally{$zip.Dispose()}
# --- 7. Import through Studio's visible UI (unless -BuildOnly) ------------------------------------------
# The archive is useful even if a vendor chooser requires one manual import step.
$result=@{saved=$true;imported=$false;archive=$plan.output;software='Razer Synapse Studio';detail='Native profile created. In Studio choose Actions > Import, then select this archive. No existing effect was overwritten.'}
if(-not $BuildOnly){try{
 # synapse-control.ps1 drives Studio's Import dialog and reports success only after selection readback.
 $import=& (Join-Path $PSScriptRoot 'synapse-control.ps1') -Action Import -Archive $plan.output -ProfileName $plan.name
 if($import){$state=$import | Select-Object -Last 1 | ConvertFrom-Json;$result.imported=[bool]$state.imported;$result.detail=$state.detail}
}catch{$result.detail+=' Automatic import was unavailable: '+$_.Exception.Message}}
# Output contract: one compressed JSON object, last line of stdout.
$result|ConvertTo-Json -Compress
