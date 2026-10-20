# NR04 — Matched application drag and hover

At source `58845aa8`, plain stock tmux 3.8, the compiled baseline TUI and the GPUI semantic bridge each delivered exactly the same 45-byte sequence: DEC1002 left down/drag/up, a mode-switch marker, DEC1003 buttonless hover, reporting-off and fresh-input markers. All three suppress buttonless hover under DEC1002 and suppress hover after reporting is disabled.

The private raw receiver changes modes only after receiving the expected preceding bytes. Each lane waits for tmux flags and observable markers; GPUI also waits for canonical published modes. The GPUI path sends typed mouse events using the published content region, never raw terminal escape strings. Plain tmux uses an attached client PTY; the compiled TUI receives actual host mouse input through its testdrive adapter. A default button label in the adapter receipt for move is metadata; the actual SGR motion code is 35 (buttonless).

The content geometry is 132×40 with one top-header row. Plain host coordinates account for that row, and TUI coordinates account for its sidebar and chrome. Original pane IDs/PIDs and final geometry match within each lane. All owned processes were cleaned up; installed artifacts and protected CLI are unchanged. Exact artifact hashes, input commands, raw bytes, captures, source hashes and cleanup receipts are retained here. Source bridge hashes remain stable across the run.

Independent read-only review verified the 45 raw bytes, oracle, transitions, identity/geometry and cleanup. No product change was needed. Raw terminal captures retain cell-padding whitespace.

This is one local SGR drag/hover workload, not physical native GPUI pointer acceptance, every button/modifier/protocol, SSH/bundled/platform qualification, smoothness or a performance benchmark. The TUI is the separately compiled baseline artifact, not a public installed GUI package. NR04 and #620 remain open.
