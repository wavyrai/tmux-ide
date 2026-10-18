# NR04 initial actual TUI calibration

The latest `tui-calibration.json` passes. This is an actual current-source OpenTUI launched by `scripts/tui-testdrive.mjs --source`, attached to a private canonical daemon started with genuine installed tmux-ide 2.9.7 (CLI SHA in receipt), using stock tmux 3.8. No main-worktree CLI build occurred. The source TUI launcher still sets TMUX_IDE_CLI to the repository CLI internally; the already-running explicit canonical daemon supplied the tested owner. This is therefore a mixed current-source TUI / packaged-daemon qualification, not an installed TUI qualification.

The private host framebuffer is captured in tui-initial.ansi and tui-initial.txt; expanded, restored and fresh-input text captures are retained. Both source content markers are rendered. Actual host resize 160×44 → 180×48 → 160×44 yields source window 132×41 → 152×45 → 132×41. Original source pane IDs/PIDs survive adoption and the round-trip. Fresh input sent via the actual TUI produces an exact standalone marker line in the source pane. Stock 3.8 reports empty pane_birth_id, so receipt explicitly reports unsupported and does not claim that identity proof.

All fixture-owned source/host sockets, daemon and temporary files were cleaned; protected bin/cli.js hash is unchanged. The first failed attempt is preserved: omitted explicit target selector made the testdrive read default session names before rejecting the missing target; no default-server input or mutation occurred. Harness now asserts explicit source and host socket ownership before testdrive commands.

Remaining NR04: plain tmux lane and GPUI bridge lane at these calibrated source geometries; horizontal divider drag (this first check exercises host resize only); switch/split/zoom/close; native physical GUI acceptance separately. No latency, smoothness, performance or full parity claim is supported by this receipt.

## Reproduction command and provenance

Run from worktree root:

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04/tui-calibration.mjs > .tasks/native-reliability-mission/nr04/tui-calibration.stdout 2> .tasks/native-reliability-mission/nr04/tui-calibration.stderr
```

Worktree HEAD: `525380c48c69fecb085505f76ba574f5cdc4bdfc`; source files may include current uncommitted parent work. Packaged daemon source commit: `6ad84931817b0ee01ca209b6341dc33dacc1cb0f`.

- `.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node`: SHA256 `e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b`
- `.tasks/tmux38-compat/tmux-3.8/tmux`: SHA256 `8b97ea85e10c6e9a6966451259f15d1041981fb313715e510c14c430d294af96`
- `.tasks/nr07/package-297-f7rol0nn/installed/lib/node_modules/tmux-ide/bin/cli.js`: SHA256 `7e7a6945cc350da7f41e6ab6b124ad6d94f3a487106b1a2658cc5789c01f740c`
- `scripts/tui-testdrive.mjs`: SHA256 `d19f33533eef72dd6242a02d9ad0f7b7491ec498e881a0a748268b2fbbb6c2a4`
- `packages/daemon/src/tui/mirror/app.tsx`: SHA256 `1be7c4bf70cff8991f7129c7f05cc9516abcbf4538e886ef6ca782bca01ee603`
- `.tasks/native-reliability-mission/nr04/tui-calibration.mjs`: SHA256 `bfe2a99e441b0ee327131685b1be999adc0a07f52af9ff5c861dce6846735d9e`
- Bun `/private/tmp/tmux-ide-295-release-nkydyctm/tools/bun`: version `1.4.2`, SHA256 `35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5`

## Cleanup qualification correction

Earlier receipts marked cleanup true after best-effort operations. Those are retained as `tui-cleanup-unqualified-pass.json` and `plain-cleanup-unqualified-pass.json` and are not authoritative cleanup proofs. Current reruns collect exact owned source server/pane PIDs plus daemon, host server and host renderer PIDs for TUI. After scoped shutdown they poll those PIDs for exit; no owned PIDs remain. Cleanup errors or changed protected CLI bytes now make pass false. Latest TUI checked 6 owned PIDs; latest plain checked 3.

Historical lane-local scope above predates the aggregate comparison. The sibling README.md now records the completed bounded three-lane resize calibration. Native physical GUI, divider drag and broader parity remain unqualified.
