# Owned SSH transport qualification

`qualify-owned-ssh.ts` is an opt-in developer test. It starts private localhost
SSH servers and exercises the production SSH transport with synthetic daemon
identity and capability responses. It does not qualify an actual daemon, TUI,
Linux host, or service supervisor.

Run from a checkout with `pnpm install --frozen-lockfile` dependencies available.
The fixture currently requires nonroot macOS, an account using `/bin/zsh`, the
system OpenSSH tools, and `/usr/bin/clang` with its SDK. It compiles a small
test-only process witness using kernel PID, UID and birth timestamps; SSH process
titles can change during startup. Production process identity logic is unchanged.

Create a short private root under the current user's temporary directory:

```sh
fixture_root="$(node --input-type=module -e 'import {mkdtempSync,realpathSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; process.stdout.write(mkdtempSync(join(realpathSync(tmpdir()),"d-")));')"
node --import tsx scripts/qualify-owned-ssh.ts --run-owned-local --root "$fixture_root"
cat "$fixture_root/qualification.json"
```

Use an absolute Node executable when qualifying a specific runtime. The root
must already exist, belong to the current user, and have private permissions.
Paths must contain only letters, digits, underscores, dots, slashes and hyphens.
Keep paths short: both discovery and OpenSSH control sockets have platform path
limits. `/private/tmp` also has different ancestor permissions from the private
per-user temporary directory; keep SSH strict ownership checks enabled.

The matrix covers an existing shared master, dedicated-forward disposal,
ProxyJump, private noninteractive PATH, rejected keys and host trust, cancellation,
delayed discovery and oversized discovery output. A baseline connection checks
that disposing or failing another transport does not destroy it. This baseline
is an HTTP fixture, not evidence of healthy TUI input under load.
Recorded durations include fixture instrumentation and process scans; they are
observations of these cases, not product latency benchmarks.

The runner writes `qualification.json` and exits nonzero on a failed case or
incomplete cleanup. It records bounded categories, timings and process witnesses;
it does not store bearer tokens, raw SSH stderr or complete discovery handshakes.
The public transport currently groups several failures under `unavailable`.
Injected cases and fixture diagnostics must not be presented as more specific
production error codes.

Owned processes, listeners and unchanged private credential files are cleaned up
on completion. Unknown process identities or changed files cause refusal and may
leave resources for explicit recovery. Preserve a failed receipt and inspect its
cleanup fields before retrying with a fresh root. Do not use broad SSH kills or
recursive deletion to hide a failed cleanup. Successful cleanup leaves the receipt
in the supplied root for inspection.

Run the focused tests with:

```sh
node --test scripts/lib/owned-ssh-fixture.test.mjs
```

On macOS this includes a real compiler/owned-child test of the kernel witness.
It does not start an SSH server. The other tests cover configuration, bounded
diagnostics, process cleanup and file ownership.

## Qualification recorded 17 September 2026

All 12 transport cases and cleanup checks passed on macOS 27 arm64 with Node
26.8.2 and OpenSSH 10.3p1. An independent run from a clean validation checkout
also passed. Each final run captured 50 processes; follow-up checks confirmed
they were gone and only the receipt remained. Exact forward closure was checked
inside the runner; numeric ports were not retained for an independent port audit.
The 17 focused tests, targeted TypeScript, lint and formatting checks also passed.

Earlier failed attempts remain recorded in the D11 evidence. They exposed fixture
process-title assumptions, control-socket path limits and a teardown identity-read
refusal. A kernel read refusal gets one bounded follow-up inside its original time
budget; only a newly confirmed dead process can be omitted. Still-live, unknown
or changed identities remain failures. The successful live runs do not establish
that this confirmation branch was taken; its semantics have deterministic tests.

The guarded transport at commit 54542def subsequently passed the same 12 cases
in 3499ms; an independent audit found all 47 recorded processes absent and only
the receipt retained. This is separate from the initial unguarded 50-process runs.

Actual native daemon replacement is now qualified on clean 54542def artifacts
for all four target/client owners. The retained TUI recovered output and typed
input with unchanged tmux/socket/pane, and its healthy sibling stayed responsive.
The wrong-identity old-port trap received one public identity request and one
explicit credential-free raw-forward witness request, with zero credentials.
All 59 captured processes and nine recorded ports were independently absent/closed;
four managed roots were reset. The earlier baseline's 23 old-token requests and
all fixture failures remain recorded. See ignored local evidence under
`plans/development-instances/evidence/d11/stage4/guarded-native-live`.

These are bounded macOS arm64 observations, not a long soak, native Linux/x64
qualification, malicious-public-identity defense or terminal-reader benchmark.

## Native replacement fixture support

The shared helper also accepts asynchronous discovery producers for actual
development daemons. A response deadline only stops waiting for the response;
it does not cancel the producer. Teardown closes discovery admission and listeners,
then waits for the original producers within a separate bounded cleanup budget.
Unsettled work causes cleanup refusal and preserves private files. Cleanup can be
retried after the producer settles.

For replacement journeys, `refreshTargetPort` verifies the owned configuration,
host key and authorized keys, validates the new exact forwarding destination with
`sshd -T`, and signals the retained listener. Its result means the signal was sent,
not that discovery or the new forward is ready. Callers must independently verify
readiness and the rewritten PID file. Modified files or a relocated fixture root
cause refusal.

These helper changes pass 23 focused tests, targeted types and lint. The original
12-case qualification predates them; the guarded regression and native 545 run
include them. Helper tests and cleanup remain distinct from actual client recovery.

## Bounded reader and scheduler cases (source checkpoint; live proof pending)

The runner adds a generic HTTP stream over the real guarded SSH transport. Its
downstream reader pauses while a finite 16 MiB producer observes backpressure.
Success requires an unexhausted producer plateau, a bounded producer-side writer
queue, and fresh healthy-control responses while the reader remains paused.
Cancellation must retire that producer and leave the healthy route usable. Reaching
the finite cap without a plateau is an inconclusive failure, not a pass. The
recorded bytes/queue peak measure the fixture producer, not every relay, SSH,
kernel or RSS buffer. This is not an actual native terminal-reader workload.

A separate case uses the production fleet scheduler with an explicit limit 1 to
force contention with only one stalled real SSH dial and one queued healthy dial.
An already established guarded control stays responsive. Aborting the stalled
request must initially retain its active slot until the connection work settles;
the healthy queued route then connects and serves a marker, and final active/queued
counts must be 0/0. Default limit 4 and larger queue prioritization remain existing
unit-test evidence; this case does not claim live fleet saturation performance.

Run the pressure helper's hermetic tests with
`node --test scripts/lib/owned-ssh-pressure.test.mjs`. No sshd or keys are started
by those tests. Both new live cases remain unqualified until a reviewed opt-in run.
