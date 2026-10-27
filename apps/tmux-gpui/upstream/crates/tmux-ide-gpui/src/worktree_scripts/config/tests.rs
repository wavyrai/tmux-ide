#![allow(clippy::unwrap_used)]

use super::*;

#[test]
fn parses_scripts_and_skips_blank_ones() {
    let config = Config::parse(
        br#"[scripts]
setup = """
cp "$HERDR_ROOT_PATH/.env" .env
npm ci
"""
run = "npm run dev"
archive = "  "
"#,
    )
    .unwrap();
    assert_eq!(
        config.scripts.get(ScriptKind::Setup),
        Some("cp \"$HERDR_ROOT_PATH/.env\" .env\nnpm ci\n")
    );
    assert_eq!(config.scripts.get(ScriptKind::Run), Some("npm run dev"));
    assert_eq!(config.scripts.get(ScriptKind::Archive), None);
    assert_eq!(config.digest.len(), 64);
    assert!(config.digest.bytes().all(|b| b.is_ascii_hexdigit()));
    // An empty file is a valid file with nothing to run.
    assert_eq!(Config::parse(b"").unwrap().scripts, Scripts::default());
}

#[test]
fn digest_follows_every_byte_of_the_file() {
    let a = Config::parse(b"[scripts]\nrun = \"make\"\n").unwrap();
    let b = Config::parse(b"[scripts]\nrun = \"make\" \n").unwrap();
    assert_eq!(a.scripts, b.scripts);
    assert_ne!(a.digest, b.digest);
    assert_eq!(
        a.digest,
        Config::parse(b"[scripts]\nrun = \"make\"\n")
            .unwrap()
            .digest
    );
}

#[test]
fn refuses_unknown_keys_bad_encoding_nul_and_oversized_files() {
    assert!(matches!(
        Config::parse(b"[scripts]\nsetpu = \"x\"\n"),
        Err(crate::Error::WorktreeScriptsParse(_))
    ));
    assert!(matches!(
        Config::parse(b"[other]\n"),
        Err(crate::Error::WorktreeScriptsParse(_))
    ));
    assert!(matches!(
        Config::parse(b"[scripts]\nrun = \"\xff\"\n"),
        Err(crate::Error::WorktreeScriptsEncoding(_))
    ));
    assert!(matches!(
        Config::parse(b"[scripts]\nrun = \"a\\u0000b\"\n"),
        Err(crate::Error::WorktreeScriptsNul)
    ));
    let large = vec![b'#'; MAX_BYTES as usize + 1];
    assert!(matches!(
        Config::parse(&large),
        Err(crate::Error::WorktreeScriptsSize { limit: MAX_BYTES })
    ));
}

#[test]
fn local_reads_tell_a_missing_file_from_a_present_one() {
    let dir = tempfile::tempdir().unwrap();
    let checkout = dir.path().to_str().unwrap();
    assert_eq!(
        read(&ConnectTarget::Local, checkout, &AtomicBool::new(false)).unwrap(),
        None
    );
    std::fs::create_dir(dir.path().join(".herdr")).unwrap();
    std::fs::write(dir.path().join(PATH), "[scripts]\nrun = \"make\"\n").unwrap();
    let config = read(&ConnectTarget::Local, checkout, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(config.scripts.get(ScriptKind::Run), Some("make"));
    std::fs::write(dir.path().join(PATH), vec![b'#'; MAX_BYTES as usize + 1]).unwrap();
    assert!(matches!(
        read(&ConnectTarget::Local, checkout, &AtomicBool::new(false)),
        Err(crate::Error::WorktreeScriptsSize { .. })
    ));
}

#[test]
fn remote_output_marks_presence() {
    assert_eq!(remote_bytes(Vec::new()), None);
    assert_eq!(remote_bytes(b"present\n".to_vec()), Some(Vec::new()));
    assert_eq!(
        remote_bytes(b"present\n[scripts]\n".to_vec()),
        Some(b"[scripts]\n".to_vec())
    );
}

#[test]
fn a_wsl_distribution_is_refused_rather_than_read_from_this_machine() {
    let target = ConnectTarget::Wsl {
        distro: "Ubuntu".into(),
        session: "default".into(),
    };
    assert!(matches!(
        read(&target, "/home/me/app", &AtomicBool::new(false)),
        Err(crate::Error::WorktreeScriptsUnsupportedHost)
    ));
}
