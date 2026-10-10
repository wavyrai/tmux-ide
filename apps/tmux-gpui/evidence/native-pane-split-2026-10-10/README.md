# Native split qualification — 2026-10-10

Native executable SHA256: `31792088c01d1d5666476711d1e61f781381ef32b3d4664cbcc2f0af78c63bd3`. Local cached build; pre-signing app, not a public release. Build source digest in build.log.

- Independent source review approved final bridge/native files and physical fixture.
- Bridge gate: 253 pass, 0 fail, 5 optional skips. Source and packaged real tmux split proofs passed: right/down, retained original selection, distinct panes, stale/duplicate refusal, no-space failure without retry, cleanup.
- Native focused: 7 passed. Before-failure geometry evidence proves capability label wrap reduced canvas481.5→462; stable Actions label restores exact canvas and zero extra commands.
- Rust fmt/file-size/both Clippy modes passed. Default tests2808passed/10existing ignored; all-features2842passed/17existing ignored; no failures.
- Packaged app/compatibility tests5passed.
- Physical CUA observed native menu right split then down split, coherent two/three-pane layouts with original node pane selected and Keyboard ready. Screenshots are in the local chat, not persisted PNG files. Independent tmux proof records exact new pane directions, originalPID92020 unchanged, all3alive after Cmd-Q, original terminal received zero bytes. Fixture cleanup succeeded.

Known remaining issue: sidebar kept “1 pane” after live splitting. Browser refreshes pane membership but not session-choice paneCount; next slice must refresh canonical session metadata under the existing request/presence guard, counting all windows. Narrow-layout physical qualification and public signing/distribution remain open. Native body can briefly show selection placeholder while refreshing split layout. No claim of complete TUI parity.

User demo launched separately: e2e-pane-actions-demo-93795-0, two windows/four interactive shells. Protected previous demo54706 remains running. Never operate this demo after handing it to the user.
