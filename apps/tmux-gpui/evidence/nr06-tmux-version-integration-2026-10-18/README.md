# NR06 GPUI selected-server diagnostics integration

Base61371792. Optional metadata getter performs one bounded authenticated probe per verified catalog lifetime. It returns immediately and does not await terminal readiness. Completion uses latest callback and exact catalog/request/current-owner fences; disposal aborts and clears. Unsupported404 or errors stay unknown without retries or normal UI errors. Native diagnostics accepts an optional bounded tmuxVersion and exports only the version, never scope or private paths.

Checks:8 bridge tests passed (new lifecycle plus existing provenance), bridge TypeScript and changed-file ESLint/Prettier passed; native diagnostics32 passed; full tmux_snapshot429 passed,0failed,1ignored; rustfmt passed. Independent np01_review found no source blockers. All author-owned gates terminal before commit.

The getter tests prove immediate return while the read is pending, latest callback replacement, private-host provenance, disposal/proof retirement and404/error behavior. They are not a measured visible first-frame performance claim. Prior61371792 actual-server proof validates the owner route separately. No new whole bridge-to-daemon runtime journey or native GUI/OS clipboard test in this increment. Existing packaged artifacts predate these changes. NR06 remains open until those acceptance checks are complete; no merge/publication.
