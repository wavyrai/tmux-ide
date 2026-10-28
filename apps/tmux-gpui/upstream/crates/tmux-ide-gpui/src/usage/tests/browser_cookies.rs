use super::*;
use crate::usage::cookies;

#[test]
fn chrome_values_decrypt_with_the_derived_key() {
    use aes::cipher::{BlockModeEncrypt, KeyIvInit, block_padding::Pkcs7};
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"peanuts", b"saltysalt", 1, &mut key);
    let seal = |plain: &[u8]| {
        let mut sealed = b"v10".to_vec();
        let mut buffer = plain.to_vec();
        buffer.resize(plain.len() + 16, 0);
        let length = cbc::Encryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into())
            .encrypt_padded::<Pkcs7>(&mut buffer, plain.len())
            .unwrap()
            .len();
        sealed.extend_from_slice(&buffer[..length]);
        sealed
    };
    assert_eq!(
        cookies::decrypt(&seal(b"session-value"), &key, false).as_deref(),
        Some("session-value")
    );
    let mut hashed = vec![0u8; 32];
    hashed.extend_from_slice(b"session-value");
    assert_eq!(
        cookies::decrypt(&seal(&hashed), &key, true).as_deref(),
        Some("session-value")
    );
    assert_eq!(cookies::decrypt(b"v11whatever", &key, false), None);
    assert_eq!(cookies::decrypt(&seal(b"x")[..10], &key, false), None);
}

#[test]
fn safari_binary_cookies_parse() {
    fn record(domain: &str, name: &str, value: &str, expires: f64) -> Vec<u8> {
        let mut strings = Vec::new();
        let base = 56u32;
        let mut offsets = Vec::new();
        for text in [domain, name, "/", value] {
            offsets.push(base + strings.len() as u32);
            strings.extend_from_slice(text.as_bytes());
            strings.push(0);
        }
        let mut out = Vec::new();
        out.extend_from_slice(&(base + strings.len() as u32).to_le_bytes());
        out.extend_from_slice(&[0; 12]);
        for offset in &offsets {
            out.extend_from_slice(&offset.to_le_bytes());
        }
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&expires.to_le_bytes());
        out.extend_from_slice(&0f64.to_le_bytes());
        out.extend_from_slice(&strings);
        out
    }
    let records = [
        record(".example.com", "sid", "abc", 2e9),
        record("other.org", "x", "y", 1.),
    ];
    let mut page = vec![0, 0, 1, 0];
    page.extend_from_slice(&(records.len() as u32).to_le_bytes());
    let mut offset = 8 + 4 * records.len() as u32 + 4;
    for record in &records {
        page.extend_from_slice(&offset.to_le_bytes());
        offset += record.len() as u32;
    }
    page.extend_from_slice(&[0; 4]);
    for record in &records {
        page.extend_from_slice(record);
    }
    let mut file = b"cook".to_vec();
    file.extend_from_slice(&1u32.to_be_bytes());
    file.extend_from_slice(&(page.len() as u32).to_be_bytes());
    file.extend_from_slice(&page);
    let cookies = cookies::binary_cookies(&file).unwrap();
    assert_eq!(cookies.len(), 2);
    assert_eq!(cookies[0].0.domain, ".example.com");
    assert_eq!(cookies[0].0.name, "sid");
    assert_eq!(cookies[0].0.value, "abc");
    assert!(cookies[0].1.is_some_and(|at| at > SystemTime::now()));
    assert!(cookies::binary_cookies(b"nope").is_none());
    assert!(cookies::matches_domain(".example.com", "example.com"));
    assert!(cookies::matches_domain("app.example.com", "example.com"));
    assert!(!cookies::matches_domain("badexample.com", "example.com"));
}
