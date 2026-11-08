# Troubleshooting

Start with the **Ready check** strip in the editor. It separates three things that are easy to confuse:

| Ready check says | Meaning | Go to |
| --- | --- | --- |
| Preview ✅, Controller ❌ | Lighting Lab can't reach Razer's Chroma service | [No controller](#preview-works-but-the-controller-is-unavailable) |
| Controller ✅, Physical lights ⏳ | Razer accepted the request; nobody has confirmed the LEDs yet | Press **Apply**, look at the keyboard, answer the question |
| Controller ✅ but you answered "No, Unchanged" | Razer accepted it, but another app owns the lights | [Accepted but unchanged](#controller-reachable-but-the-keyboard-does-not-change) |

## Starting Lighting Lab

**The black window says Node.js was not found, or is too old.**
Install or update Node.js 22+: `winget install OpenJS.NodeJS.LTS` (or nodejs.org). Close the window and
double-click `Start Lighting Lab.cmd` again. If `winget` itself is missing, use the nodejs.org installer.

**"Port 4318 is used by another program."**
Something else uses that port. Start on another one from PowerShell in the Lighting Lab folder:
```powershell
$env:LIGHTING_LAB_PORT=4319; node server.cjs --open
```
(If the message is instead "already running", that's fine: Lighting Lab was already open, and the page opens.)

**The browser shows "can't reach this page".**
The black window was closed, or it shows an error. Lighting Lab only runs while that window is open.

**The page loads but the header says "Preview only".**
The browser can't reach the server. Usually the window was closed after the page opened. Start it again.

## Preview works but the controller is unavailable

Live lighting uses Razer's **Chroma SDK**, which comes with Razer Synapse.

1. Install/open **Razer Synapse** and make sure your keyboard appears there.
2. In Synapse, make sure the Chroma **Connect / Chroma Apps** module is installed and switched on.
3. Windows **Services** should show *Razer Chroma SDK Server* and *Razer Chroma SDK Service* as Running.
4. Press **Reconnect** in Lighting Lab.

Not a Razer keyboard? Live control isn't available yet. See the support table in the [README](../README.md).

## Controller reachable but the keyboard does not change

This is the classic Chroma ownership problem: Razer acknowledges every request, but Synapse keeps showing
its own effect. (It happened on the development PC too; see [VALIDATION.md](VALIDATION.md).)

1. In Synapse → **Connect → Chroma Apps**: turn the master switch **on**, find **Jeby Lighting Lab** in the
   list, and enable it. If there's a priority list, move it up.
2. Press **Retry Chroma Connection** in Lighting Lab. It restarts the session and reads the Connect panel back
   to tell you whether the app is listed and enabled.
3. Still stuck? Restart the SDK services as administrator (saved profiles are not touched):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\restart-chroma.ps1 -IncludeSynapse
   ```
4. If **Retry** reports that a control is "covered by process …", a screen overlay (for example *Mouse Without
   Borders*) is on top of Synapse. Close or move it and retry.

## Effects stutter, skip rows, or flicker between two looks

The most common cause is **two copies of Lighting Lab running at once**. Each holds its own Chroma session and
they take turns driving the keyboard. Since 0.3.0 a second launch detects the first and reuses it, but a copy
started by an *older* version (which listened on `0.0.0.0`) can still be running in the background.

Check from PowerShell:
```powershell
Get-NetTCPConnection -LocalPort 4318 -State Listen | Select-Object LocalAddress, OwningProcess
```
More than one line means more than one copy. Close the extra Lighting Lab window, or end that process ID
in Task Manager. Then press **Apply**.

If only one copy is running, keep **Sync compatible mouse** off while testing (it doubles the work per frame on
some PCs). Remember that the preview always shows the intended timing.

## The picture doesn't match my keyboard

- Choose the right model under **Keyboard view**, or press **Identify My Layout** for a 30-second guided check.
  A broken key never makes the layout smaller: use *This key doesn't work* and press an alternative.
- **Customize keyboard view** moves or resizes individual keys in the picture. It never changes which LED a
  key controls.

## A key doesn't react

- **Key Issues & Workarounds** lets you mark a key as unresponsive and pick a working key to trigger its
  lighting reaction instead. This affects lighting only, not typing.
- Numpad `.` acting like Delete? Turn **Num Lock** on and test again.
- In **Test typing** and on the picture, reactions are previews. To see them on the keyboard, keep **Live changes**
  on. To react while you type in *other* apps, enable **Connection & input → Global key feedback**.

## App Profiles don't switch

- **Automatic switching** must be on (App profiles page, top right).
- The rule's profile must still exist. "Missing saved profile" means it was deleted, so pick another one.
- Use **Find running apps** → **Use** so the executable name is exact (e.g. `Code.exe`, not `VS Code`).
- **In front** only matches while that app's window is focused. **Running** matches whenever it's open.
  **Full screen** matches when that app is in front *and* covers its whole monitor (most games). **Time of day**
  uses this PC's clock; windows such as 23:00–07:00 wrap past midnight.
- Use the **Try it** chips to see which rule would win for an app, without changing your keyboard.
- Rules are checked top to bottom; the **first** match wins. Use **Up/Down** to reorder.
- Lighting Lab must be running. Rules resume automatically when it starts.
- Before version 0.3.0, only the *first* app in your rules was actually watched (LL-010 in the issues log).
  Update if you are on an older copy.

## Using a phone or another PC

- Start with `npm run start:lan` (or `node server.cjs --open --lan`) and open the printed `LAN:` address.
- Allow Node.js through Windows Firewall for **private** networks when asked.
- Both devices must be on the same network. The phone controls the keyboard plugged into the PC running
  Lighting Lab, not a keyboard on the phone's side.
- "Open Lighting Lab by localhost, IP address, or this PC name": you used a custom host name. Add it with
  `LIGHTING_LAB_ALLOWED_HOSTS=my-pc.lan` (this guard blocks a web-attack technique called DNS rebinding).

## Download .exe

- The button is disabled when the chosen effect has no equivalent on the export target (the status text lists
  the ones that work), or when the AL65 firmware option hasn't been ticked.
- The .exe is built on your PC by Windows' own .NET Framework C# compiler. If building fails, make sure .NET
  Framework 4.x is enabled under *Windows Features*.
- Windows SmartScreen may warn because the file isn't code-signed. It's a console program you just built.
  Run `Lighting-Lab-….exe --inspect` to see exactly what it contains before running it.

## Start fresh

Close Lighting Lab, delete the `.artifacts/lighting-lab` folder (profiles, rules, audit log), and in the browser
clear site data for `localhost:4318` (editor state, onboarding progress, local feedback).

## Still stuck?

Press **Connection & input → Download diagnostics** and attach the file to a
[GitHub issue](https://github.com/jameseby21/Lighting-Lab/issues/new). It contains device/provider status and
recent actions, never typed text or window titles.
