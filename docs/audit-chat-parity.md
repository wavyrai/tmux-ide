# Chat Surface Feature-Parity Audit

**Scope:** Compare our chat implementation (`packages/chat-solid/` + `dashboard/src/components/ChatView.tsx`) against the upstream reference at `context/t3code/apps/web/src/components/chat/`.

**Goal:** Identify every user-visible gap and rank the top 15 by impact. This is a read-only audit — no migration in this pass.

**Counts:** 52 files upstream vs ~28 in `chat-solid/src/` (components + hooks + lib). Feature density gap ≈ 2x at the file level and closer to 10x in the composer (upstream `ChatComposer.tsx` ≈ 2423 LOC vs our ~250 LOC).

---

## 1. File-Level Mapping

Status legend: ✅ = present and roughly equivalent · ⚠️ = partial · ❌ = missing entirely · — = not applicable (browser-only or tests).

### Messages timeline

| Upstream file | Our equivalent | Status | Notes |
|---|---|---|---|
| `MessagesTimeline.tsx` | `components/MessagesTimeline.tsx` | ⚠️ | Core rendering present; missing work-groups, completion divider, revert button, changed-files section |
| `MessagesTimeline.logic.ts` | `components/MessagesTimeline.logic.ts` | ⚠️ | Pure helpers; upstream is richer (work grouping, summary derivation) |
| `MessagesTimeline.browser.tsx` | — | — | SSR-only shim, not needed in Solid |
| `MessagesTimeline.test.tsx` / `.logic.test.ts` | `__tests__/MessagesTimeline*.test.tsx` | ⚠️ | We test images + basics; upstream has broader coverage |
| `MessageCopyButton.tsx` | `components/MessageCopyButton.tsx` | ✅ | Hover-reveal copy |

### Composer — input and menus

| Upstream file | Our equivalent | Status | Notes |
|---|---|---|---|
| `ChatComposer.tsx` | `components/ChatComposer.tsx` | ⚠️ | 2423 LOC vs ~250; missing most footer + pending-state UI |
| `ComposerCommandMenu.tsx` | `components/ComposerCommandMenu.tsx` | ✅ | Slash-command menu |
| `composerSlashCommandSearch.ts` | `lib/slashCommandSearch.ts` | ⚠️ | Search exists; upstream has richer scoring/highlighting |
| `composerMenuHighlight.ts` | — | ❌ | Active-item highlight helper |
| `ComposerBannerStack.tsx` | `components/ComposerBannerStack.tsx` | ⚠️ | Wrapper present; banner items list shorter |
| `ComposerPlanFollowUpBanner.tsx` | `components/ComposerPlanFollowUpBanner.tsx` | ✅ | Plan follow-up suggestion banner |
| `composerProviderState.tsx` / `.test.tsx` | — | ❌ | Provider/traits state derivation |
| `ComposerPrimaryActions.tsx` / `.test.ts` | — | ❌ | Send/Stop/Pending-action state machine |
| `CompactComposerControlsMenu.tsx` / `.browser.tsx` | — | ❌ | Compact footer menu (mode, runtime, plan, traits) |
| `ComposerPendingApprovalPanel.tsx` | — | ❌ | Approval-request panel |
| `ComposerPendingApprovalActions.tsx` | — | ❌ | Approve/deny action row |
| `ComposerPendingUserInputPanel.tsx` | — | ❌ | Multi-choice prompt with 1–9 keyboard shortcuts |
| `ComposerPendingTerminalContexts.tsx` / `.test.tsx` | — | ❌ | Chip list of selected terminal contexts |
| `userMessageTerminalContexts.ts` / `.test.ts` | — | ❌ | Terminal-context inline parsing in user messages |
| `TerminalContextInlineChip.tsx` | — | ❌ | Inline chip with tooltip + expiry |
| `TraitsPicker.tsx` | — | ❌ | Effort / context-window / model-option menu |

We additionally have `components/ComposerMentionMenu.tsx`, `lib/mentionSearch.ts`, `lib/mentionCursor.ts`, `lib/composerDraftStore.ts` — these don't have a direct upstream counterpart (upstream uses the unified command menu surface for @ + /) and represent local-only mentions UX.

### Header

| Upstream file | Our equivalent | Status | Notes |
|---|---|---|---|
| `ChatHeader.tsx` / `.test.ts` | `components/ChatHeader.tsx` | ⚠️ | Shell present; missing OpenInPicker + completion summary |
| `ProviderStatusBanner.tsx` | `components/ProviderStatusBanner.tsx` | ✅ | Provider-health switch banner |
| `ThreadErrorBanner.tsx` | `components/ThreadErrorBanner.tsx` | ✅ | Error banner |
| `ContextWindowMeter.tsx` | `components/ContextWindowMeter.tsx` | ✅ | Context usage meter |
| `OpenInPicker.tsx` | — | ❌ | Editor picker (VSCode / Cursor / Zed / …) |
| `VscodeEntryIcon.tsx` | — | ❌ | VSCode-themed file icons |

### Model picker

| Upstream file | Our equivalent | Status | Notes |
|---|---|---|---|
| `ProviderModelPicker.tsx` / `.browser.tsx` | `components/ProviderModelPicker.tsx` | ⚠️ | Basic flat picker only |
| `ModelPickerSidebar.tsx` | — | ❌ | Vertical rail of provider instances + favorites |
| `ModelPickerContent.tsx` | — | ❌ | Full search-driven list view |
| `ModelListRow.tsx` | — | ❌ | Row with capability badges + status |
| `modelPickerSearch.ts` / `.test.ts` | — | ❌ | Search/filter helpers |
| `modelPickerModelHighlights.ts` | — | ❌ | New / recommended badge logic |
| `ProviderInstanceIcon.tsx` | — | ❌ | Per-instance icon rendering |
| `providerIconUtils.ts` | `lib/provider.ts` | ⚠️ | Helpers exist; icon coverage thinner |

### Supporting cards & widgets

| Upstream file | Our equivalent | Status | Notes |
|---|---|---|---|
| `ProposedPlanCard.tsx` | `components/PlanCard.tsx` | ⚠️ | Markdown render only; missing collapse, download, save-to-workspace |
| `ChangedFilesTree.tsx` / `.test.tsx` | `components/ChangedFilesTree.tsx` | ⚠️ | Basic tree; missing diff-stat row + integrated diff viewer entry |
| `DiffStatLabel.tsx` | — | ❌ | `+nn / −nn` badge |
| `ExpandedImageDialog.tsx` | `components/ExpandedImageDialog.tsx` | ✅ | Fullscreen image dialog |
| `ExpandedImagePreview.tsx` | `components/ExpandedImagePreview.tsx` | ✅ | Inline preview |

We have additional pieces with no upstream equivalent: `ToolCallCard.tsx`, `WorkingIndicator.tsx`, `MessageRoleHeader.tsx`, `PermissionDialog.tsx`, `AttachmentChip.tsx`, `AttachmentPicker.tsx`, `usePlanState.ts`, `useChatThread.ts`. Some of these (PermissionDialog, AttachmentChip) cover gaps upstream addresses inline.

---

## 2. Feature Inventory by Area

### Messages timeline

**Have:** streaming caret, tool-call cluster (collapsed by default), inline markdown plan cards, inline + fullscreen images, file-aware markdown links, copy button, role headers with timestamp, thought/reasoning collapsed block, attachment chips on user messages.

**Missing:** work-log grouping with overflow pagination; completion divider + summary line between assistant phases; per-message elapsed/live timer; revert-to-user-message control; per-turn changed-files section with diff stats; terminal-context inline chips inside user messages; multi-turn branching/history navigation; in-place message editing; explicit regenerate-from-message; citations rendering (we render markdown links but not citation chips); shiki code-block highlighting (we render plain `<code>` blocks); katex math rendering.

### Composer textarea & menus

**Have:** auto-saved draft per thread, caret tracking, slash-command menu, mention (`@`) menu, attachment carousel + picker, prefill prompt support.

**Missing:** compact vs expanded layout modes; runtime-mode selector (Supervised / Auto-accept / Full access); interaction-mode toggle (Chat / Plan); traits picker (effort, context window, provider-specific options); pending-user-input multi-choice prompt with `1–9` shortcuts + auto-advance; pending-approval display; pending-terminal-contexts chip list; plan follow-up dropdown that opens a new thread; attachment size/count validation surfaced inline; image-paste preview before send; provider/instance switch inside composer.

### Composer primary actions (send/stop/pending)

**Have:** plain send button, disable on empty/disabled.

**Missing:** stop button when streaming; busy/connecting/env-unavailable states; multi-step Previous/Submit/Next state machine for pending user-input prompts; plan-implement dropdown; keyboard-shortcut hints; responsive shrink to icon-only.

### Composer banner stack

**Have:** generic banner-stack renderer + plan follow-up banner.

**Missing:** approval-request panel + actions, pending-user-input panel, pending-terminal-contexts chip row, and the orchestration logic that decides which to show.

### Header

**Have:** provider status banner, thread error banner, context window meter, basic title.

**Missing:** OpenInPicker (open thread/repo in VSCode/Cursor/Zed/…), VscodeEntryIcon for thread/file types, completion-summary text in the divider, edit-mode indicator, keybinding help entry.

### Model picker

**Have:** flat provider+model selector.

**Missing:** sidebar rail of provider instances with favorites + status dots, scrollable model content panel, per-row capability badges, search input with match highlighting, "new" / "recommended" badge logic, custom provider-instance icons, coming-soon states.

### Supporting

**Have:** ChangedFilesTree (basic), ToolCallCard, MessageCopyButton, ExpandedImageDialog + Preview, AttachmentChip + Picker, PermissionDialog (richer than upstream inline approval, but lives separately from composer).

**Missing:** DiffStatLabel; richer ProposedPlanCard (collapse for long plans, download, save-to-workspace); TerminalContextInlineChip with tooltip + expiry; per-work-entry icon logic (terminal vs file-read vs file-change vs thinking); work-group overflow + expand control.

---

## 3. Top 15 Gaps Ranked by User-Visible Impact

1. **Stop / Interrupt button** — `ComposerPrimaryActions`. **High.** Right now there is no way to cancel a running generation from the composer. This is the single biggest day-to-day UX miss.
2. **Runtime-mode selector (Supervised / Auto-accept / Full access)** — `CompactComposerControlsMenu` + `composerProviderState`. **High.** Safety-critical. Without it users cannot toggle how aggressively the agent acts.
3. **Pending-approval panel + actions** — `ComposerPendingApprovalPanel`, `ComposerPendingApprovalActions`. **High.** Supervised mode is meaningless without an inline approve/deny surface. We have `PermissionDialog` but it's not wired into the composer banner stack the way upstream is.
4. **Pending-user-input multi-choice panel** — `ComposerPendingUserInputPanel`. **High.** Agents that ask the user "pick one of these" need 1–9 keyboard shortcuts + auto-advance. Currently a dead end.
5. **Work-log groups in timeline** — `MessagesTimeline` work-row rendering. **High.** Dense tool-call turns collapse into noise without grouping + pagination + status badges. This is the timeline's main density lever.
6. **Traits picker (model options / effort)** — `TraitsPicker` + `composerProviderState`. **Medium-high.** Effort level and context-window toggles materially change output quality and cost; users need to set them per turn.
7. **Terminal-context chips (composer + inline in user messages)** — `ComposerPendingTerminalContexts`, `TerminalContextInlineChip`, `userMessageTerminalContexts`. **Medium-high.** Core to the "send terminal output as context" flow; we have nothing comparable.
8. **Completion divider + summary line** — timeline divider rendering. **Medium-high.** Visual anchor between phases of a long response; multi-turn legibility drops noticeably without it.
9. **Model-picker sidebar + search + favorites** — `ModelPickerSidebar`, `ModelPickerContent`, `ModelListRow`, `modelPickerSearch`. **Medium.** Multi-provider users currently scroll a flat list; sidebar + search is table-stakes once 3+ instances are configured.
10. **Revert-to-user-message control** — timeline revert UI + `onRevertUserMessage` callback. **Medium.** Lets users undo agent work and resume the conversation from an earlier turn. Important for iterative workflows.
11. **Per-turn changed-files section with diff stats** — `AssistantChangedFilesSection` + `DiffStatLabel`. **Medium.** Knowing which files a turn touched (and the +/− counts) is the main "what did the agent just do" signal.
12. **shiki-highlighted code blocks** — markdown renderer. **Medium.** Code blocks render as plain monospace; syntax highlighting is expected in 2026-era chat UIs.
13. **Plan follow-up "implement in new thread" dropdown** — `ComposerPrimaryActions` plan menu. **Low-medium.** Smooths the plan → execute handoff; we already render the banner but the action variant is missing.
14. **OpenInPicker (open in VSCode / Cursor / Zed)** — `OpenInPicker` + `VscodeEntryIcon`. **Low-medium.** Nice integration polish; not on the critical path.
15. **In-place message edit + regenerate-from-message** — timeline edit mode. **Low.** Useful for fixing typos without revert, but complex; the revert path covers most use cases.

---

## Architecture Observations (Non-Blocking)

- Upstream splits each surface into `.tsx` / `.logic.ts` / `.browser.tsx` / `.test.tsx`. We mostly keep logic and view in the same file. Splitting `.logic.ts` out earns us cheaper test coverage for the gaps above.
- Upstream uses a React context (`TimelineRowCtx`) + a UI-state store (`useUiStateStore`) so individual rows resubscribe without re-rendering the whole timeline. The Solid equivalent — a row-scoped store via `createContext` + `createMemo` — is already idiomatic but not yet applied; relevant once work-groups land.
- Upstream tests are extensive (≥10 dedicated `.test.tsx` per area). We have ~25 tests total. Closing the gap is feasible incrementally as each missing component lands.
- The composer LOC ratio (≈10x) is the clearest signal of where most of the missing surface area lives: footer controls, pending-state panels, and the model/traits menu.
