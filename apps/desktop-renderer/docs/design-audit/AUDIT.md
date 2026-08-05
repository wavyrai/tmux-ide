# m46.2 design-language audit

Zero-tolerance audit of the desktop renderer against the seven rules of the
m46.2 contract. Every item is numbered `R<rule>.<n>`, carries a file:line or a
screenshot reference, and is either fixed (with the commit that closed it) or
listed as an explicit exception with reasoning.

**Baseline evidence**: `docs/design-audit/before/{light,dark}/` — nine surfaces
per appearance, captured from the e2e harness at `E2E_DEVICE_SCALE=3` (retina,
the only density at which a 1px ring is distinguishable from a soft blur).

**What the v2 pass already landed** (and this audit does not re-litigate): the
depth ramp, the named shadow ladder (`--sf-shadow-*` → `--tmi-shadow-*`), the
radius and spacing ladders, the `--sf-text-*` type ramp, appearance-adaptive
tokens, the terminal carve-out. The v2 pass defined the vocabulary. This audit
is about the vocabulary not being *spoken* — tokens exist and go unused,
recipes exist and go unapplied.

---

## Rule 1 — Icons: Hugeicons, systematically

The renderer has no icon library. It has a hand-drawn substitute: 24 SVG path
strings authored by hand in `src/experience/dom-icons.ts`, at `strokeWidth 1.5`
on a `0 0 16 16` viewBox, plus a second ad-hoc set inlined in the canvas
controls. The contract's requirement is a real library at `strokeWidth 2`.

| #     | Violation                                                                                                                                                 | Location                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| R1.1  | 24 hand-authored icon path specs standing in for an icon library; geometrically crude at 3x (the `changes` and `missions` glyphs read as abstract marks)  | `src/experience/dom-icons.ts:35-128`                        |
| R1.2  | `strokeWidth: 1.5` hardcoded as the only weight; the contract's default is 2 (1.75 for large decorative)                                                   | `src/experience/dom-icons.ts:20,143`                        |
| R1.3  | Four ad-hoc inline `<svg>` canvas-control icons (`zoom-out`, `zoom-in`, `fit`, `reset`) bypassing the icon system entirely                                | `src/experience/app-window-canvas.tsx` (`CanvasControlIcon`) |
| R1.4  | A fifth inline `<svg>` in the ui-system showcase fixture                                                                                                    | `src/ui-system/showcase.fixture.tsx`                        |
| R1.5  | No `Icon` wrapper in ui-system — every call site re-specifies size/stroke, so the system is not swappable                                                   | `src/ui-system/` (absent)                                   |
| R1.6  | No size ladder. `DOM_ICON_USAGE_SIZES` has 16/18 only; the contract's ladder is 14 dense / 16 default / 20–24 surface headers / 28–40 empty states          | `src/experience/dom-icons.ts:3-9`                           |
| R1.7  | Sidebar section headers (SESSIONS / AGENTS / FLEET) are icon-less text                                                                                      | before/light `1-fleet-visible.png`                          |
| R1.8  | Fleet and session rows are icon-less — identity is carried by a bare status dot `<i>` with no glyph                                                        | `styles.css:1622-1652`; before/light `1-fleet-visible.png`  |
| R1.9  | No workspace identity component. The project monogram is a two-letter text tile (`E2`), not sfora's emoji → color dot → folder resolution                    | `styles.css:1506` (`.project-monogram`)                     |
| R1.10 | Degraded / recovery surfaces carry no icon — the state is signalled by a bare colored dot beside an uppercase eyebrow                                       | before/dark `5-degraded.png`                                |
| R1.11 | Empty-state / onboarding feature lists use colored bullet dots where the contract wants real glyphs                                                          | before/light `empty-fleet-onboarding.png`                   |
| R1.12 | Disclosure rows ("Advanced configuration", "Connection details") use the native `▶` marker instead of a chevron icon                                        | `styles.css:1186-1192`; both baselines                      |
| R1.13 | Status strip entries are icon-less (a mono `o` glyph stands in for a state icon)                                                                             | `styles.css:1378`; both baselines                           |
| R1.14 | Command palette rows have no icons; sfora's palette is grouped icon rows                                                                                     | `src/experience/command-palette.tsx`                        |
| R1.15 | The update chip has no icon                                                                                                                                  | `src/experience/update-chip.tsx`                            |
| R1.16 | Empty-state icon well is a bordered 38px box at an off-ladder size with an 18px glyph                                                                        | `ui-system/ui-system.css:534-549`                           |

**Count: 16.**

---

## Rule 2 — Controls are small physical objects

No control in the renderer implements the physical-object recipe. Primary
buttons are flat fills; the outline/control family has no crisp hairline plus
tight drop; disabled is an opacity multiplier, which the contract names
explicitly as the wrong mechanism.

| #     | Violation                                                                                                                        | Location                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| R2.1  | Primary button is a flat single-token fill: no vertical two-stop gradient, no `border-primary-dark` edge, no inset top highlight  | `ui-system.css:244-248`; both baselines |
| R2.2  | Primary hover swaps to a different flat token rather than brightening a gradient step                                             | `ui-system.css:274-278`                 |
| R2.3  | Primary pressed re-uses the base token — pressed does not flatten dark                                                            | `ui-system.css:294-296`                 |
| R2.4  | Secondary/outline control has no `0 1px 2px rgb(0 0 0/0.06)` tight drop and no `border-dark/70` hairline                          | `ui-system.css:250-253`                 |
| R2.5  | Disabled is `opacity: 0.64` (`--tmi-disabled-opacity`), not a flat grey color pair                                                | `ui-system.css:54,312-317`              |
| R2.6  | Danger variant fakes an edge with an `inset 0 0 0 1px` shadow on hover — an off-ladder shadow doing a border's job                | `ui-system.css:280-286`                 |
| R2.7  | Icon button has no resting elevation in any variant; it is a bare transparent hit area                                           | `ui-system.css:340-368`                 |
| R2.8  | Primary tabs use `!important` to force hover/active color and background, which makes the states unoverridable and off-recipe    | `styles.css:753-761`                    |
| R2.9  | Palette trigger is a bespoke control: its own border, its own `color-mix` fill, no shared recipe                                  | `styles.css:774-794`                    |
| R2.10 | Window-control buttons are a third bespoke control family (`border: 0; border-radius: 0`) with their own hover                    | `styles.css:727-734,805-830`            |
| R2.11 | Canvas control pill buttons are a fourth bespoke family with ad-hoc SVGs                                                          | `app-window-canvas.tsx`; baselines      |
| R2.12 | Workspace-chooser rows are a fifth bespoke button family                                                                         | `styles.css:1329-1362`                  |
| R2.13 | Transition lists include `opacity` and `transform`; the contract limits the 150ms transition to color/border/shadow              | `ui-system.css:197-202`                 |
| R2.14 | `.window-controls button` transitions are declared per-block rather than inheriting the shared control transition                 | `styles.css:817-820`                    |

**Count: 14.**

---

## Rule 3 — Focus: one utility

There is no single focus utility. Three distinct recipes coexist, and the
ui-system's version is bound to a selector list that new components must be
manually added to — a class that is open by construction.

| #    | Violation                                                                                                | Location                                            |
| ---- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| R3.1 | Focus ring implemented as an explicit selector list, not a utility class                                  | `ui-system.css:205-214`                             |
| R3.2 | A second recipe: `outline: var(--tmux-ide-focus-outline) solid var(--tmux-ide-border-focused)`            | `styles.css:50,2311`                                |
| R3.3 | A third recipe: `outline: 1px solid color-mix(… 52%, transparent)` — a 1px, half-transparent ring         | `styles.css:3030,3692,3830`                         |
| R3.4 | A fourth: focus expressed as a `box-shadow` ring instead of an outline                                    | `styles.css:2140,4341`                              |
| R3.5 | `outline: none` / `outline: 0` with no replacement affordance                                             | `styles.css:2053,4353`                              |
| R3.6 | No field-focus variant (offset −1) — fields use the same offset as buttons, so the ring clips inside rows | (absent)                                            |
| R3.7 | No invalid-field ring                                                                                     | (absent)                                            |
| R3.8 | Focus offset token defaults to 1px; the contract's ring is offset 2                                       | `ui-system.css:30`                                  |

**Count: 8.**

---

## Rule 4 — Border discipline

The strongest area of the v2 pass: 111 border declarations, and nearly all are
1px in the token family. The violations are the accent rails — 2px bars painting
emphasis rather than dividing.

| #    | Violation                                                                                     | Location                                                 |
| ---- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| R4.1 | `border-left: 2px solid var(--tmux-ide-status-warning)` — a 2px emphasis rail                  | `styles.css:3272`                                        |
| R4.2 | `border-left: 2px solid color-mix(… status-success 60% …)` — 2px, and a non-token mixed color  | `styles.css:3285`                                        |
| R4.3 | `border-left: 2px solid var(--tmux-ide-status-info)`                                           | `styles.css:3453`                                        |
| R4.4 | `border-left: 2px solid var(--tmux-ide-status-warning)`                                        | `styles.css:3942`                                        |
| R4.5 | `border-left: 2px solid var(--tmux-ide-border-attention)`                                      | `styles.css:4818`                                        |
| R4.6 | Empty-state icon well uses a border to paint card structure on a filled tile                   | `ui-system.css:540`                                      |
| R4.7 | Tooltip draws its silhouette with a border *and* a shadow — the ring should draw it alone      | `ui-system.css:388`                                      |
| R4.8 | Showcase split uses a border to paint a container box                                          | `ui-system.css:176`                                      |

**Count: 8.**

---

## Rule 5 — Shadows: named tokens only, rings mandatory

33 `box-shadow` declarations. The ladder is defined and aliased correctly; 11
declarations bypass it.

| #     | Violation                                                                                       | Location                          |
| ----- | ----------------------------------------------------------------------------------------------- | --------------------------------- |
| R5.1  | `inset 2px 0 0 color-mix(… border-focused 42% …)` — an ad-hoc inset accent rail                  | `styles.css:2132`                 |
| R5.2  | `box-shadow: 0 0 0 1px var(--desktop-focus-soft)` — an ad-hoc focus ring                         | `styles.css:2140`                 |
| R5.3  | `inset 2px 0 0 color-mix(… 36% …)` accent rail                                                   | `styles.css:3026`                 |
| R5.4  | `inset 2px 0 0 color-mix(… 36% …)` accent rail                                                   | `styles.css:3688`                 |
| R5.5  | `inset 2px 0 0 color-mix(… 36% …)` accent rail                                                   | `styles.css:3826`                 |
| R5.6  | `0 0 0 2px color-mix(… border-focused 16% …)` — a 2px soft ring, no crisp component              | `styles.css:4341`                 |
| R5.7  | `inset 0 -1px 0 color-mix(… text-muted 12% …)` — a hairline drawn as a shadow                    | `styles.css:4376`                 |
| R5.8  | `inset 2px 0 0 var(--desktop-focus-soft)` accent rail                                            | `styles.css:4422`                 |
| R5.9  | Multi-line ad-hoc composite shadows on the canvas surfaces                                       | `styles.css:2057,2458,2472,2477`  |
| R5.10 | Danger-hover `inset 0 0 0 1px color-mix(…)` edge (also R2.6)                                     | `ui-system.css:285`               |
| R5.11 | Tooltip uses `--tmi-shadow-raised` where the ladder has a dedicated `--tmi-shadow-tooltip`       | `ui-system.css:392`               |

**Count: 11.**

---

## Rule 6 — Typography: the named ramp only

This is the largest class by count and the clearest case of "tokens landed,
language didn't". The `--sf-text-*` ramp is fully defined at `styles.css:372-383`
and used **twice**. 129 ad-hoc numeric font-sizes remain in `styles.css`, plus 5
in `ui-system.css`.

| #    | Violation                                                                                                   | Count / location                     |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| R6.1 | Ad-hoc numeric `font-size` in `styles.css` against 2 named uses                                              | 129 (`styles.css`)                   |
| R6.2 | Ad-hoc numeric `font-size` in `ui-system.css` — the design system itself is off-ramp                          | 5 (`ui-system.css:191,232,394,553,563`) |
| R6.3 | 43 declarations at 9px/10px, **below** the ramp's floor (caption-2 = 11px) — no token exists for them         | 43 (`styles.css`)                    |
| R6.4 | 22 ad-hoc `letter-spacing` values where the ramp supplies `--sf-tracking-caption-{1,2}`                       | 22 (`styles.css`)                    |
| R6.5 | Ad-hoc weights off the medium/regular/semibold scale (`font-weight: 550`, `600`, `650`)                       | `styles.css:745`; `ui-system.css:194,555` |
| R6.6 | Chrome default is 13px/20px literal rather than `body-2` + its named leading                                  | `styles.css:451-452`                 |
| R6.7 | Section headers are not uniformly caption-2 uppercase with tracking                                          | `styles.css:1556-1574`               |

**Count: 7 classes covering 200+ declarations.**

---

## Rule 7 — Radius + spacing

Radius is close to clean after v2. The exceptions are decorative bars using raw
2px where `--tmi-radius-xs` exists, and the control radius token sitting at 4px
where the contract's control step is 8px (`rounded-lg`).

| #    | Violation                                                                                                | Location                                |
| ---- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| R7.1 | `--tmi-radius-control` is 4px; the contract's control radius is 8px (`rounded-lg`)                        | `ui-system.css:31,143`                  |
| R7.2 | Nav/list rows do not use the 10px (`2lg`) card/nav step the contract assigns them                         | `styles.css:1575` (`.sidebar-row`)      |
| R7.3 | Raw `2px` radii on the tab indicator and resize handle instead of `--tmi-radius-xs`                       | `ui-system.css:479,507,603`             |
| R7.4 | `border-radius: 0` on the shared tab/palette/window-control reset                                        | `styles.css:731`                        |
| R7.5 | Off-grid paddings on chrome controls (`padding: 7px 5px`, `padding-inline: 9px`, `margin: 0 9px 0 0`)     | `styles.css:724,782`; `ui-system.css:231` |
| R7.6 | Off-grid row metrics: empty-state icon 38px box, 13px margin, 6px/16px mixed gaps                         | `ui-system.css:534-570`                 |
| R7.7 | `.primary-tabs button` height 36px is off the contract's ~32px control density                            | `styles.css:738`                        |

**Count: 7.**

---

## Totals

| Rule                        | Violations |
| --------------------------- | ---------- |
| R1 Icons                    | 16         |
| R2 Control recipes          | 14         |
| R3 Focus                    | 8          |
| R4 Borders                  | 8          |
| R5 Shadows                  | 11         |
| R6 Typography               | 7 classes (200+ declarations) |
| R7 Radius + spacing         | 7          |
| **Total**                   | **71**     |

## Exit criterion

Every numbered item above is closed by a commit recorded in the fix map, or
appears in the exceptions list with reasoning. "Fewer" is not done.
