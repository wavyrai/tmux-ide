# Selected session mutation fence: actual stock3.8 diagnosis

Original real-owner.mts is preserved. Its authenticated missing-agent create failed503 before readiness; the cause was “Selected live tmux session changed before mutation” despite unchanged server/session identity.

Three isolated probes distinguish mechanism: fence-diagnostic reproduces the owner fence refusal; fence-components shows that display-message -t =owned has empty session_id/session_created/session_name context; fence-targets shows =owned: (also $0: or exact pane ID) has the expected context and condition evaluates true. This is tmux pane-target qualification, not shell expansion of $0.

The private wrapper initially changed only top-level arguments and missed the nested session condition inside the server generation fence (failure retained). The nested-target-only wrapper then yielded409 harness_unavailable with unchanged pane inventory and successful200 terminal creation. Finally real-owner-source-fixed.mts runs the original owner/route scenario with actual corrected product source and NO wrapper; it passes the same assertions. All private socket probes report closed after cleanup.

Product correction adds colon to the exact selected session target of if-shell; ID/created comparisons and replacement protection remain unchanged. New actual live regression uses stock3.8 and the real nested generation/session fence. Before:1test failed at session guard. After:1test passed, including correct session versus similarly named session and rejection after the selected session is killed/recreated between admission and mutation. An intermediate test fixture failure is retained: its set-option target itself needed pane qualification as well.

Runtime source harnesses use Node24 --import tsx from worktree root; relative imports require original .tasks/native-reliability-mission/nr07-missing-agent location, not retained evidence directory. Focused test command: PATH="$PWD/.tasks/tmux38-compat/tmux-3.8:$PATH" pnpm --filter @tmux-ide/daemon exec vitest run --config vitest.live.config.ts src/lib/tmux-session-mutation-fence-live.test.ts. No protected CLI rebuild, production daemon, or GUI interaction.
