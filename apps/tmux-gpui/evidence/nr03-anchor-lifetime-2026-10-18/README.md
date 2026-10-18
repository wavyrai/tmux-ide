# Long-paused saved history anchors

Clock-driven regression before implementation: 3 failed / 8 passed (before.log). A token captured against unchanged canonical history incorrectly became lost after five minutes, including a 24-hour pause.

Correction removes only token age expiration. Saved anchors retain owner-private ordinals until 32-token FIFO eviction, trim of their row, reset/reflow/alternate screen, identity change or owner retirement. No timer, retained connection or wire changes. Historical capture proof metadata remains capped at 64 entries with five-minute expiry; current exact proof remains capturable when quiet.

After: 56 focused tracker + replica-owner tests passed (after.log), ESLint passed (lint.log). Regression proves 24-hour retained-token continuity, current-proof fresh capture, expiration of old historical capture proof, survival of trim-before and refusal after trim-anchor. Existing cap, foreign identity, full reset, dimensions, alternate-screen, retirement and zero-subscriber integration tests remain passing.

This is deterministic owner-level clock evidence; no new native GUI, daemon runtime or installed-package claim. No CLI bundle was rebuilt.
