# Local GUI binary protocol v1

Capability: `binary-rle-v1`. Select it only before starting a transport when both
endpoints support the complete framing/codec. These modules do not negotiate it.
Legacy JSON lines remain a separate stream mode; never intermingle them with
binary bytes or reinterpret a corrupt binary frame as legacy JSON.

All integers are unsigned, big-endian. Each transport frame has 12 header bytes:

| Offset | Width | Meaning                                            |
| ------ | ----- | -------------------------------------------------- |
| 0      | 4     | ASCII `TIGF`                                       |
| 4      | 1     | Version 1                                          |
| 5      | 1     | Type 1 JSON, 2 cell publication, 3 raw image chunk |
| 6      | 2     | Flags, must be zero                                |
| 8      | 4     | Payload byte length, excludes header               |

JSON/cell payloads are nonempty and at most 8 MiB. Image payloads are at most
4 + 4096 + 524288 bytes. Unknown fields in the framing header, truncated EOF,
invalid lengths and malformed typed payloads retire the transport. Never scan
for magic to recover after corruption.

The incremental parser owns one payload at a time. `push` reports consumed
input bytes and whether its consumer blocked. Returning false from the consumer
accepts that completed frame. The caller retains the unconsumed input tail,
pauses its source, and calls `resume` before supplying that tail. No accepted
frame is replayed. Input chunks themselves may be borrowed only during `push`;
partial bytes are copied into owned bounded storage. A consumer that retains
completed frames must enforce its own queue budget.

Type 1 payload is strict UTF-8 JSON (BOM is not silently stripped).

Type 2 payload is `u32 outerMetadataBytes`, UTF-8 JSON outer publication object
WITHOUT `snapshot`, followed by one cell body. Validate outer metadata and cells
atomically before committing frame state or authority. Null snapshot publications
travel as type 1. Retained previews stay legacy in outer metadata.

A cell body contains:

1. `u32 metadataBytes`, UTF-8 JSON compact snapshot metadata excluding `grid`,
   `history`, `changedRows`. Includes encoding `rle-v1` or `rle-delta-v1`, epoch,
   seq, optional baseSeq, cols/rows, cursor, modes, placements, bootstrap.
2. `u32 recordCount`; each record is `u32 rowIndex` followed by one row.
3. `u32 historyCount`; each history row has no index.

A row is `u8 wrapped` (0 or 1), `u32 runCount`, then runs. A run is `u32 repeat`,
`u16 graphemeByteLength`, exact UTF-8 grapheme bytes, `u8 width`, `u32 foreground`,
`u32 background`, `u8 attributes`. Colors and attributes use the compact JSON
contract. UTF-8 must be well-formed, graphemes at most 256 bytes, control scalars
and lone surrogates rejected. U+FEFF is preserved as text. Width pairs must be
complete within rows. No binary byte length may truncate modulo 256.

Full records cover all row indices in ascending order. Delta indices are sorted,
unique and less than rows. Preserve epoch/sequence/full metadata semantics from
compact-delta.ts; this codec does not commit or advance a baseline. Total declared
viewport/history cells <=262144; expanded grapheme bytes <=8 MiB. Counts and all
lengths are checked before allocation/iteration; trailing bytes are rejected.

Type 3 payload is `u32 metadataBytes`, UTF-8 JSON metadata (max4096 bytes), raw
image chunk bytes (1..524288 bytes). Metadata is exactly the existing graphics
blob schema: digest, format, width, height, total, offset; optional image key
(max600 characters). No base64 `data` field. Preserve compressed formats; this
layer does not inflate. Existing assembler owns contiguous offsets, arrival
ordering, aggregate budgets, digest completion, eviction and missing recovery.

`binary-vectors.json` is the shared cross-language byte fixture. Its cells contain
body-only hex; publications/images/json contain whole framed hex. No test vector
is proof of production integration or performance gain.
