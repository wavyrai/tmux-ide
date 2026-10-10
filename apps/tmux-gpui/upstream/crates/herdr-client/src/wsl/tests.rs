use super::*;

fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

#[test]
fn distro_names_follow_the_import_rules() {
    for name in [
        "Ubuntu",
        "Ubuntu-24.04",
        "openSUSE-Leap-15.6",
        "OracleLinux_9_1",
    ] {
        assert!(valid_distro(name), "{name}");
    }
    let long = "a".repeat(65);
    for name in ["", "-d", "two words", "a/b", "a\"b", "é", long.as_str()] {
        assert!(!valid_distro(name), "{name}");
    }
}

#[test]
fn utf16_listings_decode_with_or_without_a_byte_order_mark() {
    let listing = "Ubuntu\r\nDebian\r\n";
    assert_eq!(parse_distro_list(&utf16(listing)), ["Ubuntu", "Debian"]);
    let mut marked = vec![0xff, 0xfe];
    marked.extend(utf16(listing));
    assert_eq!(parse_distro_list(&marked), ["Ubuntu", "Debian"]);
}

#[test]
fn utf8_listings_drop_stray_nuls_markers_and_docker_internals() {
    let listing =
        b"* Ubuntu\r\nU\0buntu\r\ndocker-desktop\r\ndocker-desktop-data\r\n\r\nkali-linux\n";
    assert_eq!(parse_distro_list(listing), ["Ubuntu", "kali-linux"]);
}

#[test]
fn messages_are_not_mistaken_for_distributions() {
    let message = "Windows Subsystem for Linux has no installed distributions.\r\n\
        You can resolve this by installing a distribution with the instructions below:\r\n";
    assert!(parse_distro_list(&utf16(message)).is_empty());
    assert!(parse_distro_list(message.as_bytes()).is_empty());
    assert!(parse_distro_list(b"").is_empty());
}

#[test]
fn listings_keep_order_and_drop_duplicates() {
    assert_eq!(
        parse_distro_list(b"Debian\nUbuntu\nDebian\n"),
        ["Debian", "Ubuntu"]
    );
}

#[test]
fn invalid_distros_and_sessions_are_rejected_before_anything_spawns() {
    let stop = AtomicBool::new(false);
    assert!(matches!(
        connect("-oops", "default", &stop),
        Err(Error::InvalidWslDistro)
    ));
    assert!(matches!(
        connect("Ubuntu", "../escape", &stop),
        Err(Error::InvalidSession)
    ));
    assert!(matches!(
        probe_distro("bad name", "default"),
        Err(Error::InvalidWslDistro)
    ));
    assert!(matches!(
        list_distro_sessions("bad/name"),
        Err(Error::InvalidWslDistro)
    ));
    assert!(matches!(
        delete_distro_session("Ubuntu", "default"),
        Err(Error::DefaultSession)
    ));
}

#[cfg(not(windows))]
#[test]
fn other_platforms_refuse_wsl_plainly() {
    let stop = AtomicBool::new(false);
    assert!(matches!(
        connect("Ubuntu", "default", &stop),
        Err(Error::WslUnsupported)
    ));
    assert!(matches!(list_distros(), Err(Error::WslUnsupported)));
    assert!(matches!(
        probe_distro("Ubuntu", "default"),
        Err(Error::WslUnsupported)
    ));
    assert!(matches!(
        list_distro_sessions("Ubuntu"),
        Err(Error::WslUnsupported)
    ));
    assert!(matches!(
        delete_distro_session("Ubuntu", "work"),
        Err(Error::WslUnsupported)
    ));
    assert_eq!(
        Error::WslUnsupported.kind(),
        std::io::ErrorKind::Unsupported
    );
}
