# Lighting Lab architecture

Snapshot of `main` at commit `eff3706` (2026-10-19), version 0.2.0 in `package.json`. Written from the source; nothing here is planned work unless it says "planned". Each Mermaid block below also has a `.mmd` source and an `.svg` render in [`architecture/`](architecture/): `infrastructure`, `functionality`.

## Summary

Lighting Lab is a local keyboard lighting editor for Windows. You start a small Node.js server on the PC that has the keyboard attached, open `http://localhost:4318` in a browser, pick a preset, and paint three key groups (Anchor, Background, Orientation). Each group gets a base color, a moving effect and a key-press reaction. The same JavaScript renderer draws the browser preview and the frames sent to the keyboard. On Razer hardware the server streams those frames to the Razer Chroma SDK REST service, and can also save named profiles, write a native profile into Razer Synapse Studio by driving its window, and switch profiles when a chosen app is running. The page can export a setup JSON, a share link, or a small Windows `.exe` that plays the preset on another PC: an "Auto" player for Razer keyboards, or a whole-board firmware preset for a wired YUNZII AL65. Nothing is uploaded; feedback stays in the browser unless the user downloads it or opens a prefilled GitHub issue. There is no CI, no installer and no cloud service. Per-device routing when several keyboards are attached, sensor-driven effects, and power-cycle persistence are open questions in `docs/STANDALONE-HANDOFF.md`, not built features.

## Infrastructure

Every runtime piece and where it runs. Solid arrows are data or control flow; dotted arrows are user hand-offs or test traffic.

```mermaid
flowchart LR
  subgraph HOST["Server PC: Windows, keyboard attached by USB"]
    direction TB
    LAUNCH["Start Lighting Lab.cmd<br/>Windows batch launcher"]
    subgraph BROWSER["Browser on the server PC: Edge / Chrome"]
      UI["index.html + ui.js + core.js<br/>effects.js + layout-guide.js<br/>vanilla JS, no build step"]
      LS[("localStorage<br/>setup, onboarding, feedback")]
    end
    SERVER["server.cjs<br/>Node.js 22+ node:http server<br/>port 4318, bind 0.0.0.0"]
    subgraph MODULES["Server modules: CommonJS"]
      CHROMA["providers/chroma-sdk.cjs<br/>Chroma REST client + frame loop"]
      DETECT["device-profile.cjs<br/>keyboard identity via Get-PnpDevice"]
      STORES["profiles.cjs, app-profiles.cjs<br/>control-verification.cjs"]
      EXPORT["export.cjs<br/>preset .exe builder"]
      NATIVE["synapse-profile.cjs<br/>native Synapse profile adapter"]
    end
    subgraph PS["Windows PowerShell helpers"]
      GI["global-input.ps1<br/>user32 keyboard hook"]
      APM["app-profile-monitor.ps1<br/>running / foreground .exe check"]
      SC["synapse-control.ps1<br/>UI Automation of Synapse"]
      SNP["save-native-profile.ps1<br/>build .ChromaEffects archive"]
      RC["restart-chroma.ps1<br/>admin service restart"]
    end
    subgraph RAZER["Razer software, installed separately"]
      REST["Razer Chroma SDK REST<br/>localhost:54235"]
      SYN["Razer Synapse 3<br/>Studio + Chroma Apps"]
    end
    CSC["csc.exe<br/>.NET Framework 4.x compiler"]
    STATE[(".artifacts/lighting-lab/<br/>audit.jsonl, profiles/, app rules,<br/>control-verification.json")]
    TEMPL[("LIGHTING_LAB_NATIVE_DIRECTORY<br/>private Synapse templates<br/>not in repo")]
  end
  KB["Razer keyboard + optional mouse"]
  PHONE["Phone or other PC browser<br/>same LAN, unverified"]
  subgraph TARGET["Destination Windows PC"]
    EXEA["Lighting-Lab-Auto .exe<br/>ChromaPreset.cs + RzChromaSDK64.dll"]
    EXEB["AL65 runner .exe<br/>PresetRunner.cs, hid.dll"]
    AL65["YUNZII AL65<br/>wired, VIA HID"]
    TKB["Razer keyboard on that PC"]
  end
  subgraph DEV["Build, test, hosting"]
    TESTS["node --test tests/*.test.cjs, mocked providers<br/>+ tests/check-*.cjs against a live server"]
    BCHK["tests/browser-check.cjs<br/>headless Edge via DevTools protocol"]
    GH["GitHub jameseby21/Lighting-Lab<br/>source + issue drafts, no CI"]
  end

  LAUNCH -->|starts| SERVER
  LAUNCH -->|opens localhost:4318| UI
  UI <-->|"HTTP JSON /api/*"| SERVER
  PHONE -->|"HTTP :4318"| SERVER
  UI --> LS
  SERVER --> CHROMA
  SERVER --> DETECT
  SERVER --> STORES
  SERVER --> EXPORT
  SERVER --> NATIVE
  CHROMA -->|"REST frames, heartbeat"| REST
  REST -->|lighting| KB
  SERVER -->|spawn| GI
  GI -->|key-down IDs on stdout| SERVER
  SERVER -->|execFile| APM
  SERVER -->|execFile| SC
  SC -->|UI Automation| SYN
  NATIVE -->|execFile| SNP
  TEMPL --> SNP
  SNP -->|archive import| SYN
  SYN -->|saved profile| KB
  RC -->|restart services| REST
  STORES -->|JSON files| STATE
  SERVER -->|audit lines| STATE
  EXPORT -->|C# sources + preset.json| CSC
  CSC -->|.exe download| UI
  UI -.->|user copies .exe| EXEA
  UI -.->|user copies .exe| EXEB
  EXEA -->|"Chroma native SDK"| TKB
  EXEB -->|VIA HID report| AL65
  UI -.->|prefilled issue link| GH
  TESTS -.->|HTTP checks| SERVER
  BCHK -.->|fixture server| UI
```

Notes:

- The server writes all local state under `.artifacts/lighting-lab/` (ignored by Git). Override with `LIGHTING_LAB_STATE`.
- Live effects need the server to keep running. Closing it releases the keyboard back to Synapse.
- A browser on another PC controls the keyboard attached to the server PC, not its own.

## Functionality

Features and the code that implements them. Arrows show the usual order a user moves through.

```mermaid
flowchart TB
  subgraph START["Getting started"]
    QS["First-run guide, 3 steps<br/>index.html #quickstart, ui.js"]
    GAL["Preset gallery, 12 looks<br/>ui.js + effects.js"]
    MODEL["Keyboard model view, 17 models<br/>core.js modelCatalog"]
    IDL["Identify My Layout<br/>layout-guide.js"]
    DEVSEL["Detect and pick keyboard<br/>GET /api/device, device-profile.cjs"]
  end
  subgraph EDIT["Edit in the browser"]
    GROUPS["Anchor / Background / Orientation groups<br/>ui.js, lighting-domain.cjs"]
    LAYERS["Base color + effect + reaction per group<br/>effects.js, core.js renderer"]
    TESTR["Test reactions in preview<br/>ui.js"]
    GLOBAL["Global key feedback<br/>POST /api/input, global-input.ps1"]
    GEOM["Customize view geometry<br/>ui.js #edit-geometry"]
    CAPS["Keycap word planner<br/>ui.js, effects.js"]
    ISSUES["Key Issues: broken-key aliases<br/>ui.js"]
  end
  subgraph CONTROL["Drive the hardware"]
    LIVE["Live changes<br/>POST /api/apply, chroma-sdk.cjs"]
    APPLY["Apply, forced fresh session<br/>POST /api/apply"]
    MOUSE["Mouse sync<br/>chroma-sdk.cjs mouse frame"]
    CONFIRM["Did the lights change?<br/>POST /api/control-verification"]
    REPAIR["Retry Chroma connection<br/>POST /api/repair, synapse-control.ps1"]
    REL["Release control<br/>POST /api/release"]
    STATUS["Ready check + diagnostics<br/>GET /api/status, /api/diagnostics"]
  end
  subgraph KEEP["Save, share, automate"]
    PROF["Save / load profile<br/>/api/profiles, profiles.cjs"]
    NATIVEP["Save into Synapse Studio<br/>synapse-profile.cjs, save-native-profile.ps1"]
    APPP["App profiles: switch by running app<br/>/api/app-profiles, app-profiles.cjs"]
    JSON["Export / import setup JSON<br/>ui.js, browser only"]
    SHARE["Copy share link, URL fragment<br/>ui.js readShareLink"]
    FB["Feedback: local, download, GitHub issue draft<br/>ui.js"]
  end
  subgraph EXPORTS["Portable export"]
    CAP["Export capability check<br/>GET /api/export/capabilities"]
    EXE["Download .exe, Auto for Razer<br/>export.cjs, portable/ChromaPreset.cs"]
    AL["AL65 firmware preset<br/>portable/PresetRunner.cs, al65-definition.json"]
  end

  QS --> GAL --> GROUPS
  DEVSEL --> MODEL
  MODEL --> GROUPS
  IDL --> MODEL
  GROUPS --> LAYERS
  LAYERS --> TESTR
  TESTR --> GLOBAL
  LAYERS --> LIVE
  LAYERS --> APPLY
  APPLY --> CONFIRM
  CONFIRM -->|unchanged| REPAIR
  LIVE --> MOUSE
  LAYERS --> PROF
  PROF --> NATIVEP
  PROF --> APPP
  LAYERS --> JSON
  LAYERS --> SHARE
  CONFIRM -->|confirmed| FB
  LAYERS --> CAP
  CAP --> EXE
  CAP --> AL
```

HTTP routes (all in `server.cjs`): `/api/status`, `/api/device`, `/api/diagnostics`, `/api/apply`, `/api/release`, `/api/repair`, `/api/key-press`, `/api/input`, `/api/control-verification`, `/api/profiles` (+ `/:id`, `/:id/load`, `/:id/archive`), `/api/app-profiles` (+ `/config`, `/refresh`, `/:id/toggle|delete|move|test`), `/api/export/capabilities`, `/api/export/executable`. Static files are served from a fixed allowlist (`index.html`, `ui.js`, `core.js`, `effects.js`, `layout-guide.js`, `styles.css`).

## Tech stack

| Layer | Technology and version | Where it's configured |
| --- | --- | --- |
| Runtime | Node.js 22 or newer; no npm dependencies, no lockfile | `package.json` (`engines.node: ">=22"`) |
| Web server | Node `node:http`, port 4318, bind `0.0.0.0`; env `LIGHTING_LAB_PORT`, `LIGHTING_LAB_HOST`, `LIGHTING_LAB_STATE`, `LIGHTING_LAB_NATIVE_DIRECTORY` | `server.cjs` |
| Browser UI | Plain HTML, CSS and JavaScript, no framework or bundler | `index.html`, `styles.css`, `ui.js`, `core.js`, `effects.js`, `layout-guide.js` |
| Shared renderer | `core.js` (key geometry, 17-model catalog), `effects.js`, `lighting-domain.cjs` | same files |
| Live lighting | Razer Chroma SDK REST API at `http://localhost:54235/razer/chromasdk`, registered as "Jeby Lighting Lab" | `providers/chroma-sdk.cjs` |
| Native profiles | Razer Synapse 3 at its default install path; `.ChromaEffects` archives built from private local templates | `synapse-control.ps1`, `save-native-profile.ps1`, `synapse-profile.cjs`, `docs/native/README.md` |
| Windows helpers | Windows PowerShell (`powershell.exe -ExecutionPolicy Bypass`) with inline C# via `Add-Type` (user32 hook, UI Automation) | `global-input.ps1`, `app-profile-monitor.ps1`, `synapse-control.ps1`, `restart-chroma.ps1`, `device-profile.cjs` |
| Device detection | `Get-PnpDevice -PresentOnly -Class Keyboard` | `device-profile.cjs` |
| Executable export | .NET Framework 4.x `csc.exe` (`v4.0.30319`), references `System.Web.Extensions.dll` | `export.cjs` |
| Portable players | C#: `RzChromaSDK64.dll` (Razer), `hid.dll` + `setupapi.dll` (AL65 VIA HID, definition `AL65_QMK_V0101_20241025`, VID 4D4B / PID 3068) | `portable/ChromaPreset.cs`, `portable/PresetRunner.cs`, `portable/PhysicalInput.cs`, `portable/al65-definition.json` |
| Diagnostics tool | C# native Chroma diagnostic, built by a test script | `tools/NativeChromaDiagnostic.cs`, `tests/build-native-diagnostic.cjs` |
| Tests | `node:test` (8 test files); headless Edge or Chromium via the DevTools protocol (`LIGHTING_LAB_BROWSER`) | `package.json` scripts, `tests/` |
| Launcher | Windows batch file that checks for Node and opens the browser | `Start Lighting Lab.cmd` |
| CI | None | none |
| Hosting | Public GitHub repo `jameseby21/Lighting-Lab`; the app itself runs only on the user's PC | `.git/config` |
| License | See `LICENSE` | `LICENSE` |

## Brand assets in this repo

No image, logo, icon or favicon files are tracked. The brand is drawn in markup and CSS:

| Asset | Path | Format | Light / dark | Where displayed |
| --- | --- | --- | --- | --- |
| "ll•" mark | `index.html` (`span.mark` in the header), styled by `.mark` in `styles.css` | HTML text + CSS (purple tile, green dot) | Dark only (`color-scheme: dark`) | Top-left of the page header |
| Wordmark "Lighting Lab / by jeby Labs" | `index.html` header and footer | HTML text | Dark only | Header and footer |
| Page title "Lighting Lab · jeby Labs" | `index.html` `<title>` | Text | n/a | Browser tab |
| Theme color `#101219` | `index.html` `<meta name="theme-color">` | Meta tag | Dark | Mobile browser chrome |
| Vendor app name "Jeby Lighting Lab", author "jeby Labs" | `providers/chroma-sdk.cjs` (`APP_TITLE`) | String sent to the Chroma SDK | n/a | Synapse's Chroma Apps list |

There is no favicon: the page has no `<link rel="icon">` and the server's static allowlist has no `/favicon.ico`, so browsers get a 404 and show a default icon. Exported `.exe` files are compiled without `/win32icon`, so they carry the default Windows program icon. Nothing rotates between variants.

## Where this file should live

Recommended path: `docs/ARCHITECTURE.md`. The repo already keeps long-form docs in `docs/` with upper-case names (`DESIGN.md`, `RESEARCH-EXPORT.md`, `STANDALONE-HANDOFF.md`, `VALIDATION.md`).

Registration: add one link to it from `README.md` (for example under "Development chunks" or a short "Documentation" line). The repo has no AGENTS.md, CLAUDE.md, doc-link checker or CI, and no test reads `docs/`, so nothing else needs updating to keep checks green. The `.mmd` sources and `.svg` renders sit next to it in `docs/architecture/`; they are optional because GitHub renders the Mermaid blocks.

## Unclear

- unclear: `README.md` "Checks" lists `uv run ruff check .`, `uv run mypy src` and `uv run pytest`, but the repo has no Python code, `pyproject.toml` or `src/`. These look carried over from the parent repo.
- unclear: `restart-chroma.ps1` writes its log to `../../.artifacts/lighting-lab` relative to the script, which is two folders above this repo's root (a path from the earlier monorepo layout).
- unclear: `README.md` calls `docs/background/keyboard-layout/` "ignored", but `.gitignore` in this repo does not list it.
- unclear: the README's validation list numbers two steps "6"; the second one repeats the AL65 export check.
