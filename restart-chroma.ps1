# =====================================================================================================
# restart-chroma.ps1 - OPTIONAL administrator repair: restart Razer's Chroma SDK services.
#
# When to use: Lighting Lab says "Controller reachable" and Synapse shows the app enabled, but the
# keyboard never changes. Restarting the two SDK services (and optionally Synapse's device bridge)
# clears a stuck SDK session. Saved Synapse profiles are never touched.
#
# Run from an elevated ("Run as administrator") PowerShell in the Lighting Lab folder:
#     powershell -ExecutionPolicy Bypass -File .\restart-chroma.ps1                 # SDK services only
#     powershell -ExecutionPolicy Bypass -File .\restart-chroma.ps1 -IncludeSynapse # + Synapse bridge
#
# Safety rules built in:
#   * Refuses to stop a service that has running dependents (it would take other software down).
#   * Always tries to START every service again in a finally block, even if a stop failed halfway.
#   * Writes each step to .artifacts/lighting-lab/service-repair.jsonl inside THIS folder.
#     (Before the October 2026 audit this pointed two folders up - a leftover from the old monorepo
#     layout that wrote outside the project; see docs/appforge/ISSUES-LOG.md LL-014.)
# =====================================================================================================
param([switch]$IncludeSynapse)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator permission is required to restart the Chroma SDK services. Right-click PowerShell and choose "Run as administrator".'
}

$directory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.artifacts/lighting-lab'))
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$auditFile = Join-Path $directory 'service-repair.jsonl'

# Append one JSON line. ($stage, not $event: $Event is a PowerShell automatic variable.)
function Write-RepairRecord([string]$stage, $detail) {
  @{ at = [DateTime]::UtcNow.ToString('o'); event = $stage; detail = $detail } |
    ConvertTo-Json -Compress -Depth 4 |
    Add-Content -Encoding UTF8 -LiteralPath $auditFile
}

# Stop order: SDK server, SDK service, then (optionally) Synapse. Start order is the exact reverse.
$names = @('Razer Chroma SDK Server', 'Razer Chroma SDK Service')
if ($IncludeSynapse) { $names += 'Razer Synapse Service' }
$startNames = @($names); [array]::Reverse($startNames)

foreach ($name in $names) {
  $dependents = @((Get-Service -Name $name).DependentServices | Where-Object Status -eq 'Running')
  if ($dependents.Count) { throw "Service $name has running dependents; no service was stopped." }
}

Write-RepairRecord 'service-repair-started' @(Get-Service -Name $names | Select-Object Name, Status)
try {
  foreach ($name in $names) { Stop-Service -Name $name -ErrorAction Stop }
} finally {
  foreach ($name in $startNames) {
    try { Start-Service -Name $name -ErrorAction Stop }
    catch { Write-RepairRecord 'service-start-failed' @{ name = $name; error = $_.Exception.Message } }
  }
}

$after = @(Get-Service -Name $names | Select-Object Name, Status)
Write-RepairRecord 'service-repair-finished' $after
if (@($after | Where-Object { $_.Status -ne 'Running' }).Count) {
  throw "A Chroma SDK service did not return to Running; inspect $auditFile."
}
Write-Output "Chroma services restarted. Log: $auditFile"
