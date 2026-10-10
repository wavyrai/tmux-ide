//! The helper process that applies a committed update: it revalidates the
//! stage, waits on the parent's commit barrier, swaps the installation, and
//! records the outcome for manual recovery.
use super::{
    HELPER, Mode, WAIT, authenticate, candidate, io,
    location::{detect, lock_file, no_links, owned},
    read_request,
};
use crate::updater::error::{Result, UpdateError as Error};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, Write},
    os::unix::{
        ffi::OsStringExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    sync::{atomic::AtomicBool, mpsc},
    thread,
    time::{Duration, Instant},
};

pub(super) fn record_result(file: &mut File, result: &Result<()>) -> Result<()> {
    let text = match result {
        Ok(()) => "Update installed and restart process spawned. Startup health is not confirmed.\nKeep previous-installation until the new app is verified working.\n".to_owned(),
        Err(error) => {
            // Bound and escape even filenames/error text; no terminal controls
            // or shell commands from an error are copied into recovery guidance.
            let error: String = error.to_string().chars().flat_map(char::escape_default).take(4096).collect();
            format!("Update installation or restart failed.\nError: {error}\n\nRecovery:\nKeep this private staging directory, archive.tar.gz, and previous-installation (if present).\nClose all Herdr GUI instances; leave the daemon running.\nIf the original installation exists, try launching it manually; rollback may already have restored it.\nIf it is missing, restore previous-installation to the original installation location. Preserve any existing destination before replacing it; do not merge app bundles.\nIf there is no usable backup, manually install a verified signed release.\nNo automatic retry or cleanup will run.\n")
        }
    };
    file.rewind().map_err(io)?;
    file.write_all(text.as_bytes()).map_err(io)?;
    file.set_len(text.len() as u64).map_err(io)?;
    file.sync_all().map_err(io)
}

pub(super) fn replace(
    destination: &Path,
    candidate: &Path,
    backup: &Path,
    mode: Mode,
    launch: impl FnOnce() -> Result<()>,
) -> Result<()> {
    if backup.try_exists().map_err(io)? {
        return Err(Error::RecoveryExists);
    }
    let original = fs::symlink_metadata(destination).map_err(io)?;
    match mode {
        Mode::Linux => fs::hard_link(destination, backup).map_err(io)?,
        Mode::Mac => fs::rename(destination, backup).map_err(io)?,
    }
    if let Err(error) = fs::rename(candidate, destination) {
        if mode == Mode::Mac {
            if let Err(rollback) = fs::rename(backup, destination) {
                return Err(Error::ReplacementRollback {
                    source: error,
                    rollback,
                    backup: backup.to_owned(),
                });
            }
        } else if let Err(cleanup) = remove_failed_linux_backup(destination, backup, &original) {
            return Err(Error::ReplacementCleanup {
                source: error,
                cleanup: Box::new(cleanup),
                backup: backup.to_owned(),
            });
        }
        return Err(io(error));
    }
    if let Err(error) = launch() {
        // Move aside only the exact candidate we just installed; never delete
        // an arbitrary installation tree. Both copies survive failed recovery.
        if let Err(recovery) =
            fs::rename(destination, candidate).and_then(|()| fs::rename(backup, destination))
        {
            return Err(Error::RestartRecovery {
                source: Box::new(error),
                recovery,
                backup: backup.to_owned(),
            });
        }
        return Err(error);
    }
    File::open(
        destination
            .parent()
            .ok_or(Error::MissingDestinationParent)?,
    )
    .map_err(io)?
    .sync_all()
    .map_err(io)
}

pub(super) fn remove_failed_linux_backup(
    destination: &Path,
    backup: &Path,
    original: &fs::Metadata,
) -> Result<()> {
    let current = fs::symlink_metadata(destination).map_err(io)?;
    let saved = fs::symlink_metadata(backup).map_err(io)?;
    // Remove only our extra hardlink, never a changed destination, symlink,
    // or recovery file whose identity no longer matches the original inode.
    if !original.is_file()
        || [&current, &saved].iter().any(|meta| {
            !meta.is_file() || meta.dev() != original.dev() || meta.ino() != original.ino()
        })
    {
        return Err(Error::RecoveryChanged);
    }
    fs::remove_file(backup).map_err(io)
}

/// Pass arguments excluding argv[0], before initializing GPUI. Recognized but
/// malformed helper invocations fail closed rather than starting the GUI.
pub(in crate::updater) fn run_helper(args: &[OsString]) -> Option<ExitCode> {
    if args.first().is_none_or(|arg| arg != HELPER) {
        return None;
    }
    Some(if args.len() == 2 && helper(Path::new(&args[1])).is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn helper(stage: &Path) -> Result<()> {
    let cancel = AtomicBool::new(false);
    let installation = detect(&cancel)?;
    no_links(stage)?;
    if stage.parent() != installation.destination.parent()
        || !stage
            .file_name()
            .is_some_and(|name| name.as_encoded_bytes().starts_with(b".herdr-update-"))
    {
        return Err(Error::StageLocation);
    }
    if owned(stage, installation.uid, true)?.mode() & 0o077 != 0 {
        return Err(Error::StagePermissions);
    }
    let request = read_request(stage, installation.uid)?;
    let offer = authenticate(&request)?;
    let _handoff = lock_file(&installation, ".update-handoff")?;
    candidate(stage, &installation, &offer, &cancel)?;
    // Create once only after stage/request validation. Holding the descriptor
    // avoids following a replaced result path after the GUI has gone away.
    let mut report = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(stage.join("install-result.txt"))
        .map_err(io)?;
    report
        .write_all(b"Helper armed; no committed installation outcome recorded yet.\n")
        .map_err(io)?;
    report.sync_all().map_err(io)?;
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = std::io::stdin()
            .take(40)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    std::io::stdout().write_all(b"READY\n").map_err(io)?;
    std::io::stdout().flush().map_err(io)?;
    let instruction = receiver
        .recv_timeout(WAIT)
        .map_err(Error::CommitBarrier)?
        .map_err(io)?;
    let mut expected = b"COMMIT\n".to_vec();
    expected.extend_from_slice(&request.token);
    if instruction != expected {
        return Err(Error::NotCommitted);
    }
    let result = (|| {
        let start = Instant::now();
        let _lease = loop {
            match lock_file(&installation, ".update-lock") {
                Ok(lease) => break lease,
                Err(Error::LockContended) if start.elapsed() < Duration::from_secs(5) => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(error) => return Err(error),
            }
        };
        let fresh = detect(&cancel)?;
        if fresh.destination != installation.destination {
            return Err(Error::InstallationChanged);
        }
        // Never install the previously inspected tree. Rebuild from the authenticated
        // archive after the parent closes the barrier, then validate again.
        let (tree, candidate) = candidate(stage, &installation, &offer, &cancel)?;
        let backup = stage.join("previous-installation");
        let args: Vec<OsString> = request.args.into_iter().map(OsString::from_vec).collect();
        let cwd = PathBuf::from(OsString::from_vec(request.cwd));
        let result = replace(
            &installation.destination,
            &candidate,
            &backup,
            installation.mode,
            || {
                Command::new(&installation.executable)
                    .args(args)
                    .current_dir(cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(io)?;
                Ok(())
            },
        );
        // Retain failed candidate as well as old installation for manual recovery.
        let _ = tree.keep();
        result
    })();
    let recorded = record_result(&mut report, &result);
    match (result, recorded) {
        (Err(error), Err(record)) => Err(Error::RecordOutcome {
            source: Box::new(error),
            record: Box::new(record),
        }),
        (Err(error), _) => Err(error),
        (Ok(()), recorded) => recorded,
    }
}
