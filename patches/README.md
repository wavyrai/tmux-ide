# Dependency patches

## `@opentui/solid@0.4.3`

Solid's universal renderer implements an adjacent keyed-list swap by calling
`insertBefore(node, getNextSibling(previousNode))`. For `[A, B] -> [B, A]`,
that first call is `insertBefore(B, B)`: the DOM-defined, idempotent no-op.

OpenTUI Core already returns without mutating for this case, but version 0.4.3
also emits a warning. OpenTUI's renderer console presents that warning inside
the application, so normal list reordering can cover live terminal content.
The patch makes the Solid adapter skip only an identical node/anchor call when
that node is already resident under the target parent. Nonresident identity
inputs still reach `parent.add`, while Core's same-node, invalid, destroyed,
and foreign-anchor diagnostics remain enabled for direct callers.

The behavior is pinned by
`opentui-insertion-stability-renderer.test.tsx`. Remove the patch when a future
OpenTUI release makes same-node insertion silent upstream.
