# NR04 busy actual OpenTUI divider

Run from worktree root with current explicit local dependencies:

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04-busy/tui-divider.mjs > .tasks/native-reliability-mission/nr04-busy/tui-divider.stdout 2> .tasks/native-reliability-mission/nr04-busy/tui-divider.stderr
```

Actual source OpenTUI hosted by the existing private testdrive, genuine installed2.9.7 canonical daemon, stock tmux3.8. Shared immutable producer.sh is copied byte-identically into the private fixture and started via direct tmux setup input in the left pane. The right pane remains quiet. This startup is fixture setup, not the fresh-input qualification.

Host160×44/source132×41; top pane border reserves one content row. Each TUI `mouse drag` is a full down/interpolated-move/up sequence at hosty12, x94→97,97→103,103→94. Resulting exact source widths66/65→69/62→75/56→66/65. Both source marker lines survive every step, right origin follows left width+1, height/window geometry and original pane IDs/PIDs remain stable. Source ticks are sampled before and after each drag; each increases while <200 and DONE absent. This demonstrates live output during gestures, not throughput or latency.

After finite producer completes, exact source tick200 and DONE plus actual TUI rendered tick200/DONE are required. Fresh TUI input then produces a standalone source output line. Six captured fixture-owned PIDs have exited after cleanup, no cleanup errors, protected CLI unchanged. Stock3.8 pane_birth_id unavailable. No physical native GPUI or performance claim; source TUI is not installed-TUI qualification. No failure attempts in this slice.

Observed per-drag ticks: [(1, 6), (7, 13), (14, 21)].

HEAD `5b92f4f4f2ca62cc8ebe8f9497cf9df0d1f51438`.

- `.tasks/native-reliability-mission/nr04-busy/producer.sh`: SHA256 `b7a22be828914370e1b35dd079a0b16a06a69ec6abfd27d963de32176c118617`
- `.tasks/native-reliability-mission/nr04-busy/tui-divider.mjs`: SHA256 `07279a8b66d94a743555b2984fc8424456201fdcbfe1fbcb8569e83ddafee3c7`
- `.tasks/tmux38-compat/tmux-3.8/tmux`: SHA256 `8b97ea85e10c6e9a6966451259f15d1041981fb313715e510c14c430d294af96`
- `.tasks/nr07/package-297-f7rol0nn/installed/lib/node_modules/tmux-ide/bin/cli.js`: SHA256 `7e7a6945cc350da7f41e6ab6b124ad6d94f3a487106b1a2658cc5789c01f740c`
