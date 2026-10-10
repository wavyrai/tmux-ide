use super::*;

fn archive(root: &Path, entries: &[(&str, u8, &str)]) -> anyhow::Result<PathBuf> {
    let path = root.join("fixture.tar.gz");
    let encoder = GzEncoder::new(File::create(&path)?, Compression::fast());
    let mut archive = tar::Builder::new(encoder);
    for (path, kind, content) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o755);
        header.set_entry_type(tar::EntryType::new(*kind));
        let bytes = if *kind == b'0' {
            content.as_bytes()
        } else {
            &[]
        };
        header.set_size(bytes.len() as u64);
        if *kind == b'2' || *kind == b'1' {
            header.set_link_name(content)?;
        }
        header.set_cksum();
        archive.append_data(&mut header, path, bytes)?;
    }
    archive.into_inner()?.finish()?;
    Ok(path)
}

#[test]
fn linux_exact_payload_and_cancel() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let source = archive(root.path(), &[("herdr-gpui-test-target", b'0', "binary")])?;
    let out = private_directory(root.path())?;
    let cancel = AtomicBool::new(false);
    let binary = extract(
        &source,
        out.path(),
        Mode::Linux,
        "herdr-gpui-test-target",
        &cancel,
    )?;
    assert_eq!(fs::read(&binary)?, b"binary");
    assert_eq!(fs::metadata(&binary)?.mode() & 0o7777, 0o755);
    assert_eq!(fs::metadata(out.path())?.mode() & 0o7777, 0o700);
    let out = private_directory(root.path())?;
    assert!(extract(&source, out.path(), Mode::Linux, "wrong", &cancel).is_err());
    cancel.store(true, Ordering::Relaxed);
    assert!(
        extract(
            &source,
            out.path(),
            Mode::Linux,
            "herdr-gpui-test-target",
            &cancel
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn mac_links_and_forbidden_entries() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let cancel = AtomicBool::new(false);
    let source = archive(
        root.path(),
        &[
            ("Herdr.app/file", b'0', "ok"),
            ("Herdr.app/link", b'2', "file"),
        ],
    )?;
    let out = private_directory(root.path())?;
    extract(&source, out.path(), Mode::Mac, "unused", &cancel)?;
    assert_eq!(fs::read(out.path().join("Herdr.app/link"))?, b"ok");
    for entries in [
        vec![("Herdr.app/link", b'2', "../../escape")],
        vec![("Herdr.app/file", b'1', "other")],
        vec![("Herdr.app/fifo", b'6', "")],
        vec![("Herdr.app/device", b'3', "")],
        vec![("Herdr.app/file", b'0', "a"), ("Herdr.app/file", b'0', "b")],
        vec![
            ("Herdr.app/link", b'2', "dir"),
            ("Herdr.app/link/file", b'0', "no"),
        ],
        vec![("other/file", b'0', "no")],
    ] {
        let source = archive(root.path(), &entries)?;
        let out = private_directory(root.path())?;
        assert!(
            extract(&source, out.path(), Mode::Mac, "unused", &cancel).is_err(),
            "{entries:?}"
        );
    }
    Ok(())
}

#[test]
fn traversal_and_link_policy() {
    for path in ["/absolute", "../escape", "Herdr.app/../escape", ""] {
        assert!(!safe_path(Path::new(path)));
    }
    assert!(safe_link(
        Path::new("Herdr.app/dir/link"),
        Path::new("../file")
    ));
    assert!(!safe_link(
        Path::new("Herdr.app/link"),
        Path::new("../outside")
    ));
}

#[test]
fn raw_malformed_archives_fail_before_payload_writes() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let cancel = AtomicBool::new(false);
    for (name, size) in [
        ("../escape", 0),
        ("/absolute", 0),
        ("Herdr.app/large", LIMIT + 1),
    ] {
        let mut header = tar::Header::new_ustar();
        header.set_mode(0o700);
        header.set_size(size);
        header.set_entry_type(tar::EntryType::Regular);
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        header.set_cksum();
        let source = root.path().join("bad.tar.gz");
        let mut encoder = GzEncoder::new(File::create(&source)?, Compression::fast());
        encoder.write_all(header.as_bytes())?;
        encoder.finish()?;
        let out = private_directory(root.path())?;
        assert!(extract(&source, out.path(), Mode::Mac, "unused", &cancel).is_err());
        assert_eq!(fs::read_dir(out.path())?.count(), 0);
    }
    Ok(())
}

#[test]
fn digest_is_checked_before_extraction_and_staging_is_private() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let stage = private_directory(root.path())?;
    assert_eq!(fs::metadata(stage.path())?.mode() & 0o777, 0o700);
    fs::write(stage.path().join("archive.tar.gz"), b"bad")?;
    let installation = Installation {
        mode: Mode::Linux,
        destination: root.path().join("app"),
        executable: root.path().join("app"),
        uid: fs::metadata(stage.path())?.uid(),
    };
    let asset = release::Asset {
        target: "x86_64-unknown-linux-gnu".into(),
        name: "unused".into(),
        size: 3,
        sha256: "00".repeat(32),
    };
    let offer = release::Offer {
        manifest: release::Manifest {
            schema: 1,
            version: "20260920.2".into(),
            assets: vec![asset.clone()],
        },
        asset,
        manifest_bytes: vec![],
        signature: vec![],
    };
    assert!(candidate(stage.path(), &installation, &offer, &AtomicBool::new(false)).is_err());
    assert_eq!(fs::read_dir(stage.path())?.count(), 1);
    Ok(())
}

#[test]
fn bundle_distribution_permissions_are_shared_but_staging_stays_private() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let source = root.path().join("permissions.tar.gz");
    let encoder = GzEncoder::new(File::create(&source)?, Compression::fast());
    let mut archive = tar::Builder::new(encoder);
    for (path, kind, mode, bytes) in [
        (
            "Herdr.app",
            tar::EntryType::Directory,
            0o7777,
            b"".as_slice(),
        ),
        (
            "Herdr.app/empty",
            tar::EntryType::Directory,
            0o700,
            b"".as_slice(),
        ),
        (
            "Herdr.app/Contents/MacOS/Herdr",
            tar::EntryType::Regular,
            0o6777,
            b"executable bytes".as_slice(),
        ),
        (
            "Herdr.app/Contents/Resources/config",
            tar::EntryType::Regular,
            0o6666,
            b"resource bytes".as_slice(),
        ),
        (
            "Herdr.app/Contents/Resources/current",
            tar::EntryType::Symlink,
            0o777,
            b"".as_slice(),
        ),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_mode(mode);
        header.set_size(bytes.len() as u64);
        if kind.is_symlink() {
            header.set_link_name("config")?;
        }
        header.set_cksum();
        archive.append_data(&mut header, path, bytes)?;
    }
    archive.into_inner()?.finish()?;
    let stage = private_directory(root.path())?;
    let tree = private_directory(stage.path())?;
    let candidate = extract(
        &source,
        tree.path(),
        Mode::Mac,
        "unused",
        &AtomicBool::new(false),
    )?;
    let installed = root.path().join("Installed.app");
    fs::rename(candidate, &installed)?;
    for path in [
        "",
        "empty",
        "Contents",
        "Contents/MacOS",
        "Contents/Resources",
    ] {
        assert_eq!(
            fs::metadata(installed.join(path))?.mode() & 0o7777,
            0o755,
            "{path}"
        );
    }
    let executable = installed.join("Contents/MacOS/Herdr");
    let resource = installed.join("Contents/Resources/config");
    assert_eq!(fs::metadata(&executable)?.mode() & 0o7777, 0o755);
    assert_eq!(fs::metadata(&resource)?.mode() & 0o7777, 0o644);
    assert_eq!(fs::read(executable)?, b"executable bytes");
    assert_eq!(fs::read(resource)?, b"resource bytes");
    assert_eq!(
        fs::read(installed.join("Contents/Resources/current"))?,
        b"resource bytes"
    );
    for private in [stage.path(), tree.path()] {
        assert_eq!(fs::metadata(private)?.mode() & 0o7777, 0o700);
    }
    Ok(())
}
