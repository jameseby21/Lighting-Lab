# Portable preset export evidence

Portable exports have two targets: an **auto-detecting Razer/Chroma host player** and an explicitly
chosen **YUNZII AL65 USB wired firmware preset**. Each is a small unsigned Windows console executable
with one embedded setup. Neither installs an application, startup service, driver, or firmware.
Windows .NET Framework 4.x is required. The Razer player also needs Chroma and remains open; the AL65
runner uses Windows HID and exits after applying/verifying a supported built-in mode and requesting
a firmware save. See the host-player addition below for the different persistence boundaries.

This is explicitly an approximation: the documented AL65 controls select a whole-board
firmware effect. They do not expose Lighting Lab's custom per-key pixels, keyword islands,
protected anchors, layered feedback, mouse sync, or custom geometry. The UI requires the user
to acknowledge this reduction. The complete requested setup remains embedded separately
from the reduced firmware instruction payload and is printed by `--inspect`.

## Primary evidence and resulting limits

- [YUNZII software page](https://www.yunzii.com/pages/software-1) identifies AL65 VIA support,
  requires a wired connection, and directs users to its model-specific JSON definition.
- [YUNZII manuals page](https://www.yunzii.com/pages/manuals/18674463155) links the
  [official AL65 JSON archive](https://cdn.shopify.com/s/files/1/0509/3713/5273/files/AL65_QMK_V0101_20241025.zip?v=1738837295).
  The definition is retained at `portable/al65-definition.json`, with line endings and trailing
  whitespace normalized for Git. Its JSON values are unchanged. The original extracted file was
  6,776 bytes, SHA-256 `c01c462802c8cfed555fdef2cc6ef311ee4f4aa111d70b4398166f3d0b05df29`.
  It identifies VID `0x4D4B`, PID `0x3068`, a 5×15 switch matrix and 68 physical keys,
  with row counts 15/15/14/14/10. Its Backlight menu uses channel `3`, values
  `1` brightness, `2` mode, `3` speed, `4` hue/saturation. Underglow is a separate channel
  and is deliberately left unchanged.
- [VIA custom UI specification](https://www.caniusevia.com/docs/custom_ui/) defines dropdown
  options and custom channel/value commands. The AL65 JSON's zero-based built-in mode values
  map as follows; these values come from this particular board definition, not generic QMK
  effect numbers:

  | Lab selection | AL65 mode | Reduction |
  | --- | --- | --- |
  | Rainbow Road | 7: Rainbow Moving Chevron | Whole-board firmware rainbow |
  | Matrix | 15: Digital Rain | Firmware rain; no separate white reaction layer |
  | Ghost | 0: All Off | All backlight off; underglow unchanged |
  | Subtle Keywords | 1: Solid Color | Selected whole-board color; no isolated keyword keys |
  | Solid Color | 1: Solid Color | Selected hue/saturation; brightness is separate |
  | Stripes, Chaos, Waterfall | Unsupported | Save JSON or use live/provider control |

  The export uses 80% brightness and maximum firmware speed unless explicit `portable.*`
  byte values are supplied. The UI host animation multiplier is retained in the requested
  setup but has no verified firmware-speed conversion. Solid Color and Subtle Keywords
  copy the selected color's hue/saturation; Matrix selects green by default. Every reduction
  is recorded separately in the manifest.

- [QMK Raw HID documentation](https://docs.qmk.fm/features/rawhid) establishes usage page
  `0xFF60`, usage `0x61`, 32-byte payloads and a leading report-ID byte on host writes.
  The runner also checks Windows HID attributes and both 33-byte report lengths before
  opening the matching VIA collection. Multiple matching boards are rejected.
- QMK's [protocol 11 header](https://raw.githubusercontent.com/qmk/qmk_firmware/0.19.0/quantum/via.h),
  [protocol 12 header](https://raw.githubusercontent.com/qmk/qmk_firmware/0.24.0/quantum/via.h),
  [current header](https://raw.githubusercontent.com/qmk/qmk_firmware/master/quantum/via.h)
  and [command implementation](https://raw.githubusercontent.com/qmk/qmk_firmware/master/quantum/via.c)
  support the reviewed channel commands. The runner allows protocol 11–13 only.
  Versions 9/10 used older lighting value conventions and are rejected before lighting SETs.
  Allowed commands are `0x01` protocol query, `0x08` lighting GET, `0x07` lighting SET,
  and `0x09` lighting SAVE. The SAVE response echoes command/channel; a successful echo is
  followed by another readback. No keymap, macro, reset, bootloader, or flash command exists
  on this runner's command surface. Brightness readback allows 2/255 integer quantization;
  mode, speed, hue and saturation must match exactly.
- [Microsoft HID report guidance](https://learn.microsoft.com/en-us/windows-hardware/drivers/hid/obtaining-hid-reports)
  supports the `CreateFile`/overlapped stream read approach. Each report operation has a
  1.8-second deadline. Communication failure closes the session to prevent stale replies.
- [Razer Chroma REST documentation](https://assets.razerzone.com/dev_portal/REST/html/index.html)
  describes the local SDK service and connection heartbeat. This is a runtime dependency,
  rather than a documented route for saving arbitrary custom frames into keyboard firmware.
  Accordingly, portable persistent Razer export is gated, including Ornata and Cynosa Chroma.
  [Cynosa Chroma's manufacturer announcement](https://www.razer.com/newsroom/product-news/the-razer-cynosa-chroma-keyboard-takes-on-the-thrills-and-spills)
  confirms per-key lighting, but that does not establish standalone persistent export.

## Execution, diagnostics, and undo

Before any device access the runner records the full preset and intended operation under
`%LOCALAPPDATA%\jeby Labs\Lighting Lab\portable\`. Before the first lighting SET it reads
all four original fields and writes a new backup JSON. Every report is logged before send.
An apply verifies readback, saves channel 3, and verifies again. A partial failure attempts to
restore the original fields and save. A USB timeout can prevent automatic restore; the backup
remains available and the program reports failure rather than success.

Run the downloaded executable normally to apply. Its output includes the exact undo command:

```powershell
.\Lighting-Lab-AL65-matrix.exe --restore 'C:\path\to\run-backup.json'
```

Restore checks both the model and a hash of the same Windows USB interface path. Moving to
another USB port may require returning to the original port. It refuses a backup for a
different keyboard interface. `--probe` only queries protocol/lighting, `--inspect` reads the
embedded JSON without device enumeration, and `--self-test` uses an in-memory transport.

## Verification and pending acceptance

From the repository root:

```powershell
node --test apps/lighting-lab/tests/export.test.cjs
node apps/lighting-lab/tests/build-portable.cjs
```

The second command requires Windows and its .NET Framework C# compiler. It writes the EXE
and build evidence under ignored `.artifacts/lighting-lab/`, then runs `--inspect` and
`--self-test` only. The protocol/rollback checks cover every forbidden command, old/future
protocol rejection, byte offsets, backup-before-write, successful apply/save, partial write
rollback, readback mismatch rollback and bounded brightness quantization. They perform **zero
real HID writes**. Node tests additionally check all requested target gates, explicit opt-in,
full setup preservation, byte bounds, shell-free compilation, and compiler failure handling.

**Not yet verified:** communication with a physical AL65, its exact firmware revision,
the rendered built-in effect on that board, restoration after device disconnection, and
retention after USB power loss. A firmware Save acknowledgement and same-session readback
cannot prove power-cycle retention. The brother test must check these before this target
is considered hardware accepted. No firmware flashing is needed or proposed.
# Portable host-player addition: 2026-10-18

The executable export now has two explicit paths. Auto exports a Windows player for a present Razer
keyboard through the installed Chroma runtime. It embeds 128 shared-renderer frames at 46 ms intervals,
loops them while open, and optionally composes memory-only white reactions above them. Selected mouse
frames are included. It does not install Lighting Lab or Node, but it does not remove vendor-runtime
requirements. Unknown brands are reported as unsupported. AL65 remains the acknowledged built-in
firmware approximation described below; arbitrary per-key host animations cannot be saved through
those reviewed controls.

The explicit Apply path uses the documented [keyboard effect creation](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_03_keyboard.html)
and [SetEffect identifier](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_10_effect.html)
operations after fresh registration. These return controller status, without LED readback. A host player
also maintains the documented [session heartbeat](https://assets.razerzone.com/dev_portal/REST/html/index.html).
User-visible lighting and app priority therefore require separate acceptance.
