# The app-profile probe receives only explicit executable basenames from the local server.
param([string[]]$AppName)
$ErrorActionPreference='Stop'
$wanted=@($AppName | Where-Object { $_ -match '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,123}\.exe$' } | Select-Object -Unique)
$foregroundId=$null
try {
  if(-not ('LightingLab.ForegroundWindow' -as [type])){
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace LightingLab { public static class ForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
} }
"@
  }
  $handle=[LightingLab.ForegroundWindow]::GetForegroundWindow();$unused=0
  [void][LightingLab.ForegroundWindow]::GetWindowThreadProcessId($handle,[ref]$unused);$foregroundId=[int]$unused
} catch { $foregroundId=$null }
$apps=foreach($name in $wanted){
  $base=[IO.Path]::GetFileNameWithoutExtension($name)
  $matches=@(Get-Process -Name $base -ErrorAction SilentlyContinue)
  [pscustomobject]@{executable=$name;running=($matches.Count -gt 0);foreground=($null -ne $foregroundId -and @($matches|Where-Object {$_.Id -eq $foregroundId}).Count -gt 0)}
}
[pscustomobject]@{apps=@($apps);checkedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
