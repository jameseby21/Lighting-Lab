# Restart the SDK path, optionally including Synapse's device bridge. Profiles remain untouched.
param([switch]$IncludeSynapse)
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator permission is required to restart the Chroma SDK services.'}
$directory=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.artifacts/lighting-lab'))
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$audit=Join-Path $directory 'service-repair.jsonl'
function Record([string]$event,$detail){@{at=[DateTime]::UtcNow.ToString('o');event=$event;detail=$detail}|ConvertTo-Json -Compress -Depth 4|Add-Content -Encoding UTF8 -LiteralPath $audit}
$names=@('Razer Chroma SDK Server','Razer Chroma SDK Service')
if($IncludeSynapse){$names+= 'Razer Synapse Service'}
$startNames=@($names);[array]::Reverse($startNames)
foreach($name in $names){
 $dependencies=@((Get-Service -Name $name).DependentServices | Where-Object Status -eq 'Running')
 if($dependencies.Count){throw "Service $name has running dependents; no service was stopped."}
}
Record 'service-repair-started' @(Get-Service -Name $names | Select-Object Name,Status)
try{
 foreach($name in $names){Stop-Service -Name $name -ErrorAction Stop}
}finally{
 foreach($name in $startNames){try{Start-Service -Name $name -ErrorAction Stop}catch{Record 'service-start-failed' @{name=$name;error=$_.Exception.Message}}}
}
$after=@(Get-Service -Name $names | Select-Object Name,Status)
Record 'service-repair-finished' $after
if(@($after | Where-Object {$_.Status -ne 'Running'}).Count){throw 'A Chroma SDK service did not return to Running; inspect service-repair.jsonl.'}
