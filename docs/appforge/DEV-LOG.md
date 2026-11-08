# Lighting Lab: AppForge development log

**Pass:** full audit, readability, commenting, and first-run polish · **Date:** 2026-10-20 ·
**Version:** 0.2.0 → 0.3.0 · **Operator:** Claude Code (Opus) at the owner's request, with all improvements
pre-approved · **Companion:** [ISSUES-LOG.md](ISSUES-LOG.md) (every defect with root cause and verification).

The goal, in the owner's words: get a visitor from *"oh that seems cool"* to *"holy shit, my keyboard does exactly
what I want and it only took a couple minutes"*. Every decision below is judged against that.

---

## 0. Environment (for reproduction)

| Item | Value |
| --- | --- |
| OS | Windows 10 Home 10.0.19045 |
| Node / npm | v24.19.0 / 11.17.0 (project requires ≥ 22) |
| Shells | Git Bash (POSIX) and Windows PowerShell 5.1 |
| Browser for tests | Microsoft Edge (headless, via CDP) |
| C# compiler | `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (ships with Windows) |
| Hardware present | Razer BlackWidow Elite + Razer Synapse 3 / Chroma SDK (reachable at `localhost:54235`) |
| Formatter | Prettier 3.3.3 via `npx` (no install; zero runtime dependencies kept) |
| Git | `main` @ `eff3706`, `core.autocrlf=true`, remote `github.com/jameseby21/Lighting-Lab` |

**Starting state:** 7 files had uncommitted owner work-in-progress (running-app discovery, local activity
telemetry, live-edit "unchanged" behavior). Before touching anything it was saved as a patch:
`git diff > <scratchpad>/wip-before-audit.patch` (67,614 bytes). The pass builds on top of that WIP and does
not commit; the owner decides how to commit/split.

---

## 1. Reconnaissance: read everything first

Commands: `git ls-files`, `git status`, `git log --oneline`, `git diff`, then a full read of every tracked file
(server, UI, renderer, providers, stores, export, PowerShell, C#, tests, docs).

Inventory (pre-pass, `wc -l`): 5,117 lines total. Code was written in a dense, minified style:
`styles.css` 21 lines, `ui.js` 405 lines with 300–900-character lines, `server.cjs` 418.

**Architecture understood** (now written up in [../ARCHITECTURE.md](../ARCHITECTURE.md)): browser editor →
local Node server → Razer Chroma REST SDK, with one shared renderer (`effects.js`) for preview and hardware; PowerShell
helpers for device detection, app monitoring, global keys and Synapse UI automation; a C# portable player
compiled on demand.

## 2. Baseline (before any change)

| Check | Command | Result |
| --- | --- | --- |
| Unit + API | `npm test` | **64/64 pass**, 0.94 s |
| Real browser | `npm run test:browser` | **78 checks pass** (headless Edge); screenshots in `.artifacts/browser/` |

The desktop screenshot was then *looked at* as a first-time user would. It immediately showed `�` characters
(LL-001), duplicated controls, and mismatched vocabulary (LL-023). A test suite that passes while the screen
shows `3.5�` is the first lesson of this pass: **test the pixels someone sees, not only the behavior.**

Renderer cost was measured before deciding on any performance work:
`node -e "…200 × Effects.frame(sel, t, 10 events)…"` → **1.0 ms per full 6×22 frame**. That's fine at 22 fps,
so only the O(n²) group normalization (LL-025) was changed.

## 3. Encoding repair (LL-001…LL-004)

1. Counted non-ASCII characters per file with Python (`collections.Counter`). `ui.js` had 15× U+FFFD, `server.cjs`
   one `â€™`, and several files had BOMs.
2. `git log -S'·' -- ui.js` + `git show f78afc9:ui.js` showed the first commit was clean and `82adcf1` was the
   corrupting commit.
3. Listed every non-ASCII character in `git show b1f907d:ui.js` with context, then replaced each U+FFFD **in order**
   with its recovered original (`······×··×·…—“”`). Nothing was guessed.
4. Broadened the browser-test guard to all served files.
5. *Tooling error:* the first two attempts to edit the guard line failed (see LL-T02). The heredoc layer turned
   `\ufffd`/`\\` into other text. Solved with a scratch Node script that builds backslashes via
   `String.fromCharCode(92)`.

## 4. Readability baseline: formatting (LL-007, LL-008, LL-026)

1. Added `.prettierrc.json`, `.prettierignore` (keeps `portable/al65-definition.json` byte-identical as published
   evidence; leaves hand-wrapped prose alone), `.editorconfig`, `.gitattributes`.
2. `npx --yes prettier@3.3.3 --write` over all JS/CJS/HTML/CSS/JSON: 2,600 dense lines → ~7,400 readable ones.
3. Re-ran tests: unit 63/64. One failure was a test that asserted *source text* of `synapse-profile.cjs`, which
   Prettier had spaced differently. I replaced it with a behavioral test of the real argv (LL-008), then got 64/64.
   Browser 78/78.

## 5. Bug hunt and fixes, server side

Each fix got a regression test in the same step. The order follows discovery.

- **LL-010 (S1):** while timing the app probe in PowerShell (`Measure` over 3 runs = **528 ms** each), the output
  listed `Code.exe` only, although `explorer.exe` was also requested. Reproduced through Node with the exact server
  argv and confirmed: PowerShell `-File` drops extra values for `[string[]]`. **Every multi-app rule set since the
  feature shipped only watched the first app.** Rewrote `app-profile-monitor.ps1` (comma-joined `-AppNames`,
  `-Watch` streaming mode, no `$matches` misuse) and verified all three modes against the real OS.
- **LL-015:** a new `createWindowsAppProbe(execFile, spawn)` keeps one `-Watch` child per rule set.
- **LL-011, LL-016:** polling now starts on `listening`, has an in-flight guard, forgets the active rule when nothing
  matches, and uses non-forced activation for automatic switches.
- **LL-012, LL-013:** default bind `127.0.0.1`, `--lan`, `--open`; `isAllowedHost()` DNS-rebinding guard.
- **LL-009:** `startLightingLab(argv)` handles `EADDRINUSE` by probing `/api/status` ("already running"); `openBrowser()`
  uses `cmd /c start "" url` with an argument array (no shell string).
- **LL-017, LL-018, LL-019, LL-022:** selected-device verification, injected platform, audit rotation at 2 MB, profile
  delete + friendly missing-profile error.
- **LL-020:** mouse frames sample the composed background group (+ anchor glow).

Tests added in `tests/server.test.cjs`: profile delete; DNS rebinding (raw `http.request` with a forged Host);
selected-device verification; return-to-app re-apply; app-probe argv/watcher reuse/staleness/restart/stop;
stopped-probe race. In `tests/engine.test.cjs`: native select argv; mouse sync on static looks. In
`tests/launcher.test.cjs`: CRLF/version-gate/`--open`; "second launch reports the running copy". After this phase:
**73/73**.

## 6. Real-machine smoke test (no lighting changes)

Script: `<scratchpad>/real-smoke.cjs`. It starts the real server code with a temporary state folder, pre-seeded with
4 rules (`explorer.exe`, `Code.exe`, `node.exe`, `DefinitelyNotRunning.exe`) that point at a **non-existent profile ID**.
App Profiles therefore probes real processes but `resolveRule()` can never switch, and no `/api/apply` is sent.

Observed:
```
sdkAvailable: true               (real Chroma REST discovery, 53 ms)
first /api/app-profiles:  4 apps, correct running flags (one-shot while the watcher starts)
second call after 4 s:    5 ms   (served by the -Watch process; previously ~530 ms)
forged Host header:       403
```
An immediate count then showed one `app-profile-monitor` PowerShell still alive; a re-check showed 0 (LL-T04).
Investigating it exposed a real race (a poll in flight during `stop()` could start a new watcher), which is now
latched and tested.

## 7. Bug hunt and fixes, client side

- `ui.js`: precomputed physical IDs (LL-025); debounced `setup-changed` telemetry (LL-019); one vocabulary
  (LL-023); friendly controller names; the export hint derived from capabilities (LL-024); a server-down
  message that names the launcher; a Delete profile button with confirmation (LL-022); removed the duplicated
  paint-mode options (LL-030); `controlScope.reason` (LL-028).
- `index.html`: honest onboarding copy about Live changes (LL-006), real paint-mode options, a Delete button,
  and group help text.
- `styles.css`: `.profile-actions` so Delete didn't reflow the profile row.
- Browser test: added the delete flow (with a fixture route and `window.confirm` stubbed) → **79 checks**.

## 8. Portable player (LL-021)

Rewrote `portable/ChromaPreset.cs` readably: all reaction modes, per-group mode/color, legacy compatibility,
extra self-test checks. `npm run build:portable` → AL65 exe 57,344 bytes, 287 self-checks; Auto exe 131,584 bytes,
1,055 self-checks; `realHidWrites: 0`.

## 9. Project plumbing

- `package.json` 0.3.0: license, repository, keywords; scripts `start` (`--open`), `start:lan`, `serve`, `test:all`,
  `build:portable`, `check:*`, `format`, `format:check`.
- `.github/workflows/ci.yml` (Windows, Node 22) and `.github/ISSUE_TEMPLATE/bug_report.md`.
- The launcher rewritten with CRLF endings and a Node-version gate.
- `restart-chroma.ps1` path and naming fixes (LL-014), AST parse-checked.

## 10. Documentation

- New `README.md` (pitch → 2-minute setup → App Profiles → support matrix → phone → privacy → buttons → developers
  → limits), `QUICKSTART.md`, `docs/TROUBLESHOOTING.md` (organized by what the Ready check says),
  `docs/ARCHITECTURE.md` (mermaid diagram, file table, flows, security, state, testing layers).
- `docs/STANDALONE-HANDOFF.md` → `docs/history/` (the migration it planned is complete); `VALIDATION.md` labelled
  historical.

## 11. Commenting pass

Split across six parallel workers with **disjoint file ownership** so no two edited the same file. The rule:
*comments only; code byte-identical except formatter re-wrapping; real bugs reported, not silently fixed*.

| Worker | Files |
| --- | --- |
| A | `server.cjs` |
| B | `ui.js` |
| C | `core.js`, `effects.js`, `layout-guide.js`, `lighting-domain.cjs` |
| D | `providers/chroma-sdk.cjs`, `device-profile.cjs`, `profiles.cjs`, `app-profiles.cjs`, `control-verification.cjs`, `synapse-profile.cjs`, `export.cjs` |
| E | `index.html`, `styles.css`, `global-input.ps1`, `synapse-control.ps1`*, `save-native-profile.ps1`* |
| F | `portable/PhysicalInput.cs`, `portable/PresetRunner.cs`, `tools/NativeChromaDiagnostic.cs`, `tests/*` |

\* comment lines only, no reflow: `tests/engine.test.cjs` asserts exact substrings of `synapse-control.ps1`.

Results are recorded in §12.

## 12. Commenting results

Every worker verified "comments only" mechanically rather than by eye: two compared esbuild/terser-minified
before/after builds byte-for-byte, two diffed with comment lines stripped, the CSS worker compared rules with
comments removed, and the C# worker re-ran both portable self-tests. Line counts after the pass: `server.cjs`
790 → 1,557, `ui.js` 2,137 → 2,804, and the code-file total is 12,718 lines (from 5,117 dense lines before
formatting).

What each file now carries: a large header (purpose, position in the architecture, inputs/outputs, on-disk state,
safety rules), JSDoc / `///` on every function, section banners with a table of contents in the long files, route
tables, protocol notes (Chroma REST lifecycle, VIA HID report layout, the WH_KEYBOARD_LL hook), and inline notes on
every magic number.

**The workers also found bugs** while reading closely. These became LL-035 … LL-053. The two serious ones:
- **LL-035, XSS** via imported share links: fixed with `sanitizeGroupSettings()` and a hostile-payload browser check.
- **LL-051, Matrix dark after ~11 min**: fixed with a periodic cycle table. Equivalence-tested against the old code
  (0 mismatches over 10 minutes) and checked out to 600 minutes.

Each was confirmed (several with a proof script) before fixing; see ISSUES-LOG for each.

## 13. Final verification (all on the development PC)

| Check | Command | Result |
| --- | --- | --- |
| Formatting | `npm run format:check` | All files clean |
| Syntax | `node --check` on every JS/CJS | 0 failures |
| Unit + API (fake devices) | `npm test` | **77 / 77 pass** (64 at start) |
| Real browser | `npm run test:browser` | **80 checks pass**, 3 consecutive runs (78 at start) |
| Portable build | `npm run build:portable` | AL65 287 and Auto 1,055 self-checks, `realHidWrites: 0` |
| Native diagnostic | `npm run test:native-diagnostic` | ok, `nativeCalls: 0`, `rgbWrites: 0` |
| PowerShell parse | AST `ParseFile` on every `.ps1` | 0 errors |
| Real machine smoke | `<scratchpad>/real-smoke.cjs` | Chroma reachable; 4/4 rule apps reported; watcher-served check **3 ms**; forged Host → 403; 0 leftover processes |
| Watcher crash safety | hard-kill the parent `node` | watcher exits by itself within 1 s |

**Flake observed and fixed:** one browser run (right after the CPU-heavy C# compiles) failed the very first check,
which needs the white flash within ~200 ms of a keypress. The check now also accepts a recorded key event (its real
purpose: a focused button must not swallow the key), and the visual flash is still asserted later in the run.

**Self-inflicted failure, caught by the suite:** the new XSS browser check restored a hostile setup whose invalid
effect correctly fell back to Rainbow Road, and that changed the final live request that a later "latest edit wins"
assertion expects to be Matrix. The check now restores the previous setup when it finishes.

**Not verified here (needs a person or hardware):** `--open` actually launching the default browser (the exact
command line is proven with `echo` and unit-tested, but no tab was opened, to avoid driving live lighting on the
owner's keyboard); the visual result on the physical keyboard; AL65 hardware; LAN/phone use (LL-031).

## 14. Hand-off checklist for the owner

1. Review and commit. Suggested split: (a) your pre-existing WIP (the backup patch shows exactly what it was),
   (b) formatting-only, (c) fixes + tests, (d) comments, (e) docs/CI. Or one "0.3.0 audit" commit.
2. Push, and confirm the first GitHub Actions run is green on `windows-latest`.
3. Behavior change to know about: the **default bind is now 127.0.0.1**. The phone workflow needs `npm run start:lan`.
4. Five-minute physical acceptance: double-click the launcher (browser opens by itself) → pick Matrix → confirm the
   keys → leave it 15 minutes (LL-051) → add two App Profile rules for two different apps and alt-tab between them
   (LL-010/016).
5. Open items: LL-031 (LAN reports), LL-033 (AL65 hardware), LL-048 (Razer mouse detection in the portable player).

## Reproducing this pass on a clean machine

```powershell
winget install OpenJS.NodeJS.LTS
git clone https://github.com/jameseby21/Lighting-Lab.git; cd Lighting-Lab
npm test                 # 77 pass, no hardware touched
npm run test:browser     # needs Microsoft Edge or Chrome (or LIGHTING_LAB_BROWSER)
npm run build:portable   # needs Windows .NET Framework 4.x (present by default)
npm start                # opens http://localhost:4318
```

---

# Second pass (2026-10-20, later the same day)

**Requests from the owner:** (1) a *simple* mode ("literally just the live keyboard preview plus our pre-selection
options") that expands into a *fancy* mode with every control; (2) "matrix is still acting weird: sometimes it skips
over 1 or 2 rows, sometimes it stalls a bit, sometimes it doesn't look right going from the function keys to the
number row"; (3) implement what the `lighting-lab-redesign.zip` mockups show but the app doesn't have yet. The
session hit a usage limit mid-pass; the owner asked for the pending work to be wrapped up properly, which is this
section.

## P2-1. Reading the redesign pack (untrusted input handled as data)

`D:\Downloads\lighting-lab-redesign.zip` (16 MB) was extracted into a fresh scratch folder and only *read*:
3 screen mockups (main editor, App Profiles, brand sheet), SVG/PNG logos, and a demo animation. Gap inventory
(mockup vs. app) → built list in ISSUES-LOG LL-060…LL-063, with the deliberately skipped items and reasons in LL-068.

## P2-2. Matrix investigation: measure first

1. **Geometry check:** a script compared each switch's Chroma grid row with its drawn row for every model →
   mismatches on 65%/60%/AL65/75%/ISO (LL-054). Full-size had none, so the owner's full-size symptoms had to be timing.
2. **Real latency on this PC (read-only):** 60 GETs to the Chroma discovery URL → p50 16.6 ms, max 57 ms;
   `setInterval(46)` → p50 47.3 ms.
3. **Hardware harness** (`tests/measure-matrix-cadence.cjs`): the real provider + a fake Chroma with that latency
   profile; it records which row each delivered frame shows → dwell 141–302 ms with mouse sync (LL-055).
4. **Preview harness** (`tests/measure-preview-cadence.cjs`): real headless Edge + per-animation-frame sampling →
   200/250 ms alternation; 9 double-row frames on AL65.
5. **Fixes,** each re-measured: physical rows (`physicalRowOf`); frame dedupe + 23 ms tick + 40 ms min gap; precise
   step wake-up (`nextStepAt`); mouse/heartbeat off the critical path; display-time rendering; preview every frame.
   The first pacing attempt (dedupe only) improved request count 416 → 73 but not timing; the lateness metric added
   to the harness showed the remaining error was tick granularity, which led to the precise wake-up. The final
   before/after table is in LL-055.
6. **Real-world cause found during verification (LL-056):** a forgotten pre-audit server (since Oct 19, `0.0.0.0`)
   was still streaming Stars & Stripes alongside the current one: two Chroma apps on one keyboard. Not touched (the
   owner's process). The launcher bug that allowed it was fixed (LL-065).

## P2-3. Parallel build plan

- **Backend worker** (fork, fixed API contract, owned `server.cjs`/`app-profiles.cjs`/`app-profile-monitor.ps1`/
  `providers/chroma-sdk.cjs`/`profiles.cjs` + its own tests): Full screen + Time of day conditions, default profile,
  `/:id/update`, settings in responses, real crossfade, brand asset routes. Result: 92/92 tests; full-screen `true`
  path not observable without a full-screen app (LL-067).
- **Coordinator (UI + renderer):** strength/Protect in `effects.js`, `lighting-domain.cjs` and `ChromaPreset.cs`;
  page restructure (Stage / Presets / Workspace) with `data-fancy`/`data-simple`; header/footer brand; paint pills;
  preview chips; matrix + inspector; App Profiles UI; styles.

## P2-4. Notable mistakes and how they were caught

- The restructure script's first cut ended at the wrong `</div>` → restored from a backup copy made immediately
  before; every id then verified to occur exactly once.
- A test asserted a cross-group ripple using a key-local reaction → test corrected, not the code.
- New visitors now start in Simple mode, which hid the onboarding's focus target → the browser test now asserts the
  Simple experience first and then switches to All controls (the guide is fancy-only by design).
- The XSS check from pass 1 and the new checks were placed so the final "latest edit wins" assertion still sees Matrix.
- Shell-tool truncation of a long CSS heredoc (LL-T07) and Windows path forms in a harness (LL-T08).
- Screenshot review exposed LL-064 (`[hidden]` overridden), present since before the audit.

## P2-5. Final verification (pass 2)

| Check | Result |
| --- | --- |
| `npm run format:check` | clean |
| `npm test` | **93/93** (includes the new launcher coexistence test) |
| `npm run test:browser` | **96** checks, 2 consecutive runs |
| `npm run build:portable` | AL65 287, Auto 1,055 self-checks, 0 HID writes |
| `npm run test:native-diagnostic` | ok |
| PowerShell AST parse (5 scripts) | 0 errors |
| Real-machine smoke | Chroma reachable; 4/4 apps with `fullscreen` flag; watcher-served check 6 ms; Host guard 403 |
| Screens (`tests/capture-screens.cjs`) | simple desktop, all controls, App Profiles, phone: reviewed |

## P2-6. For the owner

1. **Close the old Lighting Lab** (PID 62588, started Oct 19, bound to `0.0.0.0:4318`). With two copies, the
   keyboard alternates between them. Then restart yours once so it picks up this pass's code.
2. Five-minute physical check: Matrix for 15 minutes (smooth row steps, no skips); a Full-screen rule with a game
   (LL-067); a two-app rule set with a 1 s crossfade.
3. Commit split suggestion: pass-1 audit, Matrix timing (LL-054/055/065), redesign UI (LL-062/063/064),
   App Profiles backend (LL-060/061).
