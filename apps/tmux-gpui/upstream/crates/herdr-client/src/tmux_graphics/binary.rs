//! Bounded binary image chunks: TGB1 raw, negotiated TGB2 independent zlib streams.
use super::{Blob, CHUNK_BYTES, Error, Graphics, GraphicsUpdate};
use serde::Deserialize;
use std::time::Instant;
// The isolated ignored SSH test runs alone and verifies use of the negotiated
// codec through the real socket/session worker, without a production metric.
#[cfg(test)]
pub(crate) static COMPRESSED_CHUNKS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    pane: String,
    blob: Blob,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CompressedHeader {
    pane: String,
    blob: Blob,
    compression: String,
    decoded_bytes: usize,
}
fn decode(data: &[u8]) -> Result<(Header, &[u8], Option<usize>), Error> {
    if data.len() < 10
        || data.len() > 8 + 4096 + CHUNK_BYTES
        || !matches!(data.get(..4), Some(b"TGB1" | b"TGB2"))
    {
        return Err(Error::Bounds);
    }
    let length = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
    if length == 0 || length > 4096 || 8 + length >= data.len() {
        return Err(Error::Bounds);
    }
    let (header, decoded) = if data.starts_with(b"TGB2") {
        let h: CompressedHeader =
            serde_json::from_slice(&data[8..8 + length]).map_err(Error::Json)?;
        if h.compression != "zlib"
            || !(1..=CHUNK_BYTES).contains(&h.decoded_bytes)
            || !matches!(h.blob.format, super::Format::Rgb | super::Format::Rgba)
        {
            return Err(Error::Compression);
        }
        (
            Header {
                pane: h.pane,
                blob: h.blob,
            },
            Some(h.decoded_bytes),
        )
    } else {
        (
            serde_json::from_slice(&data[8..8 + length]).map_err(Error::Json)?,
            None,
        )
    };
    let bytes = &data[8 + length..];
    if header.pane.is_empty()
        || header.pane.len() > 128
        || !header.pane.as_bytes()[0].is_ascii_alphanumeric()
        || !header
            .pane
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || matches!(
            header.pane.as_str(),
            "__proto__" | "prototype" | "constructor"
        )
        || header.pane.starts_with("terminal.discovered.")
        || !super::wire::digest(&header.blob.digest)
        || !(1..=10_000).contains(&header.blob.width)
        || !(1..=10_000).contains(&header.blob.height)
        || header.blob.total == 0
        || header.blob.total > super::MAX_IMAGE_BYTES
        || bytes.len() > CHUNK_BYTES
        || decoded.is_some_and(|length| bytes.len() >= length)
        || header
            .blob
            .offset
            .checked_add(decoded.unwrap_or(bytes.len()))
            .is_none_or(|end| end > header.blob.total)
    {
        return Err(Error::Bounds);
    }
    Ok((header, bytes, decoded))
}
impl Graphics {
    pub fn accept_binary(&mut self, data: &[u8], now: Instant) -> Result<GraphicsUpdate, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        let (header, bytes, decoded) = decode(data)?;
        if self
            .panes
            .get(&header.pane)
            .and_then(|pane| pane.state.as_ref())
            .is_none_or(|state| {
                state.binary_blobs != Some(true)
                    || (decoded.is_some() && state.compressed_blobs != Some(true))
            })
        {
            return Err(Error::Identity);
        }
        // Reject stale registry entries and contradictory metadata before doing
        // decompression work. Superseded frames are normal during redraws.
        if decoded.is_some() {
            let pane = self.panes.get(&header.pane).ok_or(Error::Identity)?;
            if pane.tombstone || pane.incarnation.is_none() {
                return Ok(GraphicsUpdate {
                    handled: true,
                    ..Default::default()
                });
            }
            let image = pane.state.as_ref().and_then(|state| {
                state
                    .images
                    .iter()
                    .find(|image| image.digest == header.blob.digest)
            });
            let Some(image) = image else {
                self.missing(std::slice::from_ref(&header.blob.digest));
                return Ok(GraphicsUpdate {
                    handled: true,
                    invalidated: vec![header.blob.digest],
                    ..Default::default()
                });
            };
            if !header.blob.matches(image) {
                return Err(Error::Metadata);
            }
        }
        let bytes = match decoded {
            Some(length) => inflate(bytes, length)?,
            None => bytes.to_vec(),
        };
        let result = self.blob(&header.pane, header.blob, bytes, now);
        #[cfg(test)]
        if decoded.is_some() && result.as_ref().is_ok_and(|update| update.chunk.is_some()) {
            COMPRESSED_CHUNKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        result
    }
}
// The extra byte detects expansion beyond the declared output. A finished
// stream with trailing or concatenated input is rejected, never partially used.
fn inflate(bytes: &[u8], length: usize) -> Result<Vec<u8>, Error> {
    if !(1..=CHUNK_BYTES).contains(&length) {
        return Err(Error::Bounds);
    }
    let mut output = vec![0; length + 1];
    let mut decoder = flate2::Decompress::new(true);
    let status = decoder
        .decompress(bytes, &mut output, flate2::FlushDecompress::Finish)
        .map_err(|_| Error::Compression)?;
    if status != flate2::Status::StreamEnd
        || decoder.total_in() != bytes.len() as u64
        || decoder.total_out() != length as u64
    {
        return Err(Error::Compression);
    }
    output.truncate(length);
    Ok(output)
}
#[cfg(test)]
#[path = "tests/compressed.rs"]
mod compressed_tests;
#[cfg(test)]
mod tests {
    use super::*;
    fn frame(header: &[u8], bytes: &[u8]) -> Vec<u8> {
        let mut data = b"TGB1".to_vec();
        data.extend((header.len() as u32).to_be_bytes());
        data.extend(header);
        data.extend(bytes);
        data
    }
    #[test]
    fn typescript_encoder_vector_decodes_exact_raw_bytes() -> Result<(), serde_json::Error> {
        let bytes: Vec<u8> = serde_json::from_str(include_str!("tests/binary-vector.json"))?;
        assert!(matches!(decode(&bytes), Ok((_, [0, 128, 255], None))));
        Ok(())
    }
    #[test]
    fn exact_bytes_and_malformed_lengths() {
        let header=br#"{"pane":"pane.one","blob":{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","format":"png","width":1,"height":1,"total":3,"offset":0}}"#;
        let valid = frame(header, &[0, 128, 255]);
        assert!(matches!(decode(&valid), Ok((_, [0, 128, 255], None))));
        for length in [0, 1, 7, 8, 9, valid.len() - 3] {
            assert!(decode(&valid[..length]).is_err());
        }
        let mut corrupt = valid.clone();
        corrupt[4..8].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(decode(&corrupt).is_err());
        let mut corrupt = valid.clone();
        corrupt[0] = 0;
        assert!(decode(&corrupt).is_err());
        assert!(
            decode(&frame(
                br#"{"pane":"pane.one","blob":{},"extra":true}"#,
                &[0]
            ))
            .is_err()
        );
        assert!(decode(&frame(&[255], &[0])).is_err());
        assert!(decode(&frame(header, &vec![0; CHUNK_BYTES + 1])).is_err());
    }
}
