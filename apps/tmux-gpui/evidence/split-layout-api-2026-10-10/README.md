# Authenticated canonical split layout read

Read-only POST `/api/v1/tmux-servers/:serverId/:generation/split-layout/:workspaceName`
accepts strict WindowLinkTarget and returns version/server/resource. Existing owner bearer,
no-store, bounded-body and generation fencing apply. Workspace/live session is checked
against current catalog before the retained canonical channel validates its window link.
No channel acquisition or geometry mutation occurs. Native epoch is required; missing
capability fails closed. Channel retirement/disposal clears its opaque split handles.
Both standalone scoped owners and the embedded default owner provide the read.

Validation on 2026-10-10:
- 53 tests: tmux-servers, mirror-service, mirror-service-split-layout.
- 16 tests: tmux-server-owner, embedded-tmux-server-owners, tmux-server-owners.
- Daemon TypeScript --noEmit, affected ESLint and formatting pass.
- Independent boundary reviewer approved retained lifecycle, authenticated route and
  embedded-owner wiring; no scoped blockers.

Limits: channel tests use simulated control and HTTP tests use mocked owners. These
checks do not qualify a real authenticated live read, split execution capability,
geometry lease admission, or GPUI end-to-end dragging. No native provenance update,
merge, release or production session change. Existing preview remains running.
