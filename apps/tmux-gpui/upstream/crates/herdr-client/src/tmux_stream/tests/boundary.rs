use super::super::boundary::Boundary;

#[test]
fn tracks_read_ahead_extended_headers_and_fragmented_control_interleaving() {
    let mut boundary = Boundary::default();
    boundary.observe(b"HTTP/1.1 101 Switching Protocols\r\n\r\n");
    assert!(!boundary.is_partial());
    boundary.observe(&[0x81, 1, b'a', 0x81]);
    assert!(boundary.is_partial());
    boundary.observe(&[126, 0]);
    assert!(boundary.is_partial());
    boundary.observe(&[1, b'b']);
    assert!(!boundary.is_partial());
    boundary.observe(&[0x01, 1, b'c']);
    assert!(boundary.is_partial());
    boundary.observe(&[0x89, 0]);
    assert!(boundary.is_partial());
    boundary.observe(&[0x80, 0]);
    assert!(!boundary.is_partial());
}

#[test]
fn partial_at_every_byte_of_masked_extended_frame() {
    let bytes = [0x81, 0xff, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 4, b'z'];
    let mut boundary = Boundary::default();
    boundary.observe(b"HTTP/1.1 101\r\n\r\n");
    for byte in &bytes[..bytes.len() - 1] {
        boundary.observe(&[*byte]);
        assert!(boundary.is_partial());
    }
    boundary.observe(&bytes[bytes.len() - 1..]);
    assert!(!boundary.is_partial());
}

#[test]
fn binary_fragments_are_bounded_before_payload_allocation() {
    let mut boundary = Boundary::default();
    boundary.observe(b"HTTP/1.1 101\r\n\r\n");
    boundary.observe(&[0x02, 1, 0xff, 0x89, 0]);
    assert!(boundary.is_partial());
    let mut header = vec![0x80, 127];
    header.extend((8_u64 + 4096 + 512 * 1024).to_be_bytes());
    for byte in header {
        boundary.observe(&[byte]);
    }
    assert!(boundary.binary_oversized());
}
#[test]
fn binary_fragment_control_interleave_finishes_cleanly() {
    let mut boundary = Boundary::default();
    boundary.observe(b"HTTP/1.1 101\r\n\r\n");
    for byte in [0x02, 1, 0xff, 0x89, 0, 0x80, 1, 0x80] {
        boundary.observe(&[byte]);
    }
    assert!(!boundary.is_partial());
    assert!(!boundary.binary_oversized());
}
