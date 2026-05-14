# Chat-Solid Wiring Audit

> **Status:** Audit only. No code changes were made.
> **Scope:** Every `chat-solid` component → `ChatThreadView` → `ChatMountOptions` → React bridge (`dashboard/components/chat-v2/chat-solid-bridge.tsx`) → daemon endpoint.
> **Motivation:** User feedback — "we're a long way from t3 feature parity". Several surface shells are built but their wires dead-end. This document maps every chain end-to-end and prioritizes the wires that need to land.

---

## §0 — Map of the wire (key files)

| Layer                                               | File                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| Mount options (host ↔ chat-solid surface contract)  | `packages/chat-solid/src/types.ts` (`ChatMountOptions`)                                           |
| Surface root (orchestrator inside the Solid silo)   | `packages/chat-solid/src/components/ChatThreadView.tsx`                                           |
| State / API helpers (Solid side)                    | `packages/chat-solid/src/hooks/useChatThread.ts`, `packages/chat-solid/src/api.ts`                |
| React→Solid bridge                                  | `dashboard/components/chat-v2/chat-solid-bridge.tsx`, `ChatV2Root.tsx`                            |
| Daemon actions (`POST /api/v2/action/:name`)        | `packages/daemon/src/command-center/actions/registry.ts`, `…/handlers/chat-actions.ts`            |
| Daemon REST routes                                  | `packages/daemon/src/command-center/server.ts`                                                    |
| Daemon event bus (WS)                               | `packages/daemon/src/chat/message-pipe.ts`, `…/permission-coordinator.ts`, `…/dispatch-prompt.ts` |
| Provider approval policy (T102, currently unrouted) | `packages/daemon/src/chat/provider-approval-policy.ts`                                            |
| Plan orchestrator (REST-only)                       | `packages/daemon/src/chat/plan-orchestrator.ts`, server.ts `:plans/:planId/approve                | reject` |

`ChatMountOptions` currently exposes only four host hooks:

```
threadId, sessionName, apiBaseUrl, wsUrl, bearerToken,   // identity / transport
mentionCandidates                                        // host-sourced data
onOpenFile, onProviderChange, onClose                    // callbacks
```

That is the entire host surface area. Everything else either fetches over its baked-in REST contract (e.g. provider list, terminal panes) or is purely internal to chat-solid (composer drafts, mention parsing, copy buttons).

---

## §1 — Survey of components × callbacks

Every component in `packages/chat-solid/src/components/`. "Wired to" is what the orchestrator (`ChatThreadView` or its peer composer) routes the callback to. **bold** = host-facing (must reach the React bridge / daemon to do anything). _italic_ = internal to chat-solid (no host involvement needed).

| Component                                     | Callback prop                                   | Wired to (in chat-solid)                                                           |
| --------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `AttachmentChip`                              | _`onRemove`_                                    | `ChatComposer` → `chat.removeAttachment` (in-memory `attachments` signal)          |
| `AttachmentPicker`                            | _`onAdd`_                                       | `ChatComposer` → `chat.addAttachment` (in-memory)                                  |
| `AttachmentPicker`                            | _`onClose`_                                     | `ChatComposer` local `setPickerOpen(false)`                                        |
| `ChangedFilesTree`                            | (none — purely render + internal toggles)       | n/a                                                                                |
| `ChatComposer`                                | _`onAddAttachment`_, _`onRemoveAttachment`_     | `chat.addAttachment` / `chat.removeAttachment`                                     |
| `ChatComposer`                                | _`onSend`_                                      | `chat.send` → `chat.session.send` action ✅                                        |
| `ChatComposer`                                | _`onCancel`_                                    | `chat.cancel` → `chat.session.cancel` action ✅                                    |
| `ChatComposer`                                | _`onPrefillPromptConsumed`_                     | `chat.prefillPrompt(null)` (internal)                                              |
| `ChatComposer`                                | _`bannerItems`_ (accessor, not a callback)      | **NOT WIRED**: `ChatThreadView` never passes anything. Stack always renders empty. |
| `ChatHeader`                                  | **`onProviderChange`**                          | `props.options().onProviderChange?.(next)` — bubbled up                            |
| `ChatHeader`                                  | _`onCancel`_                                    | `chat.cancel` ✅                                                                   |
| `ChatHeader`                                  | _`onRename`_                                    | `chat.rename` → `chat.thread.rename` action ✅                                     |
| `ChatHeader`                                  | **`onClose`**                                   | `props.options().onClose` — bubbled up                                             |
| `ChatThreadView`                              | (the orchestrator itself; no callable props)    | n/a                                                                                |
| `ComposerBannerStack`                         | _`onDismiss`_ (per item)                        | Caller-supplied via `ComposerBannerItem`                                           |
| `ComposerCommandMenu`                         | _`onSelect`_, _`onHighlight`_                   | `ChatComposer` local (replaces slash token)                                        |
| `ComposerMentionMenu`                         | _`onSelect`_, _`onHighlight`_                   | `ChatComposer` local (replaces `@` token)                                          |
| `ComposerPendingApprovalPanel`                | **`onRespond(requestId, decision)`**            | **Component is orphaned. Never mounted by `ChatThreadView` or any host.**          |
| `ComposerPlanFollowUpBanner`                  | **`onApply` / `onModify` / `onReject(planId)`** | **Component is orphaned. Never mounted.**                                          |
| `ContextWindowMeter`                          | (none — props.usage accessor)                   | Daemon `chat.thread.usage` action + WS `chat.thread.usage` event ✅                |
| `ExpandedImageDialog`                         | **`onClose`**                                   | **Orphaned.** Exported from `index.tsx` but no host wires it.                      |
| `ExpandedImagePreview` → `InlineImagePreview` | **`onExpand`**                                  | **Orphaned.** Not used by `MessagesTimeline`/`ToolCallCard`.                       |
| `MessageCopyButton`                           | _`write` (test injection)_                      | navigator.clipboard.writeText (browser API; no host wire)                          |
| `MessageRoleHeader`                           | _`actions` slot_                                | Render-only                                                                        |
| `MessagesTimeline`                            | **`onOpenFile`**                                | `props.options().onOpenFile` — bubbled up                                          |
| `MessagesTimeline`                            | _`onSendPlanRequest`_                           | `chat.prefillPrompt` (writes plan markdown into composer; never sends)             |
| `PermissionDialog`                            | _`onRespond(optionId)`_                         | `chat.respondToPermission` → `chat.permission.respond` action ✅                   |
| `PlanCard`                                    | _`onSendPlanRequest`_                           | Forwarded to `MessagesTimeline.onSendPlanRequest` (see above)                      |
| `ProviderModelPicker`                         | **`onChange(provider)`**                        | `ChatHeader.onProviderChange` → options.onProviderChange — bubbled                 |
| `ProviderStatusBanner`                        | **`onSwitch(provider)`**                        | `props.options().onProviderChange` — bubbled                                       |
| `TerminalContextInlineChip`                   | **`onRemove`**                                  | **Orphaned.** Composer uses `AttachmentChip` instead.                              |
| `ThreadErrorBanner`                           | _`onDismiss`_                                   | `setDismissedErrorKey` local (chat-solid owns the "dismissed" memo)                |
| `ToolCallCard`                                | (none)                                          | n/a                                                                                |
| `WorkingIndicator`                            | (none)                                          | n/a                                                                                |

---

## §2 — Wiring chain audit (per surface)

Tables are read **left → right**. ✅ = full chain works. ⚠️ = partial / no-op. ❌ = dead-end at one of the stages.

### Provider switcher (`ProviderModelPicker` + `ProviderStatusBanner`)

| Stage                              | Wired? | Notes                                                                                                                                                           |
| ---------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI: `ProviderModelPicker` onChange | ✅     | `ChatHeader.tsx:74`                                                                                                                                             |
| Header → ChatThreadView            | ✅     | `ChatHeader.tsx:74` → `ChatThreadView.tsx:73`                                                                                                                   |
| ChatThreadView → ChatMountOptions  | ✅     | `options().onProviderChange?.(next)`                                                                                                                            |
| Bridge passes handler              | ❌     | `chat-solid-bridge.tsx:86-94` never assigns `onProviderChange`                                                                                                  |
| Daemon endpoint                    | ❌❌   | No `chat.thread.setProvider` action and no `POST /api/threads/:id/provider`. The closest is `chat.thread.create` with a new provider (i.e. spin a fresh thread) |
| WS broadcast on switch             | n/a    | No event type yet                                                                                                                                               |

**Classification:** ❌❌ **DEAD-END at bridge AND daemon.** ProviderStatusBanner's "Switch to" chips share the same dead-end because they call the same `options.onProviderChange`.

### Close button (`ChatHeader` close affordance)

| Stage                       | Wired?                                  | Notes                                           |
| --------------------------- | --------------------------------------- | ----------------------------------------------- |
| UI: ChatHeader close button | ✅ (renders only when `onClose` truthy) | `ChatHeader.tsx:101-110`                        |
| Header → ChatThreadView     | ✅                                      | `onClose={props.options().onClose}`             |
| Bridge passes handler       | ❌                                      | `chat-solid-bridge.tsx` does not pass `onClose` |
| Daemon endpoint             | n/a                                     | Pure host concern (e.g. unmount / route away)   |

**Classification:** ❌ **DEAD-END at bridge.** Button never renders (since `onClose` is falsy) so the surface offers no "close" affordance at all.

### File-link click in messages (`MessagesTimeline.onOpenFile`)

| Stage                                 | Wired? | Notes                                                                  |
| ------------------------------------- | ------ | ---------------------------------------------------------------------- |
| UI: anchor click on `.chat-file-link` | ✅     | `MessagesTimeline.tsx:426-453`                                         |
| Timeline → ChatThreadView             | ✅     | `onOpenFile={props.options().onOpenFile}`                              |
| Bridge passes handler                 | ✅     | `chat-solid-bridge.tsx:93` (via `onOpenFileRef`)                       |
| Host wiring                           | ✅     | `ChatV2Root` accepts and forwards (caller's responsibility from there) |

**Classification:** ✅ **WORKS** (assuming the host route is wired — that's outside this audit).

### Mention candidates (`ChatComposer` @-menu)

| Stage                                                    | Wired? | Notes                                                                         |
| -------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| UI: `@` triggers menu when `mentionCandidates` non-empty | ✅     | `ChatComposer.tsx:87-102`                                                     |
| Composer ← ChatThreadView                                | ✅     | `mentionCandidates={() => props.options().mentionCandidates ?? []}`           |
| Bridge passes through                                    | ✅     | `chat-solid-bridge.tsx:92`, also pushed on update via `setOptions`            |
| Host sourcing                                            | ⚠️     | Bridge prop is an interface — actual list is what the host hands `ChatV2Root` |

**Classification:** ✅ data path works. (Whether the dashboard actually supplies a non-empty list is an upstream concern; the wire is complete.)

### Composer banner stack (approval / plan / pending-user-input)

| Stage                                                        | Wired? | Notes                                                                                                                                                     |
| ------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI: `ComposerBannerStack` renders first item + collapsed cap | ✅     | `ComposerBannerStack.tsx:51-67`                                                                                                                           |
| Stack ← ChatComposer                                         | ✅     | `bannerItems` is an accessor prop on the composer                                                                                                         |
| Composer ← ChatThreadView                                    | ❌     | **`ChatThreadView.tsx:99-115` never sets `bannerItems`.** Stack always empty.                                                                             |
| ChatMountOptions surface                                     | ❌     | No field for host-supplied banners                                                                                                                        |
| Daemon endpoints                                             | ❌     | No banner state would be daemon-owned anyway — but pending-approval and plan-follow-up state is daemon-driven (see below) and not surfaced anywhere today |

**Classification:** ❌ **DEAD-END at ChatThreadView (and ChatMountOptions).** The component exists; nothing feeds it.

### Pending-approval panel (`ComposerPendingApprovalPanel`)

| Stage                                          | Wired? | Notes                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI: render + four-button verdict cluster       | ✅     | `ComposerPendingApprovalPanel.tsx`                                                                                                                                                                                                                                                                                                                                                            |
| Mounted in `ChatThreadView`?                   | ❌     | Component is orphaned — never imported by the orchestrator                                                                                                                                                                                                                                                                                                                                    |
| WS event the panel would consume               | ⚠️     | `chat.permission.request` exists and is already consumed by `PermissionDialog`. The two components have **different shapes**: the dialog speaks `optionId`s (option-driven) while the panel speaks `ApprovalDecision` (`accept` / `acceptForSession` / `decline` / `cancel`). The latter mirrors T102 `ProviderApprovalPolicy` but no daemon event with that vocabulary is currently emitted. |
| Daemon endpoint for `ApprovalDecision` verdict | ❌     | `chat.permission.respond` only accepts `{threadId, requestId, optionId}`. T102 verdict path is not wired to any HTTP route.                                                                                                                                                                                                                                                                   |

**Classification:** ❌❌ **DEAD-END at ChatThreadView AND at daemon contract.** Either retire this component in favor of `PermissionDialog`, or add a daemon route that emits the T102 shape and have a banner consume it.

### Plan follow-up banner (`ComposerPlanFollowUpBanner`)

| Stage                        | Wired?      | Notes                                                                                                                                                                                                                  |
| ---------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI: Apply / Modify / Reject  | ✅          | `ComposerPlanFollowUpBanner.tsx`                                                                                                                                                                                       |
| Mounted in `ChatThreadView`? | ❌          | Component is orphaned                                                                                                                                                                                                  |
| Daemon endpoints             | ⚠️ existing | `POST /api/threads/:threadId/plans/:planId/approve` and `…/reject` exist (`server.ts:795,826`). `Modify` has no daemon route.                                                                                          |
| chat-solid `api.ts` helpers  | ❌          | No `chatPlanApprove` / `chatPlanReject`. The bridge would have to call the daemon directly.                                                                                                                            |
| Plan-id source               | ⚠️          | Plan ids come from `chat.plan.upserted` event in plan-store; chat-solid does not subscribe today. The Solid surface only sees `sessionUpdate: "plan"` (an unstructured entry list), not the daemon's persisted planId. |

**Classification:** ❌ **DEAD-END at ChatThreadView, ⚠️ partial at daemon (modify missing, approve/reject exist but un-helpered).**

### Inline image preview + fullscreen dialog (`InlineImagePreview` + `ExpandedImageDialog`)

| Stage                                          | Wired? | Notes                                                                                                                                                    |
| ---------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI: thumbnail with lazy IO + zoom button       | ✅     | `ExpandedImagePreview.tsx`                                                                                                                               |
| Fullscreen modal with ←/→ and Esc              | ✅     | `ExpandedImageDialog.tsx`                                                                                                                                |
| Mounted in `MessagesTimeline` / `ToolCallCard` | ❌     | `ContentBlockView` (`ToolCallCard.tsx:43-44`) currently renders `<p>Image attachment ({mimeType})</p>` — text only. The inline component is not invoked. |
| Mounted in composer (staged attachment row)    | ❌     | Composer uses `AttachmentChip` (text-only chip)                                                                                                          |
| Daemon                                         | n/a    | All client-side once the image is in the message                                                                                                         |

**Classification:** ❌ **DEAD-END at MessagesTimeline + ChatComposer.** Components exist and are exported from `index.tsx` (so they're public surface), but no internal renderer mounts them.

### Terminal-context inline chip (`TerminalContextInlineChip`)

**Classification:** ❌ Orphaned. Composer uses `AttachmentChip` for terminal attachments (`AttachmentChip.tsx:7`). Either retire this chip or migrate the composer to use it.

### Send / cancel / rename / get / usage / permission respond / mention list / providers list / terminal capture

All flow through `chat-solid/src/api.ts` → action POSTs → daemon registered actions. ✅ **WORKS** end-to-end. These represent the baseline functioning surface.

| chat-solid API               | Daemon action                     |
| ---------------------------- | --------------------------------- |
| `chatThreadGet`              | `chat.thread.get` ✅              |
| `chatThreadUsage`            | `chat.thread.usage` ✅            |
| `chatThreadRename`           | `chat.thread.rename` ✅           |
| `chatSessionSend`            | `chat.session.send` ✅            |
| `chatSessionCancel`          | `chat.session.cancel` ✅          |
| `chatPermissionRespond`      | `chat.permission.respond` ✅      |
| `chatContextCaptureTerminal` | `chat.context.captureTerminal` ✅ |
| `chatProvidersList`          | `GET /api/chat/providers` ✅      |
| `fetchProjectPanes`          | `GET /api/project/:name/panes` ✅ |

WS event consumption (`useChatThread`): `chat.thread.update`, `chat.thread.stop`, `chat.thread.usage`, `chat.permission.request`. All emitted by `message-pipe.ts` / `dispatch-prompt.ts` / `permission-coordinator.ts`. ✅

---

## §3 — Dead-end inventory grouped by where they die

### Dies at the bridge (handler not passed into `ChatMountOptions`)

1. **`onProviderChange`** — `ChatMountOptions` accepts it, `ChatThreadView` forwards `ProviderModelPicker.onChange` and `ProviderStatusBanner.onSwitch` to it, but `chat-solid-bridge.tsx` never assigns one. Provider picker is a no-op until this lands. _(Once landed, the daemon-side hole below also needs filling.)_
2. **`onClose`** — same story. The Close button never renders.

### Dies at the daemon (bridge handler can be added but it has nowhere to call)

1. **Switch provider on existing thread** — `chat.thread.setProvider` action / `POST /api/threads/:id/provider` does not exist. Today only `chat.thread.create` accepts a provider. Header docs hint at a "create + redirect" host-side workaround (`types.ts:230-236`).
2. **T102 approval verdict (Approve / AlwaysAllow / Decline / Cancel)** — `provider-approval-policy.ts` defines the policy but the verdict path is not HTTP-reachable. No action or REST route accepts an `ApprovalDecision` payload.
3. **Plan "Modify" follow-up** — approve/reject exist, modify does not. Either drop the button or add a route that triggers a new turn pre-filled with the plan markdown for editing.

### Dies inside `ChatThreadView` (component built but never mounted)

1. `ComposerBannerStack` — composer accepts `bannerItems`, view doesn't pass anything.
2. `ComposerPendingApprovalPanel` — never mounted; would also need a daemon fix (#2 above).
3. `ComposerPlanFollowUpBanner` — never mounted; daemon partly there.
4. `InlineImagePreview` + `ExpandedImageDialog` — never mounted in timeline / composer.
5. `TerminalContextInlineChip` — never mounted; composer uses the generic AttachmentChip.

### Dies at host (works inside chat-solid; host responsibility from here)

1. `onOpenFile` — ✅ wired through bridge; what the host _does_ with the meta is outside this audit.
2. `mentionCandidates` — ✅ wired; host needs to source the array.

---

## §4 — Daemon endpoints needed (proposed routes + schemas)

These are the minimum daemon additions to make the dead-end wires reachable. All use the canonical `POST /api/v2/action/:name` envelope unless a REST-style route reads more naturally.

### D1 — `chat.thread.setProvider`

```jsonc
// POST /api/v2/action/chat.thread.setProvider
{ "threadId": "thr_…", "provider": { "kind": "claude-code" } }
// → { "thread": ThreadIndexEntry }  (also broadcast "chat.thread.update" with new provider)
```

Implementation note: today's thread record stores `provider` inline; the question is whether the daemon can hot-swap an attached ACP session or has to tear it down. If the latter, semantics become "next turn uses the new provider" — surface that clearly in the response.

### D2 — `chat.approval.respond` (T102 verdict path)

```jsonc
// POST /api/v2/action/chat.approval.respond
{ "threadId": "thr_…", "requestId": "appr_…", "decision": "accept" | "acceptForSession" | "decline" | "cancel" }
// → { "responded": true }
```

Plus a new bus event `chat.approval.request` emitted by `ProviderApprovalPolicy` when a tool call returns `needs-confirmation`. Today the policy emits via the existing `PermissionCoordinator` which uses the optionId vocabulary — the T102 banner expects the four-decision shape. Decide: (a) collapse the panel into `PermissionDialog`'s optionId vocabulary and retire `ComposerPendingApprovalPanel`, or (b) add this parallel path.

### D3 — `chat.plan.action` (Modify path)

```jsonc
// POST /api/v2/action/chat.plan.action
{ "threadId": "thr_…", "planId": "plan_…", "action": "approve" | "reject" | "modify" }
// → { "thread": ThreadIndexEntry, "planId": "plan_…" }
```

Alternatively keep the existing `…/plans/:planId/approve|reject` REST routes and just add `…/plans/:planId/modify`. The current shape is REST-only; chat-solid `api.ts` has no helper for any of the three.

---

## §5 — Prioritized fix plan

Ordered to maximize unblock per hour. **W1** is the smallest end-to-end fix that delivers a user-visible feature. Each wire is one focused task; an agent should land all three layers (daemon, bridge, chat-solid) in a single PR.

### W1 — Close-button wire end-to-end

**Surface:** `ChatHeader` close button → `ChatThreadView` → `options.onClose` → bridge
**Bridge gap:** `chat-solid-bridge.tsx` doesn't pass `onClose`; `ChatV2RootProps` has no `onClose` prop
**Daemon gap:** none (pure host concern)
**Fix:**

1. Add optional `onClose?: () => void` prop to `ChatSolidBridgeProps` and `ChatV2RootProps`; forward into `ChatMountOptions` (mount + `setOptions` for hot updates).
2. Decide host behavior: navigate back to thread list, or hide the right pane. Likely "deselect thread" — call `props.onPickThread(null)` equivalent.
   **Effort:** ~15 min
   **Depends on:** none
   **Test gate:** When the host passes an `onClose`, the Close button renders in the header and clicking it triggers the host's handler.

---

### W2 — Provider switcher wire end-to-end _(the exemplar from the task brief)_

**Surface:** `ProviderModelPicker` → `onChange` → `ChatHeader.onProviderChange` → `ChatThreadView` → `options.onProviderChange`
**Bridge gap:** `chat-solid-bridge.tsx` doesn't pass `onProviderChange`
**Daemon gap:** no `chat.thread.setProvider` action; no REST route
**Fix:**

1. Daemon: add action `chat.thread.setProvider` (see §4 D1). On success emit `chat.thread.update` with the new provider snapshot so the WS-driven header refreshes without a refetch.
2. chat-solid `api.ts`: add `chatThreadSetProvider(runtime, threadId, provider) -> Promise<{thread}>`.
3. Bridge: pass `onProviderChange: (next) => chatSolid.threadSetProvider(...).then(…)` into `ChatMountOptions`. Handle the "ACP teardown required" case (the daemon's response should signal whether the next-turn rule applies).
4. Decide whether `ProviderStatusBanner.onSwitch` uses the same handler (recommended — same wire).
   **Effort:** ~45 min if D1 is "next turn uses new provider"; ~90 min if hot-swap is required (touches `chat-integration-harness.ts`).
   **Depends on:** none
   **Test gate:** Click a non-active provider in the picker → daemon receives `chat.thread.setProvider` → broadcast → header re-renders with new provider name + glyph without remounting; in-flight composer drafts survive.

---

### W3 — Inline image preview + expanded dialog in messages

**Surface:** image content blocks inside `ContentBlockView` → `InlineImagePreview` → `ExpandedImageDialog`
**Bridge gap:** none — pure UI wire inside chat-solid
**Daemon gap:** none — content blocks already carry `data` + `mimeType`
**Fix:**

1. Replace `<p>Image attachment …</p>` in `ToolCallCard.tsx:44` and the user-content path (`MessagesTimeline.tsx:402`) with `<InlineImagePreview>` for `block.type === "image"`, using a `data:` URL built from `block.data`.
2. Add a `MessagesTimeline`-scoped `createSignal<ExpandedImagePreview | null>` and mount `<ExpandedImageDialog preview={…} onClose={() => setPreview(null)} />` once at the timeline root.
3. Build the preview cursor with `buildExpandedImagePreview` over the message's full image attachment list so ←/→ traverses other images in the same message.
   **Effort:** ~30 min
   **Depends on:** none
   **Test gate:** Send / receive a message with an image block → thumbnail renders in the transcript → click expands to fullscreen dialog → Esc / × / backdrop closes.

---

### W4 — Plan follow-up banner mount + wire (approve / reject)

**Surface:** `ComposerPlanFollowUpBanner` rendered inside the composer banner stack
**Bridge gap:** banner stack itself never receives items; chat-solid `api.ts` has no plan helpers
**Daemon gap:** approve/reject REST routes already exist; modify does not
**Fix:**

1. Plumb a `bannerItems` accessor from `ChatThreadView` into `ChatComposer` (currently the prop exists but nothing is passed).
2. In `useChatThread`, subscribe to a new WS frame `chat.plan.upserted` (emit it from `plan-store.ts` writes) so the latest unresolved plan id surfaces to the orchestrator.
3. chat-solid `api.ts`: add `chatPlanApprove(runtime, threadId, planId)` and `chatPlanReject(...)`. Use the existing REST routes (`/api/threads/:threadId/plans/:planId/approve|reject`).
4. Render `ComposerPlanFollowUpBanner` inside the `bannerItems` array when an unresolved plan exists. Wire `onApply` → `chatPlanApprove`, `onReject` → `chatPlanReject`. Drop `onModify` until D3 lands, or wire it to `chat.prefillPrompt` for now (pre-fills composer with the plan markdown so the user can edit + send).
   **Effort:** ~75 min
   **Depends on:** none (modify is deferred)
   **Test gate:** When the assistant emits a plan, the banner shows above the composer; Apply hits the daemon and removes the banner; Reject hits the daemon and removes the banner.

---

### W5 — Composer banner stack wired to canonical orchestrator-owned state

**Surface:** `ChatComposer.bannerItems` (the prop already exists)
**Bridge gap:** `ChatThreadView` never assigns this prop
**Daemon gap:** none new — drives off existing WS events
**Fix:**

1. Inside `ChatThreadView`, derive a `bannerItems` memo that includes (in priority order): pending T102 approval (once W6 lands), unresolved plan (W4), thread-level errors (already shown via `ThreadErrorBanner` — decide if it stays there or moves into the stack), and any future host-supplied items.
2. Add `bannerItems?: Accessor<ReadonlyArray<ComposerBannerItem>>` to `ChatMountOptions` to let hosts inject project-specific banners (e.g. "merge freeze in effect").
   **Effort:** ~30 min (after W4)
   **Depends on:** W4 (provides the plan-follow-up item)
   **Test gate:** Multiple concurrent banners render: first item full-chrome, the rest collapsed into the count cap.

---

### W6 — T102 approval verdict path (decide: collapse vs. parallel)

**Surface:** `ComposerPendingApprovalPanel` (currently orphaned)
**Bridge gap:** the panel is never mounted
**Daemon gap:** see §4 D2
**Fix (option A — recommended, smaller):** retire `ComposerPendingApprovalPanel`; its UX is a superset of `PermissionDialog` but the daemon only speaks `optionId`. Land richer button labels inside `PermissionDialog` instead and delete the panel. No daemon work.
**Fix (option B — more capable, larger):** add D2 (action + bus event), mount the panel in the banner stack (W5), wire `onRespond` → `chatApprovalRespond`. Update `ProviderApprovalPolicy` to emit `chat.approval.request` via the bus and resume on response.
**Effort:** option A ~30 min; option B ~120 min
**Depends on:** W5 if option B
**Test gate:** Trigger a tool call that the policy gates → banner / dialog surfaces with the four-button verdict cluster → click "Accept once" → policy resumes the call.

> Recommend option A unless we have a near-term need for the four-button vocabulary. Two parallel approval paths is the kind of duplication that "long way from t3 parity" usually means.

---

### W7 — Terminal-context chip: retire or migrate

**Fix:** Decide:

- Retire `TerminalContextInlineChip` (delete the file + export). Composer keeps `AttachmentChip` which is already wired.
- OR migrate composer's terminal attachment row to use `TerminalContextInlineChip` (better visual differentiation; needs to source `lineCount` + freshness, currently not tracked).
  **Effort:** ~10 min (retire) / ~45 min (migrate + freshness state)
  **Depends on:** none
  **Test gate:** No regressions in composer attachment row interactions.

---

### W8 — `chat.thread.delete` wire (host-facing)

Outside the canvassed components but worth noting: `chat.thread.delete` action exists in the daemon registry, but neither `ChatHeader` nor `ChatThreadView` exposes a delete affordance. `ThreadListRail.onDelete` likely handles this on the React side — confirm. If the chat surface needs a "Delete thread" menu, add it adjacent to the Close button (W1) and wire to `chatThreadDelete`.
**Effort:** ~20 min
**Depends on:** W1

---

## §6 — Pure logic vs data-flow notes

These are not "wire missing" bugs but worth flagging so the W-list doesn't mask them:

- **`ProviderStatusBanner` interval has no `onCleanup`** (`ProviderStatusBanner.tsx:47-55` admits this in a comment). If the banner is ever mounted in a transient owner (e.g. a router-driven side panel), the interval will leak. Migrate to `createEffect(() => { const id = …; onCleanup(() => clearInterval(id)); })`.
- **`ChatThreadView`'s `availableProviders` `createResource` only fires once** (`ChatThreadView.tsx:25-32`). `ProviderStatusBanner` polls separately. Two fetchers for the same endpoint — fine today since the cadence diverges, but worth consolidating once the picker also wants periodic refresh.
- **`MessagesTimeline.onSendPlanRequest` is misleading**: it does NOT send anything — it prefills the composer textarea via `chat.prefillPrompt`. Either rename to `onPrefillComposer` or actually send via `chat.send` (with the user's confirmation). Today's behavior is "user clicks 'Send plan to agent' on a `PlanCard`, plan markdown lands in the composer, user has to press Enter."
- **`ChatComposer` accepts `bannerItems` as a prop on the _composer_ but they're rendered above the textarea inside the composer form** (`ChatComposer.tsx:309`). If we want banners to live _between_ the timeline and composer (visually distinct), this is the right place — but the prop name suggests a different layout. No fix needed; mention it so future refactors don't move the slot.
- **The bridge's mount-once guard re-keys on `Boolean(threadId)`** (`chat-solid-bridge.tsx:108`). This means the Solid runtime is preserved when switching between two thread ids but torn down when going thread → no-thread → thread. Acceptable; document the intent if it's surprising.
- **`ChatComposer` writes the composer draft store on every keystroke** even with no debouncing (`ChatComposer.tsx:138-142`). The comment says "the store debounces internally" — verify in `composerDraftStore.ts` if you're chasing keystroke latency.

---

## §7 — TL;DR

**What works end-to-end today (✅):** send, cancel, rename, get, usage, permission respond, terminal capture, providers list, panes list, file-link open, mention autocomplete data flow, plus all internal Solid mechanics (drafts, mentions, slash commands, autoscroll, error banner dismissal, copy buttons, plan card editing).

**The four highest-leverage wires to land next (in order):**

1. **W2 — Provider switcher** (closes the smoking-gun example from the brief; ~45 min).
2. **W3 — Inline image preview + dialog** (huge UX win; ~30 min; pure chat-solid).
3. **W4 — Plan follow-up banner** (re-enables approve/reject without spinning up a separate UI; ~75 min).
4. **W1 — Close button** (15 min; small but completes the header surface).

Three "decide vs. build" items — **W6** (collapse approval panel into PermissionDialog vs. build the T102 verdict path), **W7** (retire `TerminalContextInlineChip` vs. migrate), and the **`onModify` plan action** (deferred until D3) — should be triaged before W6 is scheduled.

After all W1–W5 land, the chat surface has zero orphan components and zero documented dead-end wires.
