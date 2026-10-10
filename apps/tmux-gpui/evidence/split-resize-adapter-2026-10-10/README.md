# Daemon native split adapter foundation — 2026-10-10

Branch codex/tmux-gpui-bootstrap; base HEAD fc3b7869c3cd1699fe5c82fcdab09aae18f5141f. Uncommitted, no public route/runtime wiring or release.

resizeNativeSplit captures daemon-owned request data before any await, probes the actual injected tmux runner every call, and refuses missing/malformed capability without fallback. It validates request syntax/tree bounds/serializer budget. Post-dispatch exceptions or invalid receipts are uncertain and must not be retried automatically. Verified receipts preserve ordered tree/pane identities, ancestor/outside-parent rectangles, orthogonal geometry and boundary readback within requested movement; native clamping is accepted.

46focused tests (8adapter +38parser), daemon typecheck, module and live-fixture lint passed. The private real-native fixture moved the eight-pane root ancestor to83, preserved pane identities, rejected stale layout, clamped to3 and repeated without change. Cleanup succeeded. Binary713991dc7d0cd85ea61376883caae8d915da3cede6ed80fba408ee6b85685395. Independent reviewer approved adapter753141f7/testea21b4d5/livefixture9ac0024e; full hashes/logs alongside this note.

This module is authority-neutral. Runner must pin binary/server, bound time/output, enforce final execution authorization and physical lifetimes, and correlate operation identity. No authentication claim follows from native capability/layout strings.

## Concrete integration prerequisite found

Existing native direct-session and pane-birth guards deliberately validate lifetimes independently. A window can remain alive in another session after being unlinked from the expected session while all those guards and its full layout still match. Current prototype command resolves @window without session membership. Before wiring, require exact raw session ID and check session_find_by_id plus winlink_find_by_window atomically in the synchronous split command. Pass the same session ID used in the existing epoch/session/pane wrapper. Keep linked/shared-window geometry policy explicit; membership alone is not exclusive ownership. Regression must preserve window elsewhere, unlink from expected session, then prove unchanged refusal.

Remaining: native membership fence, authenticated opt-in layout resource, geometry-owner/semantic/lifetime-fenced operation through existing executor, native divider integration, production bundled build and same-path GUI verification. Existing v2 frames and legacy pane-resize behavior unchanged.

Final fixture hash clarification:6f4127c9a5fbd8520eaebc290d92b9f354b188e90cc3ee34a53500d0740697ea includes explicit node:process/node:console imports added for ESLint after reviewer observed9ac0024e. Final live run and lint passed with this final fixture; adapter/test hashes unchanged.
