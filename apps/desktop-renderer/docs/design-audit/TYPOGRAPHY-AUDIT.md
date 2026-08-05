# m46.3 typography-rules audit

The layer beyond the ramp. m46.2 put every string on a named size, weight and
tracking step; it did not ask what each site's _role_ was. This audit does.

Numbered `T<rule>.<n>`, each with grep evidence or a screenshot. Baselines in
`docs/design-audit/typography-before/{light,dark}/` — the same nine surfaces,
both appearances, `E2E_DEVICE_SCALE=3`.

**Source verified in `~/Developer/sfora`, not taken on trust:**

| Claim                          | Verified                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Weight distribution            | `grep` over `src/components`: **337** medium / **107** semibold / **11** normal / **8** bold                      |
| Tracking values                | `tracking-[-0.02em]` ×17, `tracking-tight` ×15, `tracking-widest` ×3, `-0.01em` ×2, `-0.015em` ×1                 |
| Tabular numerals               | 59 component files use `tabular-nums`                                                                             |
| Reading rhythm (`.writer-doc`) | `globals.css` — 16px / 1.8 / -0.015em, `"kern", "liga" 0`                                                         |
| Ligatures off in mono          | `globals.css` — `pre, code`: `font-variant-ligatures: none`, `"liga" 0, "calt" 0`, with the box-drawing rationale |

The ligature rationale transfers directly: the source disables ligatures so
Box-Drawing characters and arrows survive (`-->` must not become `→`, `─` must
not split). A tmux front-end renders exactly that content in its chrome labels.

---

## Rule 1 — Weight discipline

**The finding: the ratio is inverted.** The renderer runs **30 semibold to 11
medium**; the source runs 337 medium to 107 semibold. m46.2 collapsed eleven
numeric weights into three named ones _by numeric proximity_ — everything ≥600
became semibold — which named the drift instead of removing it. Semibold is
carrying interface labels it should never have carried.

Correct today (9): true panel, dialog and display titles — `runtime-launch__copy h1`,
`runtime-state-card h1`, `home-canvas h1`, `fleet-sidebar__dialog h3`,
`mission-journey__detail h3`, `mission-journey__timeline h4`,
`command-palette__header h2`, `create-pane-flow__header h2`, `tmi-empty-state h2`.

| #     | Site (`styles.css:line`)                                 | Role                       | Is       | Should be                    |
| ----- | -------------------------------------------------------- | -------------------------- | -------- | ---------------------------- |
| T1.1  | `1422` `.workspace-chooser__heading`                     | uppercase micro-header     | semibold | medium                       |
| T1.2  | `1627` `.project-monogram`                               | now holds an icon, no text | semibold | (remove)                     |
| T1.3  | `1655` `.workspace-sidebar__project strong`              | row title                  | semibold | medium                       |
| T1.4  | `1868` `.fleet-sidebar__badge`                           | count badge                | semibold | medium                       |
| T1.5  | `1963` `.fleet-sidebar__dialog-confirm`                  | **button**                 | semibold | medium                       |
| T1.6  | `2579` `.agent-graph__group-label`                       | label                      | semibold | medium                       |
| T1.7  | `2707` `.terminal-surface--unavailable strong`           | state emphasis             | semibold | medium                       |
| T1.8  | `2831` `.terminal-surface__state strong`                 | state emphasis             | semibold | medium                       |
| T1.9  | `3092` `.mission-journey__list-region > header strong`   | region label               | semibold | medium                       |
| T1.10 | `3173` `.mission-journey__list button strong`            | **button** row title       | semibold | medium                       |
| T1.11 | `3382` `.mission-proof-grid strong`                      | value                      | semibold | medium                       |
| T1.12 | `3509` `.mission-journey__timeline li strong`            | list row title             | semibold | medium                       |
| T1.13 | `3749` `.workspace-changes__list-region > header strong` | region label               | semibold | medium                       |
| T1.14 | `3868` `.workspace-files__git`                           | meta label                 | semibold | medium                       |
| T1.15 | `3967` `.workspace-changes__status`                      | status label               | semibold | medium                       |
| T1.16 | `3999` `.workspace-changes__identity strong`             | row title                  | semibold | medium                       |
| T1.17 | `4102` `.workspace-changes__diff-header strong`          | header label               | semibold | medium                       |
| T1.18 | `4524` `.command-palette__group h3`                      | uppercase micro-header     | semibold | medium                       |
| T1.19 | `4745` `.create-pane-flow__eyebrow`                      | uppercase micro-header     | semibold | medium                       |
| T1.20 | `4829` `.create-pane-flow__kind-card > strong`           | card title (interactive)   | semibold | medium                       |
| T1.21 | `5248` `.mirror-pane-node__state strong`                 | state emphasis             | semibold | medium                       |
| T1.22 | `4648` `.create-pane-flow__trigger > span:first-child`   | **interactive trigger**    | regular  | medium                       |
| T1.23 | `737` `.titlebar__product-copy strong`                   | the wordmark               | semibold | _judgement — see exceptions_ |

**Count: 23** (21 demotions, 1 promotion, 1 removal; T1.23 held for review).
No `bold` exists in the renderer — that half of the rule already holds.

---

## Rule 2 — Tracking

**The pairing rule already holds**: every one of the 13 positive-tracking sites
is paired with `text-transform: uppercase`. The violations are the _values_, and
one site where negative tracking is applied to small text.

| #    | Violation                                                                                                 | Evidence                           |
| ---- | --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| T2.1 | `--sf-tracking-eyebrow` is `0.08em`; the rule's uppercase micro-header value is `0.04em` (13 sites)       | `styles.css` token                 |
| T2.2 | `--sf-tracking-display` is `-0.04em`; the rule's display/title value is `-0.02em` (3 sites)               | `styles.css` token                 |
| T2.3 | `--sf-tracking-tight` is `-0.01em`; the rule's value from headline up is `-0.015em`                       | `styles.css` token                 |
| T2.4 | `738` `.titlebar__product-copy strong` — negative tracking at **body-2 (13px)**, below the headline floor | negative tracking on small text    |
| T2.5 | `960` `.runtime-launch__brand` — negative tracking at body-2                                              | same                               |
| T2.6 | `1656` `.workspace-sidebar__project strong` — negative tracking at body-2                                 | same                               |
| T2.7 | `4446` `.command-palette__header h2` — negative tracking at body-2                                        | same                               |
| T2.8 | `2399` `.app-window-canvas__fleet-truncated` — caption-1 tracking on **non-uppercase** caption-2 text     | "nothing else gets letter-spacing" |

**Count: 8.**

**Contract conflict, flagged for the owner.** m46.2 mandated `caption-1` carry
`+0.15px` tracking. Rule 2 here says positive tracking is _only_ for uppercase
micro-headers and nothing else gets letter-spacing. These cannot both hold. The
newer rule is taken as authoritative and the caption-1 tracking token is retired
from use (T2.8 is its only consumer); `caption-2`'s tracking survives because
every caption-2 site that uses it is uppercase. Recorded rather than silently
reversed.

---

## Rule 3 — Tabular numerals

Two sites have it (`canvas-controls output` — the zoom readout, and
`command-palette__count`). Every other surface where numbers align down a column
or update in place does not.

| #     | Surface without `tabular-nums`                                                                 | Why it needs it            |
| ----- | ---------------------------------------------------------------------------------------------- | -------------------------- |
| T3.1  | `.workspace-sidebar h2 span`                                                                   | AGENTS / FLEET counts      |
| T3.2  | `.fleet-sidebar__badge`                                                                        | per-row counts             |
| T3.3  | `.mission-journey__list button time`                                                           | ages, updating in place    |
| T3.4  | `.mission-journey__detail > header time`                                                       | timestamp                  |
| T3.5  | `.mission-journey__timeline li time`                                                           | timestamps down a column   |
| T3.6  | `.mission-journey__timeline > header span`                                                     | counts                     |
| T3.7  | `.mission-progress small`                                                                      | progress numbers           |
| T3.8  | `.workspace-files__tree-region > header span`, `.workspace-changes__list-region > header span` | counts                     |
| T3.9  | `.workspace-changes__delta`                                                                    | +N/−N aligning down a list |
| T3.10 | `.workspace-files__preview-meta`, `.workspace-changes__diff-meta`                              | line counts                |
| T3.11 | `.activity-detail__facts dd`                                                                   | facts including ports      |
| T3.12 | `.titlebar__update-chip-version`                                                               | version numbers            |
| T3.13 | `.runtime-diagnostics li`                                                                      | port numbers               |

**Count: 13.** No utility exists in ui-system to apply it with.

---

## Rule 4 — Truncation discipline

31 rules already declare `text-overflow: ellipsis`, and the pane-frame title and
subtitle are fully correct (`overflow` + `ellipsis` + `nowrap`). Five sites are
not.

| #    | Violation                                                                       | Failure mode                                     |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| T4.1 | `.status-strip__connection span` — `ellipsis` with **no `white-space: nowrap`** | ellipsis never fires; text wraps in a 22px strip |
| T4.2 | `.status-strip__safe` — same                                                    | same                                             |
| T4.3 | `.status-strip__guidance` — same                                                | same                                             |
| T4.4 | `.titlebar__update-chip` — `nowrap` with **no `ellipsis`**                      | hard clip mid-word                               |
| T4.5 | `.workbench-dock__tab` — `nowrap` with no `ellipsis` (cross-package)            | hard clip mid-word                               |

**Count: 5.** T4.1–T4.3 are the wrap failure; T4.4–T4.5 are the mid-word clip —
the sibling failure named in the original polish findings.

---

## Rule 5 — Rendering

| #    | Violation                                                                                                                                               | Evidence                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| T5.1 | `-moz-osx-font-smoothing: grayscale` absent; only `-webkit-font-smoothing` is set                                                                       | `styles.css:524` is the only smoothing declaration   |
| T5.2 | `font-feature-settings: "kern"` absent from the app root                                                                                                | zero occurrences                                     |
| T5.3 | Ligatures not disabled for mono chrome — **32 mono call-sites**, one `font-variant-ligatures: none` (on `.tmi-technical`, which the shell does not use) | paths and commands can ligate; box-drawing can split |

**Count: 3.** T5.3 is the load-bearing one: this is a tmux front-end, and its
chrome labels carry the exact glyphs the source's rationale is about.

---

## Rule 6 — Prose exemption

Not a violation class; a note on where it _would_ apply. The only long-form
reading surface today is `.workspace-files__code` (the file preview), which
renders code, not prose — code must keep the mono voice and gets rule 5's
ligature treatment instead. **No surface in the renderer qualifies for the
reading rhythm today.** Recorded so the next markdown-rendering surface adopts
it deliberately rather than inheriting chrome type.

---

## Totals

| Rule                | Violations |
| ------------------- | ---------- |
| T1 Weight           | 23         |
| T2 Tracking         | 8          |
| T3 Tabular numerals | 13         |
| T4 Truncation       | 5          |
| T5 Rendering        | 3          |
| T6 Prose            | 0 (note)   |
| **Total**           | **52**     |

Zero remaining is the exit criterion.
