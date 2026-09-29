# Linux x64 component preparation — source review, not executed

One build-only proposal. No push/build/native import/PTY/tmux/daemon/CLI or
performance execution has occurred. First CPU36593663415 and idle36595113615
passed their separately reviewed scopes; this recipe does not repeat them.

Reuses exact accepted CLI artifact11043293883/runtimecb4f71b3 and input artifact
11039584548/imaged52067ef/native893/ref9ed, Node26.8.2/Bun1.4.2 and offline deps.
No installation, tool/native/reference/CLI rebuild, network inside container or
production mutation. Source remains cb6+private default32; the three component
wrappers explicitly select0/16/32 and are unchanged from accepted ARM source.

`pins.json` binds both archive digests, original41-file ARM source map, exact x64
source map and132 actual reader-build input hashes independently compared to the
accepted x64 closure. `port.patch` is the entire component-source delta: host
architecture/native/ELF pins, fresh descriptor path for each newly admitted CI
boot, and exact cgroup identity. Raw archived host.json stays unchanged. All
measurement bodies, clocks, counters, workload bytes, producer/cleanup helpers,
parser support imports and original gates are untouched.

Workflow `.github/workflows/linux-x64-c4-components.yml` has ONLY the new exact
qualification/linux-x64-c4-component-preparation push branch plus manual trigger.
One future authorized push is the sole launch; never also dispatch or rerun.
The runner rejects run_attempt !=1 and downloads only the two accepted artifacts,
verifying ZIP/member hashes and explicitly checking the disclosed nested prior
manifest against its original accepted bytes. Root-path-only artifact exclusion
preserves all nested receipt manifests in the new output.

Fresh runner image version/Docker hash, imageID/x64 architecture, 0,2 affinity on
distinct cores, no ancestor quota, boot/CLK_TCK/cgroup identity, exact nonce/mounts
and independent owned cleanup use the accepted x64 envelope. Co-tenancy remains
unproven; topology/quota is checked before and after preparation, no performance
claim. Pinned image/tool bytes checked before any import. Original91,036-entry
payload/hash/mode/symlink closure checked before/after even failure; only the
private components-linux subtree may be added, and its receipt/archive binds
all added bytes. No prior raw receipt is rewritten.

Inside the one container, `prepare-components.py`:

1. Restores verified runtime, checks original closure and41-file staged port.
2. Composes `/evidence/component-host.json` from unchanged artifact pins plus
   this host's fresh boot/clock/cgroup; confirms all132 source inputs still match.
   Import preflight explicitly validates this descriptor and calls
   linuxHost.assertIdentity (boot/CLK_TCK/exact cgroup) before native loading.
   It proves immutable artifact fields against base.hostArtifactSha256 and
   retains descriptor hash/runtime binding. This preparation-container identity
   is deliberately NOT reusable component closure: every future lane must
   regenerate, validate and freeze the same descriptor path against that source
   artifact hash, never reuse this boot/cgroup.
3. Actually loads linux-x64/pty.node + maintained @xterm/headless-stock under
   Node26 and imports comparative definitions only. It records actual shared
   objects; file presence alone cannot pass import admission.
4. Runs accepted14 pure helper commands and actual Python timestamp-cache tests.
   No benchmark entrypoint is called. Fixture pipe/socket tests are private.
5. Invokes pinnedBun1.4.2 build-components.mjs ONCE: exactly metadata/tail/parser
   candidate.ts through production cliBundlePlugins/esbuild, targetnode20/ESM.
   Metafiles and actual sources must have exactly the accepted132 non-harness
   inputs. No automatic repair/rebuild after failure.
6. Rechecks original source/dependencies, collects actual module resolution and
   recursive ELF closure including pty/shared objects and explicit kernel vdso.
   Exports a small component-overlay.tar and reviewed:false receipt. Byte/mode
   and mtime roundtrip verified; accepted overlay_times helper preserves Python
   timestamp caches without excluding them from closure.
7. Always repeats original+new closure and host admission, then exact container
   cleanup/independent continuation/image retirement/upload. Preserve failures.

After source review, proposed single launch:

```
git push origin qualification/linux-x64-c4-component-preparation
```

Actual resulting import/build/overlay/ELF/module/closure hashes require independent
root review before any later parser18/metadata9/quiet-tail3 specification. Those
original gates are described in root `.tasks/native-x64-c4/components-next/PLAN.md`;
none is run by this workflow. No extra CPU/memory/adapter matrix is introduced.

Offline validation completed:5 pure source/closure/admission tests +2 accepted
mtime tests,14 accepted helper commands and all PythonAST/Node26 syntax; exact
port byte map and workflow parsing. Logs `.tasks/component-offline-checks.json`
in this isolated worktree. ApplePython3.9 initially failed the cache fixture due
to its relocated cache prefix; the exact unchanged regression passes under
existing Python3.13.11, matching the previously accepted local test tool. The
actual pinned imagePython repeats that fixture during preparation.

Local checks (no native-module import or build):

```
env -u PYTHONPYCACHEPREFIX PYTHONDONTWRITEBYTECODE=1 /Users/thijs/.pyenv/versions/3.13.11/bin/python3 -m unittest discover -s qualification/linux-x64-c4-components -p 'test_*.py'
git diff --check
```
