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

## Private source SSH fixture (D10 implementation checkpoint)

`source-ssh-fixture` is a separate target derived from the source lane. It adds
OpenSSH from the same dated Debian snapshot; the packed target is unchanged.
This checkpoint's unit/config tests do **not** qualify a live Debian SSH login.
A reviewed exact source export, named resources and a nonroot smoke test are
required before the wrapper advertises this lane.

The image idles as UID 1000, precreates `/tmp/ti-dev-1000` with private ownership,
and never starts a development daemon or erases lifecycle witnesses at boot.
After explicit source preparation/build/up, the fixture helper supports:

- `init <ti-dev-project-id> <public-key-file>`: inspect the verified active owner
  using the worktree's compiled manager, save a credential-free runtime lease,
  generate a private host key, install one plain ed25519 public key and configure
  exact loopback forwarding. Its stdout contains only the host **public** key,
  for trust establishment through an already verified Docker exec channel.
- `serve`: reverify that lease and start nonroot sshd on port 2222. Use the
  project-scoped dynamic loopback mapping; never expose a wildcard host mapping.
- `stop`: authenticate to the live supervisor's private Unix socket using its
  saved nonce. The supervisor signals only its retained sshd child, waits for
  exit, checks/removes its own admission records, then acknowledges retirement
  of the **listener**. This receipt explicitly allows authenticated SSH children
  to remain; it is not a full process-tree or container-stop proof.

All commands run as `/usr/local/bin/node /opt/fixture/ssh-fixture.mjs <command>`.
The fixed source path is `/workspace/tree`, store `/state/instances`, instance
name the project ID. Configuration lives in private `/state/ssh`; interrupted
serve/admission records block reuse rather than authorize a PID-only kill or
boot-time deletion. Init cannot replace keys or refresh configuration while a
listener admission exists. Refresh requires orderly listener stop and fresh
verified readiness; a daemon replacement invalidates the old configured lease.

The only accepted SSH command is exactly `tmux-ide remote-daemon-info --json`.
An internal read-only manager dispatch validates the active immutable build,
namespace, readiness and configured lease before running that build's exact
Node/CLI. It buffers the bounded handshake and verifies returned runtime identity
before releasing credentials to the authenticated SSH channel. No owner startup,
installed executable fallback or unchecked port is accepted. Do not log or
persist this handshake. Private sshd error capture is bounded to 64 KiB and is
not a public support-log source.

SSH permits public-key authentication as `node`, one verified `127.0.0.1` daemon
port, and local TCP forwarding only. Password/PAM/root login, remote forwarding,
Unix socket forwarding, tunnels, PTYs, user environment/rc, agent and X11
forwarding are disabled. The test-only image gives `node` an unusable password
hash so public-key login can be tested without a locked-account rejection;
password authentication remains disabled. Nonroot explicit host keys and these
restrictions follow the [OpenSSH server manual](https://man.openbsd.org/sshd) and
[configuration manual](https://man.openbsd.org/sshd_config); the pinned Debian
implementation still needs its live smoke check.

The future wrapper must order listener stop, core instance suspension, verified
same-container Docker stop, and then full-stop acknowledgement. Suspension stops
the exact daemon/tmux/apps and blocks late discovery/start; Docker stop retires
remaining private SSH children. Neither listener exit nor missing PID records
alone authorizes full down/reset. Same-container resume must use the separate
completed suspension proof; no SSH helper clears that barrier.
