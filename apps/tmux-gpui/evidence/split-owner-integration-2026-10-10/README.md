# Real owner split-resize integration — 10 October 2026

Run from repository root with Node 24 and the split-patched prototype binary:

```sh
node --import tsx native/tmux/tests/split-owner-runner.mjs /path/to/patched/tmux
```

The passing fixture uses the actual native server owner, native observation
reader, canonical control channel, session runtime registry, transport binder,
serialized semantic executor and guarded native command. No observation or
native runner mock is injected. Socket, HOME, state and sessions are private;
cleanup independently closes bindings/subscription/owner and kills only that
private server, then removes its directory.

Verified: resize to column 83, canonical publication of the updated boundary,
unchanged pane IDs/births/PIDs, replay response for the same operation ID,
input-only refusal, stale layout refusal and replaced geometry-owner refusal.
Independent review approved the fixture. ESLint passed.

The three prior failures were fixture setup/expectation errors, not product
regressions: invalid server ID, noncanonical redemption URL and expecting
`applied` instead of the correct `replayed` outcome on duplicate submission.
All runs reported private-server cleanup. Failed logs are retained explicitly.

Limitations: this fixture constructs trusted transport context directly; it
does not prove HTTP authentication or WebSocket redemption. Duplicate result
and stable state are observed, not an independent native dispatch count (unit
coverage checks that). GPUI drag wiring, native provenance promotion, packaging
and physical acceptance remain open. No release or performance claim.

Fixture SHA-256: `1ed4e93c02010471ee24a5d0b235466d8907e9465ad3197df26ed98fa89d6d35`.
