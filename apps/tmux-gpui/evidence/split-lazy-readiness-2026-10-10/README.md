# Lazy split readiness — 2026-10-10

Before: the real retained owner with no native-observation environment flag
refused its first canonical split read. `before.txt` retains this reproduction.

Now only a canonical split read can request lazy activation. A read-only
preflight verifies supported split and wrapper capabilities on the same native
epoch; unsupported servers never reach journal enablement. The existing owner
starts once, awaits actual readiness, then the strict issuance gate runs.
Timeout halts/disposes the reader and cannot restore late readiness. Epoch and
retained entry replacement are fenced before handles are returned. Ordinary
startup/TUI defaults remain unchanged. Only split reads gain a45s default HTTP
budget for existing bounded probes/readiness; explicit caller deadlines win.

80 daemon tests,7 client tests, typechecks and targeted lint passed. Independent
review approved lifecycle, deferred retirement and same-viewer input coverage.
Maintained owner and source bridge gesture fixtures now default to no opt-in
flag and passed against the maintained darwin-arm64 bundle SHA-256
`f546fd08b555d819c3416a8dc91d6ab75750b8245d28787fdcf7dc597eca572a`.
First read enabled a supported observer; same viewer subsequently accepted exact
selected-pane input and resized before release to boundary49 with stable pane
identities. Unsupported older binary stayed disabled. All real fixtures cleaned.

`fixture-target-failure.txt` records an intermediate test assertion reading
fixed pane0 instead of the selected semantic pane; the maintained fixture now
resolves that exact semantic pane. It was a fixture issue, not a product fix.

Working-client hash in source-sha256 includes preexisting applicationShell
changes, which are excluded from this commit. Other frozen files are exact
reviewed inputs. No GUI demo replacement, production action or publication.
Remaining: full GPUI source checkpoint/clean-checkout qualification, physical
drag/IME acceptance, other native platforms, signed install/update and release.
