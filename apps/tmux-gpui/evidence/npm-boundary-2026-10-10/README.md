# Native/npm package separation checkpoint

Source checkpoint ac2a1755, codex/tmux-gpui-bootstrap. `pnpm pack:check` exited0 on macOS ARM64 with Node24.21.0. Installer32pass/0fail; release-tag11pass/0fail; actual npm dry-run inventory3886files/4329764bytes. The package checker rejects any apps/tmux-gpui path, desktop-renderer bundle, development scripts, contributor tests, and host TUI binaries while requiring supported OpenTUI runtime entries.

The ignored prepack lifecycle was not run; bin/cli.js is the existing generated local fixture build and was not staged. This is a package-boundary/installer regression check, not a full terminal release qualification or publication. Native signing/clean-machine gates remain separate. Fresh origin/main fetch found no HEAD..origin/main commits (origin/main c78ff90b6d47a5f94e9996da01153f799b7f98b9).
