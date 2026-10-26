#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Write;
fn compressed(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}
fn packet(header: &serde_json::Value, bytes: &[u8]) -> Vec<u8> {
    let header = serde_json::to_vec(header).unwrap();
    let mut frame = b"TGB2".to_vec();
    frame.extend((header.len() as u32).to_be_bytes());
    frame.extend(header);
    frame.extend(bytes);
    frame
}
#[test]
fn inflater_rejects_bombs_truncation_trailing_input_and_wrong_lengths() {
    let bytes = vec![42; CHUNK_BYTES];
    let encoded = compressed(&bytes);
    assert_eq!(inflate(&encoded, bytes.len()).unwrap(), bytes);
    for length in [0, 1, CHUNK_BYTES - 1, CHUNK_BYTES + 1, usize::MAX] {
        assert!(inflate(&encoded, length).is_err());
    }
    assert!(inflate(&encoded[..encoded.len() - 1], bytes.len()).is_err());
    let mut trailing = encoded.clone();
    trailing.extend(&encoded);
    assert!(inflate(&trailing, bytes.len()).is_err());
    let mut corrupt = encoded;
    corrupt[4] ^= 255;
    assert!(inflate(&corrupt, bytes.len()).is_err());
}
#[test]
fn compressed_delivery_requires_negotiation_and_verifies_original_digest() {
    let raw = vec![42; 4096];
    let digest = Sha256::digest(&raw)
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let header = json!({"pane":"pane.one","blob":{"digest":digest,"format":"rgba",
        "width":32,"height":32,"total":4096,"offset":0},"compression":"zlib","decodedBytes":4096});
    let frame = packet(&header, &compressed(&raw));
    let now = Instant::now();
    for negotiated in [false, true] {
        let mut graphics =
            Graphics::new(uuid::Uuid::new_v4().to_string(), vec!["pane.one".into()]).unwrap();
        graphics.panes.get_mut("pane.one").unwrap().incarnation = Some("pane:1".into());
        let mut state = json!({"type":"terminal-graphics","pane":"pane.one","state":{
            "revision":1,"images":[{"imageId":1,"digest":digest,"format":"rgba","width":32,
                "height":32,"bytes":4096,"placeholder":null}],"placements":[],"binaryBlobs":true}});
        if negotiated {
            state["state"]["compressedBlobs"] = true.into();
        }
        graphics
            .accept_control(&serde_json::value::to_raw_value(&state).unwrap(), now)
            .unwrap();
        let result = graphics.accept_binary(&frame, now);
        if !negotiated {
            assert!(matches!(result, Err(Error::Identity)));
            continue;
        }
        // A stale frame with invalid compressed bytes must not be inflated.
        let mut stale = header.clone();
        stale["blob"]["digest"] = "b".repeat(32).into();
        let update = graphics
            .accept_binary(&packet(&stale, &[0, 1, 2]), now)
            .unwrap();
        assert_eq!(update.invalidated, vec!["b".repeat(32)]);
        assert!(update.chunk.is_none());
        let mut contradictory = header.clone();
        contradictory["blob"]["width"] = 31.into();
        assert!(matches!(
            graphics.accept_binary(&packet(&contradictory, &[0, 1, 2]), now),
            Err(Error::Metadata)
        ));
        assert!(matches!(
            graphics.accept_binary(&packet(&header, &[0, 1, 2]), now),
            Err(Error::Compression)
        ));
        let chunk = result.unwrap().chunk.unwrap();
        assert!(chunk.complete_verified);
        assert_eq!(chunk.bytes, raw);
        let wrong = packet(&header, &compressed(&vec![41; 4096]));
        assert!(matches!(
            graphics.accept_binary(&wrong, now),
            Err(Error::Digest)
        ));
    }
}
#[test]
fn typescript_compressed_vector_is_byte_exact() {
    let bytes: Vec<u8> = serde_json::from_str(include_str!("compressed-vector.json")).unwrap();
    let (header, encoded, decoded) = decode(&bytes).unwrap();
    assert_eq!(header.pane, "pane.one");
    assert_eq!(inflate(encoded, decoded.unwrap()).unwrap(), vec![42; 4096]);
}
#[test]
fn envelope_rejects_unbounded_and_inconsistent_declarations() {
    let base = json!({"pane":"pane.one","blob":{"digest":"a".repeat(32),"format":"rgba",
        "width":32,"height":32,"total":4096,"offset":0},"compression":"zlib","decodedBytes":4096});
    for (field, value) in [
        ("decodedBytes", json!(CHUNK_BYTES + 1)),
        ("decodedBytes", json!(0)),
        ("compression", json!("gzip")),
        ("extra", json!(true)),
    ] {
        let mut header = base.clone();
        header[field] = value;
        assert!(decode(&packet(&header, &[1, 2, 3])).is_err());
    }
    let mut header = base.clone();
    header["blob"]["offset"] = 1.into();
    assert!(decode(&packet(&header, &[1, 2, 3])).is_err());
    let mut header = base;
    header["blob"]["format"] = "png".into();
    assert!(decode(&packet(&header, &[1, 2, 3])).is_err());
}
