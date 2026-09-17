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

| Lane            | Command budget                             | Job budget | Actual scope                                                                |
| --------------- | ------------------------------------------ | ---------- | --------------------------------------------------------------------------- |
| Fast            | Helpers 3 min, Vitest 5 min                | 15 min     | Namespace/build/lifecycle contracts; mocked runtime boundaries              |
| Linux installed | SSH contracts 3 min, packed journey 15 min | 25 min     | Actual installed package/TUI, hermetic SSH tests                            |
| macOS SSH       | Existing owned fixture deadlines           | 15 min     | Actual nonroot OpenSSH, synthetic identity/HTTP stream and scheduler matrix |

Each direct child has a bounded log tail of 1 MiB. Receipts and selected logs are
uploaded for seven days, including failed runs. No private work directory or SSH
keys are uploaded. An always-run finalizer writes an unqualified receipt if the
runner did not reach its own receipt. GitHub hard termination can prevent even
an `always()` step; absence of evidence is never a cleanup pass.

The wrapper retains direct `ChildProcess` handles, forwards cancellation and
waits up to 45 seconds for graceful close, then two seconds after SIGKILL. It does
not discover or kill arbitrary process trees. Each native qualification remains
responsible for its own descendants, tmux sockets, daemons and files. A failed or
cancelled command preserves its private work directory and reports cleanup as
unconfirmed even if its direct child closed. In particular, the packed journey
has normal/failure teardown but is not claimed to have general signal-safe
teardown. Use ephemeral hosted runners for these jobs; do not run them against a
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
