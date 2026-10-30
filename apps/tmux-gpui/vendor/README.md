# Apple GPUI renderer patch

`bezel-gpui-apple` is copied from the crates.io package
`0.3.21+zed.f16f96`, retaining its Apache license and original package metadata.
[Provenance](bezel-gpui-apple-provenance.json) records the original crate checksum,
original file hashes and changed files. `upstream/Cargo.toml` patches this one
package to the repository copy; the application uses `upstream/Cargo.lock`.
The registry cache is unchanged.

The patch adds straight-alpha BGRA CoreVideo surfaces to the existing NV12 path.
It selects the appropriate Metal pipeline per surface and retains every submitted
surface buffer until the GPU command buffer completes. Unsupported formats and CoreVideo texture import failures return
a rendering error instead of panicking. RGBA IOSurface allocation returned CoreVideo error -6680 on
the qualification host, so this patch does not advertise RGBA support. A producer
must negotiate BGRA and alpha semantics; this renderer does not convert formats.

`surface_owner::retain_surface_owner` binds a thread-safe Rust owner to the actual
CoreVideo buffer through a private, non-propagating attachment. Attach before
publishing; never remove or replace it. Final buffer release drops the owner,
including references retained by submitted GPU work. This is the attachment
mechanism for transport leases; no producer ACK is sent by the renderer itself.

`surface_port::SurfacePort` owns one Mach send-right reference. It imports a
BGRA IOSurface only when actual dimensions, row stride and full allocation size
match the admitted description, attaches the storage owner, and releases the
right on success or failure. Raw rights require an explicit unsafe ownership
transfer from native IPC; wire integers and global surface IDs are not accepted
as authenticated capabilities. Cross-process IPC authentication is still unwired.

`surface_inbox::Inbox` receives one kernel-transferred send right at a time.
Its queue holds one message and polling does not wait. It checks envelope shape,
ticket and advancing sequence, destroying rejected descriptors and transferring
only the accepted right into `SurfacePort`. Endpoint setup must distribute the
send capability through an authenticated native mechanism; numeric task-local
port names are not a wire protocol. The sender uses copied rights and zero-timeout attempts; queue-full/interrupted
sends destroy pseudo-received copies while preserving caller ownership. Queue-full
and disconnected-destination cleanup are tested against kernel reference counts.
A separate opt-in test verifies real cross-process surface transfer and Metal
pixel output. Authenticated production setup and stream wiring remain.

The new tests verify alternating pixel colors, straight-alpha blending and clipping,
recovery after an unsupported surface, mixed BGRA/NV12 draws and actual
CoreVideo ownership before and after GPU completion. They do not implement a
producer acknowledgment, authenticate cross-process offers, bound a frame queue,
or establish presentation latency. The existing image transport remains in use.

From the repository root, on a macOS Metal host:

```sh
cargo test --locked \
  --manifest-path apps/tmux-gpui/vendor/bezel-gpui-apple/Cargo.toml \
  --lib --features runtime_shaders,test-support
```

The cross-process fixture is opt-in because its legacy bootstrap registration
leaves an inactive null-name record. It verifies that no usable endpoint survives
coordinator exit; it does not claim name-record deletion. Run only its outer test,
which owns and reaps both helpers:

```sh
cargo test --locked \
  --manifest-path apps/tmux-gpui/vendor/bezel-gpui-apple/Cargo.toml \
  --lib --features runtime_shaders,test-support -- \
  --exact metal_renderer::packed_surface_tests::native_surface_cross_process --ignored
```

The fixture's private-pipe retirement notice is not the production ACK protocol.
Its legacy bootstrap registration is not the production endpoint design.

The sibling crate's standalone lockfile pins its test dependencies; those include
optional test-support dependencies outside the application graph. Also run the
application GUI tests and Clippy using the application lockfile. Native build
receipts hash this package's manifest, build script, license, Rust/shader sources,
embedded shader-binding inputs and provenance. They exclude the standalone test
lockfile and unrelated sibling files.

For upgrades, compare the preserved original hashes with the pinned replacement,
review each modified file and reapply only necessary changes. Qualify color,
mixed-format drawing and GPU lifetime on the replacement before removing this
patch. Preserve the NV12 path and the original license. This third-party source
is kept outside the upstream application's source-size gate.
