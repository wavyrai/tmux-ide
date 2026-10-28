# Worktree Deletion Safety

The GUI uses only the connected daemon's existing JSON endpoint methods. It never
runs Git, scans a checkout, tests path ownership on the client filesystem, or
removes files locally. The upstream checkout was inspected read-only; it is not a
build dependency and has not been modified.

## Flow

1. Right-click a linked space and choose **Delete worktree checkout**.
2. Send `worktree.list` with `workspace_id` and `trust_repository: false`.
   Require a unique linked, non-bare entry whose `open_workspace_id` matches the
   clicked workspace; show its daemon-supplied path, not the terminal's cwd.
3. Require one explicit confirmation of the modal, matching the Herdr TUI.
   Revalidate the clicked workspace ID, boot and worktree metadata against the
   latest snapshot before sending `worktree.remove` with `workspace_id`,
   `force: false`, `trust_repository: false`.
4. Wait for the matching request ID. Display daemon error code/message inline.
   Only `dirty_worktree_requires_force` enables force; the dialog restates the
   discarded-files warning and requires a new confirmation before sending the
   same method with `force: true`.
5. Dismiss on a matching `worktree_removed` result (workspace, path and force).
   Pushed snapshots, not optimistic client mutations, update the sidebar.

Escape/outside click cancels confirmation, not an already queued operation.
Repeated submission while pending queues nothing. Reconnect resets the dialog
and replaces the response mailbox; delayed old results cannot open/advance a new
dialog. The mailbox retains one explicitly registered response, not an unbounded
event queue. Transport still enforces one in-flight request, ordered bounded
queues, response size limits, and boot/request-ID validation.

## Daemon Guarantees And Limits

Source references below are relative to the inspected `/Users/penso/code/herdr`.

| Concern | Upstream behavior and source |
| --- | --- |
| API contract | `src/api/schema/worktrees.rs:4-11,52-58,70-82`: list, remove parameters and checkout information. No expected-path, dry-run, or unpushed-safety option exists. |
| Response contract | `src/api/schema/response.rs:30-40,65-68,82-86`: `{error:{code,message}}`, `worktree_list`, `worktree_removed`. |
| Eligibility | `src/app/api/worktrees/deferred.rs:221-258`: resolves daemon workspace membership and rejects missing/non-linked checkouts. This does not mean the GUI can infer filesystem ownership merely from a linked sidebar flag. |
| Concurrent operations | `deferred.rs:281-323,487-509`: guards in-progress workspace/path operations and fences superseded completion. |
| Git removal | `src/worktree.rs:175-191`: `git worktree remove`, optionally one `--force`; no branch-delete command. |
| Dirty/untracked/submodules | `src/worktree.rs:194-199,324-343` classifies Git's English modified/untracked or submodule refusal. `deferred.rs:511-524` returns `dirty_worktree_requires_force` only for an unforced classified failure; other errors are `worktree_remove_failed`. On Windows, `deferred.rs:260-279` also uses a precheck (`worktree.rs:214-237`, `git status --porcelain --untracked-files=all`). This is not a guarantee against concurrent edits or protection for ignored files. |
| Unpushed commits | No check or warning field exists in this removal flow. It does not fetch or compare remote ancestry. Branches remain, but detached commits can become unreachable. The GUI explicitly warns that unpushed commits are not checked rather than claiming they are safe. |
| Force recovery | `src/worktree.rs:346-398`: after a forced "not a worktree" error, checks that Git no longer lists the path and that an existing directory's `.git` pointer belongs beneath the repository's common worktrees directory before removing a leftover directory. The GUI does not expose this generic-error recovery escalation. |
| Workspace cleanup | `deferred.rs:527-597`: closes the matching workspace and terminal runtimes after successful removal and emits `worktree_removed`. Failure may involve restoring stopped runtimes; force is not a side-effect-free probe. |
| Transport | `src/server/headless/endpoint_requests.rs:79-128`: dispatches endpoint requests into the daemon API and bridges deferred responses. The native client reassembles `ClientShellEndpointResponseChunk` and emits the preserved JSON as `ClientEvent::Response` (`crates/herdr-client/src/lib.rs`). No new binary protocol variants are needed. |
| TUI policy | `src/client/shell/worktrees.rs:210-228,341-365,439-462,499-515` fetches a path, asks confirmation, and escalates dirty or certain generic recovery errors. `worktree_overlays.rs:329-395` renders warnings/buttons locally. These confirmation UI decisions are client-owned, not daemon-rendered alerts. |

The GUI owns presentation, confirmation, input isolation, request
correlation, and snapshot target validation only. Git safety and removal stay in
Herdr. There is no daemon transaction binding the displayed path to a later
remove request: the API accepts only `workspace_id`, not an expected path or
revision. Snapshot validation reduces stale-target risk but cannot supply a
missing server-side compare-and-delete guarantee. Stronger unpushed/detached
protection or atomic path confirmation requires an upstream daemon API change,
not local Git checks.

## Verification Scope

Deterministic tests cover request schema, linked-target/boot validation,
confirmation readiness, dirty escalation, generic errors, cancellation, response correlation,
coalescing and reconnect isolation. The native sidebar fixture opens the deletion
dialog and checks editing/input isolation at narrow and wide sizes without a
daemon. These checks do not perform live checkout removal or establish OS-level
IME delivery correctness.
