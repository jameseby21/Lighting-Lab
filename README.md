# Jeby Lighting Lab

Local keyboard lighting editor, preset gallery, physical keyboard preview, and capability-aware
preset export. The runnable source is now tracked here. Private historical profiles, logs, and
backups remain in ignored `docs/background/keyboard-layout/`.

## Run

From the repository root, using Windows PowerShell:

```powershell
node server.cjs
```

Open `http://localhost:4318`. Keep the terminal running. Node 22 or newer is required; there are
no npm dependencies. The server prints detected IPv4 LAN URLs, but remote connectivity is not
verified by printing an address. `LIGHTING_LAB_HOST` and `LIGHTING_LAB_PORT` override the bind.

The default bind remains `0.0.0.0` for the existing phone/LAN workflow. Firewall permissions are
not changed by launching the app. The reported brother-PC timeout, unspecified `chromweb` error,
and console 401 responses remain deferred. Their cause is unconfirmed; browser-extension,
Synapse-authentication, and application errors must be distinguished by endpoint and timestamp.

The desktop/phone browser controls the keyboard attached to the server computer. Opening this
page from another PC does **not** give the server access to that PC's USB keyboard. Use the local
server there or a supported portable preset export to affect that computer's hardware.

## Development chunks

1. Canonical physical switch identities, documented Chroma coordinates, full keyboard geometry,
   model recognition/fallback, and regression coverage for the shifted Q/W mapping.
2. One shared preview/device effect renderer, independently configurable Anchor/Background/
   Orientation base, motion, and reaction layers; a single falling Matrix line with randomized
   three-to-seven-row gaps; fading white reactions; and live edit serialization.
3. Exact-target portable export with explicit capability limits, state backup/readback, and
   standalone executable compilation/inspection. No firmware flashing or key remapping.
4. Visual hierarchy, complete selectable keyboard, customization view, progressive disclosure,
   persistence/import, responsive layout, and browser interaction checks.
5. Integration checks, documentation, skill refinement, staged-source review, commit and push.

Each chunk needs executable evidence, followed by target-device/user acceptance where applicable.
Passing a software test does not close a repeatedly reported physical-lighting defect.

## Control and export boundaries

- **Live Chroma:** Razer SDK must be available on the server PC. Background and reactions are
  rendered continuously; settings changes reuse a session. Direct effects require the server to
  keep running and do not survive shutdown. Global input is explicitly enabled and memory-only.
  Transport success and visible control are tracked separately per keyboard/provider. If the owner
  reports unchanged lights, automatic live writes pause while Apply remains available for retesting.
  When Windows reports more than one keyboard, Lighting Lab lists each present identity and lets the
  user choose the model, preview, and saved setup. Its current generic Chroma keyboard canvas does
  not document per-device routing, so compatible keyboards may receive the same frame; the selector
  never promises isolated physical control.
- **Apply:** sends the current preview even with Live Changes off. It starts a fresh SDK session
  and uses Razer's create/SetEffect path. Later live edits reuse that session. An acknowledgment
  means the controller accepted the request; the page asks whether the physical lights changed.
  Repair Connection opens Synapse and retries; Chroma Apps enablement/priority may still need attention.
  Repair now reads the actual Connect panel, master switch, and exact registered app; it cannot
  report successful navigation merely because the process launched. The vendor identity remains
  `Jeby Lighting Lab` so the editor's shorter display name does not create a separate registration.
- **Save as Profile:** saves a named, loadable record in the selected controller. Lighting Lab
  preserves the full setup on this server. Native Synapse generation currently uses the local
  BlackWidow Elite archive template for static/keyword colors and white Reactive only; custom
  animations, mouse sync, and Ripple/Waterfall are explicitly rejected. Archive generation occurs
  before releasing live control. Import success requires UI selection readback. If the vendor UI
  cannot be automated, the page offers the actual `.ChromaEffects` archive for manual Studio import.
  On the current BlackWidow Elite, a generated solid-magenta profile was imported, selected with
  parent-combo readback, and physically confirmed; the original profile was then reselected.
  Other native applications are not yet implemented. Local-template support is not a clean-clone claim.
- **Export Setup JSON:** downloads the editable recipe. It is separate from applying/saving a
  controller profile and does not write onboard memory.
- **Download .exe / Auto:** exports a small Windows preset player. It detects a present Razer
  keyboard and uses the installed Chroma runtime, playing shared-renderer frames while open.
  Reactions are opt-in; physical key identities stay in memory. Mouse sync is included when chosen.
  Unknown brands fail clearly without guessed USB writes. A standalone file does not remove
  Razer's runtime dependency or make a host-generated animation persist after the player closes.
- **Portable AL65 preset:** applies documented whole-board firmware lighting via wired VIA HID.
  This is an explicitly chosen approximation of the editor's layered effect. It cannot preserve
  arbitrary keyword islands, orientation anchors, mouse sync, or white feedback overlays.
  See [export research and limitations](docs/RESEARCH-EXPORT.md).
- **Other devices:** a preview model is not a claim of a control protocol. Ornata variants must
  distinguish per-key from zone lighting. No generic driverless arbitrary per-key RGB claim is made.

## Checks

From the repository root:

```powershell
node --test tests/*.test.cjs
node tests/browser-check.cjs
node tests/build-portable.cjs
node tests/build-native.cjs
uv run ruff check .
uv run mypy src
uv run pytest
```

The native-build check requires this machine's ignored vendor exports and never imports its test
archive. The browser check uses an isolated headless Microsoft Edge profile and mocked device responses.
It does not run against a user's physical keyboard. Generated audit records, screenshots, and
build evidence belong in ignored `.artifacts/lighting-lab/`; raw keystrokes are not logged.

With the server running, `node tests/check-download.cjs` checks the actual
compiler/download endpoint without executing the downloaded preset. The read-only status check
is `node tests/check-live.cjs`; its explicit `--exercise` option temporarily
changes real Chroma lighting, verifies accepted frames, then releases/restores the session.
`node tests/check-connect.cjs` checks the actual Synapse Connect controls and
exact app enablement, without writing RGB. Mouse-sharing overlays can block pointer navigation;
the helper uses control selection where supported and stops rather than clicking another process.
The importer identifies Studio by its visible tab name, handles Synapse's nested legacy chooser by
verified native handles, and selects only a same-named item that exposes SelectionItem.
The optional administrator script `restart-chroma.ps1 -IncludeSynapse` also
refreshes Synapse's device bridge, logs service states, and restores the three services to Running.

## How to validate

On the Windows PC with the keyboard attached, start the server above. This does not flash firmware
or install a startup service. The page's live switch controls a temporary RGB session.

1. Check the detected model/source. Select the actual model manually if detection is unknown;
   the choice should survive provider refresh. Inspect function/navigation/numpad keys and casing.
2. Clear keyword selection, select Q/W/E/R/T individually, and verify those exact physical keys.
   Test a main-row digit and its separate numpad digit.
3. Select Matrix and Stripes. Matrix is one dropping green row, with a deterministic randomized
   gap of three to seven rows before the next line; Stripes is one rising row that alternates red
   and white. Then test
   Rainbow Road and Chaos. Confirm minimalist darkens non-anchor backgrounds while reactions remain visible.
4. Use Paint Anchor, Paint Background, Paint Orientation, or Test reactions above the board. For
   each group choose base lighting, a dynamic effect, and a reaction independently. White fade sits
   above its base color by default. Enable Global Key Feedback to test outside the browser. Ripple
   expands and Waterfall progresses downward.
   The group picker also exposes Chroma-style Static, Breathing, Fire, Spectrum Cycling, Starlight,
   Wave, Reactive, and Ripple, plus Lighting Lab's Aurora, Radar Sweep, Prism Flow, Pulse, Sparkle,
   and Comet Trail. They are rendered through the shared custom-frame engine while Lighting Lab runs.
5. Turn Live Changes off, edit, then Apply. The physical effect should update. Turn Live Changes
   on and edit again without clicking Apply. Use the physical confirmation/repair controls if needed.
6. Save a named Lighting Lab profile, alter the effect, and Load Profile. Export/import JSON
   separately. For supported native settings choose Synapse Studio and check that the actual profile
   appears there; a saved archive without confirmed import is reported as pending.
7. Use Identify My Layout at any time. Broken keys do not time out or imply a smaller board;
   try the alternate guided key or confirm by sight. Key Issues stores unresponsive keys and optional
   alternate lighting triggers. These aliases do not remap Windows typing or repair a switch.
8. Choose Auto for a Razer portable player, or AL65 Firmware Mode with explicit whole-board
   approximation consent for the brother's wired AL65. Check the resulting file on the destination
   computer. Other brands, AL65 hardware operation, and power-cycle retention remain unverified.
6. For the AL65 export, explicitly choose its built-in lighting approximation, download the EXE,
   and run it on the Windows PC with the AL65 attached by cable. Follow its backup/restore
   instructions. Verify the physical result, exit, and power-cycle the keyboard to test persistence.

The brother's preference over bundled software remains the product acceptance gate. LAN reachability,
unknown keyboards, physical color, and AL65 firmware persistence are pending until directly tested.
