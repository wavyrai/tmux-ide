# NP01 — wait for fleet retirement and correlated refresh guidance

Baseline: main 21d3a178. CI run 38604484066 failed the packaged retired-route test: it expected `Machine or session changed. Refresh the fleet and select the session again.` but read `Machine connection changed — refresh sessions to reconnect`.

The old fixture treated any unavailable/null-selection publication as route retirement, and any non-Loading unavailable publication as refresh completion. Neither is a completion contract. The retained packaged trace shows Home first becoming unavailable, then explicit retirement, then the exact correlated refresh guidance. Fifteen unchanged local retired-case runs passed; the exact CI scheduling has not been reproduced locally. This is a fixture synchronization correction, not a claimed runtime bug fix.

The fixture now latches the decoded retirement event so a following publication in the same stdout chunk cannot hide it. Each refresh waits for its own exact expected guidance. Every intervening unavailable publication also asserts no snapshot, no input grant, no selected server and no sessions. The active verification-failure negative control and stderr assertions remain unchanged.

An initial candidate that polled only the latest retirement status timed out in the packaged inflight case; retaining the event rather than requiring its message to remain current resolves that missed-event defect.

Validation: packaged native alpha 0.1.1 (build 2026101410) passes all three focused process tests after the change. Source process checks, formatting and lint are recorded in the associated PR. No daemon, SSH or tmux server is launched by this fixture: it owns private HTTP/discovery files and browser children. Hosted packaged qualification is still required before closing NP01.
