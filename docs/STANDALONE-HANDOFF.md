# Lighting Lab standalone repository handoff

## Purpose

Lighting Lab is a local-first keyboard and mouse RGB editor. Its main experience is a complete
keyboard preview, click-only presets, and an explicit three-layer model for Anchor, Background,
and Orientation key groups. Every group can independently receive base lighting, a dynamic effect,
and a key reaction. The shared JavaScript renderer drives both the preview and the Razer Chroma SDK
frame, so a browser effect is not a separate approximation.

## Proposed standalone boundary

Create a new repository named `lighting-lab` with this directory as its source root:

```text
apps/lighting-lab/
```

Copy the complete directory, including tests and this handoff. Do not copy private historical
profiles, audit logs, generated executables, screenshots, or anything in `docs/background/`.
The target repository needs its own `.gitignore` for `.artifacts/`, local profile data, and vendor
archives.

## Current verified behavior

- Local Node server on port 4318, with live Razer Chroma SDK effects and an explicit Apply action.
- Full ANSI preview with unique main-row and numpad identities, supported compact/model views, and
  a schematic hardware casing/control silhouette.
- Shared group renderer with Rainbow Road, single-line Matrix, Stars & Stripes, Chaos, Breathing,
  Spectrum, Fire, Starlight, Wave, Reactive, Ripple, Waterfall, Flash, fading trail, and rainbow ripple.
- Model detection from present Windows keyboard ancestry. Multiple devices can be listed and selected
  for model/preview/profile identity. Generic Chroma canvas routing is shared, not individual HID routing.
- Lighting Lab profile JSON, capability-aware portable export, and native Synapse profile support
  where the adapter can prove import/readback.
- 59 focused Node tests and 66 isolated browser checks pass. These are software checks; they
  do not prove every physical keyboard, Synapse state, or portable target.

## Required local prerequisites

- Node 22+.
- Windows plus Razer Chroma SDK/Synapse for physical Razer live control.
- A Chromium browser for the isolated browser check.
- Optional vendor archives/compiler tools only for native or portable export tests.

## Commands

```powershell
node server.cjs
node --test apps/lighting-lab/tests/*.test.cjs
node apps/lighting-lab/tests/browser-check.cjs
```

In the standalone repository, paths should become `tests/*.test.cjs` and `tests/browser-check.cjs`.
Update the server's static-root assumptions in the same move; do not leave it serving the old
Plantriloquist path.

## Migration order

1. Create the new directory and Git repository, then copy this source directory without ignored data.
2. Adjust root-relative paths and run the focused engine/API tests and browser test from the new root.
3. Start the new server and verify `/api/status`, the complete keyboard preview, group controls, and
   a live Apply against one physical Razer device.
4. Preserve this handoff plus relevant sanitized AppForge case material in the new repository.
5. Only after the new repository has a committed, verified copy should the old Lighting Lab source
   be deleted from Plantriloquist. Keep the historical ignored background material according to its
   privacy boundary.

## Known decisions to revisit

- Per-device Chroma SDK routing needs a documented implementation before claiming that selected
  keyboards receive separate frames.
- Sensor-driven Chroma Studio effects (such as audio or screen-aware modes) need explicit source
  capture/consent architecture; they are not represented as fake local effects.
- Power-cycle persistence depends on the target keyboard/provider and needs device-level validation.
- LAN access controls the server host's attached devices only. A browser on another computer does
  not gain access to that computer's USB keyboard.
