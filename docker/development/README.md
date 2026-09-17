# Owned Linux fixtures

These targets exercise native Linux builds independently of host tmux-ide state.
The source fixture and packed install fixture serve different purposes. They are
not release images and do not configure host integrations.

Export an explicit worktree into a new directory before building. This preserves
tracked modifications, deletions and nonignored untracked source inputs, but
excludes dependency/build/state directories, `.env*`, and external Git metadata.
The export refuses escaping symlinks and records hashes and original Git identity.
A linked worktree therefore needs no mount of its external common Git directory.

```sh
node scripts/lib/development-container-context.mjs "$PWD" /tmp/ti-source-context
# Run from the repository; the Docker context is the owned export above.
docker build --target source-development \
  -f /tmp/ti-source-context/docker/development/Dockerfile \
  -t tmux-ide-source:owned /tmp/ti-source-context
```

Node and Bun base images are digest-pinned; pnpm is version-pinned and source
packages use the frozen workspace lock. Debian packages come from the dated,
signed Debian snapshot declared in the Dockerfile. The native tmux source commit
and native-grid patch match `native/tmux/provenance.json`; the builder records ELF
dependencies, Debian packages/licenses and the glibc floor, and runs a decoded
private native-grid capture probe. This is qualified for the container's Debian
runtime, not a claim of portability to arbitrary Linux distributions.

The runtime user is `node` (UID 1000). Use dedicated named volumes for `/workspace`,
`/state` and `/evidence`. The image supplies an immutable source export and a
frozen dependency store. `prepare-source.mjs` accepts only a new or empty owned
destination, verifies its manifest, initializes a detached synthetic Git commit,
then performs offline installation and explicit native dependency rebuilds. The
original commit, branch, dirty flag and snapshot digest remain recorded in
`.development-container-source.json`; the synthetic commit is not presented as
the original repository commit.

```sh
docker volume create ti-source-workspace
docker volume create ti-source-state
docker volume create ti-source-evidence
docker run --rm -it --network none --cap-drop ALL \
  --security-opt no-new-privileges \
  -v ti-source-workspace:/workspace -v ti-source-state:/state \
  -v ti-source-evidence:/evidence tmux-ide-source:owned bash
# Inside this private container:
node /opt/source-snapshot/docker/development/prepare-source.mjs /opt/source-snapshot /workspace/a
cd /workspace/a
pnpm exec tsx scripts/development-build.ts --bun /usr/local/bin/bun --store /state/instances
pnpm --silent dev:instance up --store /state/instances --json
pnpm --silent dev:instance app --store /state/instances
```

For a read-only source bind, mount the **owned export** at `/input:ro` and pass
`/input` to `prepare-source.mjs`; keep dependencies and mutable artifacts in the
owned volumes. Do not mount a raw linked worktree, host home, default tmux socket,
production state or Docker socket. Keep the recorded Node runtime on PATH for
manager commands and builds; an ABI mismatch fails closed.

Cleanup only explicitly named fixture resources after managed apps have exited:
run `pnpm --silent dev:instance reset --yes --store /state/instances --json` in each
owned worktree, exit the container, then remove those three named volumes. Never
use Docker prune as fixture cleanup. Images can be removed by their exact fixture
tag when no longer needed.

Native Linux arm64 is the initial qualification lane. A multiarch base and ELF
validation do not imply x64 or emulated performance qualification. These fixtures
do not exercise macOS signing, desktop embedding, user shell integration,
real SSH hosts, registry publishing, or global package-manager upgrades.

## Separate packed install lane

```sh
docker build --target packed-install \
  -f /tmp/ti-source-context/docker/development/Dockerfile \
  -t tmux-ide-packed:owned /tmp/ti-source-context
docker volume create ti-packed-state
docker volume create ti-packed-evidence
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  -v ti-packed-state:/state -v ti-packed-evidence:/evidence \
  tmux-ide-packed:owned node /opt/fixture/packed-probe.mjs
# Interactive access to this same installed artifact:
docker run --rm -it --network none --cap-drop ALL --security-opt no-new-privileges \
  -v ti-packed-state:/state -v ti-packed-evidence:/evidence tmux-ide-packed:owned bash
```

The build stage packs the CLI and qualified native tmux, then uses a separate npm
fixture lock for a fresh installed dependency tree (`npm ci --ignore-scripts`).
Package postinstall, first download and upgrade behavior remain separate D12
qualification; only the explicit native rebuild scripts run here. It does not copy source
`node_modules`. The lock pins external versions and integrity; rebinding updates
only the local tarball version/integrity and refuses package contract changes.
Refresh that lock explicitly when runtime dependencies or package metadata change.
Native node-pty/watcher builds use the image's Node headers and compiler, so their
install scripts need no header or binary download. The final image includes Node,
git, procps, CA certificates, tini, the local installed package and the standalone
TUI. It has no Bun executable or source checkout (the npm package's deliberately
shipped TypeScript assets remain part of the package).

The TUI is **explicitly staged** at `/opt/fixture/tmux-ide-tui` and selected via
`TMUX_IDE_TUI_BIN`. This proves installed runtime execution with a qualified native
artifact, not release download/acquisition. The separate installed release journey
and later D12 acquisition gate cover download behavior. The packed probe runs
configless doctor, starts an owned daemon/private tmux server, launches the actual
installed CLI/TUI through node-pty, and requires an input echo. Its state and
bounded output receipts stay in the two named fixture volumes. Remove only those
named volumes after the probe exits and cleanup succeeds.

Container recreation and Docker VM replacement are currently a fixture boundary:
private runtime sockets live in the container filesystem, while instance records
may remain in `/state`. Their recorded device/inode/process witnesses can become
invalid across that boundary. The manager deliberately refuses those stale or
unverifiable records; mounting an old state volume does not prove ownership of a
new container's processes. Reset owned instances while their original container
is healthy, or retain the old volume for diagnosis and use a new explicitly owned
state volume for a new fixture incarnation. Do not remove ownership records just
to bypass a refusal. Persistent remote-container restart recovery is a separate
D10 qualification requirement.

## Qualification status

Native Linux arm64 source and separate clean packed-runtime lanes are qualified.
After reducing retained development-manager overhead, the idle, uninstrumented
D08 source isolation gate passed all 15 phases, including existing-TUI output/input
after daemon crash, runtime restart, daemon-only/full stop, stale-lock recovery,
and moved-tree reset. The sibling and private production-shaped sentinel remained
intact. The run sampled 26 owned processes and 308 file descriptors at most; final
owned processes/apps exited, gate subscriptions returned to zero, and OOM counters
did not increase. This is a bounded run, not a long soak or Linux x64/emulation
qualification.

Prior failures are retained. After 27 smaller diagnostic shutdowns did not
reproduce the rejection, failure-only diagnostics located a Linux process identity
`ENOENT` during `tmux-wait`. A single bounded confirmation read now permits cleanup
only after proving process exit. Six subsequent two-client replacement journeys
passed all twelve daemon-only/full shutdowns, preserved siblings and recorded no
OOM events. Deterministic tests cover the confirmation branch; this does not prove
all earlier uninstrumented failures had the same cause. The separate manager
memory improvement is not a production TUI throughput claim. Packed postinstall/download/upgrade and
persistent container restart remain the separate D12/D10 requirements above.
