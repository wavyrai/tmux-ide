use super::*;
fn binary_vectors() -> Vec<Value> {
    serde_json::from_str(include_str!("binary-vectors.json")).unwrap()
}
#[test]
fn binary_typescript_lifecycle_has_identical_canonical_hashes_and_shared_rows() {
    let mut store = Store::default();
    let mut old = None;
    for (index, vector) in binary_vectors().iter().enumerate() {
        let bytes: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
        assert_eq!(
            hash_representation(&bytes),
            vector["representationHash"].as_str().unwrap()
        );
        let result = store
            .apply(
                decode_binary(&bytes).unwrap(),
                vector["canonicalHash"].as_str().unwrap(),
            )
            .unwrap();
        assert_eq!(result.revision, index as u64 + 1);
        if index == 0 {
            old = store.snapshot().cloned();
        }
        if index == 1 {
            assert_eq!(result.changed_rows, vec![1]);
            assert!(Arc::ptr_eq(
                &old.as_ref().unwrap().grid[0],
                &store.snapshot().unwrap().grid[0]
            ));
        }
        if index == 4 {
            assert!(store.snapshot().is_none());
        }
        for length in 0..bytes.len() {
            assert!(
                decode_binary(&bytes[..length]).is_err(),
                "truncation {index}:{length}"
            );
        }
        let mut trailing = bytes;
        trailing.push(0);
        assert!(decode_binary(&trailing).is_err());
    }
}
#[test]
fn binary_rejects_noncanonical_integer_unknown_tag_and_unbounded_row() {
    let bytes: Vec<u8> = serde_json::from_value(binary_vectors()[0]["bytes"].clone()).unwrap();
    let mut malformed = bytes.clone();
    malformed.splice(5..6, [0x81, 0]);
    assert!(decode_binary(&malformed).is_err());
    let mut malformed = bytes.clone();
    malformed[6] = 255;
    assert!(decode_binary(&malformed).is_err());
    let mut malformed = bytes;
    malformed[4] = 3;
    assert!(decode_binary(&malformed).is_err());
    // Seed tuple, dimensions 1x1, grid with a declared million rows.
    assert!(
        decode_binary(&[
            b'T', b'C', b'B', b'1', 0, 1, 3, 8, 1, 1, 1, 1, 3, 0xc0, 0x84, 0x3d
        ])
        .is_err()
    );
}

fn uint(bytes: &mut Vec<u8>, mut n: u64) {
    loop {
        let low = (n & 127) as u8;
        n >>= 7;
        bytes.push(low | if n > 0 { 128 } else { 0 });
        if n == 0 {
            break;
        }
    }
}
fn value(bytes: &mut Vec<u8>, v: &Value) {
    match v {
        Value::Null => bytes.push(0),
        Value::Number(n) => {
            bytes.push(1);
            uint(bytes, n.as_u64().unwrap());
        }
        Value::String(s) => {
            bytes.push(2);
            uint(bytes, s.len() as u64);
            bytes.extend(s.as_bytes());
        }
        Value::Array(a) => {
            bytes.push(3);
            uint(bytes, a.len() as u64);
            for child in a {
                value(bytes, child);
            }
        }
        _ => panic!("not a typed tuple"),
    }
}
#[test]
fn binary_blank_runs_have_absolute_cumulative_expansion_limit() {
    let mut compact: Value =
        serde_json::from_str(binary_vectors()[0]["wire"].as_str().unwrap()).unwrap();
    let row = json!([0, [[4096, " ", 1, 0, 0, 0]]]);
    compact["s"][0] = json!(4096);
    compact["s"][2] = json!([row.clone(), row.clone()]);
    compact["s"][3] = json!([]);
    let mut bytes = b"TCB1\x00\x01".to_vec();
    value(&mut bytes, &compact["s"]);
    let Update::Seed { snapshot, .. } = decode_binary(&bytes).unwrap() else {
        panic!("seed")
    };
    assert_eq!(snapshot.grid[0].cells().len(), 4096);
    assert!(bytes.len() * 64 < 8192 || bytes.len() < 512);
    // Dimensions permit this history, but the cumulative expansion exceeds 1M cells.
    compact["s"][3] = json!(vec![row; 250]);
    let mut bytes = b"TCB1\x00\x01".to_vec();
    value(&mut bytes, &compact["s"]);
    assert!(matches!(
        decode_binary(&bytes),
        Err(Error::Invalid("cell budget"))
    ));
}
