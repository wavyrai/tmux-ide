# Isolated development CI

`.github/workflows/development-instances.yml` runs fast development contracts on
pull requests with Node 22 and 24, pinned Bun from `.bun-version`, at most two
matrix jobs and one Vitest worker per job. The helper inventory is explicit;
development daemon tests are selected by `development-*.test.ts`. This adds CI
coverage without replacing `pnpm check` or `pnpm release:opentui:check`.

Runtime, package, script, native prerequisite and workflow changes also select the Linux installed
package journey plus hermetic SSH transport/relay tests. It builds the patched
native tmux bundle from the exact repository/commit/patch in
`native/tmux/provenance.json` with two compiler jobs; apt tmux is not used as a
substitute for that prerequisite. Docs-only changes omit
that extra heavy job. Weekly and manual runs select the same bounded journey;
this is not a long-running soak. The existing ordinary CLI workflow also installs
tmux explicitly for its installed ownership smoke.

Every new workflow checkout explicitly selects the PR head SHA (or event SHA),
and the receipt records the actual source commit. Each runner uses a fresh directory named by run ID, attempt, job, lane, platform,
architecture and Node major. Private HOME, temporary files, cache and state are
in a fresh mode-0700 short `/tmp/ti13-*` root recorded in its receipt. Short paths
avoid Unix socket length failures in tsx and lifecycle fixtures. No live state, credentials, native build output or compiled
artifact is cached. The fast lane caches only pnpm downloads keyed by platform,
architecture, exact selected Node version, Bun pin and lockfile; pnpm side-effect
caching is disabled and there is no fallback cache key.

## Bounds and evidence

| Lane            | Command budget                                                                                               | Job budget | Actual scope                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------- |
| Fast            | Helpers 3 min, Vitest 5 min                                                                                  | 15 min     | Namespace/build/lifecycle contracts; mocked runtime boundaries              |
| Linux installed | SSH contracts 3 min, packed journey 15 min; two interruption cases each 6 min to readiness + 210 sec cleanup | 40 min     | Actual installed package/TUI, hermetic SSH tests, controlled interruption   |
| macOS SSH       | Existing owned fixture deadlines                                                                             | 15 min     | Actual nonroot OpenSSH, synthetic identity/HTTP stream and scheduler matrix |

Each direct child has a bounded log tail of 1 MiB. Receipts and selected logs are
uploaded for seven days, including failed runs. No private work directory or SSH
keys are uploaded. An always-run finalizer writes an unqualified receipt if the
runner did not reach its own receipt. GitHub hard termination can prevent even
an `always()` step; absence of evidence is never a cleanup pass.

The wrapper retains direct `ChildProcess` handles, forwards cancellation and
waits up to 45 seconds for graceful close (210 seconds for the installed
qualifier to drain a bounded build), then two seconds after SIGKILL. It does
not discover or kill arbitrary process trees. Each native qualification remains
responsible for its own descendants, tmux sockets, daemons and files. A failed or
cancelled command preserves its private work directory and reports cleanup as
unconfirmed even if its direct child closed. The packed journey now cooperatively handles SIGINT/SIGTERM: it stops new
admissions, aborts waits/fetches and drains a current bounded build/install command
before entering its existing owned cleanup. A timeout or buffer-killed build does
not establish descendant retirement and makes cleanup unconfirmed. GitHub may
escalate cancellation sooner than the 180-second command budget; arbitrary
build-phase platform cancellation and hard kill remain unqualified. Use ephemeral hosted runners for these jobs; do not run them against a
persistent shared runner and infer its state is clean after cancellation.

`development-ci.test.mjs` exercises two simultaneous private runs, failure,
bounded log retention, and cancellation of a controlled real root/child pair.
The synthetic root explicitly owns and closes its child; the test independently
requires both PIDs absent. This is local cancellation evidence for that fixture,
not proof that every test runner or installed journey handles interruption.

## Platform boundaries

The weekly/manual macOS SSH job checks Apple SDK/sshd prerequisites and uses the
existing owned local SSH runner. It is not a Linux SSH qualification and does not
exercise native TUI rendering, clipboard, notifications or GUI service startup.
Those platform claims remain separate from Docker/Linux and the existing native
notifier job.

The systemd and launchd fixtures are deliberately not wired to a green placeholder
job. `qualify-systemd.mjs` currently needs a reviewed immutable local arm64 image,
private writable cgroups and its explicit Docker context; a hosted image build
and provenance adapter is still required. `qualify-launchd.mjs` needs an actual
Aqua GUI login domain and qualified native bundle. A generic shell-only macOS
runner is not proof of that contract. See the respective fixture documentation
and D12 receipts for the completed local qualification. No workflow invokes a
missing local Docker image, global prune or unrelated service cleanup.

## Local reproduction

After dependencies are installed, select a fresh evidence parent and explicit
identity (the runner refuses to reuse its run directory):

```sh
mkdir -p /tmp/tmux-ide-ci-evidence
GITHUB_RUN_ID=local1 GITHUB_RUN_ATTEMPT=1 GITHUB_JOB=fast \
  node scripts/development-ci.mjs fast /tmp/tmux-ide-ci-evidence
```

Inspect `receipt.json` and bounded logs. A failed command retains the recorded `workRoot`; do not
remove it until any resources owned by that particular test are accounted for.
The finalizer only records evidence and never attempts broad resource cleanup.

Local tests and YAML validation do not constitute remote CI acceptance. D13 needs
actual runs of the exact committed workflow, parallel matrix evidence and a
controlled cancellation run before it can claim those acceptance criteria.

## Controlled packed interruption qualification

After the normal native prerequisite is present, set a fresh private evidence
path and `TMUX_IDE_PACK_INTERRUPT_AT=hold-input-ready` when launching
`scripts/pack-check-run.mjs`. The qualifier writes `interruption-ready.json`
only after its actual installed TUI is input-ready. Send SIGTERM to the retained
qualifier child handle within 30 seconds. Alternatively use
`TMUX_IDE_PACK_INTERRUPT_AT=fail-input-ready` for a fixed-stage failure.
Both must exit unsuccessfully while `proof.json` reports owned cleanup complete,
no retained roots and all recorded PIDs absent. The proof records cancellation
and cleanup duration. Neither interrupted run qualifies the full golden journey.
No signal by PID substring, global tmux shutdown or unrelated cleanup is allowed.

This controlled live proof is separate from the small helper tests. Until its
exact committed-source receipts are reviewed, signal-safe installed cleanup is
implemented but not live-qualified. A missing final receipt after platform hard
kill remains an unqualified result, regardless of hosted runner retirement.

The Linux installed job also runs `node scripts/qualify-packed-interruption.mjs
<fresh-evidence-directory>` after its successful ordinary journey. It runs the
two cases sequentially, sends SIGTERM only through the retained qualifier child
handle after the private input-ready receipt, and requires a nonzero exit with
an incomplete journey, verified artifact hashes and confirmed owned cleanup.
It independently checks the recorded PIDs and private paths are absent. These
are checks of the recorded inventory, not an exhaustive process census. Failed
cases retain a bounded 1 MiB log, qualification receipt and product proof; no
work directory or credentials are uploaded. Timeout escalation cannot produce
a cleanup pass. This controlled fixture does not qualify GitHub's arbitrary
build-phase cancellation or a platform hard kill.
