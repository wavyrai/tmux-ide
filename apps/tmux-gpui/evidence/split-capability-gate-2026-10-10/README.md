# Split capability gate — 2026-10-10

Reproduced: an unsupported server could receive canonical split handles when
an observation epoch existed. `before.txt` records the failing retained-owner
regression. Issuance now requires a positive, uncached, generation-pinned probe
with matching actual native epochs before and after split capability detection.
Both journal replies must satisfy the capability schema, enabled/nondegraded
state and all required direct operation guards. Observer identity/readiness and
retained channel/epoch are rechecked after awaits. Probe uses read-only `-V` only;
missing capability or callback denies issuance. Mutation guards remain in place.

Validation: 38 focused tests passed; daemon typecheck and targeted lint passed.
Independent review approved source and corrected test matrix. `source-sha256.json`
records exact reviewed inputs. Tests cover unsupported recovery, missing callback,
epoch/channel retirement, observer replacement, malformed/oversized capabilities,
disabled journal and missing guards, with exact probe-stage assertions.

Actual private old/new binary probe: old three-patch binary denied; prototype
split-patched binary accepted after explicit fixture activation. Disabled journal
remains disabled during the gate. `native-probe-script.txt` retains the exact
machine-local reproduction (paths are ephemeral). Both fixture servers cleaned.
Real owner runner and source bridge HTTP/WebSocket gesture smoke passed, including
movement before release, final boundary49 and stable pane identities. Both report
cleanup:true. These tests use an opt-in observer and the prototype native binary.

Not a release gate: packaged native provenance still omits the split patch;
a reviewed daemon activation policy and physical GUI drag qualification remain
pending. The running user demo was not replaced or interacted with during this
slice. No default observation changes, native promotion or publication.
