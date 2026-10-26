# Shared pixel storage feasibility

This opt-in macOS experiment tests one building block of the Sfora
[pixel-surface proposal](https://www.sfora.ai/org/wavyr/posts/nh75mb0pnr3prnrjtzqa5wasp18gnq2z).
It is not the GUI's production image transport.

A producer writes a 1920 × 1200 RGBA frame to a private, same-user file mapping.
A separate consumer wraps the mapping with Metal `bytesNoCopy`, creates a texture,
and checks every pixel on the GPU. Only frame numbers and acknowledgments cross
the pipes. The producer waits for GPU completion before reusing storage.

Run from the repository root:

```sh
xcrun swiftc -O -framework Metal \
  apps/tmux-gpui/research/pixel-surfaces/shared-texture.swift \
  -o /tmp/tmux-shared-texture
python3 apps/tmux-gpui/research/pixel-surfaces/check-shared-texture.py \
  /tmp/tmux-shared-texture
```

The harness has a 90-second overall deadline and owns and reaps its two children.
It creates and removes a private temporary directory. It does not discover tmux
sessions, start a daemon, or modify an installed app. The mapping requires a
unified-memory Metal device. A successful run verifies all 30 frames by default;
it does not measure presentation latency or claim a performance improvement.

## What remains before production integration

The repository's [Apple renderer patch](../../vendor/README.md) now accepts
straight-alpha BGRA CoreVideo buffers alongside NV12 and retains submitted buffers
until GPU completion. GPU readback tests cover adjacent colors and mixed formats.
RGBA IOSurface allocation failed on the qualification host; this experiment's
RGBA file mapping cannot be plugged directly into that BGRA surface API.

This experiment has one slot and strictly sequential acknowledgments; it does not
exercise production lifecycle cases or a backlog of frames. The separate native
implementation now has authenticated offers scoped to exact canonical pane
identity, bounded BGRA allocations, Mach-port transfer, GPU-retained storage and
original-connection retirement acknowledgments. See the current integration
status below rather than treating this mapping experiment as its implementation.

A real IOSurface path should transfer Mach-port rights, not expose numeric global
surface IDs. Apple's [CVPixelBufferCreateWithIOSurface documentation](<https://developer.apple.com/documentation/corevideo/cvpixelbuffercreatewithiosurface(_:_:_:_:)>)
explains that Mach-port ownership participates in pool-reuse accounting while
numeric IDs do not. This prototype uses a private file mapping, **not IOSurface
IPC**. Apple's [Metal buffer documentation](<https://developer.apple.com/documentation/metal/mtldevice/makebuffer(bytesnocopy:length:options:deallocator:)>)
requires page-aligned storage and length for this buffer construction.

Remote transport remains separate: compare lossless compressed damage for static
content against hardware video for changing images, including text fidelity,
bandwidth, decode time, frame age under backpressure, and reconnect behavior.
Neither a codec choice nor a user-visible latency claim follows from this local
mapping test. Keep pixel payloads outside tmux and preserve the current terminal
and image fallback paths while developing that channel.

## Native integration status (2026-10-25)

The daemon exposes an owner-authenticated producer registration channel. On
macOS, the Rust `tmux_native_surface::producer::Producer` API registers with the
verified local daemon and submits immutable IOSurface-backed BGRA CoreVideo
buffers. The producer supplies an actual committed pane identity and placement;
the daemon binds delivery to the receiving viewer's nonce. The native GUI opts
into protocol 115 only when the daemon reports an available producer. It keeps
the existing image path when that capability is absent or the producer fails.

The real owned-daemon fixture verifies registration, distinct source/viewer
nonces, surface import, retirement reaching producer backing, and fallback after
producer disconnect. Source and evidence details are in the
[research log](../README.md#real-daemonnative-producer-roundtrip-qualification).
This is not a physical-window paint or throughput measurement.

**A producer API is not automatic support for existing pixel applications.**
The current checkout's concrete caller is the integration fixture. An external
renderer must still integrate the API, publish compatible immutable buffers and
poll receiver/retirement events on its worker. Ordinary inline Kitty applications
continue on the existing Kitty path; this does not enable Kitty `t=s` or `t=f`,
nor does it integrate a Chromium offscreen renderer. Do not advertise the native
path to applications that cannot supply it. Windows/Linux native pixel import,
remote video codecs, and measured display-rate performance are not established
by the macOS integration result.
