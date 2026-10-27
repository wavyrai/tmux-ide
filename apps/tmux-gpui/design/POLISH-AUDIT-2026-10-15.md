# Native polish audit — NP03

Source audit, 15 October 2026. This is an implementation target, not visual acceptance or a claim of Herdr parity.

- tmux-ide baseline: `21d3a17896f3211671db062da8187f20cb1cadfa` (main).
- Herdr reference: `f75df59eb53d69a11322f092eb3e45706b72db87`, fetched from `https://github.com/penso/herdr-gpui`. Clean, detached research checkout: `/private/tmp/herdr-gpui-research-20261011`.
- Imported Herdr baseline remains `302700e1486977092e4a9165bc083ecdc9236227`; the fetch did not update our derivative.
- Scope is current TUI Home, fleet, F5 and terminals. The browser/editor sequence in the historical `HERDR-DESIGN-RESEARCH.md` is superseded for this mission.

## Ranked implementation target

1. **One control vocabulary.** Extend existing `tmux_snapshot/controls.rs`, then migrate Home's action row first. Primary, quiet, destructive, selected, disabled and pending states should have consistent dimensions, icons, typography and feedback. Preserve existing command handlers and authority guards.
2. **Home and fleet hierarchy.** Make machine/server/session relationships and available actions readable at a glance. Reduce competing card chrome; retain explicit disconnected, empty and partially observed states. Reuse existing agent indicators rather than guessing activity.
3. **A coherent F5 popover and dialog family.** F5 already is a bounded popover. Improve its rows and machine dialog header/body/footer structure; retain search, IME, keyboard selection, focus return and stale-action refusal.
4. **Consistent navigation chrome.** Home/Terminals are application destinations; retained sessions and tmux windows are different navigation levels. Give them a coherent visual family without flattening those distinctions. Keep titlebar drag room, traffic lights and overflow reachable.
5. **Consistent appearance controls.** Themes already have specialized rows. Font selection should use compatible headings, current-selection treatment, samples and feedback; font discovery and application remain with their existing owner.

## Reuse matrix

Herdr source paths below are relative to `crates/tmux-ide-gpui/src/` at the exact reference above. tmux-ide owners are under `apps/tmux-gpui/upstream/crates/tmux-ide-gpui/src/` unless otherwise stated. Within a table cell, a bare filename after a `tmux_snapshot/` path shares that directory prefix; root-level owners are explicitly identified.

| Surface                      | Herdr reference                                                                        | Existing tmux-ide owner                                                                      | Decision and adaptation boundary                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Titlebar tabs and drag space | `titlebar/tabs.rs`, `titlebar/navigation.rs`                                           | `tmux_snapshot/workspace_chrome.rs`, `controls.rs`, `shell.rs`; root-level `titlebar`        | Adapt the geometry policy: upstream reserves 40 px drag room and relocates controls when the sidebar narrows. Reuse suitable layout helpers, not Herdr workspace/group navigation. Preserve our Home/Terminals actions.                                                                                                                             |
| Compact controls             | `titlebar/navigation.rs`, `menu/devices/add_device.rs`, configuration corner constants | `tmux_snapshot/controls.rs`                                                                  | Extend our existing 32 px controls with semantic variants. Upstream's macOS navigation pair uses 30×22 px segmented buttons; do not blindly apply toolbar density to every dialog. Copy isolated paint helpers only when they remove duplication.                                                                                                   |
| Sidebar rows                 | `sidebar/row.rs`, `sidebar/row/configured.rs`, `sidebar/agents.rs`                     | `tmux_snapshot/sidebar.rs`, `agent_indicator.rs`, `home/fleet.rs`                            | Adapt measured label budgeting, explicit icon slots and truncation. Do not import repository/worktree/GitHub state or activity ownership.                                                                                                                                                                                                           |
| F5 and result rows           | `menu/chrome.rs`, `palette/render.rs`                                                  | `tmux_snapshot/picker/render.rs`, `picker.rs`                                                | Adapt shell/row composition and search hierarchy. Herdr's palette uses a larger query and suppresses its preview below 840 px. Our F5 needs no new preview feature. Keep current revision checks, focus and command admission.                                                                                                                      |
| Machine dialogs              | `menu/devices/add_device.rs`, `menu/devices/host_menu.rs`                              | `tmux_snapshot/picker/machine.rs`, `machine_edit.rs`, `machine_remove.rs`                    | Reuse visual composition, status/action hierarchy and disabled treatment. Keep tmux-ide machine identity, trust, discovery and mutation paths. No replacement Herdr device service.                                                                                                                                                                 |
| Theme and font selection     | `theme_picker.rs`, `settings_window/controls/fonts.rs`                                 | `tmux_snapshot/picker/theme_style.rs`, `picker/fonts.rs`, `terminal_font.rs`                 | Adapt visual rows and selection feedback. Preserve tmux-ide theme IDs and local font validation. Hover-only presentation must not mutate terminal geometry.                                                                                                                                                                                         |
| Materials                    | `backdrop.rs`, `config/backdrop.rs`                                                    | `tmux_snapshot/glass.rs`, `glass/macos.rs`, `shell.rs`                                       | Upstream currently implements configurable backdrop transparency; it is not evidence of a reusable NSGlassEffectView implementation. Our derivative already has actual AppKit sidebar glass and opaque fallback. Retain that owner; any expansion must explicitly revise bounded geometry and accessibility handling. Keep terminal content opaque. |
| Pane controls                | `pane_menu`, `group_terminals`, `titlebar`                                             | `tmux_snapshot/pane_chrome.rs`, `pane_actions.rs`, `divider`, terminal input/geometry owners | Adapt icon alignment, hover affordances and compact action placement. Do not replace daemon resize, pane identity or input logic with Herdr commands.                                                                                                                                                                                               |

## Attribution and boundaries

The fetched Herdr root Cargo manifest declares Apache-2.0 and its LICENSE/NOTICE remain present. Its NOTICE attributes additional adapted sources and assets; preserve applicable notices for each copied module or asset. Record the source commit, files and modifications in `UPSTREAM-CHANGES.md` and derivative provenance when code is copied. This source audit itself copies no implementation code and does not replace the imported baseline hashes.

Zed remains a secondary architectural reference: shared components, tokens and predictable states. The previous researched Zed revision is `93d745668805029476e6d7fbb19652116fed51de`; its UI crate and GPUI crate have different license declarations. No Zed UI code or assets are imported by this audit. Verify the particular source's licensing before any future copy.

## Authority that polish must preserve

The current TUI's `runtime/application-home-experience.ts`, `application-home-fleet.ts`, `application-home-agents-owner.ts`, `application-machine-navigation.ts` and `palette-production-overlay.tsx` establish the workflow reference. Home projections preserve observation coverage and stable identity ordering; modal focus cannot leak into hidden sidebar controls. Native presentation must keep request/revision/capability checks and transport work outside render methods. Themes, headings and icons do not justify new daemon behavior.

## Visual baseline and acceptance still required

Capture a uniquely named isolated native preview, with private HOME/socket/session fixtures. Do not use a production-attached preview. Record the exact binary/source receipt with each capture. Required surfaces: Home with populated and disconnected fleet, two-pane terminal, F5, add/edit/remove machine dialog, themes and fonts. Capture 640×600, 1100×760 and 1440×900 logical-point windows, in light and dark themes. For materials, capture opaque fallback and supported native glass; do not substitute a screenshot for testing reduced-transparency policy.

No fresh screenshots have been captured for this audit yet. No Herdr GUI build was launched. Source comparison is complete; equivalent visual baselines and physical checks are outstanding. NP03 remains open. New controls should first appear in one isolated Home action-row preview before migrating every surface.

## Earlier GP cards

Sfora snapshot on 15 October still lists GP01 (#586) In progress and GP02–GP11 (#587–596) To do, despite much of that foundation being present and a public alpha existing. Do not recreate those features or close the cards from source presence alone.

- GP01–GP07 overlap the existing native entry, discovery, input, geometry, reconnect and history. Preserve their runtime/physical evidence and requalify affected paths in NP11–NP12.
- GP08 overlaps NP01 and NP12 qualification; NP01 remains blocked from integration until hosted lifecycle checks pass.
- GP09–GP11 overlap the published signed alpha, NP02 installer and NP12 next-release journey. Attach exact release/signature/install evidence before reconciling their statuses.
- GP12 (#597) performance remains deferred; visual polish does not prove a speedup.

This audit changes no prior card status. A closure ledger tied to exact evidence is still required during NP12.
