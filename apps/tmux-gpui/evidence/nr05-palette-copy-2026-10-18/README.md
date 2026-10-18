# NR05 transient palette guidance

The prior NR04 split/zoom action capture showed “Open a live session first” while an existing terminal reconciled its layout. The canonical navigation owner returned the same generic guidance for every non-live state. This change distinguishes connecting (“Opening terminal…”) and rebinding (“Terminal is updating. Try again shortly.”), retaining exactly the same admission checks. No protocol or daemon behavior changed.

The added regression failed before the copy change, then 19 focused tests passed across the navigation and palette command owners; scoped ESLint passed. Tests verify no zoom dispatch for missing/non-live states or a missing pane, and one dispatch when live with a pane. Independent source review found no blockers or weakened admission.

Actual source-TUI verification used private stock tmux 3.8 and the retained genuine installed 2.9.7 daemon. Attempt 1 failed in the harness before palette admission; no subsequent Enter was sent. After adding a visible-palette guard, attempts 2 and 3 found Zoom already enabled. The transient was UNOBSERVED; these are not passing live reproduction results. All attempts confirmed six owned processes exited and the protected generated CLI remained unchanged. Source HEAD and exact dirty diff are retained. Native GUI and installed-TUI verification are not provided.

Keep NR05 open. This is a reviewed owner-level copy improvement with focused regression coverage, not full live-path or release acceptance. No production sessions, settings or daemons were changed. No push, merge or publication.
