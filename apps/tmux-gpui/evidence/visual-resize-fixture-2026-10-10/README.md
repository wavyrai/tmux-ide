# Visual specimen resize race — 10 October 2026

Actual packaged app at source a43136e0 rendered the Unicode/style/wrap specimen
in an isolated native window, inspected using CUA. On native close, the source
returned to 80 columns but retained a line drawn for 92 columns. The fixture's
post-close assertion timed out; the original source captures and result remain
in before/. Owned cleanup completed and the user's demo stayed running.

Reproduced in a private tmux PTY: custom SIGWINCH handler was registered before
Node lazily initialized stdout's dimension-update handler, so it drew using stale
columns. The producer now listens to stdout's resize event after dimensions
update. The regression exercises 80 → 92 → 80 against real tmux.

The same exact packaged application, with only the external synthetic producer
corrected, passed the physical open/select/capture/Cmd-Q path. after/ records
sourcePrepared=true, nativeLaunched=true and sourceSurvivesNativeClose=true.
No app runtime change was needed for this fixture defect.

CUA screenshots in the conversation showed ASCII, wide characters, combining
accents, emoji, palette/RGB, styles, colored blank cells, wrap continuation and
cursor. This is a qualitative single-display observation; screenshot pixels are
not stored in this evidence folder, and no exact color/font/DPI/full-matrix
verdict is claimed. IME, clipboard and narrow-layout qualification remain open.

Independent final review approved producer SHA-256
`0711c9993e3809c599046bbe600bb6b492088927f575e1eb80243b206e82601c`
and test `ffbe87555ac158fdb2febf4803c2fa958af4391778889ff5de9813aaba8e920d`.
Three tests pass with the explicit maintained tmux binary, no skips; ESLint passes.
The test checks exact wrap content, short private socket paths, and cleanup even
when the PID query fails. Text logs normalize trailing whitespace only.
