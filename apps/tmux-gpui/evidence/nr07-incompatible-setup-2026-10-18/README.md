# NR07 successful setup receipt cannot bypass incompatible owner — 18 October 2026

Actual source browser process, synthetic managed CLI and owned loopback HTTP
identity endpoint. No real daemon, tmux server, installed package or native GUI
was launched. No product source changed; Mac remained locked.

`private-parent.json` passes: fixture owner protocol 5 is incompatible with current
protocol 4. Initial discovery and acknowledged Refresh remain unavailable and never
invoke the CLI. Explicit setup invokes only `--version` then
`update --daemon --json`; the fake CLI returns a schema-valid successful 2.9.7
receipt. The browser independently probes identity again and publishes setup
`failed`, retaining incompatibility guidance. No publication grants input, a
snapshot, selected pane or first-session creation capability. All four observed
HTTP requests are unauthenticated `/identity` probes. A 350 ms passive observation
after failure sees no automatic CLI retry; this is a bounded observation window.

The private record bytes and settings sentinel remain unchanged. Owned CLI
children and browser exit, HTTP server closes, private root is removed, and
protected checkout `bin/cli.js` hash remains unchanged. Receipt records source and
harness hashes. It retains no auth token, private identity record or terminal
content. No credential-bearing endpoint was permitted by the fixture.

`first.json` is the preserved failed attempt: the fixture created the daemon-record
parent with default 0755 permissions, which the canonical record reader correctly
refused. This produced ordinary no-daemon guidance before the intended protocol
check. The fixture was corrected to 0700; no product check was weakened. Cleanup
passed on that attempt as well. Request/publication traces were added to failed
receipts after the first attempt, so that earlier receipt has only its assertion
failure and cleanup/provenance.

Run from repository root with a fresh output filename:

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx \
  apps/tmux-gpui/evidence/nr07-incompatible-setup-2026-10-18/run.mjs \
  .tasks/native-reliability-mission/nr07-incompatible-setup/repeat.json
```

The runner refuses an existing receipt path. It uses private HOME/config/state/
cache/data/record/registry paths and an owned ephemeral loopback port. The fixture
record and identity consistently omit the optional environmentId field; no
production namespace or discovery is used. Node 24.21.0 and source `tsx` dependencies
are prerequisites. This is source-process failure acceptance, not a genuine
incompatible released daemon, physical app presentation or second-Mac check.
