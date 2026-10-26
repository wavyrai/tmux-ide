# Lossless raw graphics chunks

The live Kitty graphics side channel now supports independently compressed raw
RGB/RGBA chunks. Capability bundles 113/114 include projection bundles 111/112
respectively and `TGB2` chunks. The eight-capability offer bound is unchanged.
Older daemons ignore the new bundle and can select the existing compact semantic
and JSON graphics fallback. Older clients never receive `TGB2` or its state flag.
The Rust native issuer and the existing metadata helper both offer the new bundle.

`TGB2` contains the existing bounded JSON blob metadata plus `compression: zlib`
and `decodedBytes`. Offsets, total bytes and the content digest describe the
original image, not its compressed representation. The Rust worker checks the
negotiated pane state before inflation, bounds output to 512 KiB plus an overflow
detection byte, and requires exact decoded length, stream termination and full
input consumption. Original digest verification remains the final publication
condition. A chunk never becomes a verified image merely because it inflates.

The daemon uses asynchronous level-1 deflate with at most two jobs globally and
no pending job queue. Busy admission falls back to raw binary. A bounded 4,096-byte
spread-out sample skips likely noisy chunks; this is a conservative heuristic,
not a compressibility guarantee. PNG and producer-zlib payloads are never
recompressed. Compression is used only if savings exceed 12.5% plus 128 bytes.
After the await, the sender rechecks connection/pane lifetime and image identity.

## Evidence

Focused checks passed: 40 Rust graphics tests, 93 daemon tests, five binary
contract tests, two bundle-negotiation tests, and ten bridge issuance tests.
Tests cover real daemon WebSocket framing, legacy fallback, supersession and
closure during compression, bounded concurrent jobs, exact TypeScript-to-Rust
fixture decoding, original digest verification, truncated streams, trailing
streams and declared-output overflow. Client/GUI all-target/all-feature Clippy
and contract/daemon TypeScript checks passed. The full Rust library suites passed: 536 client tests (four opt-in tests ignored)
and 3,067 GUI tests (ten opt-in tests ignored). These are correctness suites,
not physical input or packaged GUI qualification. The first terminal release
gate reached its installed-package journey, then stopped because PATH selected
Bun 1.3.11 rather than the pinned 1.4.2. The rerun with pinned Bun 1.4.2 passed the full terminal gate, including its
installed-package journey (`graphics-compressed-terminal-gate-pinned.log`).
The failed invocation is retained as evidence.

Run the codec-only measurement from the repository root:

```sh
node --import tsx apps/tmux-gpui/research/remote-compression/measure.ts
```

It verifies every output byte and alternates five samples per path after warmup.
The synthetic input is one 256x512 RGBA chunk (524,288 bytes), either a flat-color
text pattern or deterministic noise. It measures envelope/codec costs in Node,
including async scheduling, and does not include SSH, Rust decoding, GPU paint,
physical input or display refresh. The host had 10 logical CPUs and reported
load averages 1.86/1.51/1.42 before sampling; other qualification work was active.

On Node v24.22.0, the final sampled run produced:

| Workload     | Raw wire bytes | Selected wire bytes | Raw encode median (range), ms | Selected encode median (range), ms |
| ------------ | -------------: | ------------------: | ----------------------------: | ---------------------------------: |
| Text pattern |        524,435 |              32,329 |           0.050 (0.033–0.051) |                1.104 (1.063–1.231) |
| Noise        |        524,435 |             524,435 |           0.045 (0.040–0.075) |                0.059 (0.056–0.193) |

The initial run without sampling spent a median 6.905 ms trying noise before
falling back. That finding motivated the bounded sample. The final noise result
supports skipping this particular workload, not a universal CPU improvement.
Evidence files are `graphics-compressed-measurement.json` and
`graphics-compressed-measurement-sampled.json` under the task qualification root.
No GUI or SSH speedup is claimed from these measurements.

This is the lossless part of remote encoding. Video codecs, damage rectangles,
authenticated IOSurface setup/ACKs and packaged end-to-end qualification remain.

## Real SSH qualification

The owned OpenSSH harness now accepts `TMUX_IDE_NATIVE_TEST_GRAPHICS=owned-pixels`.
After the Rust session commits its initial pane, the harness writes a 256x1024
raw RGBA Kitty image into its dedicated scratch session. The real daemon sends
it over the private SSH forward to the production Rust session/graphics worker.
A test-only counter confirms accepted TGB2 chunks, rather than inferring codec
use from the offer. The fixture checks every decoded byte and final digest
verification; it also checks that the separate source pane stayed unchanged.

The qualified run (`graphics-compressed-live-ssh-qualified.log`, fixture
`nssh-WZaqOa`) passed with 1,048,576 bytes and two compressed chunks. Its receipt
confirms real OpenSSH, real daemon, source-pane preservation and cleanup of owned
processes, files, daemon and fleet. A copy of the receipt and CLI/test-binary
hashes are retained under the qualification root. The temporary generated CLI
was removed from the source checkout after verified cleanup.

The first run (`nssh-AVVzaa`) exposed a fixture error: the legacy session
constructor did not pass the issued binary/projection capabilities. The second
run (`nssh-jOHbCY`) exposed a real Rust issuer bug: remote handoffs offered the
local-file bundle despite having no local image access. Issuance now selects 113
for remote access and 114 only when actual local image access accompanies the
handoff. A regression test inspects the exact remote capability offer. Both
failed runs confirmed complete fixture cleanup and remain retained as evidence.

Compressed chunks also now check current image registry membership and metadata
before inflation. A stale digest invalidates the image without decoding; a
contradictory description fails before allocation. Regression tests supply bad
compressed payloads to prove these checks precede the decoder.

This run did not open a GUI window, render pixels, simulate physical input or
measure end-to-end frame latency. Those remain separate qualification work.
