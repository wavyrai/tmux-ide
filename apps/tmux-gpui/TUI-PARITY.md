# TUI to GPUI parity checklist

Current priority: full TUI parity with a coherent native design system is the next
delivery goal. Proper icons, buttons, tabs, pane headers and sidebars are part of
parity acceptance, not a later cosmetic pass. Embedded browser and VS Code follow
this milestone; they must not displace missing TUI workflows.

Scope corrected by the user on 11 October 2026: the current TUI no longer includes
Files/editor or Changes. Do not implement those surfaces for parity or count them
as v1 blockers. The remaining product scope is fleet management and Home/F5
workflows. Preserve and regression-test the working terminal foundation, then
complete packaged-app and release qualification. Embedded browser/VS Code and
other earlier expansion ideas are deferred beyond this v1.

## Acceptance rule

For each item, record the TUI trigger and result, native implementation, automated
test, physical comparison and commit. Use the same isolated daemon/session fixture
for both clients. Exercise keyboard and pointer paths, normal and narrow windows,
unavailable data and stale selections. Keep daemon ownership and existing contracts;
GPUI owns presentation, not a second source of terminal or fleet truth.

## 1 Native shell and navigation

Present: Home/Terminals, session sidebar, window strip, pane headers, switcher and theme picker.
The first F5 slice adds searchable Home, Switch session, Appearance and Refresh
commands using the existing picker. It has keyboard/input-isolation tests and
physical light/dark verification. F1 Home, F2 Terminals and F6 session search now reuse the native tab/picker
owners, and the F5 list exposes Terminals and shortcut labels. Modified function
keys remain available to the terminal. F5 now floats in a centered popover over the unchanged view; shared control sizing
and theme treatments are consistent. F6 now shares this popover. Fleet-wide F7 is implemented and undergoing native
qualification; full TUI action vocabulary remains unfinished. See [`evidence/native-f5-popover-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-f5-popover-2026-10-11). Shared icon tabs and sidebar buttons landed in
`2b83924c`; see [`evidence/native-controls-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-controls-2026-10-11) and [`evidence/native-f5-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-f5-2026-10-11).

- [ ] Match TUI information hierarchy: machine, session, window, pane and agent status.
- [ ] Match Home search, machine filter, All/Working/Needs attention and jump-to-agent workflows.
      Native Home now filters loaded agents by name/session label and All/Working/Needs
      attention, preserving coverage, unavailable rows and identity/revision fences.
      Headless tests and physical light/dark checks are recorded in
      [`evidence/home-filters-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/home-filters-2026-10-11). Broader team/project/machine search, machine
      filters and remaining physical acceptance stay open. Home now supports `/`
      to focus search, `0` All, `w` Working, `a` toggle Attention, and Escape to
      clear/exit search. Modified keys, dialogs, search typing and marked IME
      retain their existing ownership; Workspace typing is not intercepted.
      Native physical qualification of these shortcuts is pending desktop unlock.
- [ ] Complete sidebar show/hide, grouping, overflow, long labels and keyboard navigation.
- [ ] Add full command palette with the TUI action vocabulary and contextual availability.
- [ ] Match help, shortcut reference and relevant user-facing connection diagnostics.
- [ ] Physically compare Home and Terminals at normal size and 640×400; no clipped controls.

## 2 Sessions windows and panes

Present: local discovery, selection, new sessions, pane rename/zoom/split and daemon-owned resizing.

- [ ] Complete pane close with confirmation and correct next-selection behavior.
- [ ] Audit every TUI window/session action, including new terminal window, against native controls.
- [ ] Verify external tmux changes immediately update selection, names, counts and layouts.
- [ ] Verify continuous horizontal/vertical resizing, minimum sizes, nested splits and zoom restoration.
- [ ] Verify DPI/fractional geometry and competing-client authority denial/restoration.
- [ ] Ensure every action targets the captured live identity and cannot affect a replacement pane.

## 3 Terminal interaction

Present: live multi-pane output, keyboard/paste, bounded history, selection and copy.
Physical full-visible-pane Unicode copy has exact-byte evidence; broader selection remains open.

- [ ] Qualify ordinary keys, modifiers, application shortcuts and terminal key forwarding.
- [ ] Qualify IME commit/cancel across focus loss, pane switching and denied input.
- [ ] Compare wheel/trackpad scrolling, history navigation and return-to-live behavior with TUI.
- [ ] Qualify historical selection, Unicode/soft-wrap boundaries and resize/topology invalidation.
- [ ] Audit TUI mouse reporting, alternate-screen scrolling, links and search; implement matching reachable behavior.
- [ ] Verify alternate-screen apps, cursor-only updates, colors, decorations and wide characters.
- [ ] Ensure no discarded input is replayed following disconnect or stale target recovery.

## Removed legacy scope

Files/editor and Changes are not current TUI surfaces and are excluded from this
milestone. External VS Code behavior already present must remain correct; building
an embedded editor, Git Changes UI or new integration is not required for v1.

## 6 Remote machines and agent activity

Native preview is primarily local; a local demo does not qualify fleet parity.

The Node connection owner is now reusable through
`@tmux-ide/daemon/connection-owner` (`createDaemonConnectionOwner`). The TUI retains
its telemetry adapter and consumes the same owner; the public subpath brings in
no TUI modules. This is a Node-only API and does not belong in host-neutral clients.
The existing multi-machine manager is now also shared through the Node-only
`@tmux-ide/daemon/machine-connections` subpath; the TUI retains its singleton and
telemetry adapter. The Home/multi-machine catalogs are also shared via the
Node-only `@tmux-ide/daemon/machine-catalog` subpath, retaining disabled stale rows
and per-machine identity scopes. The native `bridge/fleet.ts` adapter now projects
bounded, credential-free groups and issues exact-route selection tokens. Returned
selections retire on navigation, catalog failure or connection replacement.
Ordinary sessions without a workspace remain selectable for daemon promotion.
The agent observer, authenticated event transport and multi-machine aggregation
owner are now renderer-neutral under the daemon's Node-only `machine-agents`
subpath. TUI adapters retain selected-machine discovery and singleton defaults;
native callers must supply their manager. The default local GPUI browser now uses
that owner for foreground Home, with a globally bounded native roster and opaque
machine/session/agent keys. Opening validates fresh semantic/native ownership and
the captured route across asynchronous work. Private-host and Workspace rosters
retain their previous paths. See [`evidence/native-fleet-agents-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-fleet-agents-2026-10-11);
real cross-machine agent clicks and native physical acceptance remain open.
Local/remote discovery can resolve an explicitly selected server ID and generation;
private SSH host files now support that scope without reconnecting the transport.
The default local browser now owns the shared fleet manager and publishes groups
to native Home and the F5/F6 session picker. Selection uses the captured token and
the existing daemon promotion, pane catalog and input path. Private host-file
previews remain single-host and isolated. Machine filters, attention navigation,
real multi-machine SSH and release qualification remain open.

The bridge now has a tested `remote-route.ts` adapter that borrows one verified
SSH epoch, rejects stale inventory, and cancels on retirement. The browser now
accepts a private SSH machine file through `host-source.ts`, reuses the shared
owner on Home refresh, and clears its catalog/input/child when the route retires.
An isolated process fixture covers connection, refresh and disconnect; real SSH
and physical remote-terminal acceptance remain pending. A centered native SSH
dialog is available through F5, with a Local action that cancels pending discovery.
The bridge now exposes lazy local-registry read/save/edit/enable/disable/remove
commands using the shared daemon-owned persistence path. Stale revisions and
overlapping writes are rejected; uncertain replies are reconciled without replay.
UUID-based bridge routing landed in `50dd355c`. The native F5 saved-machine
picker now reads the shared registry, searches labels/SSH targets and submits the
captured UUID/revision; stale, disabled and unavailable rows cannot connect.
Dedicated headless checks cover selection fencing, command serialization, Escape,
input isolation and a failed read queue. The native Connect form now attempts a local save before dialing, preserves
existing saved UUID/pins, and reports an explicitly temporary connection when
persistence cannot be confirmed and no conflicting profile exists. Late save
results cannot reconnect after navigation cancellation. Native F5 **Manage saved machines** now exposes revision-fenced enable/disable
actions through the existing canonical registry mutation path. The dialog uses
authoritative pending/results rather than optimistic saved-state changes. Keyboard
dispatch and stale/pending/unavailable guards have headless coverage. Physical
macOS enable/disable now has native screenshots and separate-process persisted
registry reads in [`evidence/native-fleet-live-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-fleet-live-2026-10-11); restart restoration and
real SSH acceptance remain unqualified. Native edit/remove controls and physical
saved-picker/Add acceptance remain pending.
Reuse SavedMachineSchema and scoped clients;
never import the Solid navigation singleton or implement a second SSH stack.
Cancellation, child cleanup, sanitized failures, generation mismatches and late
completion after a machine switch must remain fenced through the native adapter.

- [ ] Native add-machine/SSH flow and machine/session grouping.
- [ ] Match retry, disconnect, unavailable-machine feedback and identity conflict diagnostics.
- [ ] Match remote session/pane selection, output, input and geometry authority.
- [ ] Match agent status, attention counts, search/filter and jump-to-pane behavior.
- [ ] Keep remote editor behavior explicit; never open a remote path as a local folder.

## 7 Settings and persistence

Present: theme picker. This is not the complete TUI settings surface.

- [ ] Verify all tmux-ide themes, accent colors and persistence across restart.
- [ ] Match notifications, quiet hours, updates/background refresh and crash-restore settings.
- [ ] Match keyboard reference and reset-to-defaults behavior.
- [ ] Match selection/layout restoration where supported, with live identity revalidation.

## 8 Native design acceptance

Use the TUI for product structure and Zed/Herdr for native interaction quality.

- [ ] Establish shared native design tokens: semantic colors mapped to all tmux-ide themes,
      typography, spacing, radii, borders, elevation and focus states.
- [ ] Build reusable Icon, IconButton, Button, Tab, PaneHeader, SidebarRow, Menu,
      Tooltip, Dialog and StatusBadge components; migrate existing chrome to them.
- [ ] Use one attributed SVG icon family with consistent optical size/stroke,
      accessible labels and tooltips; keep agent/product logos separate from action icons.
- [ ] Add a component gallery with light/dark, disabled, hover, selected and keyboard-focus specimens.

- [ ] Compact pane headers with title, selected state and discoverable contextual actions.
- [ ] Coherent tab strip, overflow and tooltips; distinguish app sections from tmux windows.
- [ ] Consistent spacing, typography, icon sizes and restrained status indicators.
- [ ] Correct titlebar/traffic-light alignment and useful translucent materials with readable contrast.
- [ ] Visible divider hover/drag state, keyboard focus and accessible control labels.
- [ ] Avoid permanent diagnostic text occupying normal workspace space; expose details on demand.
- [ ] Compare normal/narrow, light/dark, focused/unfocused and empty/loading/error specimens.

Zed references: its [panel system](https://zed.dev/blog/new-panel-system) separates
panes from docked panels and supports zoom; its [terminal documentation](https://zed.dev/docs/terminal)
shows panel versus center placement, tabs, scrolling and a breadcrumb toolbar.
Adapt these patterns to tmux-ide's Home/Terminals structure. Do not add Zed's entire
editor feature set to the parity milestone. Inspect the license of each source file
before any code reuse; Herdr's license does not cover Zed code.

## 9 Distribution acceptance

- [ ] Latest native and impacted daemon CI green, plus exact packaged-app checks.
- [ ] First launch can establish supported daemon connectivity without developer setup.
- [ ] Signing/notarization and clean-machine install, update, rollback and removal verified.
- [ ] Publish explicit supported capabilities and remaining limitations.

## 10 Embedded browser and VS Code

Deferred future product ideas, explicitly outside the current v1 milestone. The external VS Code
launcher does not satisfy this requirement. See [upstream research](HERDR-DESIGN-RESEARCH.md).

- [ ] Adapt Herdr browser tabs and native webview lifecycle to native workspace groups.
- [ ] Handle webview focus, resizing, overlay occlusion, navigation and close correctly.
- [ ] Embed VS Code web as a tab or side panel using the selected live workspace context.
- [ ] Adapt server discovery/supervision, loopback token authentication, readiness,
      failure/retry and shutdown; preserve explicit user acceptance of server terms.
- [ ] Keep browser/editor tabs client-owned and distinguish them from tmux windows/panes.
- [ ] Verify session switches, server exit, app exit and overlays without leaking
      terminal input or opening a stale/remote path as a local folder.

## Execution order

1. Complete fleet management: saved-machine list, add/save/edit/remove,
   enable/disable, selection and recovery, preserving daemon ownership and identity.
2. Complete Home/F5 workflows against the current TUI: machine grouping/filtering,
   agent attention/navigation, relevant commands and native dialogs/shared controls.
3. Run regression checks for the existing terminal/pane/window behavior and qualify
   real local/remote workflows without risking production sessions.
4. Complete packaged-app, install/update and preview-release acceptance.

Keep each implementation card narrow. Existing GP03–GP08 acceptance remains open
where its required evidence is missing. Older checklist items outside fleet/Home/F5
are historical audit ideas, not automatic scope additions or v1 blockers. Performance
comparisons remain a separate measured workstream.

## Source map

- TUI action inventory: `packages/daemon/src/tui/mirror/workspace/application-action-descriptions.ts`,
  `application-command-description.ts`, `pane-action-menu-model.ts`.
- TUI native-surface targets: `packages/daemon/src/tui/mirror/features/{home,files,changes,settings,rich-preview}`
  and `runtime/application-machine-*.tsx`.
- GPUI baseline and limits: `apps/tmux-gpui/README.md`, `INTEGRATION.md`, `VALIDATION.md`.
- GPUI native action implementation: `upstream/crates/tmux-ide-gpui/src/tmux_snapshot/pane_actions.rs`.

## Zed reference for native machine workflows

Inspected Zed main at `93d745668805029476e6d7fbb19652116fed51de` (11 October 2026).
Use these concrete patterns when completing native machine controls:

- A shared modal header/body/footer, with scroll confined to the body and stable
  action placement. Apply to Connect, Save/edit machine and removal confirmation.
  Source: [modal components](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/ui/src/components/modal.rs).
- Distinct list, server-options, edit and connection states. Keep saved UUIDs as
  authority; labels are display/search text. A connection form should not double
  as an implicit Save operation.
  Reference: [remote server modes](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/recent_projects/src/remote_servers.rs).
- A shared modal owner that captures previous focus, focuses the dialog, and
  coordinates dismissal. For tmux-ide, restore the previous valid focus without
  replaying input or accidentally granting terminal authority.
  Source: [modal layer](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/workspace/src/modal_layer.rs).
- Explicit disconnected presentation with a named target and deliberate recovery
  action. Adapt this to our shared connection-owner states and sanitized errors;
  never copy Zed's remote-server startup behavior into tmux-ide implicitly.
  Source: [disconnected overlay](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/recent_projects/src/disconnected_overlay.rs).
- Build dialogs, rows, buttons, icon actions and tab treatments from consistent
  native primitives instead of one-off styling. Verify keyboard/pointer parity,
  long labels, narrow windows, focus loss and pending-operation cancellation.

These are implementation/design references, not completed acceptance items.
No Zed application code was copied. Its `ui` crate declares GPL-3.0-or-later;
GPUI declares Apache-2.0. Keep source provenance explicit for any future reuse;
existing Herdr-derived controls and tmux-ide theme tokens remain our starting point.

## Disconnected fleet retry

Native Home cards and F5 expose Retry for disconnected SSH machines via the shared
connection manager. Per-route tokens reject removed/replaced targets; retry does
not change saved settings or navigation. Queue failure stays visible in the
command picker. Physical native interaction and real SSH recovery are still open;
see [`evidence/native-fleet-retry-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-fleet-retry-2026-10-11).

## Disconnect a fleet machine

Native Home and F5 now expose Disconnect through the same manager operation used
by the TUI machine sidebar (`application-machine-navigation.ts`). This pauses that
SSH connection without disabling/removing its saved profile or stopping remote
sessions. A one-use capability binds the exact live handle and endpoint epoch;
replacement/removal retires it. A catalog failure does not necessarily close the
SSH transport, so Disconnect can remain available beside an unavailable catalog.
Selected route retirement reuses the existing input/child retirement path. Real
remote SSH/PTY acceptance remains a separate gate.

## Design direction — 11 October comparison

Keep TUI information architecture and daemon authority. Adopt consistent native
components rather than translating each TUI action into a separately styled row.
Zed's `crates/ui/src/components/button` and `tab.rs` show reusable control families,
explicit selected states and reserved icon/action slots. Herdr's existing
`sidebar/row.rs`, `tokens.rs` and `wash.rs` provide measured label budgets,
primary/secondary/muted typography and restrained machine-group color.

Next visual acceptance should prioritize:

- One compact titlebar/navigation band, aligned with native traffic lights.
- Machine/session sidebar hierarchy with aligned status/icon slots, measured long
  labels and quiet contextual actions; selection and keyboard focus stay distinct.
- Consistent window tabs and compact pane headers; terminal content gets priority.
- Home as a fleet overview with aligned agent/session rows and useful empty/error
  states, replacing oversized disconnected sections.
- A centered F5 command palette with search, groups, shortcut hints, keyboard
  selection and explicit disabled actions; coherent machine dialogs.
- Shared spacing, typography, icon sizes, control heights and semantic colors
  across all existing tmux-ide themes. Apply macOS material to surrounding chrome
  only after hierarchy/contrast is sound; keep terminal backgrounds legible.

Sources inspected: https://github.com/zed-industries/zed/tree/main/crates/ui/src/components,
https://zed.dev/docs/appearance, https://github.com/penso/herdr-gpui and the vendored
Herdr modules above. These are design targets, not completed visual parity claims.

## Next Home/F5 parity increments after the first popover

Independent source comparison identified these concrete gaps. None is complete
merely because an equivalent-looking button exists:

1. F6/F7 now use the shared popover and scoped observation lifetime below.
   Remaining physical acceptance includes narrow/dark/IME and remote destinations.
2. F5 needs scoped machine/session/agent destinations and useful previews, beyond
   static commands and retry/disconnect (`application-shell-overlays.tsx`).
3. Home agent rows now have selected-row arrows, Page Up/Down, Home/End and
   Enter. Selection uses opaque keys and displayed roster revision; replaced rows
   cannot be opened before redraw. Physical nested-scroll/IME qualification
   remains distinct from headless controls.
4. Home needs machine filtering, observation Retry and Load more; connection retry
   is distinct. Reuse the shared observation owner rather than duplicating it.
5. Preserve machine/server/session hierarchy and qualify favorites/collapse, so
   duplicate session labels on different servers remain distinguishable
   (`application-machine-sidebar.tsx`).

Popover physical acceptance: normal/narrow Home and Workspace geometry; outside
click dismissal without underlying action/input; wheel isolation; marked IME and
paste ownership; Escape focus restoration without clearing interrupted-input
state; disabled/stale commands; light/dark contrast and resize while open.

### Fleet-wide F7 dependency

TUI F7 preserves the current view and filters enabled agent destinations by exact
`attention: true`. Native `homeAgents` is published only on foreground Home;
`workspaceAgents` covers the selected session. Neither is a global attention feed
for a popover over Workspace. Do not substitute a Home redirect, cached roster or
selected-session list for fleet-wide attention.

Add a bounded observation lifetime for the open F7 popover using the existing
fleet-agent owner. Admission must bind request, roster revision and opaque route
key, preserving fresh identity checks without weakening Home-only activation.
Retire on dismiss, background, navigation, connection retirement and shutdown.
Distinguish loading/unavailable/truncated from an empty attention result. Qualify
Home and Workspace, duplicate labels across machines, replaced routes, stale
revisions, dismissal/reopen, background during activation and no underlying
terminal input/resize. Existing Home Attention filtering also includes blocked
and failed states; F7 must use the TUI's exact attention predicate.

### F7 implementation qualification (11 October)

F7 now shares the native popover and fleet observation owner with Home. A scoped
subscription preserves Home/Workspace selection, input readiness and geometry.
Action admission checks foreground state, scope, roster revision, exact attention
flag and opaque live route; rejected actions retain the current terminal. Enter
submits navigation: once admitted, dismissing observation does not undo navigation.
Explicit newer navigation supersedes it with a higher request. Loading, partial,
unavailable and truncated coverage remain distinct from no observed attention.

Independent source review passed; the full bridge gate passed 333 tests with five
explicit skips, and an isolated real-daemon test verified workspace preservation
and correlated rejection for invalid scope/revision/key. Native workspace gates passed (2866 default / 2900 all-feature tests, both
Clippy configurations, formatting, size and debug build). Physical light-theme
Home and Workspace agent activation, paste isolation, outside dismissal and
unchanged pane dimensions passed. F7 narrow/dark/OS-IME and remote acceptance
remain open; this is not released parity. Discovered fleet agent admission was
subsequently added in c8c1efca and physically qualified for Home/F7 with exact
keyboard/paste delivery to duplicate-label second panes; see
[`evidence/native-agent-admission-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-agent-admission-2026-10-11). Original F7 evidence:
[`evidence/native-f7-attention-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-f7-attention-2026-10-11).

### Next observer recovery slice

TUI Home observation Retry / Load more delegates to resident `machine-agents`
`retry()` / `loadMore()`; the latter expands each observer by 32 sessions. Native
Retry connection already exists and is a distinct operation. Add captured
Home request/revision recovery commands through the shared fleet-agent owner,
with truthful availability and unchanged F7 subscription, search and selection.
Qualify observation failure recovery without reconnecting healthy machines,
more than 32 sessions, and stale/background rejection. This does not resolve the
separate 256-row publication cap. Machine filtering must use exact machine identity
before truncation, recompute Home coverage, and leave global F7 scope unchanged.

## Home observation recovery checkpoint — 11 October 2026

Native Retry observations and Load more sessions now use the shared observer,
including r/m shortcuts fenced from search/IME/modal input. Physical local macOS
Load more32→33 retained search and selection; shared F7 and unchanged tmux source
are verified by the real-process fixture. Evidence: [evidence/home-recovery-2026-10-11/](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/home-recovery-2026-10-11).
Unavailable-source Retry, physical shortcuts, narrow/dark/IME and remote acceptance
remain open. Prerequisite owner fixes fb008a99 and458143b6 remove polling starvation
and legacy full-fleet discovery during semantic subscriptions. No full-parity or
release checkbox is closed by this checkpoint. Next Home work remains exact-machine
filtering and clearer fleet/agent hierarchy.

## Home exact-machine filtering — 11 October checkpoint

Native Home now cycles All/published machines with `f` or the shared icon button.
The bridge projects the selected machine before its row cap and retains routes for
both Home and global F7; duplicate labels are not identities. Current request,
roster revision, acknowledged foreground presence and modal guards remain enforced.
Machine removal resets All. Search/activity selection is retained.

Independent review, bridge346/5optional skips, real private two-session smoke and
full native gates passed; see [`evidence/home-machine-filter-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/home-machine-filter-2026-10-11). Physical
filter acceptance remains open because the user took over the isolated QA app.
This supersedes earlier implementation-gap statements about machine filtering,
without closing the broader Home/fleet acceptance checklist.

## F5 pane actions — 11 October checkpoint

Workspace F5 exposes Zoom/Unzoom pane, Split right and Split down through the
existing captured pane-action capability. Queue refusal leaves the picker open;
stale tokens and callbacks from a replaced picker cannot dispatch. Terminal input
is not rearmed and the tested canvas stays unchanged. Independent review, focused
202 native tests, both full workspace configurations, both Clippy configurations,
format/size checks and debug build passed. Physical F5 pane-action QA remains open.
See [`evidence/native-f5-pane-actions-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-f5-pane-actions-2026-10-11); this does not close the full
F5 action-vocabulary or release acceptance checklist.

## Exact fleet-server navigation — 11 October checkpoint

Commits `2d889407` and `5ca94577` add retained-empty-server catalog handling and
native machine/server/session navigation. Home and F5/F6 use opaque exact server
routes; New session identifies its machine/server destination. Ordinary sessions
remain navigable when bounded server metadata is omitted, but creation requires
an explicitly published current destination.

The full private bridge workflow passed with two genuinely empty duplicate-label
servers: select the second by identity, create exactly one session there, preserve
the first empty server and source session identity/geometry/stamps. Failed-before
and passing-after evidence, independent reviews and source hashes are in
[`evidence/fleet-server-navigation-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/fleet-server-navigation-2026-10-11) and
[`evidence/empty-server-owner-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/empty-server-owner-2026-10-11). Bridge 354 passed/5 optional skips;
native focused 207 and both full workspace configurations passed, as did both
Clippy configurations and the debug build. Physical native server selection and
creation, remote SSH and packaged acceptance remain open. This supersedes the
implementation gap for server hierarchy, not the broader physical checklist.

## Next Home context/search slice

Current TUI `application-home-fleet.ts` searches agent, team, harness, project,
session, machine and server names. Native `bridge/home-agent-publication.ts`
currently retains only agent and session labels, and `home/filters.rs` searches
only those. Reuse existing shared HomeAgentRow metadata as bounded display/search
fields and show machine/server context without changing opaque navigation keys or
admission. Verify context-only queries, duplicate labels, absent metadata, stale
selection and narrow layouts. This is a current Home parity gap; embedded editors
and legacy project-launch surfaces remain outside v1.

## Saved-machine removal checkpoint — 11 October

F5 Manage saved machines now exposes Remove through the existing canonical local
registry API. Confirmation displays captured label/SSH target and binds UUID,
revision, browser request and a unique modal identity. Queue acceptance is not
success; registry publication drives the result, and uncertain replies are never
replayed. This adds a native management control over an existing API, not a port
of a production TUI remove dialog. Saved-machine editing remains unimplemented.

Evidence: [`evidence/native-machine-remove-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-machine-remove-2026-10-11). Independent review approved;
211 focused native tests, full default/all-feature workspace suites, both Clippy
configurations, format/size/debug build and bridge gate (356 pass/5 optional skips)
passed. Actual isolated browser/canonical HTTP handler verifies registry removal;
manager-level tests verify selected-route retirement and sibling preservation.
Real remote SSH and physical macOS dialog acceptance remain open. Registry
revision is local preflight, not daemon-side atomic compare-and-swap. User demos
and actual saved profiles were left untouched.

## Home agent context/search checkpoint — 11 October

Home and F7 now search agent, team, harness, project, session, machine and server
names using a whole-query substring within each field, matching the current TUI
field vocabulary. Five optional display fields use the existing shared metadata,
control stripping and 160-Unicode-scalar bounds. Machine/server/session context is
shown on Home rows and F7 choices; plain session labels are no longer prefixed with
machine names. Opaque keys, captured scope/revision and availability remain the
navigation authority. Missing metadata remains compatible.

The isolated two-session daemon smoke verifies exact Home/F7 context before and
after machine filtering with unchanged source identity/geometry/stamps. Native
headless coverage includes context-only queries over duplicate agent labels,
stale F7 revision refusal, optional/invalid fields and 520px layout with maximum
length Unicode context plus a real simulated Open click. Physical light/dark,
OS input and remote checks remain distinct and open. See
[`evidence/home-agent-context-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/home-agent-context-2026-10-11) for exact final gates and source hashes.
This supersedes the preceding context/search implementation gap, without claiming
full Home/fleet parity or release readiness.

## Packaged Home/fleet checkpoint — 11 October

The fresh release-mode development app at source96e1ecc6 passed five artifact/
compatibility checks. Maintained Home machine-filter/context and empty-server
creation fixtures now support strict explicit packaged-app mode: bundled Node and
browser, private scratch cwd, no source fallback. Source and exact-package paths
both passed with unchanged source sessions. Evidence and exact artifact hashes:
[`evidence/packaged-fleet-home-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/packaged-fleet-home-2026-10-11). This narrows the packaging gap for those
bridge workflows only; no native UI, real remote SSH, signing or install/update
acceptance is claimed. Saved-machine removal is still source-process qualified.

## Home/fleet CI wiring — 11 October

Source Linux and exact-package macOS Home/fleet journeys are now wired into the
GPUI workflow, with fresh private CLI builds and retained failure logs. macOS
builds the pinned patched tmux in a private directory. The exact journey step
passed locally against existing qualified artifacts; a new hosted run is still
required. This does not close native UI, remote SSH or release acceptance. See
[`evidence/packaged-fleet-ci-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/packaged-fleet-ci-2026-10-11).

## Saved-machine editing checkpoint — 11 October

F5 → Manage machines now includes Edit for each saved connection. The native
form edits label and SSH target through the existing canonical registry API;
UUID, enabled state and environment identity pin are preserved. Captured profile,
revision, browser request, foreground presence and per-dialog identity prevent
stale writes. Unchanged fields do not queue a write; changed fields show success
only after a newer settled matching registry publication. Typing, Tab, IME
isolation and hidden-list key isolation reuse native input ownership.

Headless coverage includes real typing/Tab/Enter, 640×400 dialog bounds, rendered
pending/confirmed states and stale/reopen/queue guards. An actual browser plus
canonical HTTP handler verifies exact private-file editing, sibling/pin retention
and duplicate refusal. See [`evidence/native-machine-edit-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/native-machine-edit-2026-10-11) for gate
results and source hashes. Physical pointer/IME, real SSH and exact packaging of
this newer native binary remain unqualified. The active user demo is unchanged.

## Packaged machine-management checkpoint — 11 October

A fresh release-mode app including native saved-machine editing passed seven
artifact/compatibility and exact-bundled Edit/Remove checks. The packaging gate
now runs those canonical HTTP/private-registry journeys automatically; explicit
invalid packages fail before fixture allocation. This supersedes source-only
Edit/Remove bridge qualification, but does not claim physical native form or real
SSH acceptance. Evidence: [`evidence/packaged-machine-edit-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/packaged-machine-edit-2026-10-11).

## New terminal window checkpoint — 11 October

F5 New terminal window and the fixed window-strip + button use the existing
scoped daemon creation API. Captured identity, presence and authority checks
prevent stale or duplicate creation; selection follows only a verified receipt
and fresh canonical topology. New-window navigation exposed a daemon controller
cleanup defect, fixed separately in `09f2d651` without weakening input admission.

Native focused/workspace/all-feature tests, both Clippy configurations and build
passed. The bridge passed 372 tests (five explicit skips). Source and exact
packaged real-tmux journeys both prove one new window, input delivered to its
exact pane, preserved source identities and duplicate/stale refusal. The fresh
development app passed all seven packaging checks. CI now runs the creation
journey on Linux source and macOS packaged bridges. Evidence:
[`evidence/new-window-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/new-window-2026-10-11) and [`evidence/controller-release-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/controller-release-2026-10-11).
Physical pointer/F5/narrow-window acceptance remains open; the user's active
demo is unchanged. Pane close confirmation and harness creation remain gaps.

## Close pane checkpoint — 11 October

F5 Close pane now opens an explicit captured-target confirmation with Cancel
and destructive-action icons. Old callbacks, changed targets, backgrounding and
duplicate confirmation cannot dispatch a close. The surviving bridge owns the
daemon response, verifies exact removal and uses fresh canonical topology to
select a surviving active pane. The daemon still refuses the last session pane;
an unconfirmed close requalifies only the original pane, without replaying it.

Both source and exact packaged journeys cover same-window panes and closing a
nonlast window, with actual survivor input, preserved sibling identity and usable
input after last-pane refusal. New-window regression also passes. Native gates:
220 focused, 2,900 default and 2,934 all-feature tests; both Clippy configurations,
format, size and build passed. Bridge: 381 passed, five explicit skips. Packaging:
seven passed. Evidence: [`evidence/close-pane-2026-10-11/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/close-pane-2026-10-11).

Physical confirmation/pointer/IME acceptance remains open. Existing user demos
are unchanged. New agent, Help, Keyboard shortcuts and What's new remain missing
F5 workflows; real remote acceptance and signed release qualification remain open.

## Native font and shortcuts checkpoint — 12 October

F5 now includes a searchable Keyboard shortcuts reference and Terminal font
picker. Font family and size persist independently of Herdr settings. Native
save/restart qualification passed for Menlo 15, with zero terminal input bytes
and source-process survival; exact-package checks passed. See
[`evidence/terminal-font-2026-10-12/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/terminal-font-2026-10-12) and [`evidence/shortcuts-native-2026-10-12/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/shortcuts-native-2026-10-12).
This supersedes the earlier statement that Keyboard shortcuts is missing.
Help, What's new, new-agent workflows, broader remote/native acceptance and
release qualification remain separate gaps. An intermittent runtime-failure
observed during an earlier font fixture is still unexplained; a successful fresh
run is not a fix for that observation.

## Help and preview changes checkpoint — 13 October

Local commit `606edc7d` adds F5 Using tmux-ide and What's new, sharing searchable
reference popovers and Escape-to-Commands. Informational paragraphs wrap;
composing Commands search text cannot be discarded by retained reference-entry
callbacks. The exact composition regression failed before the guard and passed
after it. All 77 focused picker tests passed, along with both Rust workspace
configurations and Clippy checks.

The optimized macOS artifact passed a synthetic Home visual check for readable
wrapping, final-paragraph keyboard reveal, search and Escape. No terminal input
was emitted. Physical narrow-window, Workspace and OS-composition checks remain
open; attempted edge drags did not change the QA window dimensions. Evidence:
[`evidence/help-reference-2026-10-13/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/help-reference-2026-10-13). This supersedes the missing-implementation
claim for Help/What's new, without closing complete F5 or release acceptance.

The downloadable local unsigned alpha build 2026101302 predates this increment.
All development and runners currently remain local; no hosted CI, publication or
Sfora update is authorized by the current local-only working preference. Session
sidebar keyboard focus/navigation is the next bounded implementation slice.

## Native Home fleet preferences checkpoint — 13 October

Home now exposes persistent favorites and machine collapse using the existing
local daemon resource. Duplicate labels use canonical IDs; collapsed machines
retain favorite and active sessions. Commands are explicit, revision-scoped and
acknowledged, with no selected-SSH persistence or terminal input.

Bridge gate456pass/5optional skips; native default2945pass/10ignored and
all-features2979pass/17ignored; formatting/file-size/bothClippy passed. Actual
native star/collapse/expand clicks passed against a private authenticated resource
and storage fixture, including exact writes and no input. See
[`evidence/fleet-preferences-2026-10-13/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/fleet-preferences-2026-10-13). First launch remained inactive/Loading;
identical second launch passed. That activation failure, physical narrow layout,
and full canonical-daemon/TUI reload acceptance remain open. This is local branch
work, not a published or distribution-qualified alpha.

The subsequent real canonical-daemon round trip also passed: native
favorite/collapse → actual compiled TUI startup → TUI expand/unstar → TUI restart
→ native explicit Refresh. Exact pane identities survived; owned cleanup passed.
Fresh CLI/TUI artifacts and captured TUI screens are recorded in the same evidence
folder. An initial inactive-presence run remains recorded and unresolved; no
instant synchronization or physical narrow-window claim is made.

### 13 October: F5 direct navigation

Native F5 now searches published sessions and the agents available on the current
screen. It preserves exact targets behind duplicate names, displays machine/server
context, searches agent project/harness/team metadata, and rejects callbacks from
a replaced popover. Reviewed commit `d02c27da` passed both workspace test modes and
strict Clippy configurations. A private native fixture verified exact session and
agent command dispatch through the visible F5 popover; see
[`evidence/f5-direct-navigation-2026-10-13/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/f5-direct-navigation-2026-10-13). This was a synthetic routing check,
not a live daemon/terminal admission test.

Full fleet-wide agent search from Workspace remains open: its current roster is
selected-session scoped, and Home still uses its existing machine filter. The
follow-up must reuse the shared fleet observer with bounded target retention and
request/scope/revision checks. Narrow-window acceptance and the earlier intermittent
activation issue also remain open. The downloadable alpha has not been replaced.

### 13 October: F5 observed-fleet search

Local commit `b0df3146` adds query-scoped fleet agent search from Home and
Workspace using the existing shared observer. Matching happens before the
256-row cap; the UI exposes observation/omission counts. Query replacements
retain a single subscription and invalidate stale targets immediately.
Request/scope/roster/presence checks and existing daemon admission remain owners
of navigation. Older helpers retain contextual agent fallback.

Bridge gate: 468 passed / five optional skips, plus seven final query tests.
Native: 2,960 default and 2,994 all-feature passes, both Clippy configurations,
format and size checks. Real native F5 query replacement selected synthetic
agent-299 beyond the initial cap, displayed the correlated destination, emitted
no terminal input, and exited cleanly. Ten exact-package checks passed. See
[`evidence/f5-fleet-search-2026-10-13/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/f5-fleet-search-2026-10-13). This is observed-roster search, not proof
of unobserved-session discovery or live remote fleet admission.

Remaining parity includes the full Workspace fleet tree and visited-session
history. Narrow layout, broader physical IME/remote checks, intermittent
activation and signed clean-machine installation remain open.

### 13 October: Workspace fleet sidebar and local alpha09

Commit `528c78cd` renders machine/server/session hierarchy with acknowledged
machine collapse, favorites and exact scoped keyboard navigation. It retains
active/favorite sessions when collapsed and keeps unknown-scope catalog fallback
conservative. This does not yet add a full cross-session fleet-agent tree.

Native gates passed: 289 focused, 2,969 default and 3,003 all-feature tests;
format, size and both strict Clippy modes. Evidence commit `9a61a499` preserves
a corrected-scope synthetic native journey, selecting the second identically
named session on a different server. Expand/collapse and accepted pane display
passed after keyboard activation. An earlier mouse-only activation failure is
preserved, not resolved or excluded from the record.

Unsigned local alpha build2026101309 includes this slice and F5 observed-fleet
search. Ten packaged tests passed, and all22 regular archive files match the
assembled app. It requires an existing local daemon and is not signed, notarized
or qualified on a clean Mac. Older alpha builds remain available. No publishing
or production daemon changes occurred. See
[`evidence/workspace-fleet-sidebar-2026-10-13/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/workspace-fleet-sidebar-2026-10-13).

Remaining: cross-session Workspace agent tree, visited-session history, activation
diagnosis, narrow/IME/remote qualification and signed install/update acceptance.

### 13 October: acknowledged session history and local alpha10

Commits `eed9e807`, `b4ed0c99` and `92a07ae3` implement F8 Back / Shift-F8
Forward using daemon-persisted canonical visits and fresh target revalidation.
Visits advance only after a current live frame gains input readiness. Rejected
history admission retains the displayed terminal. The catalog-to-pane handoff
now survives intentional metadata-helper retirement; the first real smoke
exposed and reproduced the missing Forward action before this repair.

Native default/all-feature gates passed 2,974/3,008 tests (10/17 existing ignored),
format/size/both strict Clippy checks passed, and a qualified optimized build
passed the physical synthetic rejection → Back → Forward journey. The source
bridge with a real private canonical daemon passed the same navigation plus
persisted visits and unchanged pane identities. Bridge: 494 passed, five optional
skips. Ten exact-package checks and all 22 archived-file comparisons passed.
Evidence: [`evidence/session-history-acceptance-2026-10-13/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/session-history-acceptance-2026-10-13); package evidence
commit `010834bd`. Unsigned local alpha `2026101310` includes these controls.

This supersedes the missing history implementation statement above. Native GUI
and real-daemon history were checked separately; combined packaged native/remote
acceptance remains open. The activation trace narrowed automated failures to
AppKit-inactive delivery, not a proven missing presence ACK, and does not claim
a fix for normal Finder launch. Full cross-session Workspace agent hierarchy,
narrow/IME/remote checks and clean-machine signed install/update remain open.
The existing daemon remains required. No hosted runner or release was used.

### Current remaining workflow audit — 13 October

Alpha1310's bundled bridge now also passes the real private canonical-daemon
history smoke, without source fallback. Native GUI and daemon checks remain
separate. See the same session-history evidence folder.

Source comparison identifies two substantive missing workflows: persistent
Workspace cross-session fleet-agent rows (TUI `application-machine-sidebar.tsx`
and `application-machine-navigation.ts`) and retained session tabs with F9 /
Shift-F9 / Ctrl-F9 (TUI `application-fleet-tabs.ts`). GPUI tmux-window tabs and
F5/F7 agent search do not substitute for either. A bounded shared-observer roster
and exact session navigation targets should reuse existing admission paths; do
not create background terminal owners or reinterpret tab close as session kill.

The base TUI F5 command vocabulary is represented in native source; older blanket
missing-palette claims above are superseded. The native shortcut reference still
needs F8/Shift-F8 plus sidebar collapse/favorite guidance. Physical/remote checks
remain acceptance gaps even where implementation exists.

### Workspace fleet-agent implementation — 13 October

Bridge commit `1ec81f6f` adds persistent cross-session Workspace agent publication
and exact scoped navigation using the existing shared observer and admission.
It retains a separate bounded projection so F5 query/cancel cannot evict sidebar
targets, and revalidates native/daemon incarnation before selected-row display.
The reviewed source bridge passes 503 tests (five optional skips), typecheck,
lint, and an isolated canonical-daemon two-session switching fixture. That fixture
preserves source pane identities and sends no terminal input.

The native sidebar implementation is independently reviewed, with 303 focused
tests passing. Regression evidence covers focus across roster revision updates
and overlapping F5/F7 submissions. The keyboard reference now documents existing
F8/Shift-F8 and sidebar collapse/favorite shortcuts. Broad native gates now pass: 2,983 default / 3,017 all-feature tests (10/17
existing ignored), format, size and both strict Clippy configurations. Rendered
acceptance and a new package are pending; alpha1310 does not contain this slice.
See [`evidence/workspace-fleet-agents-2026-10-13/`](https://github.com/wavyrai/tmux-ide/tree/a0cff52add18dfdf9d4acbf3ec40a44c7542b7cd/apps/tmux-gpui/evidence/workspace-fleet-agents-2026-10-13) for the exact evidence and limits.
Retained session tabs, combined native/remote validation, activation and signed
clean-machine install/update acceptance remain open.

### Local alpha1311 qualified — 13 October

Native sidebar commit `33109b26` now has a qualified optimized build and physical
synthetic acceptance: duplicate agent context/status/coverage displayed, exact
Machine B selection reached the intended pane and selection, then owned cleanup.
The first fixture omitted fleet context and failed; the correction and both
receipts are retained. Native QA used Ctrl-G activation and does not prove normal
Finder launch. Long context labels ellipsize; broad narrow-layout QA remains open.

Local unsigned alpha `2026101311` passed ten exact-package checks and the bundled
bridge's real isolated canonical-daemon switching fixture, without source fallback.
All 22 regular archived files match the assembled app. Native and daemon checks
remain separate; combined remote, signed/clean-Mac install/update acceptance and
retained session tabs remain open. See the Workspace fleet evidence directory.

### Retained session tabs in validation — 13 October

Bridge `cbb8ce9f` retains up to eight accepted session identities without additional
terminal owners. It publishes exact activation/close capabilities, unread/activity
from shared observations, and the TUI's F9/Shift-F9/Ctrl-F9 behavior. Inactive close
preserves the current terminal; active/pending close returns Home without killing
tmux sessions. The same real-daemon fixture passes these paths and original pane
identity checks after fixing capability invalidation during badge refresh.
Bridge: 511 tests passed, five optional skips, typecheck/lint and review passed.

Native strip, controls and shortcuts are source-reviewed with 311 focused tests
passing. Full native gates pass (2,991 default / 3,025 all-feature tests, 10/17
existing ignored, format, size and both strict Clippy configurations). Native
synthetic physical QA verified F9 activation, pointer-close of the inactive tab
with the current frame preserved, and Ctrl-F9 returning Home. The first attempt
sent a second F9 before observing the first switch; its failure receipt is
preserved alongside the unchanged passing rerun. Ctrl-G activation was used,
so normal Finder launch remains unqualified.

Local unsigned alpha1312 is assembled from native commit `f1dd38b0`. Ten exact
package checks and the packaged bridge real-daemon tab fixture pass, including
original pane identity preservation and owned cleanup. Combined native GUI and
real daemon testing found a release blocker: F9 reaches the completed catalog
but the native client does not send its preferred-pane continuation, remaining
in Opening. A diagnostic-only rerun confirmed this seam. Alpha1312 is therefore
not qualified for distribution; alpha1311 does not include retained tabs.
Evidence: retained-session-tabs-2026-10-13. No full-parity, remote or signed
clean-Mac acceptance claim is made.

### Session admission continuation repair — 13 October

Combined native/daemon evidence exposed a missing native preferred-pane
continuation after retained-tab admission. History navigation had the same gap.
The reviewed repair extends the existing one-shot session-open intent to an
acknowledged request, preserving exact-session navigation and cancellation.
Closing tabs and directly accepted live frames do not arm a continuation.
Both regressions fail before the fix; 319 focused tests pass after. Full gates
pass: 2,999 default / 3,033 all-feature tests (10/17 existing ignored), format,
size and both strict Clippy configurations. Evidence: session-continuation-2026-10-13.
Rebuilt native-plus-daemon verification remains required; alpha1312 stays
unqualified. User is testing the current preview, so UI automation is paused.
