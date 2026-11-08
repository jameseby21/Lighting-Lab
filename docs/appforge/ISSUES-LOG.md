# Lighting Lab: issues & errors log (AppForge case)

Every defect, papercut, environment error, and risk found during the October 2026 audit pass (v0.2.0 → v0.3.0).
Each entry records **what was seen**, **why it happened**, **what changed**, and **how it was verified**,
so the pass can be replayed and checked on a clean machine. The chronological story is in
[DEV-LOG.md](DEV-LOG.md).

**Status:** `fixed` (code changed and verified) · `mitigated` (risk reduced, residual noted) · `documented`
(known limit, written down for users) · `open` (needs hardware or an owner decision).
**Severity:** **S1** breaks the first-run promise or a headline feature · **S2** visible defect, misleading
message, or security hardening · **S3** papercut, hygiene, maintainability.

## Index

| ID | Sev | Area | Summary | Status |
| --- | --- | --- | --- | --- |
| LL-001 | S2 | UI text | 15 `U+FFFD` replacement characters in `ui.js` showed as `3.5�`, `Unrecognized keyboard � …` | fixed |
| LL-002 | S2 | Server text | Double-encoded apostrophe `Chromaâ€™s` in the multi-keyboard notice | fixed |
| LL-003 | S3 | Tests | Browser test printed `âœ“`; its mojibake guard covered only `index.html` | fixed |
| LL-004 | S2 | Docs | `QUICKSTART.md` first line contained a literal PowerShell `` `r`n`r`n `` | fixed |
| LL-005 | S3 | Docs | README listed monorepo-only checks (`uv run ruff/mypy/pytest`) and history before the pitch | fixed |
| LL-006 | S1 | UX copy | Onboarding promised "Nothing reaches your hardware until you apply it", but Live changes defaults on | fixed |
| LL-007 | S3 | Readability | Source was effectively minified (one-line functions, a 21-line stylesheet) | fixed |
| LL-008 | S3 | Tests | A test grepped source text and broke on harmless reformatting | fixed |
| LL-009 | S2 | Launcher | `.cmd` had LF endings, a blind 2 s sleep before opening the browser, and no Node version check | fixed |
| LL-010 | S1 | App Profiles | Only the **first** rule's executable was ever checked (PowerShell `-File` array binding) | fixed |
| LL-011 | S1 | App Profiles | Automatic switching did not resume after a restart until settings were changed | fixed |
| LL-012 | S2 | Security/UX | Default bind `0.0.0.0` → firewall prompt on first run + whole-LAN control | fixed |
| LL-013 | S2 | Security | No `Host` check → DNS-rebinding pages could drive the API | fixed |
| LL-014 | S3 | Scripts | `restart-chroma.ps1` logged two folders *above* the repo; `$event` shadowed `$Event` | fixed |
| LL-015 | S2 | Performance | App Profiles started a new `powershell.exe` every second (≈530 ms each) | fixed |
| LL-016 | S2 | App Profiles | Returning to an app didn't re-apply its profile; automatic switches forced a session re-register | fixed |
| LL-017 | S2 | Verification | "Lights changed?" answers were stored against the first-detected keyboard, not the selected one | fixed |
| LL-018 | S3 | Testability | `enableInput` checked `process.platform`, ignoring the injected `platform` | fixed |
| LL-019 | S2 | Disk/Privacy | Audit log grew forever, and the new activity telemetry posted on every slider tick | fixed |
| LL-020 | S2 | Mouse sync | Mouse went black for Solid Color / Subtle Keywords / Lights Out | fixed |
| LL-021 | S2 | Portable .exe | Only 3 of 11 reactions rendered; always white; per-group reactions ignored | fixed |
| LL-022 | S2 | Profiles | No way to delete a profile; a missing profile leaked `ENOENT … D:\path` to the UI | fixed |
| LL-023 | S3 | UI wording | Raw IDs shown (`— lighting-lab`); three names for the same key groups | fixed |
| LL-024 | S3 | Export | Hint said "Ghost" (UI says "Lights Out") and omitted Solid Color | fixed |
| LL-025 | S3 | Performance | `normalizeGroups()` was O(n²) on every preview frame | fixed |
| LL-026 | S3 | Repo hygiene | No `.gitattributes`/`.editorconfig`; CRLF warnings; stray BOMs | fixed |
| LL-027 | S3 | Process | No CI | fixed |
| LL-028 | S2 | UI | Multi-keyboard "same frame" warning never displayed (`detail` vs `reason`) | fixed |
| LL-029 | S3 | Scripts | `app-profile-monitor.ps1` assigned to PowerShell's automatic `$matches` | fixed |
| LL-030 | S3 | UI | Paint-mode options duplicated (stale ones in HTML, real ones injected by JS) | fixed |
| LL-031 | S2 | LAN | Owner-reported LAN timeout, `chromweb` error, and 401s | open |
| LL-032 | S3 | Hardware | Several Razer keyboards share Chroma's generic canvas | documented |
| LL-033 | S2 | Hardware | AL65 firmware export not yet run on a real AL65; power-cycle retention unverified | open |
| LL-034 | S3 | Synapse | `synapse-control.ps1` automation targets the Synapse 3 install path/UI | documented |
| LL-035 | S1 | Security | XSS: imported share links / setup JSON could inject markup via group colors into `innerHTML` | fixed |
| LL-036 | S2 | Import | Legacy (pre-groups) setups produced an invalid dynamic effect the server rejected | fixed |
| LL-037 | S2 | UI | "Keep anchor colors during reactions" reset on every restore of a current (v3) setup | fixed |
| LL-038 | S3 | App Profiles | The add-rule form cleared what you typed even when saving failed | fixed |
| LL-039 | S3 | UI copy | "No, Unchanged" message claimed live edits were paused for the provider (no longer true) | fixed |
| LL-040 | S3 | Accessibility | Keyboard handler for the file-picker label was assigned twice | fixed |
| LL-041 | S2 | Launcher | `--open` passed `""` as an argv element; Node escaped it, so `start` got a garbage title | fixed |
| LL-042 | S3 | Security | `Origin: null` POSTs returned 422 instead of 403 | fixed |
| LL-043 | S3 | Diagnostics | After audit rotation, diagnostics showed almost no history; a torn line hid all records | fixed |
| LL-044 | S3 | App Profiles | Rule toggle/move/delete used an index computed outside the store update (two-tab race) | fixed |
| LL-045 | S3 | Durability | `control-verification.json` was written non-atomically | fixed |
| LL-046 | S2 | Portable .exe | `--restore` on a PC with a Razer keyboard fell into the Razer player with a misleading error | fixed |
| LL-047 | S3 | Tests | The live hardware exercise never covered the `flame` reaction | fixed |
| LL-048 | S3 | Portable .exe | Razer detection matches any Razer HID keyboard collection (a Razer *mouse* may qualify) | documented |
| LL-049 | S3 | Repo | Leftovers: duplicate `if` in save-native-profile.ps1; dead `razer-ornata-v3-x`; CSS literals bypass tokens | documented |
| LL-051 | S1 | Renderer | **Matrix went permanently dark after ~11 minutes** of a live session or open preview | fixed |
| LL-052 | S3 | Renderer | Breathing, Fire and Aurora ignored the speed slider | fixed |
| LL-053 | S3 | Layout guide | ISO-without-numpad and "no nav keys + function row" both map to TKL (no closer reference model) | documented |
| LL-054 | S2 | Renderer | Row effects used Chroma *grid* rows: compact boards lit Esc a step early; a hidden 6th step | fixed |
| LL-055 | S1 | Timing | Matrix rows held 141–302 ms on hardware (ideal 230) and 200/250 ms in the preview | fixed |
| LL-056 | S1 | Environment | **Two Lighting Lab servers** (old `0.0.0.0` + new `127.0.0.1`) streamed to one keyboard | open (owner action) |
| LL-058 | S3 | Copy | Matrix preset said "Rising neon green bands"; it falls | fixed |
| LL-059 | S2 | UI | "Keep anchor colors during reactions" did nothing for layered (group) setups | fixed |
| LL-060 | S2 | App Profiles | Full screen + Time of day conditions, default profile, inline rule editing | fixed (new) |
| LL-061 | S2 | App Profiles | The saved "Transition window" was never used: now a real crossfade | fixed (new) |
| LL-062 | S2 | Redesign | Group matrix + inspector, per-layer strength, Protect, brand assets, new header/footer | fixed (new) |
| LL-063 | S2 | Redesign | Simple / All-controls modes | fixed (new) |
| LL-064 | S2 | UI | `display:flex/grid` overrode `[hidden]`: hidden strips and panels stayed visible | fixed |
| LL-065 | S1 | Launcher | A new launch did not detect an older copy bound to `0.0.0.0` (EADDRINUSE never fires) | fixed |
| LL-066 | S3 | Crossfade | A fade that interrupts a fade starts from the previous *target*, not the half-blended frame | documented |
| LL-067 | S3 | App Profiles | Full-screen detection verified only for the `false` case (no full-screen app during testing) | open |
| LL-068 | S3 | Redesign | Mockup items deliberately not built: layer reordering, extra custom groups, keyword triggers | documented |
| LL-T01 | — | Tooling | Prettier via `npx` needs network on first use | documented |
| LL-T02 | — | Tooling | The agent shell layer collapsed `\\` inside heredocs, corrupting regex/escape edits | mitigated |
| LL-T03 | — | Tooling | Python `print` of non-ASCII crashed on the cp1252 console | mitigated |
| LL-T04 | — | Tooling | Windows process termination is asynchronous; an immediate orphan count looked like a leak | documented |
| LL-T05 | — | Tooling | A process-count query matched its own command line and reported a phantom leak | documented |
| LL-T07 | — | Tooling | A 400-line CSS heredoc was truncated mid-rule by the shell tool | mitigated |
| LL-T08 | — | Tooling | Git Bash path forms broke a Node path guard in a test harness | mitigated |
| LL-T06 | — | Tooling | A long heredoc with backticks and quotes broke the Bash tool (`unexpected EOF`) | mitigated |

(Findings that came out of the commenting pass are appended at the end of the entries.)

---

## Entries

### LL-001 · Replacement characters in the editor UI
- **Severity / area:** S2 · `ui.js` user-visible text.
- **Seen:** speed read `3.5�`; device line `Unrecognized keyboard � test fixture`; selection count `0 color � 1 protected`;
  the recipe, key tooltips, word planner, profile list and the "Sending…" status all had `�`. Confirmed in the
  browser test screenshot `.artifacts/browser/desktop.png`.
- **Root cause:** commit `82adcf1` ("add app profiles workspace") round-tripped `ui.js` through a tool that read
  UTF-8 as a legacy code page and wrote it back. `·`, `×`, `→`, `…`, `—`, `“ ”` became U+FFFD (22 occurrences, 15
  left by the time of the audit; the WIP had replaced some with ASCII ` - `/`->`). The browser test's mojibake
  guard only scanned `index.html`.
- **Fix:** recovered every original character, in order, from `git show b1f907d:ui.js` (the last clean version)
  rather than guessing. Restored `→` in the word planner (it had become `?`) and the WIP's ASCII stand-ins.
  Extended the guard in `tests/browser-check.cjs` to every served file and to the `â€` signature.
- **Verification:** a Python scan reports 0 U+FFFD in all served files; the browser test passes with the wider guard.
- **Status:** fixed.

### LL-002 · `Chromaâ€™s` in the multi-keyboard notice
- **Severity / area:** S2 · `server.cjs` `selectedDevice().controlScope.reason`.
- **Root cause:** same encoding round-trip class as LL-001 (UTF-8 `’` read as Windows-1252).
- **Fix:** replaced with `’`. The broadened guard now also covers `â€`.
- **Verification:** `grep "â€" server.cjs` → no match. Note this text was invisible anyway until LL-028 was fixed.
- **Status:** fixed.

### LL-003 · Browser test output mojibake and narrow guard
- **Seen:** `npm run test:browser` printed `âœ“ custom view geometry …`.
- **Root cause:** the `✓` in the test source was itself double-encoded.
- **Fix:** restored `✓`; the guard now scans `index.html, ui.js, core.js, effects.js, layout-guide.js, styles.css`.
- **Status:** fixed.

### LL-004 · Literal `` `r`n `` in QUICKSTART.md
- **Seen:** the first line rendered as ``# Lighting Lab quick start`r`n`r`nOn Windows, double-click…``.
- **Root cause:** a PowerShell string with backtick escapes written with single quotes (no expansion).
- **Fix:** rewrote QUICKSTART.md as a 7-step card.
- **Status:** fixed.

### LL-005 · README written for the maintainer, not a newcomer
- **Seen:** the README opened with private-history notes, "development chunks", deferred-bug details and a
  Checks section listing `uv run ruff check .`, `uv run mypy src`, `uv run pytest` (Python tools from the old
  Plantriloquist monorepo that don't exist here).
- **Fix:** new README ordered pitch → features → 2-minute setup → App Profiles → hardware support matrix →
  phone use → privacy → which-button-does-what → developers → honest limits. History moved to
  `docs/history/`; `VALIDATION.md` labelled historical; new `ARCHITECTURE.md` and `TROUBLESHOOTING.md`.
- **Status:** fixed.

### LL-006 · Onboarding contradicted the default Live setting
- **Severity / area:** S1 · first-run trust. Step 1 said "Nothing reaches your hardware until you apply it" and
  the status said "The preview stays local until you choose Apply", yet `<input id="live" checked>` means that as
  soon as `/api/status` reports Chroma, `refreshProviderStatus()` calls `queueLiveUpdate(true)` and the keyboard
  changes.
- **Decision:** kept Live on by default, because instant feedback on real keys *is* the "holy shit" moment, and
  fixed the copy to say so, including how to experiment in preview only (turn Live changes off).
- **Status:** fixed.

### LL-007 · Minified-style source
- **Seen:** `styles.css` was 21 lines (1,744 after formatting), `ui.js` had 400+ character lines, and most
  functions were one-liners chained with `;`.
- **Fix:** added `.prettierrc.json` (printWidth 110, single quotes), `.prettierignore` (evidence JSON, prose),
  `npm run format` / `format:check`, ran Prettier 3.3.3 once, then added the commenting pass.
- **Verification:** unit 64/64 and browser 78/78 immediately after formatting (except LL-008); now enforced in CI.
- **Status:** fixed.

### LL-008 · Source-grep test broken by formatting
- **Seen:** `native import finds the real named Studio tab…` failed after Prettier: it asserted
  `adapter.includes("'-Action','Select','-ProfileName',profile.name")`, and Prettier added spaces.
- **Fix:** replaced that assertion with a behavioral test, `native profile selection passes the exact name as a
  separate argument`, which calls `loadNativeProfile()` with a fake `execFile` and checks the argv array (and
  that a name with quotes stays one argument). The remaining `synapse-control.ps1` substring checks are left
  alone, and that `.ps1` is excluded from reformatting.
- **Status:** fixed.

### LL-009 · Fragile Windows launcher
- **Seen:** `Start Lighting Lab.cmd` was stored LF-only; it opened the browser after `Start-Sleep 2` whether or
  not the server had started; it only checked that `node` existed.
- **Root cause:** cmd.exe can mis-parse LF-only batch files (label/`goto` and parenthesised blocks near 512-byte
  boundaries). The sleep raced slow first starts (Defender scanning `node.exe`) and port conflicts.
- **Fix:** CRLF on disk, pinned in `.gitattributes`; a Node ≥ 22 check with `winget` instructions;
  `node server.cjs --open`, so the server opens the browser after `listen` succeeds; a second launch is detected
  (`EADDRINUSE` + `/api/status` probe) and simply reopens the page.
- **Verification:** `tests/launcher.test.cjs` asserts CRLF, the version gate and `--open`, and a new test starts
  two servers on one port and expects "already running" with exit code 0.
- **Status:** fixed.

### LL-010 · App Profiles only ever watched the first app
- **Severity / area:** S1 · App Profiles (headline feature in progress).
- **Seen:** with real PowerShell:
  `powershell -File app-profile-monitor.ps1 -AppName Code.exe explorer.exe node.exe` → only `Code.exe` in the
  output. The server built exactly that argv (`'-AppName', ...names`).
- **Root cause:** with `-File`, PowerShell binds one value to a `[string[]]` parameter; the remaining
  space-separated values are dropped (not an error). The unit tests inject a fake `appProbe`, so they never saw it.
- **Fix:** the server passes `-AppNames "a.exe,b.exe"` (one argument) and the script splits on `,`. This is safe
  because the rule validator (`EXECUTABLE` regex) forbids commas. The legacy `-AppName` is still accepted.
- **Verification:** a real run with 4 names returns all 4 (including a not-running one). The unit test
  `the Windows app probe passes every rule name in one argument…` asserts the argv. The real-machine smoke test
  (DEV-LOG, Phase 6) shows all 4 rule apps with live running state.
- **Status:** fixed.

### LL-011 · Rules idle after a restart
- **Seen (by reading):** `ensureAppProfilePolling()` was only called from the App Profiles mutation routes.
- **Impact:** after a reboot, saved rules did nothing until someone opened App Profiles **and changed** something.
- **Fix:** `server.once('listening', ensureAppProfilePolling)` on Windows, plus an in-flight guard so a slow
  activation can't stack overlapping polls.
- **Status:** fixed.

### LL-012 · LAN-wide bind by default
- **Seen:** default host `0.0.0.0`.
- **Impact:** (a) Windows Defender Firewall shows an "allow access" dialog on the very first run, which is the
  scariest possible first impression for a downloaded tool; (b) anyone on the same Wi-Fi could change lights,
  enable global key feedback, list running apps, and read diagnostics (there's no auth).
- **Fix:** default `127.0.0.1`; `--lan` / `npm run start:lan` restores the phone workflow; `LIGHTING_LAB_HOST`
  still overrides. The startup output explains both.
- **Owner impact:** the previous phone/LAN workflow now needs `--lan`. This is called out in the README and the
  summary.
- **Status:** fixed.

### LL-013 · DNS rebinding
- **Root cause:** the Origin check blocks foreign origins, but a rebinding page *is* same-origin from the
  browser's point of view (its own domain resolving to 127.0.0.1).
- **Fix:** `isAllowedHost()`: localhost, `*.localhost`, IP literals, this PC's hostname (+ `.local`), plus
  `LIGHTING_LAB_ALLOWED_HOSTS`. Anything else → 403 before any route runs.
- **Verification:** a unit test with a forged `Host: evil.example` gets 403 and reaches no provider; the real smoke
  test got 403 too.
- **Status:** fixed.

### LL-014 · `restart-chroma.ps1` wrote outside the project
- **Root cause:** `Join-Path $PSScriptRoot '../../.artifacts/lighting-lab'` was correct when the script lived at
  `apps/lighting-lab/` in the monorepo; standalone, it resolves above the repo. `function Record([string]$event…)`
  shadowed the automatic `$Event`.
- **Fix:** log under `<repo>/.artifacts/lighting-lab`; renamed to `Write-RepairRecord($stage…)`; readable layout and
  usage header. Not executed (it needs admin and restarts services), but parse-checked with the PowerShell AST parser.
- **Status:** fixed.

### LL-015 · A new PowerShell process every second
- **Measured:** 3 runs of the one-shot probe averaged **528 ms** each; at 1 Hz that's half a CPU-second per second
  while any rule exists.
- **Fix:** `app-profile-monitor.ps1 -Watch` loops in a single process and prints one JSON line per second. The server
  keeps one watcher per distinct rule set, uses its output while fresh (≤ 3 s), falls back to a one-shot when stale,
  restarts the watcher when rules change, and kills it on shutdown. The loop also exits by itself when stdout closes.
- **Verification:** real smoke test: second `/api/app-profiles` call **5 ms** (from the watcher). Unit tests cover
  reuse, staleness fallback, restart on rule change, and stop.
- **Follow-up found during verification:** a poll already in flight could restart a watcher after `stop()`. Fixed with
  a `stopped` latch; test `a stopped app probe never starts another watcher`.
- **Status:** fixed.

### LL-016 · Switching back to an app did nothing
- **Root cause:** `activeAppProfileId` was set on switch and never cleared, so returning to the same app found
  `activeAppProfileId === candidate.id` and returned early, even if the lighting had changed meanwhile. Every
  automatic switch also used `force: true`, which unregisters and re-registers with Chroma (a visible flash per alt-tab).
- **Fix:** forget the active rule when nothing matches (lighting itself still stays as it is); automatic switches use
  `force: false` (reuse the live session). Manual **Test** / **Load** still force.
- **Verification:** test `returning to an app re-applies its profile…`.
- **Status:** fixed.

### LL-017 · Verification stored against the wrong keyboard
- **Root cause:** `/api/control-verification` used `deviceValue.modelId` (first detected) while `/api/status` read
  back `selectedDevice().modelId`. With two keyboards, a "Yes, I see it" could be filed under the other model.
- **Fix:** record against `selectedDevice()`. **Verification:** new test with two keyboards.
- **Status:** fixed.

### LL-018 · Injected platform ignored by global input
- **Fix:** `enableInput()` uses the injected `platform`, so the error path is testable on non-Windows runners.
- **Status:** fixed.

### LL-019 · Unbounded audit growth + telemetry flood
- **Seen:** the WIP added `recordActivity('setup-changed')` inside `changed()`, which runs on every `input` event
  of the speed slider and color picker, so dozens of POSTs and audit lines per second while dragging. `audit.jsonl`
  had no size limit, and `recentAudit()` reads the whole file.
- **Fix:** `setup-changed` is debounced (1.5 s trailing); the audit file rotates to `audit.1.jsonl` past 2 MB
  (one generation kept).
- **Status:** fixed.

### LL-020 · Mouse sync black on static looks
- **Root cause:** `createCustomMouseFrame` sampled `Effects.background()`, i.e. only the *dynamic* layer, which is
  `BLACK` for `solid`, `ghost` and `subtle-keywords`.
- **Fix:** sample the composed background group (`Effects.sampleAt`, which includes the static base). When the
  background is deliberately dark and anchor keys are lit with a static color, the mouse shows the anchor color.
  Keypress-only stays dark. This also fixes mouse frames embedded in portable exports.
- **Verification:** test `mouse sync follows the composed background group…` (solid, anchor glow, dark, minimalist,
  animated).
- **Status:** fixed.

### LL-021 · Portable player reactions
- **Root cause:** `portable/ChromaPreset.cs` `Fade()` handled only `reactive|ripple|waterfall`; it always blended to
  white; it picked the mode by the pressed key's legacy group and ignored `groups`.
- **Fix:** all 10 reaction modes ported from `effects.js` (`flash`, `pulse`, `flame`, `fading-trail`, `comet`,
  `sparkle`, `rainbow-ripple`…), per-group mode and `reactionColor` with the same "lit key's group decides" rule as
  the editor, and legacy behavior kept for setups without `groups`. The file was rewritten readably with comments.
- **Verification:** `npm run build:portable` compiles with the real `csc.exe`; the self-test grew from 275 → **287**
  (AL65) and → **1055** (Auto), including "every mode lights a key" and color-blend checks. Zero HID/SDK calls.
- **Status:** fixed.

### LL-022 · Profiles could only accumulate
- **Fix:** `POST /api/profiles/:id/delete` (also removes a generated `.ChromaEffects`), a **Delete** button with a
  confirmation, and a friendly "That saved profile no longer exists" instead of `ENOENT: … D:\…\id.json`.
- **Verification:** API test plus browser check `a saved profile can be deleted from the picker after confirmation`.
- **Status:** fixed.

### LL-023 · Mixed vocabulary and internal IDs
- **Seen:** the legend said *Color anchor / Protected anchor*, the paint menu said *Paint anchor / Paint orientation*,
  a select said *Keyword Key Reaction*, the count said `N color · N protected`, and profiles were listed as
  `My Lighting — lighting-lab`.
- **Fix:** one vocabulary (Anchor / Background / Orientation) everywhere; friendly controller names
  (`Lighting Lab`, `Synapse Studio`); clearer help text explaining what each group is for.
- **Status:** fixed.

### LL-024 · Export hint names
- **Fix:** server text says "Lights Out"; the UI builds the "choose one of…" list from
  `capability.supportedEffects` and the real option labels, so it can't drift again.
- **Status:** fixed.

### LL-025 · O(n²) group normalization
- **Root cause:** `normalizeGroups()` (called by `configuration()` on every 40 ms preview frame) did
  `Object.keys(...).includes(id)` per key.
- **Fix:** precomputed `PHYSICAL_IDS` / `PHYSICAL_ID_SET`. (Renderer cost was measured at ~1 ms per full frame, so no
  deeper renderer change was needed.)
- **Status:** fixed.

### LL-026 · Repository hygiene
- **Fix:** `.gitattributes` (LF in repo; CRLF for `.cmd/.bat/.ps1`; binaries marked), `.editorconfig`, BOMs removed
  from `.cjs`/`.md` files, CRLF applied to PowerShell scripts.
- **Status:** fixed.

### LL-027 · No continuous integration
- **Fix:** `.github/workflows/ci.yml` on `windows-latest` with Node 22: format check, unit, real-browser, and portable
  compile + self-test; uploads browser screenshots. Plus a hardware-aware bug report template.
- **Status:** fixed (first run happens on the next push).

### LL-028 · Multi-keyboard warning never shown
- **Root cause:** `ui.js` rendered `deviceStatus.controlScope?.detail`; the server sends `controlScope.reason`.
- **Fix:** read `reason` (with `detail` as a fallback).
- **Status:** fixed.

### LL-029 · `$matches` misuse in the app monitor
- **Fix:** renamed to `$processes` / `$group`, with a comment explaining why.
- **Status:** fixed.

### LL-030 · Duplicated paint-mode options
- **Fix:** the four real options live in `index.html`; the JS override was removed.
- **Status:** fixed.

### LL-031 · LAN timeout / `chromweb` / 401 (inherited)
- From the original README: a second PC timed out over LAN, plus an unspecified `chromweb` error and console 401s.
  Not reproduced in this pass (no second PC). With LL-012 the default is now loopback-only, which removes the
  configuration that produced the reports. Diagnosis needs endpoint + timestamp from a `--lan` session.
- **Status:** open.

### LL-032 · Shared Chroma canvas with several keyboards
- Chroma's generic keyboard endpoint isn't per-device. The UI explains this (and, with LL-028 fixed, now
  actually shows the explanation).
- **Status:** documented.

### LL-033 · AL65 hardware validation
- The AL65 runner's protocol, backup and rollback are exercised in memory (287 checks) but have never talked to a
  real AL65. Power-cycle retention is unverified.
- **Status:** open (needs the hardware).

### LL-034 · Synapse 3 assumptions
- `synapse-control.ps1` looks for `Razer Synapse 3.exe` and Synapse 3 automation IDs. Synapse 4 users still get live
  Chroma control (REST SDK); only the **Retry/repair** UI automation and native-profile import may not apply.
- **Status:** documented.

### Tooling entries (the development environment, not the product)
- **LL-T01:** `npx --yes prettier@3.3.3` downloads on first use; offline machines can skip formatting (CI checks it).
- **LL-T02:** in this agent environment, `\\` inside a Bash heredoc reached the file as `\`, which produced
  `/ENOENT|[A-Z]:\/` (a syntax error) and broke a Python/Node one-off. Workaround: write scripts with the file
  tool, build backslashes with `String.fromCharCode(92)`, or edit with exact-match replacements.
- **LL-T03:** `python -c "print(…non-ASCII…)"` raised `UnicodeEncodeError: 'charmap'` (cp1252 console). Workaround:
  `PYTHONIOENCODING=utf-8`.
- **LL-T04:** counting `app-profile-monitor` processes 2 s after shutdown showed 1; re-checking showed 0. Windows
  `TerminateProcess` completes asynchronously. Verification now re-checks after a delay, and the real race it
  prompted is fixed under LL-015.
- **LL-T05:** a later orphan check, `Get-CimInstance … | ? CommandLine -like '*app-profile-monitor*'`, ran inside a
  powershell.exe whose own command line contained that text (and `-Watch`), so it always counted itself. Fifteen
  seconds of `1 [watch]` looked like a leaked watcher. Instrumenting `spawnImpl` showed exactly one watcher, killed at
  shutdown (`SIGTERM`); excluding `$PID` from the query gives **0**. A follow-up hard-kill of the parent `node` proved
  the script's own fallback (it exits when its stdout pipe closes) also works within 1 s. *Lesson:* exclude the
  observer from any process census.
- **LL-T06:** a long Node heredoc containing backticks and quotes made the Bash tool fail with
  ``unexpected EOF while looking for matching `'``. Same class as LL-T02; exact-match file edits were used instead.

---

## Findings from the commenting pass

The six commenting workers changed comments only and reported anything suspicious. Each finding was then checked
and fixed by the coordinator, with a regression test where one was practical.

### LL-035 · XSS through imported group settings (S1, security)
- **Root cause:** `restoreSetup()` copied every field of `data.groups[name]` verbatim, and `renderGroupEditor()`
  interpolates `group.color` / `reactionColor` into `innerHTML`. A crafted share link (`#lighting-lab=…`) or setup
  JSON could run script on `localhost:4318`, and that page can call every `/api/*` route (same origin).
- **Fix:** `sanitizeGroupSettings()` accepts only `#rrggbb` colors, `off|static` bases, and allowlisted dynamic
  effects/reactions; anything else falls back to the group default.
- **Verification:** browser check `imported setups cannot inject markup through group colors or effect names`
  restores a payload containing `"><img onerror=…>` and asserts that no element or flag appeared and defaults were used.

### LL-036 · Legacy imports rejected by the server
- Flat setups set `background.dynamic = effect`, which could be `solid|ghost|subtle-keywords` (not dynamic effects),
  so live Apply failed with "Choose a supported dynamic effect for background". Now mapped exactly like presets
  (`solid` → static base + its color).

### LL-037 · Protect toggle silently reset
- `if (data.reactionLayersVersion !== 2)` was written when the format was v2. Current saves are v3, so every
  restore, profile load and share link turned the option off. Now only setups without a version (< 2) reset.

### LL-038 – LL-040 · Small UI defects
- `appProfileAction()` returns success, and the add-rule form clears only on success. The "No, Unchanged" message
  describes what actually happens now. The duplicate `onkeydown` assignment was removed.

### LL-041 · `start ""` quoting for `--open`
- **Proof:** `spawnSync('cmd.exe', ['/d','/s','/c','echo','""', url])` printed an escaped `"\"\""`, so Node's argv
  quoting mangles the empty window title. Fixed with `windowsVerbatimArguments`: cmd now receives exactly
  `start "" "http://localhost:4318"` (proven with `echo`). A URL character allowlist keeps anything unexpected off the
  command line. A unit test asserts the exact command line and the refusal of `" & calc`.

### LL-042 – LL-045 · Server robustness
- Opaque `null` origins → 403 (test added). `recentAudit()` tops up from `audit.1.jsonl` and skips a torn line.
  Rule mutations re-find the rule inside the store update. Verification writes use tmp + rename.

### LL-046 – LL-047 · Portable/hardware checks
- `--restore` now skips the Razer branch (it is an AL65-only operation). Recompiled; self-tests unchanged
  (287 / 1055). `flame` was added to `check-live.cjs`.

### LL-048 · A Razer mouse could look like a keyboard to the portable player
- `HasDevice(0x1532, 0, keyboard: true)` accepts any Razer HID interface with a keyboard usage, and many Razer mice
  expose one for macros. Effect: a PC with only a Razer mouse gets "Razer keyboard detected" and plays frames that
  light nothing. It isn't dangerous (no guessed USB writes; Chroma decides), just misleading. A precise fix needs a
  Razer keyboard PID list or a Chroma device query. Documented for a later pass.

### LL-051 · Matrix stopped raining after ~11 minutes (S1)
- **Root cause:** `fallingMatrixRow()` walked gap cycles from t = 0 with `cycle < 256` as a guard. Past ~2,816 steps
  (≈ 10.8 min at speed 3.5) the cursor never advanced and every row returned -1. The live provider keeps `startedAt`
  across edits, so a Matrix keyboard left running went black, and so did a preview tab. Cost also grew to 512 hashes
  per sample.
- **Fix:** cached per-seed prefix sums of the 256 cycle lengths, the step wrapped by the total period, and a binary
  search for the cycle.
- **Verification:** an equivalence script compared the new code with the old implementation inlined from git. Result:
  **0 mismatches over the first 10 minutes**, and 217 lit rows in a 20-minute window (old code: 0). Permanent test
  `Matrix keeps raining after a long session…` checks 0, 10, 11, 12, 30 and 600 minutes.

### LL-052 · Speed slider ignored by three effects
- Breathing, Fire and Aurora now scale time by `speed / 3.5`, which is identical at the default. The test measures
  total color distance travelled at speed 6 vs 0.5. Rainbow Road's raw `speed` multiplier is intentional (it defines
  the default look) and is documented in code.

---

## Second pass (same day): Simple/All-controls modes, row-effect timing, redesign gap

### LL-054 · Row effects used transport-grid rows
- **Seen (owner):** "sometimes it doesn't look right going from the function keys to the number row."
- **Measured:** a script compared each switch's Chroma grid row with the row it is drawn in, for every model.
  Full-size boards match; **65%/60%/AL65** put Esc in grid row 0 and the rest of its physical row in grid row 1
  (so the top row lit in two steps). The 75% navigation column and ISO Enter were also out of order. Matrix also
  spent a 6th step on a row that 5-row boards don't have (an invisible stall). In real headless Edge, the AL65
  view showed **9 frames with two rows lit at once**.
- **Fix:** `physicalRowOf()` derives visible rows from the drawn geometry; Matrix and Stars & Stripes step through
  them, and Matrix falls through exactly that many rows. Full-size output is unchanged.
- **Verification:** test `Matrix falls through the VISIBLE rows of every layout…` (6 layouts, one row per step,
  gap right after the bottom row); preview harness: 0 double-row frames on AL65.

### LL-055 · Uneven Matrix cadence (hardware and preview)
- **Seen (owner):** "sometimes it skips over 1 or 2 rows, sometimes it stalls a bit… not consistent."
- **Measured on the dev PC:** Chroma REST p50 **16.6 ms** per call (Windows timer quantum), Node `setInterval(46)`
  ≈ 47 ms. Every 46 ms tick sent a keyboard PUT, plus a mouse PUT with mouse sync and a heartbeat every 1.5 s:
  2–3 sequential calls, so ticks overran and were dropped.
- **Harness** (`matrix-cadence.cjs`): drives the real provider against a fake Chroma with the measured latency
  profile and records which row each delivered frame shows. Before/after, 3 runs × 15 s each:

  | | requests | row-change timing p10…p90 | row dwell p10–p90 (ideal 230 ms) |
  | --- | --- | --- | --- |
  | before, no mouse | ~313 | −27 … +22 ms | 188–265 ms |
  | after, no mouse | **55** | **−11 … +5 ms** | 203–250 ms |
  | before, mouse sync | ~337 | −44 … +40 ms | 186–284 ms |
  | after, mouse sync | **98** | **−19 … +6 ms** | 201–253 ms |

  The remaining dwell spread comes from the model's simulated 4% latency spikes (45–60 ms), which only Chroma can remove.
- **Preview** (`preview-cadence.cjs`, real headless Edge): the 40 ms repaint throttle landed on every 3rd 60 Hz
  frame, so rows showed for **200 or 250 ms** alternately. After the fix: **217/233 ms** (one-frame quantization).
- **Fix:** 23 ms tick that skips identical frames; changed frames ≥ 40 ms apart; `nextStepAt()` + a precise one-shot
  wake-up at each step boundary (minus measured latency); mouse frames and heartbeats moved off the keyboard's
  critical path; frames rendered for their display time. Preview paints every frame with per-key change detection
  and one clock (`performance.now()`).
- **Tests:** `nextStepAt…`, `the Chroma provider never re-sends an identical animation frame…`; one existing test
  needed a later sample time because identical Stars & Stripes frames are now correctly not re-sent.

### LL-056 · Two copies of Lighting Lab were driving the keyboard
- **Found while verifying:** `Get-NetTCPConnection -LocalPort 4318` showed two listeners: the owner's current
  server (`127.0.0.1`, started 10:36 today, effect Lights Out) and a **pre-audit server started Oct 19, 5:50 PM** on
  `0.0.0.0` (effect Stars & Stripes, **1,866,682 frames sent**). Both hold Chroma sessions, so Synapse shows a mix:
  stutters, skipped rows, and flicker between looks. This very likely contributed to the reported Matrix behavior.
- **Not changed by the agent:** it is the owner's running process. **Action:** close the old window (or end
  PID 62588), then Apply. LL-065 prevents a recurrence.

### LL-058 · Matrix preset copy
- The card said "Rising neon green bands"; it now says "Falling lines of green rain".

### LL-059 · The protect shortcut was a no-op for layered setups
- `protectAnchors` only affected legacy (pre-groups) setups, and every current setup uses groups. The checkbox now
  drives the anchor group's new **Protect** flag (and the matrix toggle syncs it back).

### LL-060 / LL-061 · App Profiles conditions, default, inline editing, crossfade (backend worker)
- New conditions **Full screen** (foreground window covers its monitor; rectangles and class names only, never
  titles) and **Time of day** (`from`/`to`, wraps midnight). `defaultProfileId` = "Everything else".
  `POST /api/app-profiles/:id/update` for inline edits. Responses include profile settings for thumbnails.
- `transitionMs` was saved but unused ("reserved for compatible providers"). Automatic switches now crossfade cell
  by cell in the provider; manual Apply/Test/Load stay instant. 11 new tests (`app-profiles`, `server`,
  `crossfade.test.cjs`).

### LL-062 / LL-063 · Redesign implemented (from `lighting-lab-redesign.zip`)
- **Built:** four-key icon + "by jebyLabs" header, profile indicator, status pill, header Apply / Save & device,
  favicon; paint pills; per-group preview eye-chips with counts (preview only); the "What each group does" matrix
  with Link all, Protect and option/parameter cells; the inspector with search, categories, swatches, descriptions,
  color, strength, speed and **Shows on**; quick key sets; the layer-order legend; the App Profiles active card with
  a live mini keyboard and **Try it** simulation; badges; the inline rules table; Everything else; quick-add chips;
  the detected list with status pills; the crossfade slider; the saved-profiles gallery with thumbnails and auto
  descriptions; the jebyLabs × JA Insights footer; brand tokens (Anchor #FF7AD9, Background #8F8DA6,
  Orientation #5FD6E8, Lab Violet #B9A5FF).
- **Simple mode (owner request):** the live keyboard + the looks gallery (+ Apply, Live, and the physical check).
  "All controls" reveals the rest and is remembered.
- **Verification:** browser checks 83 → **96** (simple/fancy, pills, chips, matrix, inspector search, strength,
  Link all, Protect, Try it, time-rule form, default profile); four reviewed screenshots (simple desktop, all
  controls, App Profiles, phone).

### LL-064 · `[hidden]` was overridden by component `display` rules
- Visible in the very first baseline screenshot: "Did your physical keyboard change?" *and* "That effect landed"
  showed together; later the intro/advanced panels stayed visible on the App Profiles view. Fixed with a global
  `[hidden]{display:none!important}`.

### LL-065 · Second launch next to an old `0.0.0.0` copy
- **Root cause:** Windows allows `127.0.0.1:4318` to bind while `0.0.0.0:4318` is held, so the "already running"
  path (EADDRINUSE) never fired. **Fix:** probe `127.0.0.1:<port>/api/status` *before* binding.
  **Test:** a launcher test starts an old-style `0.0.0.0` copy, then a default launch, and expects "already
  running", exit code 0, and no second server.

### LL-066 – LL-068 · Known limits of this pass
- **LL-066:** an interrupted crossfade restarts from the previous target look (minor visual jump).
- **LL-067:** full-screen detection was only observed returning `false`; confirm with a full-screen game.
- **LL-068 (not built, on purpose):** *layer reordering* (the renderer's base → dynamic → reaction order is fixed
  and shown as a legend, not as fake arrows); *adding custom groups* beyond three (validation, export and the
  portable player all assume three; "Add keys" quick sets cover the WASD/numpad/F-row use case);
  *keyword-triggered reactions* ("type jeby to fire…") would require assembling typed text, which the privacy
  promise rules out. *Base lighting* has the two options the renderer supports, not the mockup's illustrative "9".

### Tooling (second pass)
- **LL-T07:** a 400-line CSS heredoc was silently truncated mid-rule by the shell tool, leaving `[aria-pressed='` at
  end of file. The remaining commands then became heredoc text. It was caught by inspecting the tail, the file was
  trimmed back to the last original line, and the CSS was re-appended from a file. Long content now always goes
  through the file tool.
- **LL-T08:** Git Bash's `$PWD` (`/d/...`) and `pwd -W` (`D:/...`) both broke a Node path guard (`path.join` yields
  `D:\...`). Normalize with `path.resolve()` before comparing paths.
