# NR01 constrained Node heap diagnostic

Current payload from the failed default run was reused unchanged: CLI SHA256 `d4252e328292012da246bc086833c3720b0e55365e50e5da86826a4f2c31b1f5`, bridge manifest in `../nr01-current-payload-2026-10-18`. Source overlay was frozen at 873ef58e. No product source was changed.

The private container fixture alone sets NODE_OPTIONS to `--max-old-space-size=128 --require=/tmp/probe.cjs` instead of deleting it. The parent smoke and browser/helper children inherit the same settings. This changes GC/heap behavior and is not default-product qualification. V8 reported a 184549376-byte total heap limit for the smoke, both CLI processes, browser, and five live helpers; 128 MiB is the old-space setting, not total process or VM memory.

The same 90-second smoke deadline and container limits were retained. Exit 0, OOMKilled false, cgroup oom/oom_kill/max all zero. The smoke reports session switching/request ordering/unavailability pass and resize/foreground recovery completed, including fresh 95×30 grid after resume. No native GUI, presentation latency, general memory safety or performance improvement is established.

The owned terminal container was removed. Existing Supabase services and VM configuration were untouched. The preceding default run remains an OOM-affected failure and NR01 remains open. Next: qualify an adequately provisioned default runner separately; do not silently make this diagnostic heap cap a product default.

`run.py` records the exact diagnostic change and command; `probe.cjs` records only PID, entry point and V8 heap limit. Receipt retains container terminal state and limits. Original payload files remain in `.tasks/native-reliability-mission/nr01-current-payload`.
