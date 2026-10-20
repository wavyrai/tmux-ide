# Bounded diagnostics export

NR06 increment based on b63c8909. F5 offers Copy diagnostics with Developer mode off, including when the bridge command channel is absent. Other offline commands remain disabled. Export does not navigate, reconnect, send terminal input or change the request identity; composition/modal guards remain active.

The JSON allowlist includes schema/product/platform/architecture, developer-mode state, bridge inputReady, deduplicated fleet states and typed phase/failure codes. inputReady describes the bridge publication, not native focus or the interruption gate. Output is capped at 4 KiB. No freeform status, terminal contents, machine labels/IDs, paths, capability tokens, timestamps or retry counters are serialized.

Native build/version and daemon/tmux versions remain explicitly null: upstream crate metadata is not the packaged tmux-ide identity. These fields must be filled from trustworthy runtime metadata in a follow-up, not guessed. This is not yet the complete NR06 diagnostic report.

Clipboard is written only after successful preparation; failure retains the existing clipboard. GPUI's clipboard API has no completion result, so OS-level delivery is not proven by the source call. Independent review found no privacy/action-isolation blocker. The successful export and composition refusal are exercised headlessly. A further F5/search/Enter offline test covers the actual event entry path.

## Validation

Initial focused suite: 402 passed, 1 ignored, zero failures. Initial full clippy rejected unwrap calls in the new pure test module; the module now follows the existing test-only unwrap convention. Failed log retained at .tasks/nr05-quiet-status/export-clippy-all-failed-test-unwrap.log. The subsequent full default run reproduced an offline keyboard-path defect: F5 opened Commands, but search refresh closed it when the bridge channel was absent. Retained failure: .tasks/nr05-quiet-status/export-default-failed-offline-refresh.log (2817 passed, one failed in the GPUI library). The refresh owner now permits Commands offline while rendering/dispatch continue to allow only Copy diagnostics. Same F5/search/Enter path now passes: three focused keyboard/clipboard tests, zero failures. Independent follow-up review found no blocker. Full workspace gates passed: default 3,083 passed / 11 ignored; all features 3,117 passed / 18 ignored; zero failures. All-feature and no-default-feature clippy, formatting and file-size checks passed. Logs are retained in .tasks/nr05-quiet-status/export-*.log.

Native GUI and OS clipboard checks remain pending: native discovery reports the Mac locked. No production input or settings were changed. Error-details access, trustworthy version metadata, failed-export injection and full card acceptance remain open. Nothing merged or released by this increment.
