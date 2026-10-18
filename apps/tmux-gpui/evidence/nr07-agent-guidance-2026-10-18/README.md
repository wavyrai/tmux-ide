# Known agent readiness guidance

Only a typed create-pane 409 `harness_unavailable` refusal on an agent action now becomes fixed actionable text: check installation and configuration, or open a shell. This does not assert the executable is missing: daemon readiness can reject configuration too. Unknown errors and shell actions keep generic uncertain-failure wording. The browser allowlists these two exact strings; raw error text never reaches display. No automatic mutation retry or input authority is added.

Validation: 16 focused guidance/history handoff/history restoration tests pass; bridge TypeScript and ESLint pass. Independent reviewer traced createPane→new-window→live→browser propagation and found no blocker. No new physical GUI or installed-package claim.

Actual missing-tool owner investigation separately uncovered a stock tmux 3.8 session mutation fence target defect before readiness. That defect and its full authenticated-route verification belong to a separate increment. Do not count these guidance unit checks as proof of successful end-to-end agent onboarding.
