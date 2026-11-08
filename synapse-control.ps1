# =====================================================================================================
# synapse-control.ps1 - carefully scoped automation of the Razer Synapse 3 window.
#
# Lighting Lab never calls Synapse's private/authenticated internal APIs. When it needs Synapse to do
# something (enable the "Chroma Apps" integration, import or select a Studio profile) it drives the
# visible Synapse window through Windows UI Automation, exactly as a person would, and READS BACK the
# result before claiming success.
#
# Actions (-Action) and their callers
#   Open     Launch/locate the Synapse window only.                       (diagnostics)
#   Inspect  Open the Chroma Apps (Connect) panel and REPORT the master switch and whether -AppTitle is
#            listed and enabled. Changes nothing.                         (tests/check-connect.cjs)
#   Repair   Same as Inspect, but turns the master switch and this app's switch ON if they are off.
#                                                                        (server.cjs POST /api/repair)
#   Import   Import the archive -Archive through Studio's Import dialog, then select -ProfileName.
#                                                                        (save-native-profile.ps1)
#   Select   Select an already imported Studio profile named -ProfileName.
#                                                                        (synapse-profile.cjs loadNativeProfile)
#   -AppTitle defaults to the Chroma registration title used by providers/chroma-sdk.cjs (APP_TITLE).
#
# Output contract
#   The LAST line of stdout is compressed JSON. Inspect/Repair: {opened, connectPanelVerified,
#   masterBefore, masterEnabled, appTitle, appListed, appEnabled, physicalLightingVerified:false, detail}.
#   Import/Select: {imported, selected, detail}. Any failure THROWS (non-zero exit, message on stderr);
#   callers treat a throw as "not verified", never as success.
#
# Safety rules (each enforced in code below)
#   * Only the Synapse executable at the exact install path is trusted; a lookalike window is refused.
#   * Prefer UI Automation patterns (Invoke / SelectionItem / Toggle) over pointer input.
#   * When a click is unavoidable it is sent as a window message to the verified Synapse window, and
#     only after checking: Synapse is foreground, the target is inside its bounds, and the pixel under the
#     target belongs to Synapse (overlays such as Mouse Without Borders are detected and refused).
#   * Legacy file-dialog controls are written via their native handle only if that handle's owning
#     process is Synapse.
#   * Every wait is bounded (Wait-For); a timeout throws instead of guessing.
#   * physicalLightingVerified is always false: switches being "On" does not prove the keyboard changed.
#
# Limits: written against the Synapse 3 UI (automation ids such as ChromaApps / cmbLightPac). Synapse 4
# or a UI redesign will make these lookups fail loudly (bounded waits), not misbehave.
# =====================================================================================================
# Scoped vendor UI automation; it never replays authenticated internal endpoints or guessed input.
# Parameters: -Action (see header), -Archive (Import only), -ProfileName (Import/Select), -AppTitle (Inspect/Repair).
param([ValidateSet('Open','Import','Select','Inspect','Repair')][string]$Action='Open',[string]$Archive,[string]$ProfileName,[string]$AppTitle='Jeby Lighting Lab')
$ErrorActionPreference='Stop'
# Windows UI Automation (the accessibility API) lets us find and operate Synapse controls by id/name.
Add-Type -AssemblyName UIAutomationClient
# The one executable we trust. Launching it is harmless if Synapse is already running (it just focuses).
$exe='C:\Program Files (x86)\Razer\Synapse3\WPFUI\Framework\Razer Synapse 3 Host\Razer Synapse 3.exe'
if(-not (Test-Path -LiteralPath $exe)){throw 'The installed Synapse 3 application was not found.'}
Start-Process -FilePath $exe -WindowStyle Hidden
# Wait-For: poll a query every 200 ms until it returns something, or throw after the timeout (default 3.2 s).
function Wait-For([scriptblock]$query,[string]$description,[int]$timeoutMs=3200){$timer=[Diagnostics.Stopwatch]::StartNew();do{$value=& $query;if($null -ne $value){return $value};Start-Sleep -Milliseconds 200}while($timer.ElapsedMilliseconds -lt $timeoutMs);throw "Synapse did not expose $description within the bounded wait. No successful navigation was verified."}
# Desktop root of the UI Automation tree, plus two lookup helpers:
#   Descendants = every element under a node; ById = first visible element with a given AutomationId.
$root=[System.Windows.Automation.AutomationElement]::RootElement
function Descendants($element){$element.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)}
function ById($element,[string]$id){Descendants $element | Where-Object {$_.Current.AutomationId -eq $id -and -not $_.Current.IsOffscreen} | Select-Object -First 1}
# Minimal user32 bindings for the scoped-click fallback and for writing into the legacy file dialog.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SynapsePointer {
 [StructLayout(LayoutKind.Sequential)] public struct Point {public int x,y;}
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr window,ref Point point);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr SendText(IntPtr window,uint message,IntPtr wParam,string text);
 [DllImport("user32.dll",EntryPoint="SendMessageW")] public static extern IntPtr SendAction(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
}
'@
# UI Automation exposes physical pixels; use the same coordinate space for scoped pointer checks.
$null=[SynapsePointer]::SetThreadDpiAwarenessContext([IntPtr](-4))
# Find the visible top-level Synapse window (up to 30 s while Synapse starts), then prove which process owns it.
$window=Wait-For {$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)|Where-Object {$_.Current.Name -match 'Razer Synapse' -and -not $_.Current.IsOffscreen}|Select-Object -First 1} 'a visible Synapse window' 30000
$owner=Get-Process -Id $window.Current.ProcessId
if($owner.MainModule.FileName -ne $exe){throw 'The visible window does not belong to the installed Synapse executable.'}
# Activate: operate one control the safest way available.
#   1) InvokePattern (buttons)  2) SelectionItemPattern (list items; not tabs)  3) verified scoped click.
function Activate($element){
 if(-not $element -or -not $element.Current.IsEnabled -or $element.Current.IsOffscreen){throw 'Required visible Synapse control was not found.'}
 $pattern=$null
 if($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke();return}
 if($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::TabItem -and $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){$pattern.Select();return}
 # Some vendor tabs change SelectionItem state without loading their page. A scoped click triggers it.
 # Fallback click, guarded: Synapse must be foreground, the control inside its window, and not covered.
 $null=[SynapsePointer]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle)
 [uint32]$foregroundOwner=0;$null=[SynapsePointer]::GetWindowThreadProcessId([SynapsePointer]::GetForegroundWindow(),[ref]$foregroundOwner)
 if($foregroundOwner -ne $window.Current.ProcessId){throw 'Synapse did not gain foreground ownership; no pointer input was sent.'}
 $rect=$element.Current.BoundingRectangle;$bounds=$window.Current.BoundingRectangle
 if($rect.IsEmpty -or $rect.Left -lt $bounds.Left -or $rect.Right -gt $bounds.Right -or $rect.Top -lt $bounds.Top -or $rect.Bottom -gt $bounds.Bottom){throw 'Synapse control is outside its verified window; no pointer input was sent.'}
 $point=New-Object SynapsePointer+Point;$point.x=[int]($rect.Left+$rect.Width/2);$point.y=[int]($rect.Top+$rect.Height/2)
 [uint32]$pointOwner=0;$null=[SynapsePointer]::GetWindowThreadProcessId([SynapsePointer]::WindowFromPoint($point),[ref]$pointOwner)
 if($pointOwner -ne $window.Current.ProcessId){throw "Synapse control '$($element.Current.Name)' at $($point.x),$($point.y) is covered by process $pointOwner (expected $($window.Current.ProcessId)); no button input was sent."}
 # Convert to window-client coordinates and send WM_LBUTTONDOWN (0x0201) / WM_LBUTTONUP (0x0202) to Synapse only.
 $mainHandle=[IntPtr]$window.Current.NativeWindowHandle
 if(-not [SynapsePointer]::ScreenToClient($mainHandle,[ref]$point)){throw 'Synapse control coordinates could not be scoped to its window; no button input was sent.'}
 $messagePoint=[IntPtr](($point.y -shl 16) -bor ($point.x -band 0xffff))
 $null=[SynapsePointer]::SendAction($mainHandle,0x0201,[IntPtr]1,$messagePoint);Start-Sleep -Milliseconds 100
 $null=[SynapsePointer]::SendAction($mainHandle,0x0202,[IntPtr]0,$messagePoint);Start-Sleep -Milliseconds 100
}
# NativeHandle: the Win32 handle of a classic dialog control, refused unless Synapse owns it.
function NativeHandle($element){
 $handle=[IntPtr]$element.Current.NativeWindowHandle
 if($handle -eq [IntPtr]::Zero){throw 'Legacy dialog control exposed no native handle; no message was sent.'}
 [uint32]$controlOwner=0;$null=[SynapsePointer]::GetWindowThreadProcessId($handle,[ref]$controlOwner)
 if($controlOwner -ne $window.Current.ProcessId){throw 'Legacy dialog control belongs to another process; no message was sent.'}
 return $handle
}
# Set-NativeText = WM_SETTEXT (0x000C) into a file-name box; Invoke-NativeButton = BM_CLICK (0x00F5).
function Set-NativeText($element,[string]$value){$null=[SynapsePointer]::SendText((NativeHandle $element),0x000C,[IntPtr]::Zero,$value)}
function Invoke-NativeButton($element){$null=[SynapsePointer]::SendAction((NativeHandle $element),0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)}
# ---- Action: Open -------------------------------------------------------------------------------------
if($Action -eq 'Open'){@{opened=$true;windowVerified=$true;detail='Synapse window verified. Connect controls can now be inspected.'}|ConvertTo-Json -Compress;exit}
# ---- Actions: Inspect / Repair (Chroma Apps panel) -----------------------------------------------------
if($Action -in @('Inspect','Repair')){
 if(-not (ById $window 'ChromaApps')){
  # Studio flyouts are modal enough to consume top-navigation clicks. Close only the open effect
  # expander owned by this window before asking CONNECT to load.
  $windowBounds=$window.Current.BoundingRectangle
  $effectExpander=Descendants $window | Where-Object {$_.Current.AutomationId -eq 'ExpanderButton' -and -not $_.Current.IsOffscreen -and $_.Current.BoundingRectangle.Left -lt ($windowBounds.Left+300)} | Select-Object -First 1
  if($effectExpander){$effectToggle=$null;if($effectExpander.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$effectToggle) -and $effectToggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On){$effectToggle.Toggle();Start-Sleep -Milliseconds 200}}
  $manageApps=ById $window 'btnChromaApp'
  if($manageApps){
   # Synapse 3 exposes Chroma Apps as a scoped management button on the active device page.
   # Selecting CONNECT alone leaves that panel closed, even when the app currently owns lighting.
   Activate $manageApps
  }else{
   Activate (Descendants $window | Where-Object {$_.Current.Name -eq 'CONNECT' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem}|Select-Object -First 1)
  }
 }
 # The panel must actually load (its automation id appears); a selected tab alone is not proof.
 $panel=Wait-For {ById $window 'ChromaApps'} 'the Connect Apps panel'
 # Dismiss an informational overlay if Synapse shows one over the panel.
 $close=Descendants $window | Where-Object {$_.Current.Name -eq 'CLOSE' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button}|Select-Object -First 1
 if($close){Activate $close}
 # Master "Chroma Apps" switch: read it; Repair turns it on if it was off.
 $master=Wait-For {Descendants $window | Where-Object {$_.Current.Name -eq 'CHROMA APPS' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button}|Select-Object -First 1} 'the Chroma Apps master switch'
 $toggle=[System.Windows.Automation.TogglePattern]$master.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
 $before=$toggle.Current.ToggleState.ToString()
 if($Action -eq 'Repair' -and $before -eq 'Off'){$toggle.Toggle()}
 $enabled=$toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On
 # This app's own entry in the list (exact registration title). Repair enables it if it is off.
 $app=Descendants $window | Where-Object {$_.Current.Name -eq $AppTitle -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem}|Select-Object -First 1
 $appEnabled=$null
 if($app){Activate $app;$button=Wait-For {Descendants $window | Where-Object {$_.Current.Name -eq 'ENABLE THIS APP' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button}|Select-Object -First 1} 'the app enablement switch';$appToggle=[System.Windows.Automation.TogglePattern]$button.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern);if($Action -eq 'Repair' -and $appToggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off){$appToggle.Toggle()};$appEnabled=$appToggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On}
 # Report what was read back. physicalLightingVerified stays false by design.
 @{opened=$true;connectPanelVerified=$true;masterBefore=$before;masterEnabled=$enabled;appTitle=$AppTitle;appListed=[bool]$app;appEnabled=$appEnabled;physicalLightingVerified=$false;detail=if(-not $app){'Connect opened, but this exact app was not found in the current vendor list. Device takeover is unresolved; inspect app filters or the Synapse bridge.'}else{'Connect panel and enablement read back. Physical lighting still needs confirmation.'}}|ConvertTo-Json -Compress;exit
}
# ---- Actions: Import / Select (Studio profiles) --------------------------------------------------------
if(-not $ProfileName){throw 'A native profile name is required.'}
# Import: reuse an already-open file chooser, otherwise open Studio, Actions, Import, Browse.
if($Action -eq 'Import'){
 if(-not (Test-Path -LiteralPath $Archive)){throw 'Native profile archive is missing.'}
 $open=Descendants $window | Where-Object {$_.Current.Name -eq 'Open' -and $_.Current.ClassName -eq '#32770' -and -not $_.Current.IsOffscreen} | Select-Object -First 1
 if(-not $open){
  $studioContent=ById $window 'btnActions'
  if(-not $studioContent){
   $studio=Descendants $window | Where-Object {$_.Current.Name -eq 'STUDIO' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem} | Select-Object -First 1
   if(-not $studio){throw 'Synapse did not expose its named Studio tab; no import was attempted.'}
   Activate $studio
  }
  Activate (Wait-For {ById $window 'btnActions'} 'Studio Actions')
  Activate (Wait-For {ById $window 'rzAvatarPopItem_ImportProfile'} 'Import')
  Activate (Wait-For {ById $window 'browseBtn'} 'Browse')
  $open=Wait-For {Descendants $window | Where-Object {$_.Current.Name -eq 'Open' -and $_.Current.ClassName -eq '#32770' -and -not $_.Current.IsOffscreen} | Select-Object -First 1} 'the nested file chooser'
 }
 # Classic Windows "Open" dialog: control 1148 is the file-name box, control 1 is the Open button.
 $field=Wait-For {Descendants $open|Where-Object {$_.Current.AutomationId -eq '1148' -and $_.Current.ClassName -eq 'Edit'}|Select-Object -Last 1} 'the native filename field'
 Set-NativeText $field $Archive
 $openButton=Wait-For {Descendants $open|Where-Object {$_.Current.Name -eq 'Open' -and $_.Current.AutomationId -eq '1' -and $_.Current.ClassName -eq 'Button'}|Select-Object -First 1} 'the native Open button'
 Invoke-NativeButton $openButton
 # Confirm the import once Synapse enables its Import button.
 Activate (Wait-For {$button=ById $window 'btnImport';if($button -and $button.Current.IsEnabled){$button}} 'enabled Import confirmation')
}
# Select (also the second half of Import): make sure the Studio page with the effects combo box is showing.
$studioContent=ById $window 'cmbLightPac'
if(-not $studioContent){
 $studio=Descendants $window | Where-Object {$_.Current.Name -eq 'STUDIO' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem} | Select-Object -First 1
 if(-not $studio){throw 'Synapse did not expose its named Studio tab; no profile was selected.'}
 Activate $studio
}
# Open the Chroma Effects combo box so its profile items exist in the automation tree.
$combo=Wait-For {ById $window 'cmbLightPac'} 'Chroma Effects'
$expand=[System.Windows.Automation.ExpandCollapsePattern]$combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
if($expand.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Expanded){$expand.Expand()}
# Same-named wrappers can exist; only the element that supports SelectionItem is the real profile entry.
$profilePattern=$null
$profile=Wait-For {
 foreach($candidate in @(Descendants $window|Where-Object {$_.Current.Name -eq $ProfileName -and -not $_.Current.IsOffscreen})){
  $pattern=$null
  if($candidate.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){$script:profilePattern=$pattern;return $candidate}
 }
 return $null
} 'the selectable imported profile'
# Select it, then READ BACK the combo selection; success is claimed only if the name is really selected.
$profilePattern.Select()
$selected=Wait-For {
 $selection=$null
 if($combo.TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern,[ref]$selection) -and @($selection.Current.GetSelection()|ForEach-Object {$_.Current.Name}) -contains $ProfileName){return $true}
 return $null
} 'the imported profile selection readback'
@{imported=$true;selected=$true;detail=if($Action -eq 'Import'){'Profile imported and selected in Razer Synapse Studio.'}else{'Existing profile selected in Razer Synapse Studio.'}}|ConvertTo-Json -Compress
