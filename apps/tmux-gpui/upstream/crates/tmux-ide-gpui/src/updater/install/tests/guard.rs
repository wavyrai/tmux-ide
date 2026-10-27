use super::*;
use crate::updater::install::location::lock_file;

#[test]
fn process_output_and_cancellation_are_bounded() {
    let cancel = AtomicBool::new(false);
    assert!(matches!(
        output(&mut Command::new("/usr/bin/yes"), &cancel),
        Err(Error::ValidationOutputLimit)
    ));
    cancel.store(true, Ordering::Relaxed);
    assert!(matches!(
        output(Command::new("/bin/sleep").arg("30"), &cancel),
        Err(Error::Cancelled)
    ));
    assert!(run_helper(&[HELPER.into()]).is_some());
    assert!(run_helper(&["--help".into()]).is_none());
}

#[test]
fn lease_and_ownership_checks() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let executable = root.path().canonicalize()?.join("app");
    fs::write(&executable, b"old")?;
    let uid = fs::metadata(&executable)?.uid();
    let installation = Installation {
        mode: Mode::Linux,
        destination: executable.clone(),
        executable: executable.clone(),
        uid,
    };
    let lease = lock(&installation)?;
    assert!(matches!(lock(&installation), Err(Error::LockContended)));
    // Explicit unlock avoids a concurrently spawning test's brief fork/exec
    // window retaining an inherited descriptor after this thread drops it.
    lease.unlock()?;
    drop(lease);
    let next = lock(&installation);
    assert!(next.is_ok(), "{next:?}");
    next?.unlock()?;
    let handoff = lock_file(&installation, ".update-handoff")?;
    assert!(lock(&installation).is_err());
    let helper_lease = lock_file(&installation, ".update-lock")?;
    helper_lease.unlock()?;
    handoff.unlock()?;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o4777))?;
    assert!(owned(&executable, uid, false).is_err());
    Ok(())
}

#[test]
fn guard_keeps_committed_stage_and_reaps_before_cancel_cleanup() -> anyhow::Result<()> {
    for commit in [false, true] {
        let root = tempfile::tempdir()?;
        let parent = root.path().canonicalize()?;
        let stage = private_directory(&parent)?;
        let stage_path = stage.path().to_owned();
        fs::write(stage_path.join("archive.tar.gz"), b"retained archive")?;
        let uid = fs::metadata(&parent)?.uid();
        let installation = Installation {
            mode: Mode::Linux,
            destination: parent.join("app"),
            executable: parent.join("app"),
            uid,
        };
        let lease = lock(&installation)?;
        let transcript = parent.join("control-transcript");
        let child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(File::create(&transcript)?)
            .spawn()?;
        let prepared = Prepared {
            stage,
            lease,
            installation,
        };
        let instruction = [b"COMMIT\n".as_slice(), &[42; 32]].concat();
        let (mut guard, owner) = own_helper(prepared, child, instruction.clone());
        assert!(stage_path.join("archive.tar.gz").exists());
        let committed = (|| -> anyhow::Result<()> {
            if commit {
                guard.commit()?;
                guard.commit()?; // Only one instruction may be sent.
                assert!(stage_path.join("archive.tar.gz").exists());
            }
            Ok(())
        })();
        drop(guard);
        owner
            .join()
            .map_err(|_| anyhow::anyhow!("helper owner thread panicked"))?;
        committed?;
        assert_eq!(stage_path.exists(), commit);
        if commit {
            assert_eq!(
                fs::read(stage_path.join("archive.tar.gz"))?,
                b"retained archive"
            );
            assert_eq!(fs::read(transcript)?, instruction);
        }
    }
    Ok(())
}

#[test]
fn result_marker_is_bounded_and_uses_the_preopened_file() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let stage = private_directory(root.path())?;
    let path = stage.path().join("install-result.txt");
    let mut report = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    let held_path = stage.path().join("held-result.txt");
    fs::rename(&path, &held_path)?;
    let outside = root.path().join("do-not-touch");
    fs::write(&outside, b"unchanged")?;
    std::os::unix::fs::symlink(&outside, &path)?;
    record_result(
        &mut report,
        &Err(io(std::io::Error::other("\x1b[31m unsafe\n".repeat(4096)))),
    )?;
    let text = fs::read_to_string(&held_path)?;
    assert!(text.len() < 8192);
    assert!(!text.contains('\x1b'));
    assert!(text.contains("previous-installation"));
    assert!(text.contains("manually install a verified signed release"));
    assert_eq!(fs::metadata(&held_path)?.mode() & 0o777, 0o600);
    assert_eq!(fs::read(&outside)?, b"unchanged");
    record_result(&mut report, &Ok(()))?;
    let text = fs::read_to_string(&held_path)?;
    assert!(text.starts_with("Update installed"));
    assert!(!text.contains("Recovery:"));
    Ok(())
}

#[test]
fn argument_bytes_and_guard_decision_are_lossless() -> anyhow::Result<()> {
    let raw = vec![b'a', 0xff, b' '];
    let encoded = serde_json::to_vec(&vec![OsString::from_vec(raw.clone()).into_vec()])?;
    let decoded: Vec<Vec<u8>> = serde_json::from_slice(&encoded)?;
    assert_eq!(OsString::from_vec(decoded[0].clone()).into_vec(), raw);
    let (control, receiver) = mpsc::channel();
    drop(RestartGuard {
        control,
        input: None,
        instruction: vec![],
        committed: false,
    });
    assert!(matches!(receiver.recv()?, Control::Close));
    let (control, receiver) = mpsc::channel();
    let mut child = Command::new("/bin/cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()?;
    let mut guard = RestartGuard {
        control,
        input: child.stdin.take(),
        instruction: b"COMMIT\n".to_vec(),
        committed: false,
    };
    guard.commit()?;
    // COMMIT alone must not release the EOF barrier.
    assert!(child.try_wait()?.is_none());
    drop(guard);
    assert!(matches!(receiver.recv()?, Control::Commit));
    assert!(matches!(receiver.recv()?, Control::Close));
    assert!(child.wait()?.success());
    Ok(())
}
