# Linux x64 metadata9 — source proposal, no dispatch

First component lane after accepted Linux x64 CPU/idle and build-only preparation.
No artifact rebuild or live action is authorized by this source. Reuses exact
CLI ZIP11043293883/runtimecb4f71b3, inputZIP11039584548/imaged52067ef/native893/ref9ed
and componentZIP11046174860/overlay0718450c. All full hashes in pins.json; no
installation/build/native functional run/CLI launch or reader-source modification.

The accepted 60-file component overlay is extracted unchanged, regular-file
mtimes restored before Python cache imports, and all4255 closure entries verified.
The five original `/inputs` build script entries are carried byte-identically
because they belong to the artifact's closure, but no build script is executed.
Raw preparation receipts and archived host.json remain immutable.

Fresh lane authority is explicit: current runner image/Docker/image/tool pins,
CPU0,2 on separate physical cores, no CFS quota on exact cgroup or ancestors,
new boot/CLK_TCK/cgroup. Compose both fresh-host-inputs.json and component-host.json
from the SAME immutable artifact descriptor. Reused native import preflight
validates descriptor/identity and artifactHostSha256 before loading x64pty/headless
and comparative definitions only. No fixture is started by that preflight.

Existing base prepare-freeze validates original full runtime/resolution/ELF
closure but launches no case; its temporary cpu lane label is only the existing
freeze API selector. freeze-metadata derives a separate metadata9 spec by adding
component4255closure/shared ELF objects, extra package resolutions, exact lane
helpers, fresh `/evidence/component-host.json`, and source-at-prepare manifest.
It asserts fresh component host equals the frozen base spec host. Nothing reuses
the preparation container's runtime identity. Output/spec/home must be fresh.

Actual workload command (only after future approval):

```
/usr/bin/python3 /work/source/.tasks/components-linux/metadata/metadata.py --approved-metadata
```

Original accepted ARM metadata.py/reader/helper bytes run unchanged. Orders:
0/16/32,32/16/0,16/0/32. Each of9 cases uses1500pairs,6002records,3001effects,
retained256,pending0,last6002,journalCursor3001,published3001,zero gaps and complete
owned cleanup. `metadata_gate.py` and `gate-metadata.py` are exact accepted ARM
oracle bytes; every case AND pooled mode must meet p99<=50ms,max<=100ms. Native
CLOCK_MONOTONIC vs Python timestamp-before-JSON stays unchanged; no sample
selection, clock adjustment, diagnostic-overhead subtraction or new metric.
CPU is diagnostic only. Base sourcecb6/private32 remains explicit; wrappers
select0/16/32. No production/default promotion is implied.

Exact cgroup+ancestor identity/quota/throttling and topology are sampled before
and after the WHOLE nine-case lane; zero throttling required. This is the already
reviewed x64 observation scope, not ARM's5-second host monitor or a guarantee of
co-tenancy isolation. No new checks are inserted into the measured per-pair body.
Original metadata 300-second outer timeout retained; original child deadlines
and recursive owned cleanup remain unchanged.

Always retain original and component closure checks after failures, plus derived
spec verification whenever freeze completed; archive original source-at-start/end,
all samples/results and bounded private fixture diagnostics. Exact-container
nonce/image/ID/mount checks precede retirement. Independent always cleanup,
image retirement and artifact upload remain separate CI steps. No retries.

Proposed exact branch trigger ONLY after root review:

```
git push origin qualification/linux-x64-c4-metadata-r1
```

Workflow manual trigger is retained but must not also be dispatched; attempt must
be1. Parser18 and quiet-tail3 are deliberately not chained: their future envelopes
can reuse this admitted runtime+overlay and accepted ARM oracle bodies after
metadata evidence review. No new build or additional qualification axis needed.

Offline checks:9 tests (4 original metadata gate negatives/positives,2 accepted
actual-cache tests,3 envelope/pin/order checks), all Python AST/Node26 syntax,
exact original5build-input and2oracle byte equality, single-job workflow parsing.
No native module import/build/fixture or live lane used during source checks.
