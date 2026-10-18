# NR03 canonical history-anchor owner

Basea8dd36f2. Owner-only prerequisite: no HTTP/client/native restoration yet.

Private bounded tokens identify a row ordinal under the exact committed workspace/pane/generation/incarnation/revision/stateHash. Only proven historyDelta trim/append preserves identity. Seed/full replacement, geometry/alternate transition, reset/reseed, fault and retirement revoke anchors. Token count32 and lifetime5minutes are bounded. Existing terminal v1 payloads and hashes remain unchanged; tokens do not appear in terminal publications.

Actual interpreter onUpdate feeds the tracker. Subscriber currentSeed delivery does not. Integration regression captures repeated-text history, closes all subscribers, processes more output, reattaches and resolves the same anchor; stale proof and disposed owner are refused. Tracker tests cover trimming before vs trimming the anchor, replacement, bounds and expiry.

53 tests passed in two focused files. Daemon typecheck, lint and diffcheck passed. Independent np01_review approved final source including fault invalidation and complete identity proof. Original logs retained in .tasks/native-reliability-mission/nr03-anchor-owner; copies here. No production sessions, generated CLI, native UI or release changes. Actual user-visible scroll restoration and NR03 acceptance remain unfinished.
