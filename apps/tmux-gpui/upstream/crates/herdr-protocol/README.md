# Protocol API

Generation-1 wire declarations, bounded bincode framing, and atomic surface
validation. See [NOTICE.md](NOTICE.md) for upstream provenance. Wire field and
enum variant order are compatibility contracts and are unchanged by error APIs.

## Errors

The crate exports `Error` and `Result<T> = std::result::Result<T, Error>`.
`encode_message`, `decode_payload`, `read_message`, `write_message`,
`FrameData::validate`, and `PaneSurfaceFrame::apply_patch` return this result.
The `thiserror` enum distinguishes framing limits, trailing bytes, invalid
geometry/hyperlinks, and patch identity/geometry failures without string parsing.

`Io`, `Encode`, and `Decode` retain their concrete I/O or bincode source through
`std::error::Error::source()`. Outbound limits are enforced by a bounded `Write`
implementation: its `io::Error` contains `Error::FrameLimit`, retained inside
the bincode `EncodeError::Io` source. Only actual `Read`/`Write` trait interfaces
use `io::Result`; public framing operations report protocol errors as well.

`Error::kind()` returns an original I/O error's kind, or `InvalidData` for
codec/validation failures, preserving retry classification. Callers that must
adapt to an I/O interface can use `io::Error::new(error.kind(), error)` without
discarding the source. Error display and source chains are diagnostics, not
sanitized presentation of untrusted terminal or daemon content.

## Optional Surface Encodings

Three upstream encodings shrink surface updates. Each module exposes its
`CAPABILITY`, `MESSAGE_KIND` (an `EndpointControl` kind), `decode`, and an
`encode` used by mock peers. They are requested in the hello, which precedes
the welcome, and accepted only when the welcome advertises the capability.

- `surface_scroll`: a patch plus per-region row shifts, applied by
  `PaneSurfaceFrame::apply_scroll_patch` with the same atomic validation as
  `apply_patch`; regions must fit the frame and be disjoint.
- `surface_delta`: a recomputed surface as metadata plus sorted changed-cell
  spans (and a popup patch or replacement); `SurfaceDelta::reconstruct`
  rebuilds the full surface from the retained one.
- `surface_reuse`: JSON metadata for a recomputed surface whose cells are all
  unchanged; `SurfaceReuse::reconstruct` reuses the retained cells.

Reconstruction is fenced on boot ID, base projection/surface revision, and the
next surface revision; the result still goes through `FrameData::validate`.
Failures are typed (`ScrollBounds`, `DeltaSpan`, `SurfaceBaseline`, ...).

## Clipboard Images

`encode_clipboard_image(target: ClientClipboardImageTarget, extension: &str,
data: Vec<u8>) -> Result<Vec<u8>>` validates and encodes the existing upstream
`ClientMessage::ClipboardImage` variant, without changing its tag or field order.
`validate_clipboard_image_target(&ClientClipboardImageTarget) -> Result<()>`
is also available for reservations before bytes are read.

- `MAX_CLIPBOARD_IMAGE_PAYLOAD`: 16 MiB; empty and larger payloads are rejected.
- `MAX_CLIPBOARD_IMAGE_TARGET_BYTES`: 1024; pane/popup IDs must be nonempty.
  `DirectTerminal` has no ID.
- `MAX_CLIPBOARD_IMAGE_FRAME_SIZE`: 16 MiB plus 2048 bytes for the bounded envelope.
- Extensions are case-insensitive `png`, `jpg`/`jpeg`, `gif`, `webp`, and `bmp`;
  encoded extensions are lowercase, and JPEG is canonicalized to `jpg`.

Validation failures are typed `ClipboardImageSize`, `ClipboardImageTarget`, and
`ClipboardImageExtension` errors. Data remains opaque, matching upstream's TUI:
no image decoding, signature validation, filesystem access, or local clipboard
mutation occurs. Encoding can allocate a second image-sized buffer and belongs
on a background executor. The ordinary `MAX_FRAME_SIZE` remains 2 MiB; only the
image-specific encoder selects the larger cap.

## Verification

`cargo test --locked -p herdr-protocol` covers frozen wire tags, independent
positional layouts, JSON fixtures, bounded framing, atomic patch validation,
typed error categories/source preservation, and replay of Herdr-encoded
surface scroll/delta/reuse fixtures.
