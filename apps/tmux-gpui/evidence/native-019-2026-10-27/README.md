# Native alpha 0.1.9 candidate

Actual native screenshot of the isolated local browser fixture, showing the pane
cards and favicon. The window was inactive when captured. The user confirmed
that the browser pane opens. A later inspection showed the expanded browser and
its favicon in the window tab as well.

Verified locally:

- CLI 2.9.14 focused terminal release gate, including packed-install journey.
- Native default tests: 3,868 passed; all features: 3,902 passed.
- Both native Clippy configurations, formatting and source-size checks.
- Fresh release build receipt and explicit metadata assembly; 10 package checks.
- Developer ID signing, Apple notarization, stapling, Gatekeeper and archive verification.
- Signed bundled Node/session-open journey and production Rust viewport/input journey.
- Native installer upgrade from 0.1.8, repeat install, rollback, update after rollback,
  and uninstall preserving the configuration marker. A second rollback correctly
  refused because the old version has no predecessor.
- Live browser favicon changes red/blue/red and native header appearance.

Remaining limitations:

- Computer Use can inspect the app but fails to deliver clicks. The final manual
  browser restore and transport check remains unconfirmed; automated stale-surface
  and resize regressions pass. No transport-parity or physical latency claim.
- Native browser integration requires the separately prepared external browser.
- No fresh second-Mac GUI check. Linux/Windows favicon checks have not been repeated locally.
- The inherited release-script history test rejects historical commits in the
  parent monorepo; the other 59 release-script tests pass (5 platform skips).
- The mockup recipe test could not run locally because `just` is unavailable.
