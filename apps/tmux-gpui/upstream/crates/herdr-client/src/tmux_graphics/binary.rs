//! Capability 107: bounded strict metadata followed by unchanged image bytes.
use super::{Blob, CHUNK_BYTES, Error, Graphics, GraphicsUpdate};
use serde::Deserialize;
use std::time::Instant;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    pane: String,
    blob: Blob,
}
fn decode(data: &[u8]) -> Result<(Header, &[u8]), Error> {
    if data.len() < 10 || data.len() > 8 + 4096 + CHUNK_BYTES || data.get(..4) != Some(b"TGB1") {
        return Err(Error::Bounds);
    }
    let length = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
    if length == 0 || length > 4096 || 8 + length >= data.len() {
        return Err(Error::Bounds);
    }
    let header: Header = serde_json::from_slice(&data[8..8 + length]).map_err(Error::Json)?;
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
        || header
            .blob
            .offset
            .checked_add(bytes.len())
            .is_none_or(|end| end > header.blob.total)
    {
        return Err(Error::Bounds);
    }
    Ok((header, bytes))
}
impl Graphics {
    pub fn accept_binary(&mut self, data: &[u8], now: Instant) -> Result<GraphicsUpdate, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        let (header, bytes) = decode(data)?;
        if self
            .panes
            .get(&header.pane)
            .and_then(|pane| pane.state.as_ref())
            .is_none_or(|state| state.binary_blobs != Some(true))
        {
            return Err(Error::Identity);
        }
        self.blob(&header.pane, header.blob, bytes.to_vec(), now)
    }
}
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
        assert!(matches!(decode(&bytes), Ok((_, [0, 128, 255]))));
        Ok(())
    }
    #[test]
    fn exact_bytes_and_malformed_lengths() {
        let header=br#"{"pane":"pane.one","blob":{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","format":"png","width":1,"height":1,"total":3,"offset":0}}"#;
        let valid = frame(header, &[0, 128, 255]);
        assert!(matches!(decode(&valid), Ok((_, [0, 128, 255]))));
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
