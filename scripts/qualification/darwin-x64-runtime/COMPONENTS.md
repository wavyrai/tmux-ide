# Held original Darwin Intel component lanes

Additive source at c4638a02. Existing CPU/idle/admission/stage/build-reader files are unchanged. No build, workload, push or deployment was performed. `pins-components.json` is held (`executionAuthorized:false`, `authorizedLane:null`, functional receipt SHA/run null); filling reviewed reference pins/prerequisite and authorizing exactly one lane remain separate root actions.

`runner-component.py` reuses actual `runner.download`, `intake-cpu.intake`, `bind_runtime`, `stage_sources` and `verify-cpu` implementations. Each fresh hosted envelope verifies actual ZIP/tar/every member before executable imports, stages external sources, admits fresh Intel host/Mach/native addon, builds the three existing reader bundles using admitted Bun, then freezes and runs only the pinned original lane. No extra CI preparation job or human pause is required between checked machine phases. CLI/native/reference are never rebuilt or modified.

`freeze-component.py` generates the required reference.json/source-at-prepare.json/verify.mjs, hashes staged sources/bundles/metafiles/descriptors and all shared recipe/host/tool inputs. Spec/output live outside source ledger. The original payloads remain closed and fully reverified before and in finally after any outcome. The three existing bundles are preparation artifacts, never reader executions. The existing renderer-neutral plugin and esbuild recipe remain unchanged.

Workloads/gates:
- Parser18: original six modes, three round rotations,200+2samples,10resizes; median-round p95 delta<=1ms versus disabled. Parked reader/parser callback, not attributed-command consumed paint.
- Metadata9: original0/16/32 round orders,1500pairs/6002records/3001effects, exact kinds/pending/gaps/cleanup, every case plus pool p99<=50ms/max<=100ms.
- Tail3: original ten phases/source-file bursts/64-record backlog, same6002/3001 counts and every phase+run gates. No tail rerun, tuning or relaxed latency.

Pure gates in component-gates are unchanged accepted source copies; component-gate-origins records origins/hashes. Entry adapters remove Linux path literals, not gate logic. Metadata report's combined-lane main is never called; only its shared pure distribution is used. Original command/telemetry loops and clocks are unchanged.

Only fixture execution delta is cancellation: parser preload sets a flag and an exact overlay seam checks it before the next case, permitting current bounded case cleanup; the Python bootstrap converts SIGTERM/SIGINT once into the original driver's failure/finally path and ignores repeated cancellation during cleanup. Wrapper also remembers cancellation and never accepts a cancelled run. Neither original admitted source nor shared upstream snapshot is changed. There is no supervisor-only timeout that orphans a live case; hosted job ceiling120minutes is a last external bound and force termination means missing/incomplete cleanup, never acceptance. Existing per-case bounded waits/retirement remain authoritative.

A failed gate or uncertain cleanup retains all raw results, driver log, terminal receipt and finally-postclosure. Success requires original gate plus all expected cleaned cases. Partial results are not complete cleanup proof. A one-shot marker refuses restart in the same output. All generated evidence and reader receipts are collected, excluding node_modules/home/caches.

Six focused tests pass on /usr/bin/python3: actual descriptor explicit bindings, original lane argv, actual wrapper postclosure on failed exit/uncertain cleanup, held runner refusal before transport, and bounded pure Python cancellation fixture proving original finally executes even on second signal. The added sixth test checks exact receipt byte pinning, same-reference identity, success/cleanup/prepost fields and missing/tampered/failed prerequisite refusal. No tmux/daemon/reader workload or unchanged qualification matrix was run. Existing shared and pure-gate tests were not redundantly repeated.

Proposed machine command after separate approval:
`/usr/bin/python3 scripts/qualification/darwin-x64-runtime/runner-component.py metadata "$RUNNER_TEMP/darwin-x64-component"`
Parser or tail requires matching explicit authorizedLane pin. Workflow reads that closed pin, not arbitrary dispatch inputs. Current workflow is inactive/unpushed. Reference functional4case prerequisite is owned separately by cold_start_preparation and is not bypassed here.

Accepted reference artifact11059409786/run36624139102 is now pinned verbatim from the owner recipe: binary01bd7831…, ZIP047fde1b…, tar2c657ac5…. This is build acceptance, not functional acceptance. `component-prerequisite.py` requires the ORIGINAL forthcoming accepted.json as fixed `reference-functional-accepted.json`, exact reviewed SHA and originating CI run. It checks same binary SHA,4cases/no skips, cleanup and pre/post admission. The file and pins remain absent/null until root audits actual CPU artifact terminal/vitest/four ownership receipts; then root can retain and pin that exact accepted receipt here. No synthetic receipt, boolean override, prerequisite rerun or additional transfer framework. The complete recipe freeze includes its bytes once supplied.

Shared intake correction from reviewed CPU22b966fc7edc4046866bd6906a5cfbce4765638f: identical no-follow chmod restores archived symlink modes after creation. Strict original verifier remains unchanged. The exact two-umask regression verifies link700/755 and untouched target600/bytes. Six shared-envelope plus six component tests passed on /usr/bin/python3; no skipped tests or runtime workloads. Historical CPU36626475919 pre-runtime failure stays retained.

## Reviewed derivation and accepted prerequisite integration

Original accepted reference receipt from CPU36680179337 is now retained byte-identically as reference-functional-accepted.json (SHA568e6b3545133cd5a1dd3d62481fce990c5d06b7cfdcfa8da7045b66ccda49fb). Root reviewed four tests/no skips, ownedcleanup and fullprepost closure; later CPU fixture import failure does not substitute for or invalidate this separately closed prerequisite. Executionfalse/authorizedLane null remain unchanged.

Exact reviewed derived_runtime.py SHA31d77b2d1dc760cbffd6f94a29b8a9da08f5a4f7c7fa0a3cc986ccf621f4369c is copied unchanged. Runner first binds original runtime/reference, then prepares the sole x64nodepty helper0700→0755 derivation, then rebinds with its explicit descriptor before staging/import/build. admission.json carries that descriptor; verify-cpu passes it on every pre/post check; freeze includes receipt+ledger files. Collection retains derivation evidence. Original ZIP/tar/proof remain untouched; source/CLI/native/reference/hash checks are unchanged. Product bytes runtimePatch remain null, while dependencyModeDerivation is disclosed separately.

Source startup audit found no CPU-like strip-only TS graph here: parser echo/comparative imports .mjs support/native addon; metadata/tail readers are existing esbuildbundled candidate.mjs. No speculative tsx loader or new import gate was added; all compared modes retain their original launcher. No new performance axis or overhead.

Eight focused component tests now pass, adding actualacceptedreceipt admission and explicit deriveddescriptor propagation through the actual shared verifier. The separately reviewed five derivation tests were already passed by root; no redundant workload run.

Parser promotion handoff: selected lane parser; source review remains executionheld until the separate authorization-only pin commit. Portable derivation fixture accepts TMUX_QUAL_NODE_PTY_HELPER and imports local shared binding. Five helper + eight component tests PASS. Held runner test now uses explicitfalse fixture pins and cannot accidentally download if eventual execution pins become true. Exact proposed push branch qualification/darwin-x64-components-r1; one original parser18 job only. Metadata/tail remain deferred pending its outcome.
