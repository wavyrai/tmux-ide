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

Actual daemon replacement with the old SSH forward still alive, retained TUI
recovery, terminal-reader stalls and fleet scheduler saturation remain separate
D11 qualification work.
