# Lighting Lab architecture

Lighting Lab is a dependency-free Node.js server plus a vanilla-JavaScript browser editor. Its central design
choice: **the browser preview and the hardware frame are computed by the same renderer** (`effects.js`). What
you see on screen is what Lighting Lab sends to the keyboard, rather than an approximation of it.

```mermaid
flowchart LR
  subgraph Browser["Browser (localhost:4318)"]
    HTML[index.html + styles.css]
    UI[ui.js<br/>editor state, events,<br/>live-write queue]
    CORE[core.js<br/>switch IDs, Chroma grid,<br/>model layouts]
    FX[effects.js<br/>shared renderer]
    LG[layout-guide.js]
    UI --> CORE & FX & LG
  end

  subgraph Server["Node server (server.cjs)"]
    API[HTTP API + static allowlist<br/>Origin + Host guards<br/>serialize() queue]
    DOM[lighting-domain.cjs<br/>validateSelection<br/>frame builders]
    SDK[providers/chroma-sdk.cjs<br/>Chroma REST session,<br/>46 ms animation loop]
    DEV[device-profile.cjs]
    PROF[profiles.cjs]
    APPS[app-profiles.cjs]
    VER[control-verification.cjs]
    EXP[export.cjs]
    NAT[synapse-profile.cjs<br/>optional]
    API --> DOM --> FX
    API --> SDK & DEV & PROF & APPS & VER & EXP & NAT
  end

  subgraph Windows["Windows helpers (child processes)"]
    PS1[app-profile-monitor.ps1<br/>-Watch: 1 process, 1 line/s]
    PS2[global-input.ps1<br/>low-level key hook]
    PS3[synapse-control.ps1<br/>UI Automation]
    PNP[PnP keyboard query]
    CSC[csc.exe → portable .exe]
  end

  UI -- "fetch /api/*" --> API
  SDK -- "HTTP localhost:54235" --> CHROMA[(Razer Chroma SDK)]
  CHROMA --> KB[[Keyboard / mouse LEDs]]
  APPS -.-> PS1
  API -.-> PS2 & PS3
  DEV -.-> PNP
  EXP -.-> CSC
  API --> STATE[(.artifacts/lighting-lab<br/>profiles/, app-profiles.json,<br/>control-verification.json,<br/>audit.jsonl)]
```

## Files at a glance

| File | Runs in | Responsibility |
| --- | --- | --- |
| `index.html`, `styles.css` | Browser | Page skeleton and visual design (dark theme, responsive down to phone width). |
| `ui.js` | Browser | All editor behavior: painting key groups, presets, onboarding, live writes, profiles, App Profiles view, feedback. |
| `core.js` | Browser + Node | Physical switch IDs, the Chroma 6×22 grid coordinate of each switch, model catalog, layout geometry, `KeyboardEvent` → switch ID. |
| `effects.js` | Browser + Node | The renderer: base color → dynamic effect → reaction overlay, per key, per millisecond. Also builds a full Chroma frame. |
| `layout-guide.js` | Browser + Node | Untimed "Identify My Layout" interview → reference layout. |
| `server.cjs` | Node | HTTP API, static file allowlist, security guards, audit trail, App Profiles polling, process entry point (`--open`, `--lan`). |
| `lighting-domain.cjs` | Node | `validateSelection()`: the single trust boundary every setup passes before it reaches hardware. Keyboard and mouse frame builders. |
| `providers/chroma-sdk.cjs` | Node | One Razer Chroma REST session: register, heartbeat, frames, explicit Apply, recovery, release. |
| `device-profile.cjs` | Node | Which keyboards are *present right now* (Windows PnP ancestry), matched against known models. |
| `profiles.cjs` | Node | Named saved setups (`profiles/<uuid>.json`). |
| `app-profiles.cjs` | Node | App rule validation, first-match resolution, atomic `app-profiles.json` store. |
| `control-verification.cjs` | Node | What the *person* observed ("lights changed / unchanged") per keyboard model and provider. |
| `export.cjs` | Node | Builds the portable `.exe` (embedded JSON + C# compiled with Windows' `csc.exe`). |
| `synapse-profile.cjs`, `save-native-profile.ps1`, `synapse-control.ps1` | Node + PowerShell | Optional: native Synapse Studio profiles via local templates and UI Automation; Chroma Apps repair. |
| `app-profile-monitor.ps1` | PowerShell | Which configured apps are running / in front. Long-lived `-Watch` mode. |
| `global-input.ps1` | PowerShell | Opt-in global key reactions: streams physical key IDs only. |
| `portable/*.cs` | Standalone .exe | Razer frame player + AL65 VIA firmware writer, with backup/rollback and `--self-test`. |
| `restart-chroma.ps1` | PowerShell (admin) | Optional manual repair of Razer's SDK services. |

## Key flows

### 1. An edit becomes light

1. The user changes something; `ui.js` calls `changed()`.
2. `changed()` re-renders the board, saves the setup to `localStorage`, repaints the preview with
   `LightingEffects.sample()`, and calls `queueLiveUpdate()`.
3. `queueLiveUpdate()` keeps **one** pending setup (newest wins) and debounces 120 ms. `drainLiveUpdates()`
   sends it to `POST /api/apply`, one request at a time, so an older response can never overwrite a newer edit.
4. `server.cjs` audits the raw request, then `validateSelection()` normalizes it (unknown switch IDs, effects,
   colors, etc. are rejected), then the Chroma provider applies it inside the `serialize()` queue.
5. `chroma-sdk.cjs` renders `effects.frame()` every 46 ms while anything animates and `PUT`s it to the Chroma
   session, with a heartbeat every 1.5 s.
6. The UI says "acknowledged, check your keyboard". The person's Yes/No goes to `/api/control-verification`.

### 2. App Profiles

- On start, `server.cjs` polls once per second (with an in-flight guard).
- `createWindowsAppProbe()` keeps **one** `app-profile-monitor.ps1 -Watch` process per rule set. It prints
  one JSON line per second, so each poll reads memory instead of starting PowerShell (≈5 ms vs ≈530 ms, measured).
- `resolveRule()`: first enabled rule whose app matches its condition **and** whose profile still exists.
- A new match must persist for `waitMs` before switching. Switching reuses the normal profile activation.
  When nothing matches, the active rule is forgotten (lighting unchanged), so coming back re-applies it.

### 3. Download .exe

`export.cjs` validates the setup, pre-renders 128 frames (+ mouse frames) with `effects.js`, writes a JSON
manifest, and compiles `portable/*.cs` with that manifest embedded as a resource. The result runs on any
Windows PC with .NET Framework 4.x. A Razer PC plays the frames through Chroma; a wired YUNZII AL65 gets an
acknowledged built-in firmware mode, with a backup written first.

## Security & privacy boundaries

- **Bind:** `127.0.0.1` by default; `--lan` opts into all interfaces.
- **Cross-site:** `POST` with a foreign `Origin` → 403. **DNS rebinding:** a `Host` that isn't localhost, an IP
  literal, or this PC's name → 403.
- **Input:** bodies capped at 128 KB; every setup goes through `validateSelection()`; IDs are UUID-shaped
  before they become file names; child processes get argument arrays, never shell strings.
- **Static files:** a fixed allowlist of 7 paths; source, audit, and state are never served.
- **Privacy:** no typed text, window titles, or command lines are read or stored. Activity records allow only
  a short list of fields with safe characters (`normalizeClientActivity`).

## State on disk

All under `.artifacts/lighting-lab/` (git-ignored; override with `LIGHTING_LAB_STATE`):

| Path | Contents |
| --- | --- |
| `profiles/<uuid>.json` | `{id, name, software, updatedAt, settings}` |
| `app-profiles.json` | `{version:1, automatic, waitMs, transitionMs, rules:[{id,name,executable,condition,profileId,enabled}]}` |
| `control-verification.json` | Person-observed result per `model:provider` |
| `audit.jsonl` (+ `audit.1.jsonl`) | One JSON line per action/result; rotates at about 2 MB |
| `<uuid>.ChromaEffects` | Optional native Synapse archive for a native profile |

Browser `localStorage`: `lighting-lab-setup-v2` (current editor), `lighting-lab-onboarding-v1`,
`lighting-lab-feedback-v1`.

## Testing layers

| Layer | Command | Touches hardware? |
| --- | --- | --- |
| Unit + HTTP API (fake devices) | `npm test` | No |
| Real browser (headless Edge, fixture server) | `npm run test:browser` | No |
| Portable compile + self-test | `npm run build:portable` | No (zero HID writes, no SDK calls) |
| Live provider exercise | `npm run check:live -- --exercise` | **Yes**: temporarily changes RGB, then restores |
| Synapse Connect readback | `npm run check:connect` | Reads/navigates the Synapse UI; no RGB writes |

## Timing and motion (how a stepped effect stays smooth)

- **Rows are the rows you see.** Row-stepped effects (Matrix, Stars & Stripes) use `physicalRowOf()` in
  `effects.js`, which derives visible rows from the drawn layout (a new row starts ≥ 0.75u lower). The Chroma
  grid row is only used for cells without a switch. Matrix falls through exactly that many rows.
- **Hardware pacing** (`providers/chroma-sdk.cjs`): a 23 ms tick, but a keyboard frame is only sent when the
  picture changed (and at most every 40 ms). `effects.nextStepAt()` tells the provider when the next Matrix row
  / stripe flip / twinkle is due, and a one-shot timer fires then, minus the measured REST latency, so the frame
  lands on the boundary. Mouse frames and heartbeats run on ticks that sent no keyboard frame. Each frame is
  rendered for the moment it will reach the LEDs (now + smoothed latency).
- **Preview**: repaints on every display frame, skips keys whose color did not change, and uses
  `performance.now()` for both animation and key presses.
- **Crossfade**: an automatic App Profile switch passes `transitionMs`; for that long the provider blends the
  old setup's frame into the new one cell by cell, then drops the old setup. Manual Apply/Test/Load are instant.

## Editor modes and the group editor

- `body[data-mode]` is `simple` (keyboard + looks) or `fancy` (all controls). Elements marked `data-fancy` /
  `data-simple` are hidden by CSS; the choice is stored in `localStorage` (`lighting-lab-mode-v1`). In simple
  mode a key click always fires its reaction.
- Each group carries `base`, `color`, `dynamic`, `reaction`, `reactionColor`, plus optional
  `baseStrength` / `dynamicStrength` / `reactionStrength` (0–1) and `protect` (ignore reactions that start in
  another group). `validateSelection()` checks them; `effects.js` and `portable/ChromaPreset.cs` render them.
  Omitted fields reproduce the previous look exactly.

## App Profiles model

| Field | Meaning |
| --- | --- |
| `condition` | `running`, `foreground`, `fullscreen` (in front and covering its monitor), or `time` |
| `executable` | `Name.exe` for app conditions; `null` for `time` |
| `from`, `to` | `HH:MM` local time for `time` rules (wraps past midnight; equal = all day) |
| `defaultProfileId` | config-level "Everything else" profile, or `null` to keep the current lighting |

The first enabled rule whose condition matches and whose profile exists wins; otherwise the default applies.
`POST /api/app-profiles/:id/update` edits a rule in place. The UI's **Try it** chips run the same first-match
logic client-side, preview-only.
