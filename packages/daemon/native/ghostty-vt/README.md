# libghostty-vt parser bridge feasibility

This directory is an **isolated parser-only prototype** for Sfora #215. It is
not imported by the daemon, is not a production dependency, and cannot become
the default terminal interpreter by being present in a package install.

The source and toolchain are pinned in `checksums.json`. `fetch-upstream.sh` is
the only networked step. `build.sh` is deliberately offline: it accepts an
already verified Ghostty checkout and Zig executable, builds `libghostty-vt`,
and compiles the small Node-API bridge. Production packaging would consume
signed, checksummed prebuilds produced from this recipe; it must never download
Ghostty or Zig at runtime.

## Result

At Ghostty commit `48ccec182a932c2ec04c344d45a5fc553861cb13`, the official C API plus three
narrow, checksummed API patches are sufficient for the bounded canonical
terminal projection exercised here:

- incremental byte parsing and resize;
- primary/alternate screen identity and all nine canonical modes;
- dense viewport and styled scrollback cells, including width-zero spacers,
  grapheme clusters, palette-vs-RGB color identity, row wrapping, and all eight
  canonical attributes;
- cursor position, visibility, visual style, and blink state;
- render-state and row-level dirty tracking;
- OSC 8 hyperlink URIs.

The exact symbol map is machine-readable in `capability-map.json`. A blank
width-one cell projects as a single space, while a width-zero spacer stays
empty. A row's canonical `wrapped` flag means it continues a preceding row;
the forward-wrap flag is not substituted. These rules are covered by fixtures
whose IDs match the shared xterm corpus. Kitty graphics remain explicitly
deferred: the proof maps the upstream API but does not project images or claim
Kitty parity.

Ghostty's unmodified public API has no direct cursor-position setter. A narrow,
checksummed upstream-style patch adds
`ghostty_terminal_cursor_set_absolute()`. It moves the real active-screen
parser cursor with `Screen.cursorAbsolute`, marks the old and new cursor rows
dirty, and clears pending-wrap. It does not inject CUP, interpret DECOM, change
scrolling margins, or overwrite the saved cursor. The proof verifies that a
write after synchronization lands at the authoritative position and that
DECOM, margins, and saved cursor behavior survive unchanged.

The unmodified API also does not expose a reliable capped-history delta. The
second patch adds monotonic history generation and cumulative logical append
and trim counters. Those counters advance only after a successful scroll
commit; they are not updated by a fallible `defer`. The third patch adds one
infallible, atomic render-dirty acknowledgement after projection construction.
The native boundary therefore returns a transaction:

- the first projection (and resize or screen switch) is a `seed` containing the
  complete viewport and bounded visible history;
- later projections are `delta` objects containing only dirty viewport rows,
  explicit history trim, and newly appended history rows;
- dirty flags are cleared only after the complete JavaScript object has been
  constructed. Injected construction and acknowledgement failures prove the
  next call still receives every dirty row; acknowledgement never clears a
  prefix of rows.

The bridge enforces caps of 512 columns, 256 rows, 5,000 projected history rows,
and 16 MiB per write. Every numeric argument must be a finite, non-negative
safe integer. Addon state is per Node environment, and each terminal owns an
idempotent counted lifetime. Per-environment cleanup owns and drains every
surviving terminal before the instance state is finalized. Twelve concurrent
worker environments cover explicit disposal, GC/finalization, and environment
exit while a terminal is intentionally retained.

`normalize.mjs` is the strict native-boundary adapter. It emits only the
`TerminalReplicaSnapshot` fields and converts a seed/delta transaction into a
complete canonical snapshot. All ten fixtures in the shared conformance corpus
parse with the strict Zod schema and hash identically to the xterm backend.

The addon targets Node-API 9, the baseline available in Node 20. The loader
checks `process.versions.napi` before requiring native code and returns a
structured `unsupported` or `unavailable` result instead of attempting an
unsafe load. The complete conformance/lifecycle proof passes unchanged on the
pinned Node 20, 22, and 24 images recorded in `checksums.json`.

## Reproduce the proof

```bash
# Networked, explicit vendoring step (writes only to the chosen cache):
./scripts/fetch-upstream.sh /tmp/tmux-ide-ghostty-cache

# Offline build; requires a platform compiler and Node headers:
./scripts/build.sh \
  /tmp/tmux-ide-ghostty-cache/ghostty \
  /tmp/tmux-ide-ghostty-cache/zig/zig \
  /tmp/tmux-ide-ghostty-cache/zig-global-cache \
  /tmp/tmux-ide-ghostty-build

node test/native-proof.mjs /tmp/tmux-ide-ghostty-build/ghostty_vt_proof.node
node test/history-delta.mjs /tmp/tmux-ide-ghostty-build/ghostty_vt_proof.node
node --expose-gc test/native-workers.mjs /tmp/tmux-ide-ghostty-build/ghostty_vt_proof.node
node benchmark/native-benchmark.mjs /tmp/tmux-ide-ghostty-build/ghostty_vt_proof.node
node --expose-gc benchmark/qualification.mjs /tmp/tmux-ide-ghostty-build/ghostty_vt_proof.node
```

`build.sh` passes the prefetched package directory through Zig's `--system`
mode, which disables package fetching. The proof was also rebuilt in a
`--network none` container to verify the boundary. Release artifacts are
post-link stripped because this pinned Ghostty commit does not propagate its
`-Dstrip` option into `GhosttyLibVt`; two clean Linux output directories then
produce a byte-identical runtime library.

`fetch-upstream.sh` refuses a pre-existing destination, stages a clean verified
archive, applies all three patches only after checking their SHA-256, and writes
an immutable SHA-256 manifest for every patched Ghostty source (5,706 entries)
and every prefetched Zig package (19,881 entries in the recorded proof cache).
Mutation tests prove that changing the compiled `Terminal.zig` or the addon C
source fails closed. Both build scripts verify the exact Node-API headers, Zig
executable, addon input, patch-set identity, full patched-source manifest, and
complete dependency manifest. The native Linux builder additionally pins GCC
and binutils; the Darwin cross-builder uses the already-pinned Zig compiler for
the final link. Each recipe builds into a temporary directory, then atomically
renames the completed output. They refuse
to overwrite an existing cache or output. Compiler scratch state is separate
from the immutable dependency cache.

The patched addon identifies itself as
`ghostty-vt-48ccec182a93+tmuxide.cursor-history-dirty.v3+napi9`. Before production
promotion, submit all three additive APIs upstream with the same semantics and
tests; when equivalent upstream APIs are available, replace the patches and
re-pin rather than carrying parallel paths.

The local macOS 26/Xcode 26 host cannot execute Zig 0.15.2's generated build
runner: `SDKROOT`, `MACOSX_DEPLOYMENT_TARGET=15.0`, and
`SYSTEM_VERSION_COMPAT=1` all leave the same undefined libSystem/dispatch
symbols (`_abort`, `_arc4random_buf`, `_dispatch_queue_create`, `_fork`,
`_malloc_size`, `_sysctlbyname`, plus `__availability_version_check`). This
happens even for `zig build --help` and `zig libc`, before target compilation.

Darwin arm64 prebuilds are nevertheless achievable without changing pins. The
offline Linux arm64 builder cross-compiles `-Dtarget=aarch64-macos.15.0`, then
uses the same Zig toolchain to statically link the Node addon:

```bash
./scripts/build-darwin-arm64.sh GHOSTTY_SOURCE ZIG ZIG_GLOBAL_CACHE OUTPUT_DIR
```

That Mach-O addon was loaded by Node 24 on this Apple Silicon host and passed
the same conformance, lifecycle, and benchmark runs. CI should use the pinned
Linux arm64 image for deterministic Darwin prebuild production, then execute
the produced artifact on a macOS arm64 runner as the package gate.

The current Zig Mach linker emits a new LC_UUID, current-time nlist data, and
ad-hoc signature on each clean link, so Darwin artifacts are not yet
byte-for-byte reproducible. The release pipeline must sign each prebuild and
publish its actual checksum, SBOM, builder identity, and provenance. Input pins
and behavior are reproducible; a stable Darwin artifact hash is not claimed.

On macOS 26.5.2, the official Zig 0.15.2 host build runner currently fails to
link against the Xcode 26 SDK before Ghostty compilation starts (undefined
libSystem and dispatch symbols). The same pinned recipe builds and passes under
the pinned Linux arm64 container recorded in `checksums.json`; this is a host
toolchain compatibility issue, not a missing Ghostty API. A production pipeline
must use controlled builders and run the packaged-install gate on every
advertised target.

## Verified gates

The full proof, history rotation test, and twelve-worker lifecycle test pass on
Node 20.20.2 (Node-API 9), Node 22.23.1, and Node 24.19.0. Tests cover malformed
and over-cap numeric/write inputs, authoritative cursor writes, DECOM/margin/
saved-cursor isolation, alternate-screen and resize reseeding, canonical blank
and wrap semantics, multi-line scroll, and projected history caps of 0, 100,
500, and 5,000 rows. Thirty lifecycle cycles finish with zero live handles on
each runtime. The full ten-fixture strict schema/hash gate passes on the Darwin
artifact. Exact artifact hashes and benchmark distributions are recorded in
`checksums.json` and `evidence/`.

The qualification result is deliberately **no promotion**. At 512x256, native
seed projection took 193 ms and increased RSS by about 150 MB on the recorded
Darwin host. At a 5,000-row history cap, steady native deltas read one appended
history row (not the entire history), but were materially slower than the xterm
comparison. This proves the incremental algorithm is O(changed rows), while
also proving the current N-API object materialization is not production-ready.

## Promotion boundary

This prototype is evidence, not permission to cut over. Promotion still needs
a broader differential/fuzz corpus, upstream resolution of all patched APIs,
signed prebuilds with SBOM/provenance, lifecycle and packaged-install gates on
every advertised target, and ProductRig proof that the native implementation
materially improves latency without fidelity loss. No production daemon or
TypeScript runtime imports this package.
