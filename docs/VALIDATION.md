# Validation record: 2026-10-18

The owner confirmed that the physical keyboard and mouse retained their original lighting through
both REST and direct native-SDK diagnostics, despite successful Razer result codes. A separately
generated solid-magenta Synapse Studio profile then changed the BlackWidow Elite immediately.
This isolates the current-machine failure to Chroma Apps/SDK ownership rather than rendering,
device presence, or Synapse's profile-to-device path.

Follow-up: the owner explicitly confirmed the original rainbow remained after the first repair.
Further diagnosis restarted the verified Synapse GUI and, with Windows elevation, Synapse's
device bridge plus both SDK services (all returned to Running). Connect master/app switches were
read as On; a bounded off/on master cycle did not itself establish visual success. The new short
registration name was absent even with compatibility filtering disabled. The provider now preserves
the existing `Jeby Lighting Lab` identity. Actual UI readback confirms that exact app is listed and
enabled, with the Connect master enabled. Solid-cyan REST and solid-lime native diagnostics were
both rejected by visual acceptance; the native diagnostic deleted its effect and uninitialized
successfully. The original editor selection remains backed up in ignored artifacts.

The native profile importer was repaired against this installation's actual controls: Studio is a
named tab with no automation ID, its legacy file chooser is nested under the Synapse window, and
duplicate same-named profile wrappers must be filtered by SelectionItem support. Synapse readback
confirmed `Lighting Lab Diagnostic - Magenta`, the owner observed solid magenta, and the original
`Noob Deterrent - Rainbow Road - 24 switches` profile was then selected again.

An active Mouse Without Borders overlay blocked process-owned pointer hit tests. The diagnostic
retains that guard and uses SelectionItem for the app list. Tab selection alone had not loaded its
page; Connect content is now explicitly verified. Different DLL/REST version strings were observed
but were not established as the cause. HTTP.sys owns port 54235 as PID4; its request queue was traced
to the genuine RzSDKServer executable, rather than assuming PID4 implied a mock or another app.

Follow-up checks: 54 Node tests and 66 actual-browser fixture checks pass. The local app now stores
owner-observed control results per device/provider, pauses automatic live writes for a rejected
provider, and keeps Apply available for an explicit retest. Actual `check-connect.cjs` still reads
master/app enabled without treating that state as physical control. Its Studio-to-Connect navigation
now closes an open effect flyout and sends the click directly to the verified Synapse window; the
installed app check passed before the original Studio profile was selected again.

This pass separates Apply, controller profiles, and executable/JSON downloads; enables keyword
reactions above fixed colors; adds independent reaction groups and a physical-layout interview.

| Check | Observed result | Boundary |
| --- | --- | --- |
| Node unit/API suite | 48 passing | Isolated transports, forced activation/recovery, profile round trips, layouts, reaction groups and export gating. |
| Real Edge fixture | 64 checks passing | UI actions, guided broken-key/alternate flow, profiles, live-off Apply, geometry, desktop/phone layout. No physical device assertions. |
| Portable compilation | AL65 275 checks; auto/Razer 1043 checks | Actual installed Windows compiler, embedded animation and mouse frames, physical-input identities; zero real HID writes. |
| Native archive build/readback | Passed | Actual local template, 3 generated layers and exactly one keyword reactive LED. Separate archive; not imported. |
| Actual HTTP downloads | AL65 53,248 bytes; Auto 145,920 bytes | Both endpoints built real EXEs; `--inspect` preserved extra request fields. No lighting playback executed. |
| Explicit real Apply and four-mode SDK exercise | Fresh registration + create/SetEffect accepted; 7–8 additional frames per mode; feedback accepted | Still SDK acknowledgments, not LED ownership or visual acceptance. Pre-test setup restored. |
| Windows identity | BlackWidow Elite recognized again | Present-device ancestry completed after a bounded 20-second timeout was allowed. |
| Repository baseline | Ruff and mypy pass; pytest 342 passed, 6 skipped | Python checks pass; unrelated Python changes were preserved. |
| Skill refinement | Debugging skill validator passes | New rules are tied to the Node/browser/native/portable checks, not a claim of user acceptance. |

The two SDK services were restarted successfully through Windows elevation. The verified server
process was replaced with the updated source, preserving its previous selection first. No existing
native profile, registry enablement setting, or firewall rule was overwritten. An explicit saved
mostly dark-blue setup was reapplied with keyword reactions enabled. The owner has been asked to
confirm visible output; no response is assumed. Global input remains opt-in after a server restart.

The portable Razer player requires an installed Chroma runtime and must remain open. The AL65
path remains a firmware built-in approximation and has not been run on a real AL65. Native import
uses UI selection readback and exposes a manual archive download if automation cannot be verified.
LAN timeout/401 investigation stays deferred at the owner's request.

## Previous record: 2026-10-17

Environment: this Windows desktop, Node24.19.0, Microsoft Edge, .NET Framework C# compiler,
Razer Chroma SDK3.38.06. This record separates automated contracts from physical acceptance.

| Check | Observed result | What it establishes |
| --- | --- | --- |
| `node --test apps/lighting-lab/tests/*.test.cjs` | 36 passing | Mapping, switch/layout identity, shared effects, reaction timing, live-session ordering/recovery, model variants, export gating, real HTTP handlers, and root launcher. Device I/O is mocked. |
| `node apps/lighting-lab/tests/browser-check.cjs` | 53 passing | Actual Edge rendering/interactions, complete keys, numpad fit, media controls, saved/imported/custom view, live request ordering, focus feedback, downloads, mobile reflow. Provider responses are fixtures. |
| `uv run ruff check .` | Passed | Repository Python lint. |
| `uv run mypy src` | Passed,47 source files | Repository Python type checks. |
| `uv run pytest` | 306 passed,6 skipped | Existing Plantriloquist suite; does not imply keyboard hardware acceptance. |
| `node apps/lighting-lab/tests/build-portable.cjs` | Compiled EXE, inspected embedded request,265 simulated runner checks | Real Windows compilation and in-memory protocol/backup/rollback behavior, zero real HID writes. |
| `node apps/lighting-lab/tests/check-download.cjs` | Actual HTTP endpoint produced32768-byte Windows EXE | Browser-facing route invokes real compiler and returns a binary download. The downloaded EXE's `--inspect` preserved the full original request, including extra fields. `--self-test` passed265 checks without real HID writes. |
| `node apps/lighting-lab/tests/check-live.cjs --exercise` | Multiple accepted Matrix, Stripes, Rainbow Road, and Chaos frames, feedback accepted | Real Chroma API acknowledgements. The temporary test session was released. Physical appearance is not observable through this API. |
| Windows present-keyboard ancestry | Razer BlackWidow Elite recognized | Current-device identity rather than an archived registry entry. Its visible casing remains a schematic approximation. |
| Debugging skill validator | Passed | Instruction structure; effectiveness is supported only by the specific regressions above. |

Artifacts are intentionally ignored under `.artifacts/lighting-lab/`: browser screenshots,
build evidence, downloaded executables, live-probe evidence, runtime logs, and full request audit.
No raw typed-key history is stored. The global input helper's C# was compiled without starting
the listener; outside-browser subjective feedback still needs an explicit user test.

The initial sandboxed launch denied child-process creation (`spawn EPERM`), affecting enumeration
and compilation. The running server was restarted as a normal hidden Windows process so its
device probe and compiler could run. This was not a missing-keyboard diagnosis. No firewall
rule was added or changed during this task.

## Remaining acceptance

- Restore Chroma Apps ownership before judging Q/W/E/R/T, animations, or reactions through the live
  SDK path; this machine currently records that provider as physically rejected.
- Judge Matrix/Stripes movement, Rainbow speed, fading white reactions, Ripple/Waterfall,
  minimalist behavior, and optional mouse synchronization visually.
- Run the AL65 executable on the brother's wired AL65; verify effect, restore, and power-cycle
  retention. The AL65 runner has not communicated with a real AL65 during this task.
- Diagnose the deferred LAN timeout, unspecified uncaught chromweb error, and401 reports by
  exact endpoint/timestamp. The app has not been proven reachable from the brother's computer.
- Obtain brother preference/acceptance before calling the click-only product successful.

Code publication and commit identity are reported in the task handoff. Publishing source does
not close these acceptance gates or promise universal hardware/clean-clone compatibility.
