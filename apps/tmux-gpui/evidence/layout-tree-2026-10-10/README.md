# Opt-in canonical layout ancestry — 2026-10-10

Branch: codex/tmux-gpui-bootstrap; base HEAD fc3b7869c3cd1699fe5c82fcdab09aae18f5141f. Source changes are uncommitted and unreleased.

`parseLayoutTree` retains internal split axes, ordered children and runtime pane rectangles. One shared grammar preserves the legacy flat `parseLayout` API and its permissive geometry behavior. No wire frames, daemon runtime consumers or GUI resize operations changed.

The tree entry point bounds source length to64KiB, depth64,512leaves and1023nodes. It rejects unsafe integer geometry/sums, duplicate normalized pane IDs, nonpositive sizes, nonzero root origin, and children that do not tile their parent exactly with one-cell separators. These are internal parser bounds, not permission to exceed current wire limits. The checksum prefix is syntax only; runtime pane IDs are not semantic identities.

Validation: existing/new parser tests38/38; combined parser plus session-channel consumer tests206/206; ESLint and daemon typecheck exit0. Exact logs and source hashes are beside this note. Independent boundary_review approved the frozen hashes without blocking findings. Fifteen recorded real-tmux layouts from the split-target reproducer retain the same leaf geometry and nested ancestry.

Remaining: authenticated opt-in layout resource, semantic split identity/topology fencing, a correct split-level mutation owned by the daemon, native divider integration, and same-path live verification. The known nested ancestor resize limitation is NOT fixed by this parser alone. Existing strict v2 clients must not receive an unsolicited tree field.
