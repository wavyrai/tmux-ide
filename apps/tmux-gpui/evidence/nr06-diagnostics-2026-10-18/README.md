# NR06 bounded diagnostics identity and Home access

Base: b94ab430. Local source increment; not merged or released.

Running-app native version/build now come from NSBundle Info.plist with bounded validation, never upstream Cargo metadata. Daemon version comes from actual verified identity, registered against the exact private host object and cleared on owner disposal, foreground/readiness/request loss. Local discovery regression deliberately uses differing record and actual endpoint versions. Unknown stays null; selected-server tmux version is still pending a separate scoped route.

Home error details offer Copy diagnostics with Developer mode off. Home callbacks capture and revalidate request, Home state and modal admission. F5 and Home use the same prepare-before-clipboard export. Invalid preparation leaves existing clipboard untouched and sends no connection or input command.

## Validation

- Node24 `--import tsx --test apps/tmux-gpui/bridge/{diagnostic-versions,discovery,remote-route}.test.ts`: 26 passed.
- Bridge TypeScript typecheck, changed TypeScript ESLint, Prettier and native rustfmt checks passed (author-owned terminal gates).
- Canonical Rust toolchain `cargo test --locked -p herdr-gpui tmux_snapshot --lib`: final 428 passed, 0 failed, 1 ignored. The ignored trace fixture is not acceptance evidence.
- Earlier diagnostics filter: 30 passed.
- First full suite: 427 passed, 1 failed, 1 ignored. New offline keyboard fixture omitted KeyUpEvent, required by existing native-button activation tests. Corrected test asserts focus index 4 then dispatches Enter down and up; it does not invoke the action directly. Failure and corrected full-suite logs retained.
- Independent reviewer np01_review found stale Home callback issue; fixed captured-request/modal guards and regression reviewed. Reviewer also required a valid live-version positive baseline before stale-null assertion; final suite covers it.
- Protected bin/cli.js unchanged. No production sessions, daemon settings or clipboard touched by root commands.

## Limits

GPUI test-context keyboard/clipboard checks are not physical GUI or macOS clipboard-delivery proof. Actual running-bundle metadata extraction, accessibility, light/dark/narrow checks remain pending while Mac is locked. Existing QA bundle predates this source. Current assembled QA Info.plist identifier is com.tmux-ide.gpui.development, matching the allowed family; this inspection alone does not prove runtime extraction. NR06 stays open, including selected-server tmux identity and remaining acceptance.
