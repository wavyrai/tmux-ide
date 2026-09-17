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
A bounded native Linux arm64 smoke now qualifies nonroot login through the
production SSH transport, authenticated daemon discovery and the allowed local
forward. Command, key, password, remote-forward and unsupported-destination
restrictions passed, including a Unix socket restriction checked against a live
private echo target. These are combined component receipts: the original harness
failures are retained, not presented as one uninterrupted passing journey.

The source image is an exact clean `b494367a` export; the host Compose ownership
and networking correction is `04e3dec3`. Actual core suspension followed by exact
owned Docker stop passed, with PID zero and no OOM kill. A subsequent same-container resume check also passed: ordinary up first refused
the suspension barrier, explicit proof-bound resume admitted the unchanged build,
and SSH authenticated a new daemon through a refreshed dynamic endpoint with the
same host key. Listener retirement, a second suspension and exact Docker stop
then passed. No container recreation or changed-VM recovery was exercised.
The wrapper and one native TUI journey are qualified separately below.
Two-project isolation remains an acceptance gate before this lane is advertised
as a complete workflow.

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
[configuration manual](https://man.openbsd.org/sshd_config). The pinned Debian
implementation passed the bounded component checks described above; the broader
SSH failure matrix remains a separate qualification.

The wrapper orders listener stop, core instance suspension, verified
same-container Docker stop, and then full-stop acknowledgement. Suspension stops
the exact daemon/tmux/apps and blocks late discovery/start; Docker stop retires
remaining private SSH children. Neither listener exit nor missing PID records
alone authorizes full down/reset. Same-container resume must use the separate
completed suspension proof; no SSH helper clears that barrier.

The SSH project uses one ordinary project-local bridge (`internal: false`), with
outbound access available for development work. The initial internal-only bridge
accepted the Compose port request but produced no host mapping on the qualified
Docker Desktop engine; that failed inspection is retained as evidence. The
manager still requires exactly one actual SSH mapping on `127.0.0.1`, no extra
published ports or network attachments, and exact project-owned network identity.
An absent mapping on a running container is an error, never an accepted endpoint.
This fixture does not claim to be an outbound-network sandbox.

## Initial container wrapper

The source wrapper supports `up`, `status`, `logs` and `down` with explicit
`--container`. A native Linux arm64 journey from clean commit `29e6f891` passed
startup, status/logs, idempotent startup, down, ordinary-up suspension refusal,
explicit resume and down again using only the wrapper. The artifact manifest and
SSH host key remained identical; a new daemon authenticated through its refreshed
loopback endpoint. Final container PID was zero, OOM counters stayed zero, and
unrelated running container identities were unchanged.

This qualifies one bounded wrapper journey, not native TUI or two-project
acceptance. Native app, shell and reset integration are described below. Container rebuild
integration remains a separate stage.

First startup requires a source export from the selected canonical worktree and
an already-built immutable image. It verifies that the image's snapshot and fixed
helpers match that export before preparing or building the private Linux instance.
It does not build an image implicitly or mount the host worktree.

```sh
node scripts/lib/development-container-context.mjs "$PWD" /tmp/ti-ssh-context
docker build --target source-ssh-fixture \
  -f /tmp/ti-ssh-context/docker/development/Dockerfile \
  -t tmux-ide-dev:local /tmp/ti-ssh-context
image_id=$(docker image inspect tmux-ide-dev:local --format '{{.Id}}')
pnpm --silent dev:instance up --container --name demo --json \
  --container-image "$image_id" --container-source /tmp/ti-ssh-context
pnpm --silent dev:instance status --container --name demo --json
pnpm --silent dev:instance logs --container --name demo --json
pnpm --silent dev:instance down --container --name demo --json
pnpm --silent dev:instance up --container --name demo --resume --json
```

Run subsequent commands from the same worktree with the same name and store.
`--store` selects a private development store when the default is unsuitable.
Different worktrees have distinct project identities even with the same name.
Status separates observed Docker state from the saved transition phase and
explicitly reports that it has not probed SSH. Logs expose the existing bounded
structured owner-log projection, excluding raw messages and SSH credentials.

Ordinary down preserves resources and data: it retires the SSH listener, completes
core suspension, then stops the exact container. Ordinary up preserves this
barrier; `--resume` explicitly admits a proof-backed same-container restart and
refreshes the endpoint while preserving host-key trust. A new container, changed
volume witnesses or changed Docker VM cannot reuse that proof.

Interrupted creation, preparation, build, startup, resume or listener retirement
remain protected for diagnosis. Only a completed suspension with its retained
proof permits retrying/finalizing the Docker stop. Cancellation may leave a
process already launched by Docker exec; the saved phase prevents an unsafe
automatic retry. Do not clear records, recreate resources or use Docker prune to
bypass a refusal. Explicit reset can remove fully adopted owned resources as
described below; unadopted partial creation remains protected.

### Native managed client

A bounded macOS arm64 client journey passed with host manager `14137948` and
separate native/Linux artifacts from clean `29e6f891` source. The actual native
TUI selected the Linux workspace, displayed fresh shell output and delivered
keyboard input whose decoded result appeared in the active terminal. The remote
server, socket and pane stayed unchanged. The app exited zero, its receipts were
released, scoped native cleanup retired all captured host processes, and wrapper
down left the same container stopped with PID zero and no OOM kill. Unrelated
running containers were unchanged. The native build used Node 26.8.2 / ABI 147,
Bun 1.4.2 and a separately verified macOS tmux bundle.

Two earlier harness failures are retained: an incorrect named development-label
check and input sent while the command palette was open. Neither counts as a
passing interactive run. The corrected terminal-selection journey passed without
product changes. This qualifies one client/container, not two-project isolation,
Linux shell access, reset or a long-duration performance run.

After the selected container is ready, `pnpm dev:instance app --container` launches
an immutable native TUI through the existing authenticated SSH transport. The
first launch additionally requires `--bun /absolute/pinned/bun` to build its own
host artifact. That selected worktree must also contain its platform-native tmux
bundle in `packages/daemon/dist/native/tmux/<platform>-<arch>`. Build it with
`pnpm build:tmux --source /absolute/pinned/tmux-checkout`; the source commit and
patch must match `native/tmux/provenance.json`. The script builds in private
scratch space and stages the bundle without changing system tmux. A previously
built bundle may be copied only after checking its manifest hashes, provenance
and host compatibility. Keep the recorded Node runtime/ABI consistent with the
worktree dependencies and artifact. Supplying Bun alone does not provide these
native prerequisites.

Repeat the same `--worktree`, `--name` and `--store` selection used
for container startup. A stopped container must first be resumed explicitly with
`up --container --resume`; app admission never starts or resumes Docker.

The host client uses a separate canonical instance and build. Existing verified
builds are reused; corrupt selections are refused, and source edits never trigger
an implicit rebuild. Its child PATH contains only the private SSH wrapper before
the existing pinned runtime PATH. User SSH configuration and saved machines are
not modified. Admission verifies the current project, host key and daemon, then
releases the project lock before the interactive app lifetime.

The small local managed owner is retained after app exit. Container status JSON
exposes `nativeClient` with its exact id, worktree, store and native cleanup argv;
the same guidance prints after the TUI exits. Close its apps, then use the supplied
native `down --id ... --store ...` arguments for scoped owner cleanup, or native
`reset --yes --id ... --store ...` for explicit state/artifact removal. Existing
reset refuses live or unknown app receipts. **Container down stops neither this
host owner nor its native apps**; remote apps may become disconnected. Container reset
checks and retires these separate host resources under their native locks. The
two-project interactive gate remains outstanding.

### Linux shell

A bounded Linux arm64 shell/TUI journey passed on its first run with host manager
`fb552a5b` and the unchanged Linux artifact from clean `29e6f891`. The printed app
command opened that existing instance. Its selected terminal displayed fresh
shell output and the decoded result of keyboard input. The TUI returned to Bash,
a separate shell command succeeded, and Bash exited zero. App/manager processes
and receipts were gone before wrapper down; final container PID was zero with
no OOM kill. The native host client stayed stopped and unrelated containers
were unchanged. This remains a single-project bounded run.

Use `pnpm dev:instance shell --container` with the same worktree, name and store
as the ready container. It opens Bash as UID 1000 in `/workspace/tree` through the
fully inspected container ID. It requires an interactive terminal, rejects
`--json`, and never starts or resumes Docker. The project lock is released after
admission so an open shell does not prevent container down.

The banner prints the exact managed app command, including the project instance
name and `/state/instances` store. Run that command inside the shell to exercise
the Linux TUI against the existing owner. The worktree is a private exported
snapshot: edits inside it do not synchronize to the host worktree.

Exit the Linux app before exiting Bash. Cancellation tracks and reaps the owned
Docker client; that alone does not prove the inner shell or app exited. Container
down retires the container's private process tree. Native host clients still
require their separate cleanup described above. Live container reset and the
combined two-project journey remain qualification gates.

### Scoped container reset (source checkpoint; live qualification pending)

`pnpm dev:instance reset --container --yes` destroys the selected private
container, its project network and its three named volumes. Repeat the exact
worktree, name and store used for startup. Shared images, source worktrees and
other projects stay outside its deletion scope. Ordinary down preserves data.

Close the native client's apps and stop its retained owner using the exact
`nativeClient.cleanup.down` arguments from container status or reset's refusal.
Reset checks its native ownership and app records under the existing build and
lifecycle locks, retires its artifacts/state, and holds those locks through
container cleanup. Live or unknown native processes are protected; container
ownership never authorizes signalling host processes.

Reset verifies complete resource ownership and foreign references before saving
a private deletion plan. It then stops the exact container, removes resources in
order, and deletes only unchanged known host keys/configuration after the Docker
resources are gone. Lock directories and reset records remain for serialization
and retry. An interrupted reset blocks other container commands and prints
`container-reset-incomplete`; repeat reset with the same selection. Replacement
resources, changed keys or unknown files cause refusal rather than broader cleanup.

Fully adopted containers can be reset after failed initialization without a
completed core suspension. A prepared project with no Docker resources can also
be reset. Partial creation that was never adopted remains unsupported, as does
container `--id` selection after the canonical worktree is removed. Retain that
worktree until cleanup completes. These source checks are covered by focused
regressions; live deletion and the two-project isolation journey remain pending.
