# Lighting Lab design decisions

This is a local effect editor with a small preset catalog, not a replacement device-driver suite.
The first screen should answer three questions: what keyboard is shown, what effect is selected,
and whether edits are reaching the physical device.

## Research assessment

| Principle | Existing behavior | Decision for this pass |
| --- | --- | --- |
| Visible system status | Native archive, SDK reachability, and current session were combined in a long status paragraph. | Keep live/preview/error state visible. An HTTP success or preview animation does not establish physical acceptance. |
| Match the real world | Four alpha rows, missing controls, duplicated numpad identities, wrapping numpad. | Render physical key geometry, casing, distinct switch IDs, and a model selector. Use a standard full-size layout when identity is unknown. |
| User control | Save and Apply meanings had drifted; settings needed repeated reconnects. | Changes stream live; Save downloads settings. Expose release/disconnect and separate native versus executable export limits. |
| Progressive disclosure | Cap inventory, lighting, recipes, and diagnostics competed for space. | Lead with keyboard and presets; keep physical cap planning and diagnostics available in advanced sections. |
| Recognition over recall | Users needed Studio concepts to choose effects. | Provide click-only presets, then independent background, reaction, and anchor controls. |
| Accessible controls | Small targets, animation without pause, color-only distinctions. | Visible focus, labels and pressed states, generously sized controls, preview pause, and reduced-motion support. |
| Honest capabilities | Every model looked equally supported. | Separate preview support, per-key/zone control, firmware built-ins, and persistent storage. Explicitly acknowledge AL65 whole-board approximations. |

The existing dependency-free HTML/Node approach remains appropriate for a local MVP. This pass
does not introduce accounts, a design-system package, a plugin marketplace, a cloud service,
an installer, or a cross-brand protocol invented from USB names.

## Sources and limits

- [Nielsen Norman Group: usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
  informed status, physical correspondence, consistency, user control, and recognition.
- [W3C: target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
  sets a 24 by 24 CSS pixel minimum subject to its exceptions. Larger controls are preferable here.
- [W3C: contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
  informs text/background choices; colorful simulated LEDs must not be the only selection cue.
- [W3C: pause, stop, hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)
  informs preview pause. Pausing the screen preview does not stop the physical keyboard effect.

These sources guide the implementation; they do not constitute an accessibility certification,
a usability study, or brother-test acceptance. Browser geometry/interaction checks and protocol
tests are separate from physical-keyboard and power-cycle checks.
