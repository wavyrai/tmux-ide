# Open a session into its active terminal

Work in progress, not a passing qualification receipt.

Baseline: a43136e0 native package with only an isolated Info.plist identity change. Set TMUX_GPUI_TEST_INITIAL_WINDOW=two and launched native-window-nav-smoke.mjs under an isolated daemon/socket. Through CUA, refreshed Home and opened session e2e-gpui-window-nav-15287-0 without clicking a window tab. Both tabs rendered, but no terminal was selected; status was "Choose a pane or window". Screenshot is in the conversation. Closed this owned baseline app with Cmd-Q after observation; fixture exits 1 with "App closed before input proof". This is an operator-ended reproduction of the blank UI, not a timeout or a proven dropped-input defect. No terminal text was sent. User demo remains separate.

The physical fixture now accepts initial window one or two so the after-run can verify a non-first active window. A result depends on following its UI procedure (open session without clicking a tab); the fixture cannot independently attest every mouse action. Product correction, review, rebuild and same-path after-run remain pending.

Source validation checkpoint: the original real private helper journey failed because preferredPane was absent. With the correction, it passes currentWindowNotFirst, metadataOnly, explicitPaneFollowup, staleSessionRetired and cleanup. Full bridge gate passes TypeScript plus 229 tests, zero failures and five explicit optional skips. Native tests/build/physical after-run are still pending; these source results do not establish automatic native navigation.

Independent source review approved the frozen implementation and fixture repairs. Native library filter ran 126 tests successfully (the earlier binary filter ran zero and is not coverage). All six workspace gates pass: formatting, size, both Clippy feature configurations, default and all-feature tests; totals are in rust-gates.json and complete logs remain in /tmp/gpui-session-open-gates. Source same-path evidence passes; rebuilt physical after-run remains pending.
