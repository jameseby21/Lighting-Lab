# =====================================================================================================
# app-profile-monitor.ps1 - the only code in Lighting Lab that looks at which apps are running.
#
# Called by server.cjs (createWindowsAppProbe). It answers one question: "for these executable names,
# is each one running, is one of them the foreground (in front) window, and does that window cover its
# whole monitor (fullscreen: games, presentations, video)?"  It prints JSON on stdout, one object per app:
#   {"executable":"Code.exe","running":true,"foreground":true,"fullscreen":false}
#
# Three modes:
#   -AppNames "Code.exe,Spotify.exe"            One-shot check of the configured rule names.
#   -AppNames "..." -Watch [-IntervalMs 1000]   Same check, repeated forever, one JSON line per tick.
#                                               The server keeps ONE of these alive instead of starting a
#                                               new powershell.exe every second (~0.5 s of CPU each time).
#   -Discover                                   User-started list of visible desktop apps (the "Find
#                                               running apps" button). Emits executable names only.
#
# Privacy boundary (also stated in the UI): window titles, command lines, typed text and key history are
# never read. Only process names and a yes/no "is this the foreground process" flag leave this script.
#
# Why -AppNames is ONE comma-separated string: `powershell.exe -File script.ps1 -AppName a.exe b.exe`
# binds only "a.exe" to a [string[]] parameter - the rest are silently dropped. That bug meant only the
# first rule was ever checked (ISSUES-LOG LL-010). Rule names are validated to never contain commas,
# so splitting on "," is unambiguous.
# =====================================================================================================
param(
  [switch]$Discover,
  [switch]$Watch,
  [string]$AppNames = '',
  [string[]]$AppName = @(),   # Legacy single-name form; still accepted so older servers keep working.
  [ValidateRange(250, 10000)][int]$IntervalMs = 1000
)
$ErrorActionPreference = 'Stop'

# Same allowlist as app-profiles.cjs EXECUTABLE: a bare file name ending in .exe, no path separators.
$namePattern = '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,123}\.exe$'
$wanted = @(@($AppNames -split ',') + $AppName |
  ForEach-Object { "$_".Trim() } |
  Where-Object { $_ -match $namePattern } |
  Select-Object -Unique)

# Compile a small user32 shim once per process. In -Watch mode this cost is paid once, not every tick.
# Besides "which process owns the window in front" it answers "does that window cover its whole monitor"
# (the Full screen condition, ISSUES-LOG LL-060). Only rectangles and the window CLASS name are read - class
# names are fixed per program type ("Progman", "Chrome_WidgetWin_1"), never the window title or content.
try {
  if (-not ('LightingLab.ForegroundInfo' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace LightingLab { public static class ForegroundInfo {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor; public Rect Work; public uint Flags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr handle, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder name, int size);
  // True when the window is not the desktop/shell and its rectangle covers (or exceeds) its monitor.
  // Borderless "fullscreen windowed" games and true exclusive fullscreen both qualify; a maximized normal
  // window does not, because the taskbar area (rcWork vs rcMonitor) stays uncovered.
  public static bool IsFullscreen(IntPtr handle) {
    if (handle == IntPtr.Zero || handle == GetShellWindow() || handle == GetDesktopWindow()) return false;
    var cls = new StringBuilder(64); GetClassName(handle, cls, cls.Capacity);
    string name = cls.ToString();
    if (name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd") return false;
    Rect window; if (!GetWindowRect(handle, out window)) return false;
    IntPtr monitor = MonitorFromWindow(handle, 2); // MONITOR_DEFAULTTONEAREST
    var info = new MonitorInfo(); info.Size = Marshal.SizeOf(typeof(MonitorInfo));
    if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return false;
    return window.Left <= info.Monitor.Left && window.Top <= info.Monitor.Top
      && window.Right >= info.Monitor.Right && window.Bottom >= info.Monitor.Bottom;
  }
} }
"@
  }
  $foregroundAvailable = $true
} catch { $foregroundAvailable = $false }

# Returns @{ id = <process ID owning the window in front>; fullscreen = <bool> }, or id = $null if Windows
# will not say (locked screen, UAC prompt...).
function Get-ForegroundState {
  if (-not $foregroundAvailable) { return @{ id = $null; fullscreen = $false } }
  try {
    $handle = [LightingLab.ForegroundInfo]::GetForegroundWindow(); $ownerId = 0
    [void][LightingLab.ForegroundInfo]::GetWindowThreadProcessId($handle, [ref]$ownerId)
    return @{ id = [int]$ownerId; fullscreen = [LightingLab.ForegroundInfo]::IsFullscreen($handle) }
  } catch { return @{ id = $null; fullscreen = $false } }
}

# One snapshot as a compressed JSON string. Note: never name a variable $matches - it is PowerShell's
# automatic regex-result variable and gets clobbered by every -match above.
function Get-Report {
  $foregroundState = Get-ForegroundState
  $foregroundId = $foregroundState.id
  if ($Discover) {
    # Only processes that own a visible top-level window; a few always-present shell hosts are hidden as noise.
    $visible = @(Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -notin @('svchost', 'TextInputHost', 'ApplicationFrameHost') } |
      Sort-Object ProcessName, Id)
    $apps = @($visible | Group-Object { $_.ProcessName.ToLowerInvariant() } | ForEach-Object {
        $group = @($_.Group)
        $inFront = ($null -ne $foregroundId -and @($group | Where-Object { $_.Id -eq $foregroundId }).Count -gt 0)
        [pscustomobject]@{
          executable = ($group[0].ProcessName + '.exe')
          running    = $true
          foreground = $inFront
          fullscreen = ($inFront -and $foregroundState.fullscreen)
        }
      } | Sort-Object executable | Select-Object -First 40)
    $scope = 'visible-desktop-apps'
  } else {
    $apps = @($wanted | ForEach-Object {
        $name = $_
        $base = [IO.Path]::GetFileNameWithoutExtension($name)   # Get-Process wants "Code", not "Code.exe".
        $processes = @(Get-Process -Name $base -ErrorAction SilentlyContinue)
        $inFront = ($null -ne $foregroundId -and @($processes | Where-Object { $_.Id -eq $foregroundId }).Count -gt 0)
        [pscustomobject]@{
          executable = $name
          running    = ($processes.Count -gt 0)
          foreground = $inFront
          # Full screen = this app owns the window in front AND that window covers its monitor.
          fullscreen = ($inFront -and $foregroundState.fullscreen)
        }
      })
    $scope = 'configured-rules'
  }
  return ([pscustomobject]@{ apps = @($apps); checkedAt = [DateTime]::UtcNow.ToString('o'); scope = $scope } | ConvertTo-Json -Compress -Depth 4)
}

if ($Watch -and -not $Discover) {
  # Stream forever. When the server exits, its end of stdout closes, the next write throws, and this loop ends,
  # so an orphaned watcher cannot outlive Lighting Lab for more than one tick.
  while ($true) {
    try { [Console]::Out.WriteLine((Get-Report)); [Console]::Out.Flush() } catch { break }
    Start-Sleep -Milliseconds $IntervalMs
  }
} else {
  Get-Report
}
