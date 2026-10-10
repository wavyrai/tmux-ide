# Open a session into its active terminal

Source correction and local packaging passed. Active-window native opening and input were observed successfully; full release qualification remains incomplete. Earlier checkpoints below are chronological.

Baseline: a43136e0 native package with only an isolated Info.plist identity change. Set TMUX_GPUI_TEST_INITIAL_WINDOW=two and launched native-window-nav-smoke.mjs under an isolated daemon/socket. Through CUA, refreshed Home and opened session e2e-gpui-window-nav-15287-0 without clicking a window tab. Both tabs rendered, but no terminal was selected; status was "Choose a pane or window". Screenshot is in the conversation. Closed this owned baseline app with Cmd-Q after observation; fixture exits 1 with "App closed before input proof". This is an operator-ended reproduction of the blank UI, not a timeout or a proven dropped-input defect. No terminal text was sent. User demo remains separate.

The physical fixture now accepts initial window one or two so the after-run can verify a non-first active window. A result depends on following its UI procedure (open session without clicking a tab); the fixture cannot independently attest every mouse action. Product correction, review, rebuild and same-path after-run remain pending.

Source validation checkpoint: the original real private helper journey failed because preferredPane was absent. With the correction, it passes currentWindowNotFirst, metadataOnly, explicitPaneFollowup, staleSessionRetired and cleanup. Full bridge gate passes TypeScript plus 229 tests, zero failures and five explicit optional skips. Native tests/build/physical after-run are still pending; these source results do not establish automatic native navigation.

Independent source review approved the frozen implementation and fixture repairs. Native library filter ran 126 tests successfully (the earlier binary filter ran zero and is not coverage). All six workspace gates pass: formatting, size, both Clippy feature configurations, default and all-feature tests; totals are in rust-gates.json and complete logs remain in /tmp/gpui-session-open-gates. Source same-path evidence passes; rebuilt physical after-run remains pending.

## Rebuilt native verification — 10 October

Commit `3b3abe18` was rebuilt and assembled with an explicit development identity. All five exact-artifact/compatibility tests passed. Build receipt and artifact log are retained here. The physical two-window fixture completed successfully, but its first marker followed a manual tab click while recovering from background CUA interaction: this is not a clean first-open proof. With the window active, Home → Open subsequently selected the current second window and rendered its terminal without a tab click. A separate fresh two-pane demo also opened its active Side by side window directly. See native-after.txt for scope and native-routing.log for the fixture result.

Hosted Linux bridge and isolated lifecycle job 114283194067 passed for the exact source commit in run 38076057772. Hosted macOS job 114283194274 was still running at observation. Local packaging is a development preview, not signed/notarized distribution; GP08/GP09 remain open.
