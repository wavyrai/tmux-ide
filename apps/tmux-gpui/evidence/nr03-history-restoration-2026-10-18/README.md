# NR03 source-browser history restoration

Final run session 50125 exited 0. Source browser uses a private supported CLI outfile build (build.log; CLI SHA in result.json), stock tmux 3.8 and a fresh two-session scratch fleet. No production state or generated bin/cli.js mutation. Bridge source hashes match before/after.

The actual browser session/tab commands exercise A → B → A while a finite private producer appends output in A. The saved unique NR03_LINE_060 row returns at the same published grid row (anchorRow), despite growing numeric history offset. An exact output tick proves producer start; absence of the exact DONE line proves restoration occurred before completion. Historical viewport rejects attempted text/Enter; after exact DONE and scroll-to-live, fresh input produces an exact output line and denied marker remains absent from source history.

A second A → B → A after owned clear-history verifies explicit “Saved history is no longer available — live terminal shown” and zero history offset. Pane IDs/PIDs/birth identities remain unchanged. All five captured owned server/pane/daemon/browser PIDs are absent after cleanup. Source hash stability and protected CLI hash equality are required exit gates.

Initial and strengthened-pass directories retain earlier passing attempts with weaker assertions. Only top-level run.mjs/result.json are the final exact-row-position receipt. CLI build predates package-only commit 4480bca4 but contains the reviewed transport source; it is not an installed release artifact.

Scope: real source-browser bridge and daemon, coherent published grid; no native GUI, local selection/focus restoration or physical scrolling claim. This runtime covers explicit full history reset loss, not a separate trim-anchor runtime. Bounded owner tests cover trim-before and trim-anchor identity behavior. The 250 ms capture settling interval is fixture pacing, not a latency/performance assertion; a missed capture would fail restoration.
# NR03 bridge history integration checks

33 focused Node tests passed; bridge TypeScript, changed-file ESLint, Prettier and git diff checks passed. No Cargo build or native code change in this slice. Logs are retained beside this file.

Actual runtime harness and original receipts: `.tasks/native-reliability-mission/nr03-browser-history/run.mjs` and `result.json`. Its final exact-row-position run passed. That source-browser/daemon test is not physical native GUI evidence. It covers busy A/B/A, input refusal while historical, explicit full reset loss, fresh input and owned PID cleanup. See that directory README for exact scope.

Two source changes after the runtime receipt: browser lost-status text now distinguishes a still-historical viewport from live offset zero; history-restoration owner comment clarifies that per-tab persistence holds only tokens while its transient proof cache retains bounded row references. No routing/admission/restoration behavior changed. Final source hashes and receipt hashes are in source-delta.json; the runtime receipt must not be described as exact final-source hash qualification.

Remaining limits: 5-minute owner token lifetime; switching before capture completes reports unavailable; no saved local selection/focus or physical GUI proof. Restoration is bounded, not a claim of full NR03 seamless acceptance.
