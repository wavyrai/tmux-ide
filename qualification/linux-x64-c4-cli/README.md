# One offline Linux x64 CLI preparation — source review only

No push, CI invocation, build or runtime execution accompanies this source change. New isolated branch `qualification/linux-x64-c4-cli-preparation`; workflow `.github/workflows/linux-x64-c4-cli.yml` is currently manual-only. The earlier input workflow's push filter names a different branch and will not run here. New-workflow registration/one-trigger handling remains a separate reviewed launch step.

## Exact reusable inputs

`pins.json` binds CI36581517710 artifact11039584548:704781316bytes/SHA052cabc075719fc470bd6198604b2883fea79694493da95c81bc10f752a2e131. The runner downloads that exact existing archive, verifies its outer digest and every inner manifest entry, then loads the existing image `sha256:d52067ef26a974b46ad1b6301b449b4f774ead40c2c41df971c50e0778a0d76b`. It never docker-builds, installs tools, or builds native/reference code. Qualified893 remains the existing branch-local hash-checked bundle; reference9eddef39 and offline pnpm store come from the verified artifact. Actual Node26.8.2, Bun1.4.2, pnpm10.21.0 and system-tool hashes are pinned, including Docker client6435ff92.

Source is exactly cb6f09efb173d045d2bc221d0f14cfe415075b48/tree9d2b15709502af95a4a736b56069d3158cc08a1a. `candidate.patch` is the reviewed private32 overlay SHA4393ae0b; resulting git diff SHAa1b39370 and each of its three changed files are closed in pins.json. The39-file harness map closes the current Linux x64 port including exact proc-stat one-reopen helper. No other product overlay is admitted. Root production0 and final-cut applicability remain separate.

The source bundle is made from CI's exact source checkout with local Git; it is not a new source download inside the preparation container. The actual bundle digest joins the per-attempt input manifest; source commit/tree and resulting patch bytes must match the pre-reviewed pins. This permits incidental Git pack encoding differences without admitting a different source tree.

## Proposed command and workflow

After review, one invocation in ephemeral ubuntu24.04 x64 CI is:

```
python3 qualification/linux-x64-c4-cli/runner.py
```

The workflow checks out its reviewed branch and exact cb6 source; `actions:read` token is used only to retrieve the pre-existing private artifact. The tool-image container receives no token and runs `--network=none --pull=never --init --cgroupns=host --cpuset-cpus 0,2`,4GiB/256PIDs, runner UID/GID. Runner ImageVersion must be20260920.314.1 and Docker executable hash must match before Docker use. Fresh boot/cgroup/clock identity is measured; admitted CPU pair must be two distinct physical cores and effective affinity must match. Every visible cgroup ancestor must have cpu.max=max (root absence allowed); old boot/cgroup IDs are not reused. A mismatched runner/tool/topology stops for review; no fallback host or quota change.

`launch-preparation.py` persists exact name/nonce/image intent and container identity; both its finally cleanup and the workflow's independent always-step require positive ownership before retirement. The latter also removes only the exact loaded image. Artifact upload always retains failures, fresh input/admission evidence and cleanup. No timing quietness or exclusive physical-core claim is inferred from cpuset.

## Offline inner sequence

1. Validate every input hash, tools, native/reference manifests and source/overlay/harness mapping; materialize dependencies with frozen lockfile/ignore-scripts/offline/no side-effects cache.
2. Run the successful ARM72d `harness-workspaces.mjs` private-alias preparation: only audited @tmux-ide/contracts link, internal relative target, source hash/resolution receipt. This closes the known private `.tasks` import boundary; it changes no production package dependency.
3. Build CLI ONCE using the existing pinned Bun builder, capture its actual metafile/observer/default32/input bytes and CLI hash. Do not execute CLI, start daemon/tmux or build TUI.
4. Import the actual fixture dependency graph without executing the case. Run the existing bounded harmless wait4-grandchild ancestry proof; this is prerequisite accounting evidence, not a CPU/idle case or product launch.
5. Verify native/reference ELF and explicit-loader resolutions, collect runtime transitive package/workspace closure and an UNREVIEWED artifact receipt. Record full source/dependency/input file modes, bytes and symlink targets. SHA hashing of large input/archive files streams1MiB chunks.
6. Package closed runtime payload (`source`, native, reference, host, host-inputs and artifact receipt), excluding `.git` as in reviewed ARM payload. Roundtrip verifies bytes/modes/internal relative symlinks. Original source bundle and full preparation source closure remain retained as input provenance. Upload runtime archive, build/metafile/import/ancestry/ELF/fullclosure receipts and cleanup. No freeze is labelled reviewed; no CPU/idle command is called.

Independent root review must admit the generated artifact before a separate campaign. Fresh campaign containers need fresh boot/CLK_TCK/cgroup records and a new frozen spec; immutable artifact pins and original budgets/modes/accounting remain unchanged. This task does not touch Darwin qualification.
