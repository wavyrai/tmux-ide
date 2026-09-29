# Linux x64 C4 idle — executable source proposal, never launched

Depends on root review of CPU36593663415 and explicit separate approval. No
push, dispatch, build or performance run is authorized by this source proposal.

Parent source is ed28bad3's closed CPU envelope. Exact same accepted CLI ZIP
11043293883/runtime cb4f71b3 and input ZIP11039584548/image d52067ef, native893,
reference9ed, tool and 39-file harness pins remain. Scope is cb6/private32 idle;
production0, native default-off, final-cut applicability and promotion unchanged.
`pins.json` closes immutable artifacts, original harness and accepted overlays.

Only ONE candidate32 idle case: original125 seconds/26 samples, <=100 ms wake,
seed+one wake pair, six effects and final statuscursor12, one persistent producer,
no recurring native tmux observer spawn, original accounting/cleanup/deadlines.
No CPU modes are run here. The supervisor still executes original code; a narrow
copy dispatches `case-idle.mjs` and observes exact x64 host-namespace cgroup plus
ancestors instead of mount-root. Original campaign.py and case.mjs are untouched.

`case-idle.mjs`, `final-capture-drain.mjs`, `cleanup-diagnostic.mjs` are exact
byte copies of the accepted Spark idle-r2 fixture inputs. The original x64 case
to accepted case delta is `case-overlay.patch`; no product code changed.
Final capture uses identity prefix on the same command connection, validates
that exact issuer's capture/snapshot effect at sequence11 and same-epoch status12
with exactly six allowed effects. Wake timing ends only after that causal drain.
Additional final captures remain visible and fail exact cardinality; there is
no retry/omission to obtain a pass. Structured cleanup errors preserve phase
information without changing ownership or cleanup behavior.

The envelope verifies all91,036 prepared payload entries/modes/links before any
import, adds only six explicit harness files, freezes their dependency/ELF
closure, and verifies both original and derived closure even after failure.
Fresh Ubuntu runner image/Docker hash, boot ID/CLK_TCK/cgroup, affinity0,2 on
separate cores, quota-free ancestors, network-none, private PID namespace and
exact nonce/ID/mount/image cleanup are reused. Cgroup admission is before/after
the case, not continuous tracing; co-tenancy remains unproven and disclosed.

`validate_idle.py` ports accepted Spark post-case assertions to x64 topology
receipts, retaining every original idle gate. CLI/tool/native/ref bytes are never
rebuilt. Raw original artifact receipt remains unchanged; a separate reviewed
copy cites parent preparation acceptance and disclosed nested-manifest omission.

Actual command after future reviewed admission/spec generation:

```
/usr/bin/python3 /work/source/.tasks/native-x64-c4/harness/campaign-idle.py --approved-campaign /evidence/frozen-spec.json
```

Potential future trigger, ONLY after root reviews final SHA and CPU evidence:

```
git push origin qualification/linux-x64-c4-idle-r1
```

Exact branch push, not an additional manual dispatch; run_attempt must be1.
Independent always cleanup and artifact retention run after failure. Output
`idle-receipt.json` does not alone imply release qualification: post-closure,
container cleanup and independent review remain necessary.

Offline checks:9 Python tests (cgroup/closure/pins and original idle gate negative
cases) plus6 Node causal-delivery/cleanup diagnostics tests; syntax, exact byte
comparison and patch reproduction checked separately. No product execution.
