# First Linux x64 C4 CPU campaign — source proposal, not executed

Scope: accepted cb6f09ef + private 32 ms observer patch; production default 0
and native default-off are unchanged. This closes only this artifact's Linux x64
CPU comparison, subject to independent review. It does not qualify final-cut
applicability, idle, memory, other architectures or promotion.

Consume CLI artifact 11043293883 from successful run 36589727232, exact ZIP
4b86aacbbfce201f70afc5aa4a885497dd7a9b10764295e77f56962232a29e76;
restore runtime cb4f71b3cc8343f5afdf4e4193da3b6b70b36e1d1c1861f8dc32c3579c433d14.
Load image d52067ef from accepted input artifact 11039584548/run 36581517710.
All complete IDs/hashes/source/tool/39-file harness pins are in `pins.json`.
No install, build, native/reference rebuild, dependency resolution or product
smoke occurs. Raw receipts stay immutable. A separate reviewed receipt records
the parent's explicit preparation acceptance; it never claims performance pass.
The omitted nested prior manifest is byte-bound by the ZIP, explicitly checked
against its accepted f40b2fb7 hash and the downloaded original input manifest.

Fresh ubuntu-24.04 runner ImageVersion 20260920.314.1 and Docker hash must match;
otherwise fail before launch. Container is network-none, init-enabled, private
PID namespace, cgroupns=host, UID/GID-scoped, 4 GiB, 256 PIDs, affinity 0,2 on two
distinct physical cores, no CFS quota. Fresh boot ID, CLK_TCK and exact cgroup
path replace only runtime identity in a separate host-inputs file. Every
ancestor must have unlimited cpu.max (only controller-less root may omit it).
Normal runner co-tenancy is unproven and must be disclosed, not called isolated.

Original 12 cases: three fixed rotated rounds of reference, disabled,
enabled-no-reader and candidate32; 1,500 pairs per case. Unchanged candidate vs
disabled median CPU and elapsed limits: <=10%. Reference remains contextual.
Original wait4 inclusive descendants minus fixture self plus separately owned
orphan tmux-server/app CPU accounting, readiness, fixed deadlines and cleanup
remain byte-identical. Original supervisor is preserved; the generated
`campaign-cpu.py` changes only environment sampling and its explanatory text:
exact container cgroup plus all ancestors replace the incorrect mount-root
cpu.stat. Before/after case samples bind directory inode, identity, quota and
throttling counters; any change invalidates the attempt. CPU/load/pressure are
retained as context. This is not continuous tracing and cannot exclude transient
between-sample changes; no contention threshold is invented.

Restore/verify 91,036 payload entries including modes, hashes and relative
symlink targets before import. Check all image tools and frozen harness pins.
Existing prepare-freeze generates `/evidence/frozen-spec.json` with fresh host
identity and full dependency/ELF/module closure, including the exact overlay.
Run exactly:

```
/usr/bin/python3 /work/source/.tasks/native-x64-c4/harness/campaign-cpu.py --approved-campaign /evidence/frozen-spec.json
```

Always verify original full payload closure and frozen spec after terminal,
even on failure. All original stages/failed rows/cleanup receipts remain. The
outer owned container is identity-checked before force removal; independent
always-step repeats ownership/absence checks and removes the loaded image.
No retry, mode selection, warm-up trial or failing-row omission is allowed.
`performanceQualified:false` is retained until independent evidence review.

Proposed single CI trigger AFTER root reviews final commit:

```
git push origin qualification/linux-x64-c4-cpu-r1
```

Exact-branch push trigger avoids unregistered manual-workflow dispatch. Do not
also dispatch manually. Runner rejects GITHUB_RUN_ATTEMPT != 1. Nothing has
been pushed or launched by this source proposal. Workflow timeout 55 minutes;
container supervisor timeout bounds the 12 original 180-second cases plus
verification, and always cleanup/upload remain separate workflow steps.

Offline checks:

```
python3 -m unittest discover -s qualification/linux-x64-c4-cpu -p test_campaign_source.py
python3 -m unittest discover -s qualification/linux-x64-c4-cli -p test_cleanup_ledger.py
git diff --check
```

Initial missing-controller regression exposed a None-handling error in the new
sampler; fixed before execution. Six campaign source tests plus one manifest
regression pass. No product, build, Docker or performance execution was used.
