# Packed installation qualification

`pack-check-run.mjs` builds the CLI and a local package tarball, installs it into
private npm projects, and exercises the installed product. It requires an
installed checkout toolchain (Node, pnpm and Bun), tmux, and the qualified native
bundle for the target platform. See [development instances](../docs/development-instances.md)
for native prerequisites. Dependency installation can access the npm registry;
runtime-download scenarios use controlled local release assets.

Run from a clean checkout with a fresh evidence directory outside tracked source:

```sh
TMUX_IDE_PACK_EVIDENCE_DIR=/absolute/private/evidence-directory \
  /absolute/pinned-node scripts/pack-check-run.mjs
```

Put the intended Node, Bun and pnpm executables on `PATH` and record their exact
versions. Evidence mode rejects a dirty source checkout. The gate builds artifacts
for that commit; it does not publish a release or upgrade a global installation.

The ordinary installation runs the complete installed TUI/agent journey. A second
installation of the same tarball uses `--ignore-scripts`, a separate HOME/cache and
private tmux socket. It checks exact CLI bytes/version, offline runtime acquisition,
successful controlled acquisition and runtime provenance, missing prerequisites,
legacy permissions, unsafe-state refusal, dead-owner replacement and live-owner
reuse. The second lane does not independently qualify interactive TUI rendering.
Exact postinstall workspace links distinguish the two installation modes.

`proof.json` records source and artifact provenance, per-scenario results, journey
observations and cleanup. Completion requires the journey and cleanup to pass.
The fixture tracks deliberate tmux server replacements only at its own creation
boundaries. Socket identity checks permit tmux's measured private `0600`/`0700`
attachment-mode toggle while preserving the other identity checks. A stale socket
is removed only after its recorded owner is dead, connections are refused and
its captured identity is unchanged.

If retirement cannot be confirmed, the gate fails and retains its private roots
for inspection. Preserve the failed receipt and inspect `cleanup` and
`retainedRoots` before recovering resources. Do not treat a successful journey
with failed cleanup as a passing gate. Later recovery is a separate receipt.

This gate does not qualify interrupted downloads, external launchd/systemd
ownership, reboot recovery, historical published-version compatibility, or a
platform other than the one actually tested. Those remain separate D12 checks.

Qualification at `066f55fc` on macOS arm64 passed the combined gate: all 72
ordinary TUI/agent milestones, all nine scripts-disabled scenarios, and cleanup
in 54.524 seconds. Independent review verified all five artifact hashes and
confirmed all 67 recorded PIDs, both private roots and both sockets absent.
This is one local qualification run, not a performance benchmark or additional
platform coverage.
