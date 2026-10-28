use super::*;
use anyhow::Context as _;
use ed25519_dalek::{Signer, SigningKey};

#[test]
fn request_profiles_allow_slow_archives_with_finite_deadlines() {
    for (profile, total, body) in [
        (RequestProfile::Metadata, 120, 30),
        (RequestProfile::Archive, 600, 600),
    ] {
        let config = request_config(profile);
        let timeouts = config.timeouts();
        assert_eq!(timeouts.global, Some(Duration::from_secs(total)));
        assert_eq!(timeouts.recv_body, Some(Duration::from_secs(body)));
        assert_eq!(timeouts.resolve, Some(Duration::from_secs(10)));
        assert_eq!(timeouts.connect, Some(Duration::from_secs(10)));
        assert_eq!(timeouts.send_request, Some(Duration::from_secs(15)));
        assert_eq!(timeouts.recv_response, Some(Duration::from_secs(15)));
        // A short per-call timeout would also truncate the entire body.
        assert_eq!(timeouts.per_call, None);
        assert!(config.https_only());
        assert_eq!(config.max_redirects(), 0);
    }
}

#[cfg(unix)]
#[test]
fn archive_creation_is_private_and_never_overwrites() -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::AtomicU64;

    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = loop {
        let directory = std::env::temp_dir().join(format!(
            "herdr-release-permissions-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match std::fs::create_dir(&directory) {
            Ok(()) => break directory,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).context("Creating test directory"),
        }
    };
    let path = directory.join("archive.tar.gz");
    let mut file = create_archive(&path)?;
    // Do not mutate the process-global umask in a parallel test. The explicit
    // creation mode excludes group/other bits regardless of the current umask.
    assert_eq!(file.metadata()?.permissions().mode() & 0o077, 0);
    file.write_all(b"original")?;
    assert!(create_archive(&path).is_err());
    assert_eq!(std::fs::read(&path)?, b"original");
    drop(file);
    std::fs::remove_file(path)?;
    std::fs::remove_dir(directory)?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn fixture() -> Manifest {
    Manifest {
        schema: 1,
        version: "20260920.2".into(),
        assets: vec![Asset {
            target: "universal-apple-darwin".into(),
            name: "herdr-gpui-20260920.2-macos-universal.app.tar.gz".into(),
            size: 3,
            sha256: hex(&Sha256::digest(b"abc")),
        }],
    }
}

fn signed(bytes: &[u8]) -> Result<Manifest> {
    let key = SigningKey::from_bytes(&[42; 32]);
    verify_manifest(
        bytes,
        &key.sign(bytes).to_bytes(),
        &hex(key.verifying_key().as_bytes()),
        "20260920.2",
    )
}

#[test]
fn versions_are_canonical_bounded_calendar_versions() {
    for value in ["20260920.1", "10000101.99", "99991231.18446744073709551615"] {
        assert!(parse_version(value).is_some(), "{value}");
    }
    for value in [
        "",
        "1",
        "1.2",
        "1.2.3",
        "20260920",
        "20260920.",
        "20260920.1.2",
        ".20260920.1",
        "2026092.1",
        "202609201.1",
        "02602092.1",
        "20260920.0",
        "20260920.01",
        "2026-09-20.1",
        "v20260920.1",
        "vv20260920.1",
        "20260920.1-alpha",
        "20260920.1+build",
        "+20260920.1",
        "-20260920.1",
        " 20260920.1",
        "20260920.1\n",
        "２0260920.1",
        "20260920.18446744073709551616",
    ] {
        assert!(parse_version(value).is_none(), "{value}");
    }
    assert_eq!(parse_version("20260920.3"), Some((20260920, 3)));
    for (new, old) in [
        ("20260920.2", "20260920.1"),
        ("20260920.10", "20260920.9"),
        ("20261005.1", "20260920.99"),
        ("20270101.1", "20261231.4"),
    ] {
        assert!(parse_version(new) > parse_version(old));
    }
}

#[test]
fn linux_update_assets_are_distinct_from_manual_archives() -> anyhow::Result<()> {
    for target in ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"] {
        let mut manifest = fixture();
        manifest.assets[0].target = target.into();
        manifest.assets[0].name = format!("herdr-gpui-20260920.2-{target}-update.tar.gz");
        assert_eq!(signed(&serde_json::to_vec(&manifest)?)?, manifest);
        for name in [
            format!("herdr-gpui-20260920.2-{target}.tar.gz"),
            format!("Herdr-20260920.2-{target}.tar.gz"),
        ] {
            manifest.assets[0].name = name;
            assert!(matches!(
                signed(&serde_json::to_vec(&manifest)?),
                Err(Error::ManifestAsset)
            ));
        }
    }
    Ok(())
}

#[test]
fn authentication_binds_exact_bytes_key_and_version() -> anyhow::Result<()> {
    use std::error::Error as _;
    let manifest = fixture();
    let bytes = serde_json::to_vec(&manifest)?;
    assert_eq!(signed(&bytes)?, manifest);
    let key = SigningKey::from_bytes(&[42; 32]);
    let signature = key.sign(&bytes).to_bytes();
    let public = hex(key.verifying_key().as_bytes());
    let error = verify_manifest(&bytes, &signature[..63], &public, &manifest.version)
        .err()
        .context("expected signature length error")?;
    assert!(matches!(error, Error::SignatureLength(_)));
    assert!(
        error
            .source()
            .context("expected signature length source")?
            .is::<ed25519_dalek::SignatureError>()
    );
    assert!(matches!(
        verify_manifest(&bytes, &signature, &public, "20260920.3"),
        Err(Error::ManifestVersion)
    ));
    let wrong_key = SigningKey::from_bytes(&[43; 32]);
    assert!(
        verify_manifest(
            &bytes,
            &signature,
            &hex(wrong_key.verifying_key().as_bytes()),
            &manifest.version
        )
        .is_err()
    );
    let mut changed = bytes.clone();
    changed.push(b' ');
    let error = verify_manifest(&changed, &signature, &public, &manifest.version)
        .err()
        .context("expected signature verification error")?;
    assert!(matches!(error, Error::Signature(_)));
    assert!(
        error
            .source()
            .context("expected signature verification source")?
            .is::<ed25519_dalek::SignatureError>()
    );
    assert!(matches!(
        signed(&vec![b' '; MANIFEST_LIMIT + 1]),
        Err(Error::ManifestBounds)
    ));
    let error = signed(b"not json")
        .err()
        .context("expected manifest JSON error")?;
    assert!(matches!(error, Error::ManifestJson(_)));
    assert!(
        error
            .source()
            .context("expected manifest JSON source")?
            .is::<serde_json::Error>()
    );
    Ok(())
}

#[test]
fn signed_manifest_still_requires_strict_policy() -> anyhow::Result<()> {
    let base = fixture();
    let mut invalid = Vec::new();
    let mut value = base.clone();
    value.schema = 2;
    invalid.push(value);
    let mut value = base.clone();
    value.assets.clear();
    invalid.push(value);
    let mut value = base.clone();
    value.assets.push(value.assets[0].clone());
    invalid.push(value);
    let mut value = base.clone();
    value.assets[0].target = "unknown".into();
    invalid.push(value);
    let mut value = base.clone();
    value.assets[0].name = "../archive".into();
    invalid.push(value);
    let mut value = base.clone();
    value.assets[0].size = ARCHIVE_LIMIT + 1;
    invalid.push(value);
    let mut value = base.clone();
    value.assets[0].size = 0;
    invalid.push(value);
    let mut value = base.clone();
    value.assets[0].sha256 = "A".repeat(64);
    invalid.push(value);
    for manifest in invalid {
        assert!(signed(&serde_json::to_vec(&manifest)?).is_err());
    }
    let mut value = serde_json::to_value(base)?;
    value["extra"] = true.into();
    assert!(signed(&serde_json::to_vec(&value)?).is_err());
    assert!(signed(br#"{"schema":1,"schema":1,"version":"20260920.2","assets":[]}"#).is_err());
    Ok(())
}

#[test]
fn archive_reader_checks_size_digest_and_cancellation() -> anyhow::Result<()> {
    let asset = fixture().assets.remove(0);
    let cancel = AtomicBool::new(false);
    let mut output = Vec::new();
    let mut progress = Vec::new();
    copy_archive(&b"abc"[..], &mut output, &asset, &cancel, |done, total| {
        progress.push((done, total))
    })?;
    assert_eq!(output, b"abc");
    assert_eq!(progress, [(0, 3), (3, 3)]);
    for bytes in [&b"ab"[..], &b"abcd"[..], &b"abd"[..]] {
        assert!(copy_archive(bytes, std::io::sink(), &asset, &cancel, |_, _| {}).is_err());
    }
    assert!(
        copy_archive(&b"abc"[..], std::io::sink(), &asset, &cancel, |_, _| cancel
            .store(true, Ordering::Relaxed))
        .is_err()
    );
    assert!(matches!(
        read_bounded(&b"abc"[..], 3, &cancel),
        Err(Error::Cancelled)
    ));
    cancel.store(false, Ordering::Relaxed);
    assert_eq!(read_bounded(&b"abc"[..], 3, &cancel)?, b"abc");
    assert!(matches!(
        read_bounded(&b"abcd"[..], 3, &cancel),
        Err(Error::ResponseLimit)
    ));
    Ok(())
}

#[test]
fn transport_io_failures_keep_sources_and_do_not_masquerade_as_cancellation() -> anyhow::Result<()>
{
    use std::{error::Error as _, io};

    struct FailedRead;
    impl Read for FailedRead {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::TimedOut))
        }
    }
    struct FailedWrite;
    impl Write for FailedWrite {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::StorageFull))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let cancel = AtomicBool::new(false);
    let error = read_bounded(FailedRead, 3, &cancel)
        .err()
        .context("expected update read error")?;
    assert!(matches!(error, Error::ReadUpdate(_)));
    assert_eq!(
        error
            .source()
            .context("expected update read source")?
            .downcast_ref::<io::Error>()
            .context("expected I/O source")?
            .kind(),
        io::ErrorKind::TimedOut
    );
    let asset = fixture().assets.remove(0);
    let error = copy_archive(FailedRead, io::sink(), &asset, &cancel, |_, _| {})
        .err()
        .context("expected archive read error")?;
    assert!(matches!(error, Error::ReadArchive(_)));
    let error = copy_archive(&b"abc"[..], FailedWrite, &asset, &cancel, |_, _| {})
        .err()
        .context("expected archive write error")?;
    assert!(matches!(error, Error::WriteArchive(_)));
    assert_eq!(
        error
            .source()
            .context("expected archive write source")?
            .downcast_ref::<io::Error>()
            .context("expected I/O source")?
            .kind(),
        io::ErrorKind::StorageFull
    );
    cancel.store(true, Ordering::Relaxed);
    assert!(matches!(
        read_bounded(FailedRead, 3, &cancel),
        Err(Error::Cancelled)
    ));
    Ok(())
}

#[test]
fn redirects_require_exact_https_authorities() {
    for value in [
        LATEST_URL,
        "https://github.com/a",
        "https://release-assets.githubusercontent.com/a?signature=x",
    ] {
        assert!(allowed_url(value));
    }
    for value in [
        "http://github.com/a",
        "https://github.com.evil.test/a",
        "https://github.com@evil.test/a",
        "https://evil@github.com/a",
        "https://github.com:444/a",
        "https://github.com/a#fragment",
        "/relative",
        "https://objects.githubusercontent.com/a",
    ] {
        assert!(!allowed_url(value), "{value}");
    }
}

#[test]
fn release_metadata_rejects_unstable_and_untrusted_names() -> anyhow::Result<()> {
    let value = serde_json::json!({"tag_name":"v20260920.2", "draft":false, "prerelease":false, "assets":[{
        "name":"update-manifest.json", "size":100,
        "browser_download_url":"https://github.com/penso/herdr-gpui/releases/download/v20260920.2/update-manifest.json"
    }]});
    assert_eq!(
        parse_release(&serde_json::to_vec(&value)?)?.version,
        "20260920.2"
    );
    for tag in [
        "20260920.2",
        "vv20260920.2",
        "V20260920.2",
        "v020260920.2",
        "v20260920.2-rc.1",
        "v20260920.01",
    ] {
        let mut bad = value.clone();
        bad["tag_name"] = tag.into();
        assert!(parse_release(&serde_json::to_vec(&bad)?).is_err(), "{tag}");
    }
    for tag in ["20260920.2", "vv20260920.2", "v20260920.1"] {
        let mut bad = value.clone();
        bad["assets"][0]["browser_download_url"] = format!(
            "https://github.com/penso/herdr-gpui/releases/download/{tag}/update-manifest.json"
        )
        .into();
        assert!(matches!(
            parse_release(&serde_json::to_vec(&bad)?),
            Err(Error::ReleaseAsset)
        ));
    }
    for field in ["draft", "prerelease"] {
        let mut bad = value.clone();
        bad[field] = true.into();
        assert!(parse_release(&serde_json::to_vec(&bad)?).is_err());
    }
    for name in ["../escape", "bad/name", "..", "bad%20name"] {
        let mut bad = value.clone();
        bad["assets"][0]["name"] = name.into();
        assert!(parse_release(&serde_json::to_vec(&bad)?).is_err());
    }
    let mut bad = value.clone();
    bad["assets"][0]["browser_download_url"] = "https://evil.test/a".into();
    assert!(parse_release(&serde_json::to_vec(&bad)?).is_err());
    Ok(())
}
