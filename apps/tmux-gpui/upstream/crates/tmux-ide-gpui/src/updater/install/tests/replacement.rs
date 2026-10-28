use super::*;
use crate::updater::install::location::linux_location;

#[test]
fn replacement_retains_backup_and_rolls_back_on_spawn_failure() -> anyhow::Result<()> {
    for mode in [Mode::Linux, Mode::Mac] {
        for fail in [false, true] {
            let root = tempfile::tempdir()?;
            let destination = root.path().join("installed");
            let candidate = root.path().join("candidate");
            let backup = root.path().join("backup");
            fs::write(&destination, b"old")?;
            fs::write(&candidate, b"new")?;
            let result = replace(&destination, &candidate, &backup, mode, || {
                if fail {
                    Err(io(std::io::Error::other("spawn failed")))
                } else {
                    Ok(())
                }
            });
            assert_eq!(result.is_err(), fail);
            assert_eq!(fs::read(&destination)?, if fail { b"old" } else { b"new" });
            if !fail {
                assert_eq!(fs::read(backup)?, b"old");
            }
        }
    }
    Ok(())
}

#[test]
fn replacement_rename_failure_restores_old() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let destination = root.path().join("installed");
    fs::write(&destination, b"old")?;
    let mut launched = false;
    assert!(
        replace(
            &destination,
            &root.path().join("missing"),
            &root.path().join("backup"),
            Mode::Mac,
            || {
                launched = true;
                Ok(())
            }
        )
        .is_err()
    );
    assert!(!launched, "must not launch");
    assert_eq!(fs::read(destination)?, b"old");
    Ok(())
}

#[test]
fn linux_failed_rename_removes_our_link_and_remains_eligible_for_retry() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let home = root.path().canonicalize()?;
    let destination = home.join("installed");
    let backup = home.join("backup");
    fs::write(&destination, b"old")?;
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o755))?;
    let original = fs::metadata(&destination)?;
    for _ in 0..2 {
        let mut launched = false;
        assert!(
            replace(
                &destination,
                &home.join("missing"),
                &backup,
                Mode::Linux,
                || {
                    launched = true;
                    Ok(())
                }
            )
            .is_err()
        );
        assert!(!launched, "must not launch");
        let current = fs::metadata(&destination)?;
        assert_eq!(current.ino(), original.ino());
        assert_eq!(current.nlink(), 1);
        assert!(!backup.exists());
        linux_location(&destination, &home, original.uid(), false)?;
    }
    let candidate = home.join("candidate");
    fs::write(&candidate, b"new")?;
    replace(&destination, &candidate, &backup, Mode::Linux, || Ok(()))?;
    assert_eq!(fs::read(destination)?, b"new");
    assert_eq!(fs::read(backup)?, b"old");
    Ok(())
}

#[test]
fn failed_linux_backup_cleanup_preserves_changed_paths() -> anyhow::Result<()> {
    for change in ["destination", "backup", "destination-link", "backup-link"] {
        let root = tempfile::tempdir()?;
        let destination = root.path().join("installed");
        let backup = root.path().join("backup");
        fs::write(&destination, b"old")?;
        let original = fs::metadata(&destination)?;
        fs::hard_link(&destination, &backup)?;
        let changed = if change.starts_with("destination") {
            &destination
        } else {
            &backup
        };
        if change.ends_with("-link") {
            fs::remove_file(changed)?;
            let other = if changed == &destination {
                &backup
            } else {
                &destination
            };
            std::os::unix::fs::symlink(other, changed)?;
        } else {
            let different = root.path().join("different");
            fs::write(&different, b"changed")?;
            fs::rename(different, changed)?;
        }
        let saved = fs::symlink_metadata(&backup)?;
        assert!(remove_failed_linux_backup(&destination, &backup, &original).is_err());
        assert_eq!(fs::symlink_metadata(&backup)?.ino(), saved.ino());
    }
    Ok(())
}

#[test]
fn mac_replaces_entire_bundle_and_preserves_recovery() -> anyhow::Result<()> {
    for fail in [false, true] {
        let root = tempfile::tempdir()?;
        let destination = root.path().join("Herdr.app");
        let candidate = root.path().join("candidate.app");
        let backup = root.path().join("previous.app");
        fs::create_dir(&destination)?;
        fs::create_dir(&candidate)?;
        fs::write(destination.join("old-only"), b"old")?;
        fs::write(candidate.join("new-only"), b"new")?;
        assert_eq!(
            replace(&destination, &candidate, &backup, Mode::Mac, || if fail {
                Err(io(std::io::Error::other("launch failed")))
            } else {
                Ok(())
            })
            .is_err(),
            fail
        );
        assert_eq!(destination.join("old-only").exists(), fail);
        assert_eq!(destination.join("new-only").exists(), !fail);
        if !fail {
            assert!(backup.join("old-only").exists());
        }
    }
    Ok(())
}

#[test]
fn real_executable_archive_installs_relaunches_and_rolls_back() -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    for fail in [false, true] {
        let root = tempfile::tempdir()?;
        let parent = root.path().canonicalize()?;
        let destination = parent.join("herdr-gpui");
        fs::copy("/bin/cat", &destination)?;
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o700))?;
        let old = fs::read(&destination)?;
        let uid = fs::metadata(&destination)?.uid();
        linux_location(&destination, &parent, uid, false)?;
        let installation = Installation {
            mode: Mode::Linux,
            destination: destination.clone(),
            executable: destination.clone(),
            uid,
        };
        let stage = private_directory(&parent)?;
        let payload = parent.join("portable-executable");
        let source = parent.join("fixture.c");
        fs::write(
            &source,
            b"#include <stdio.h>\nint main(int argc, char **argv) {\n    if (argc != 2) return 1;\n    return puts(argv[1]) == EOF;\n}\n",
        )?;
        // Build an ordinary relocatable executable. Apple's system binaries
        // can retain platform restrictions even after ad-hoc re-signing.
        output(
            Command::new("/usr/bin/env")
                .arg("PATH=/usr/bin:/bin")
                .arg("/usr/bin/cc")
                .arg(&source)
                .arg("-o")
                .arg(&payload),
            &AtomicBool::new(false),
        )?;
        fs::set_permissions(&payload, fs::Permissions::from_mode(0o700))?;
        let expected_payload = fs::read(&payload)?;
        let archive_path = stage.path().join("archive.tar.gz");
        let encoder = GzEncoder::new(File::create(&archive_path)?, Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        // Match release packaging, without append_file's platform-dependent
        // GNU sparse detection for linker-created executable files.
        let mut header = tar::Header::new_ustar();
        header.set_size(expected_payload.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive.append_data(
            &mut header,
            "herdr-gpui-20260920.2-portable-test",
            expected_payload.as_slice(),
        )?;
        archive.into_inner()?.finish()?;
        let bytes = fs::read(&archive_path)?;
        let asset = release::Asset {
            target: "portable-test".into(),
            name: "fixture.tar.gz".into(),
            size: bytes.len() as u64,
            sha256: Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
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
        let cancel = AtomicBool::new(false);
        // No signing-key bypass in production: this fixture enters below
        // manifest authentication to exercise real hash/extract/swap/exec.
        let (_tree, candidate) = candidate(stage.path(), &installation, &offer, &cancel)?;
        let backup = stage.path().join("previous-installation");
        let result = replace(&destination, &candidate, &backup, Mode::Linux, || {
            let mut command = Command::new(&destination);
            command.arg("restarted successfully");
            if fail {
                command.current_dir(parent.join("missing-directory"));
            }
            let text = output(&mut command, &cancel)?;
            assert_eq!(text, "restarted successfully\n");
            Ok(())
        });
        let mut report = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(stage.path().join("install-result.txt"))?;
        record_result(&mut report, &result)?;
        assert_eq!(result.is_err(), fail, "{result:?}");
        assert_eq!(
            fs::read(&destination)?,
            if fail { old.clone() } else { expected_payload }
        );
        assert!(archive_path.exists());
        if !fail {
            assert_eq!(fs::read(backup)?, old);
        } else {
            assert!(
                fs::read_to_string(stage.path().join("install-result.txt"))?
                    .contains("restart failed")
            );
        }
    }
    Ok(())
}
