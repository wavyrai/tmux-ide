use super::*;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
    sync::atomic::AtomicU64,
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "herdr-upload-test-{}-{} ' space",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
    fn remote(&self, script: &str) -> Command {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", script]).env("TMPDIR", &self.0);
        cmd
    }
    fn staged(&self) -> Vec<PathBuf> {
        fs::read_dir(&self.0)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("herdr-upload.")
            })
            .collect()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn multi_file_binary_roundtrip_preserves_quoted_names_and_private_permissions() {
    let temp = Temp::new();
    let data: Vec<_> = (0..CHUNK * 3 + 19).map(|i| i as u8).collect();
    let first = temp.file("-a'$(touch INJECTED);`x`.iso", &data);
    let empty = temp.file("empty.txt", &[]);
    let link = temp.0.join("link.iso");
    symlink(&first, &link).unwrap();
    let paths = [first, empty, link];
    let mut progress = Vec::new();
    let result = upload(
        &paths,
        &AtomicBool::new(false),
        |n, total| progress.push((n, total)),
        |s| temp.remote(s),
    )
    .unwrap();
    assert_eq!(result.len(), 3);
    for (i, path) in result.iter().enumerate() {
        assert_eq!(Path::new(path).file_name(), paths[i].file_name());
        assert_eq!(
            fs::read(path).unwrap(),
            if i == 1 { &[][..] } else { &data }
        );
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(Path::new(path).parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    assert_eq!(progress.first(), Some(&(0, 2 * data.len() as u64)));
    assert_eq!(
        progress.last(),
        Some(&(2 * data.len() as u64, 2 * data.len() as u64))
    );
    assert!(progress.windows(2).all(|w| w[0].0 <= w[1].0));
    assert!(!temp.0.join("INJECTED").exists());
}

#[test]
fn public_limits_names_and_descriptor_validation_precede_spawn() {
    let stop = AtomicBool::new(false);
    assert!(matches!(
        upload_files("-bad", &[], &stop, |_, _| {}),
        Err(Error::InvalidSshTarget)
    ));
    assert!(matches!(
        upload_files("host", &vec![PathBuf::new(); 257], &stop, |_, _| {}),
        Err(Error::UploadPathLimit)
    ));
    let temp = Temp::new();
    assert!(matches!(
        prepare(std::slice::from_ref(&temp.0), &stop),
        Err(Error::UploadNotFile)
    ));
    assert!(matches!(
        prepare(&[temp.file("bad\nname", b"x")], &stop),
        Err(Error::UploadName)
    ));
    use std::os::unix::ffi::OsStringExt;
    assert!(matches!(
        prepare(
            &[temp.0.join(std::ffi::OsString::from_vec(vec![255]))],
            &stop
        ),
        Err(Error::UploadName)
    ));
    let fifo = temp.0.join("fifo");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let link = temp.0.join("fifo-link");
    symlink(&fifo, &link).unwrap();
    for path in [fifo, link] {
        assert!(matches!(prepare(&[path], &stop), Err(Error::UploadNotFile)));
    }
    assert!(matches!(
        prepare(&[temp.0.join("missing")], &AtomicBool::new(true)),
        Err(Error::UploadCancelled)
    ));
    let error = prepare(&[temp.0.join("missing")], &stop).err().unwrap();
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
    assert!(std::error::Error::source(&error).is_some());
}

#[test]
fn sparse_larger_than_u32_reports_u64_total_without_loading_it() {
    assert_eq!(total_size([u64::MAX, 0]).unwrap(), u64::MAX);
    assert!(matches!(
        total_size([u64::MAX, 1]),
        Err(Error::UploadSizeOverflow)
    ));
    let temp = Temp::new();
    let path = temp.file("large.iso", &[]);
    let len = u64::from(u32::MAX) + 65537;
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(len)
        .unwrap();
    let stop = AtomicBool::new(false);
    let mut observed = Vec::new();
    let error = upload(
        &[path],
        &stop,
        |sent, total| {
            observed.push((sent, total));
            if sent >= CHUNK as u64 {
                stop.store(true, Ordering::Release);
            }
        },
        |s| temp.remote(s),
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Interrupted);
    assert_eq!(observed[0], (0, len));
    assert!(observed.last().unwrap().0 <= CHUNK as u64);
    assert!(temp.staged().is_empty());
}

#[test]
fn short_and_growing_sources_are_rejected_and_prior_success_is_removed() {
    for grow in [false, true] {
        let temp = Temp::new();
        let first = temp.file("one", b"one");
        let second = temp.file("two", b"two");
        let mut modified = false;
        let error = upload(
            &[first, second.clone()],
            &AtomicBool::new(false),
            |n, _| {
                if n == 3 && !modified {
                    fs::write(&second, if grow { &b"longer"[..] } else { &b""[..] }).unwrap();
                    modified = true;
                }
            },
            |s| temp.remote(s),
        )
        .unwrap_err();
        assert!(matches!(error, Error::UploadSourceChanged));
        assert!(temp.staged().is_empty());
    }
}

#[test]
fn remote_short_receive_trap_removes_file_and_directory() {
    let temp = Temp::new();
    let stop = AtomicBool::new(false);
    let mut last = Instant::now();
    let (mut stream, mut child) = spawn(temp.remote(&receive_command("partial.iso", 100))).unwrap();
    assert_eq!(
        line(&mut stream, &stop, &mut last).unwrap(),
        "herdr-upload-ready:1"
    );
    let dir = line(&mut stream, &stop, &mut last).unwrap();
    write_bytes(&mut stream, b"accept\n", &stop, &mut last, |_| {}).unwrap();
    assert_eq!(
        line(&mut stream, &stop, &mut last).unwrap(),
        "herdr-upload-created:1"
    );
    assert_eq!(
        line(&mut stream, &stop, &mut last).unwrap(),
        format!("{dir}/partial.iso")
    );
    write_bytes(&mut stream, b"short", &stop, &mut last, |_| {}).unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    assert!(matches!(
        finish(&mut stream, &mut child, &stop, last),
        Err(Error::UploadExit { .. })
    ));
    assert!(!Path::new(&dir).exists());
}

#[test]
fn remote_exclusive_create_never_overwrites_an_existing_file() {
    let temp = Temp::new();
    let stop = AtomicBool::new(false);
    let mut last = Instant::now();
    let (mut stream, mut child) = spawn(temp.remote(&receive_command("existing.iso", 0))).unwrap();
    assert_eq!(
        line(&mut stream, &stop, &mut last).unwrap(),
        "herdr-upload-ready:1"
    );
    let dir = line(&mut stream, &stop, &mut last).unwrap();
    let destination = Path::new(&dir).join("existing.iso");
    fs::write(&destination, b"do not overwrite").unwrap();
    write_bytes(&mut stream, b"accept\n", &stop, &mut last, |_| {}).unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    assert!(matches!(
        finish(&mut stream, &mut child, &stop, last),
        Err(Error::UploadExit { .. })
    ));
    assert_eq!(fs::read(destination).unwrap(), b"do not overwrite");
}

#[test]
fn full_upload_collision_rolls_back_prior_success_without_deleting_collision() {
    let temp = Temp::new();
    let bin = temp.0.join("bin");
    fs::create_dir(&bin).unwrap();
    let fake_mktemp = bin.join("mktemp");
    crate::test_executable::write(&fake_mktemp, b"#!/bin/sh\ndir=\"$TMPDIR/herdr-upload.123456ABCDEF\"\nmkdir \"$dir\" || exit 1\nprintf 'keep collision' > \"$dir/collision.iso\"\nprintf '%s\\n' \"$dir\"\n", 0o700).unwrap();
    let mut calls = 0;
    let mut sent = 0;
    let error = upload(
        &[
            temp.file("first", b"first"),
            temp.file("collision.iso", b"must not be sent"),
        ],
        &AtomicBool::new(false),
        |n, _| sent = n,
        |script| {
            calls += 1;
            let mut command = temp.remote(script);
            if calls == 2 {
                command.env("PATH", format!("{}:/usr/bin:/bin", bin.display()));
            }
            command
        },
    )
    .unwrap_err();
    assert!(matches!(error, Error::UploadCleanup { source, cleanup }
        if matches!(*source, Error::UploadResponse) && matches!(*cleanup, Error::UploadExit { .. })));
    assert_eq!(calls, 3, "both uploads and explicit rollback must run");
    assert_eq!(sent, 5, "collision payload must not be streamed");
    let dir = temp.0.join("herdr-upload.123456ABCDEF");
    assert_eq!(temp.staged(), vec![dir.clone()]);
    assert_eq!(
        fs::read(dir.join("collision.iso")).unwrap(),
        b"keep collision"
    );
}

#[test]
fn incomplete_created_ack_never_grants_file_cleanup_ownership() {
    let temp = Temp::new();
    let dir = temp.0.join("herdr-upload.123456ABCDEF");
    fs::create_dir(&dir).unwrap();
    let file = dir.join("file");
    fs::write(&file, b"unacknowledged").unwrap();
    // Simulate lost/truncated acknowledgement and an unavailable remote trap.
    let script = format!(
        "printf 'herdr-upload-ready:1\\n%s\\n' {}; IFS= read -r accept; printf 'herdr-upload-created:1\\n%s' {}",
        quote(dir.to_str().unwrap()),
        quote(file.to_str().unwrap()),
    );
    let mut calls = 0;
    let error = upload(
        &[temp.file("file", b"must not be sent")],
        &AtomicBool::new(false),
        |n, _| assert_eq!(n, 0),
        |command| {
            calls += 1;
            temp.remote(if calls == 1 { &script } else { command })
        },
    )
    .unwrap_err();
    assert!(
        matches!(error, Error::UploadCleanup { source, .. } if matches!(*source, Error::UploadResponse))
    );
    assert_eq!(calls, 2);
    assert_eq!(fs::read(file).unwrap(), b"unacknowledged");
}

#[test]
fn remote_trap_owns_created_file_before_acknowledgement() {
    let temp = Temp::new();
    let stop = AtomicBool::new(false);
    let mut last = Instant::now();
    // Fail immediately after the trap acquires the file, before emitting its ACK.
    let script =
        receive_command("file", 10).replace("file=$destination", "file=$destination\nexit 1");
    let (mut stream, mut child) = spawn(temp.remote(&script)).unwrap();
    assert_eq!(
        line(&mut stream, &stop, &mut last).unwrap(),
        "herdr-upload-ready:1"
    );
    let dir = line(&mut stream, &stop, &mut last).unwrap();
    write_bytes(&mut stream, b"accept\n", &stop, &mut last, |_| {}).unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    assert!(matches!(
        finish(&mut stream, &mut child, &stop, last),
        Err(Error::UploadExit { .. })
    ));
    assert!(!Path::new(&dir).exists());
}

#[test]
fn fake_ssh_requires_exit_success_and_redacts_stderr() {
    let temp = Temp::new();
    let fake = temp.file("fake-ssh", b"#!/bin/sh\nfor arg do remote=$arg; done\n/bin/sh -c \"$remote\"\nprintf 'SECRET\\033[31m' >&2\nexit 17\n");
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    let path = temp.file("one.iso", b"abc");
    let mut calls = 0;
    let error = upload(
        &[path],
        &AtomicBool::new(false),
        |_, _| {},
        |script| {
            calls += 1;
            if calls > 1 {
                return temp.remote(script);
            }
            // Exercise the real policy arguments with an injected executable, not PATH.
            let policy = crate::ssh::command("host", script);
            let mut cmd = Command::new(&fake);
            cmd.args(policy.get_args()).env("TMPDIR", &temp.0);
            cmd
        },
    )
    .unwrap_err();
    assert!(matches!(error, Error::UploadExit { status } if status.code() == Some(17)));
    assert!(!format!("{error:?} {error}").contains("SECRET"));
    assert_eq!(calls, 2);
    assert!(temp.staged().is_empty());
}

#[test]
fn cleanup_failure_retains_primary_error_and_never_returns_partial_paths() {
    let temp = Temp::new();
    let path = temp.file("one", b"abc");
    let stop = AtomicBool::new(false);
    let mut calls = 0;
    let error = upload(
        &[path],
        &stop,
        |n, _| {
            if n > 0 {
                stop.store(true, Ordering::Release);
            }
        },
        |s| {
            calls += 1;
            // Drain the cleanup paths before failing: closing a socket with
            // unread input produces ECONNRESET on Linux instead of an exit error.
            temp.remote(if calls == 1 {
                s
            } else {
                "cat >/dev/null; exit 19"
            })
        },
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Interrupted);
    assert!(matches!(
        error,
        Error::UploadCleanup { source, cleanup }
            if matches!(*source, Error::UploadCancelled)
                && matches!(*cleanup, Error::UploadExit { status } if status.code() == Some(19))
    ));
    assert_eq!(calls, 2);
}

struct ShortWriter {
    bytes: Vec<u8>,
    retry: bool,
}
impl Write for ShortWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.retry {
            self.retry = false;
            return Err(io::ErrorKind::Interrupted.into());
        }
        let n = bytes.len().min(3);
        self.bytes.extend_from_slice(&bytes[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn bounded_copy_handles_partial_writes_errors_and_large_progress_offsets() {
    let mut writer = ShortWriter {
        bytes: vec![],
        retry: true,
    };
    let data = b"0123456789abcdef";
    let mut progress = u64::from(u32::MAX) - 2;
    copy(
        &mut &data[..],
        &mut writer,
        data.len() as u64,
        &AtomicBool::new(false),
        &mut Instant::now(),
        |n| progress += n,
    )
    .unwrap();
    assert_eq!(writer.bytes, data);
    assert_eq!(progress, u64::from(u32::MAX) - 2 + data.len() as u64);
    struct Broken;
    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::ErrorKind::PermissionDenied.into())
        }
    }
    let error = copy(
        &mut Broken,
        &mut io::sink(),
        1,
        &AtomicBool::new(false),
        &mut Instant::now(),
        |_| {},
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(std::error::Error::source(&error).is_some());

    // Exercise the entire >4-GiB copy counter with generated data and a sink;
    // neither endpoint allocates storage proportional to the declared length.
    let len = u64::from(u32::MAX) + CHUNK as u64;
    let mut count = 0u64;
    copy(
        &mut io::repeat(0).take(len),
        &mut io::sink(),
        len,
        &AtomicBool::new(false),
        &mut Instant::now(),
        |n| {
            assert!(n <= CHUNK as u64);
            count += n;
        },
    )
    .unwrap();
    assert_eq!(count, len);
}

#[test]
fn cancellation_and_idle_deadline_are_polled_on_every_loop() {
    let stop = AtomicBool::new(true);
    assert!(matches!(
        write_bytes(&mut io::sink(), b"x", &stop, &mut Instant::now(), |_| {}),
        Err(Error::UploadCancelled)
    ));
    assert!(matches!(
        line(&mut &b"ready\n"[..], &stop, &mut Instant::now()),
        Err(Error::UploadCancelled)
    ));
    assert!(matches!(
        copy(
            &mut &b"x"[..],
            &mut io::sink(),
            1,
            &stop,
            &mut Instant::now(),
            |_| {}
        ),
        Err(Error::UploadCancelled)
    ));
    let mut expired = Instant::now() - IDLE;
    assert!(matches!(
        write_bytes(
            &mut io::sink(),
            b"x",
            &AtomicBool::new(false),
            &mut expired,
            |_| {}
        ),
        Err(Error::UploadTimeout)
    ));
    let mut last = Instant::now() - Duration::from_secs(20);
    write_bytes(
        &mut io::sink(),
        b"x",
        &AtomicBool::new(false),
        &mut last,
        |_| {},
    )
    .unwrap();
    assert!(last.elapsed() < Duration::from_secs(1));
    let temp = Temp::new();
    let (mut stream, mut child) = spawn(temp.remote("exec sleep 60")).unwrap();
    let pid = child.0.id();
    assert!(matches!(
        finish(&mut stream, &mut child, &stop, Instant::now()),
        Err(Error::UploadCancelled)
    ));
    drop(child);
    assert!(
        !Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn response_bounds_and_owned_directory_validation() {
    for dir in [
        "/tmp/herdr-upload.abcdefghijkl",
        "/a ' $ x/herdr-upload.123456ABCDEF",
    ] {
        assert!(valid_directory(dir));
    }
    for dir in [
        "/",
        "relative/herdr-upload.abcdefghijkl",
        "/tmp/../herdr-upload.abcdefghijkl",
        "/tmp//herdr-upload.abcdefghijkl",
        "/tmp/herdr-upload.short",
        "/tmp/herdr-upload.abcdefghijk;",
        "/tmp\n/herdr-upload.abcdefghijkl",
    ] {
        assert!(!valid_directory(dir));
    }
    let stop = AtomicBool::new(false);
    assert!(matches!(
        line(
            &mut &vec![b'x'; LINE_LIMIT + 1][..],
            &stop,
            &mut Instant::now()
        ),
        Err(Error::UploadResponse)
    ));
    assert!(matches!(
        line(&mut &b"\xff\n"[..], &stop, &mut Instant::now()),
        Err(Error::UploadResponse)
    ));
    assert!(matches!(
        line(&mut &b"partial"[..], &stop, &mut Instant::now()),
        Err(Error::UploadResponse)
    ));
    let error = cleanup(
        &[StagedUpload {
            directory: "/tmp/not-owned".into(),
            file: Some("/tmp/not-owned/file".into()),
        }],
        &mut |_| panic!("must not spawn"),
    )
    .unwrap_err();
    assert!(matches!(error, Error::UploadCleanupPath));
}

#[test]
fn rejected_readiness_never_sends_file_bytes_or_attempts_unowned_cleanup() {
    let temp = Temp::new();
    let file = temp.file("secret", b"PRIVATE FILE BYTES");
    let witness = temp.0.join("stdin");
    let script = format!(
        "printf 'herdr-upload-ready:1\\n/tmp/not-owned\\n'; cat > {}",
        quote(witness.to_str().unwrap())
    );
    let mut calls = 0;
    let error = upload(
        &[file],
        &AtomicBool::new(false),
        |_, _| {},
        |_| {
            calls += 1;
            temp.remote(&script)
        },
    )
    .unwrap_err();
    assert!(matches!(error, Error::UploadResponse));
    assert_eq!(calls, 1);
    if witness.exists() {
        assert!(fs::read(witness).unwrap().is_empty());
    }
}

#[test]
fn source_identity_is_pinned_before_progress_callback() {
    let temp = Temp::new();
    let path = temp.file("original", b"original bytes");
    let mut replaced = false;
    let result = upload(
        std::slice::from_ref(&path),
        &AtomicBool::new(false),
        |n, _| {
            if n == 0 && !replaced {
                fs::rename(&path, temp.0.join("old")).unwrap();
                fs::write(&path, b"new bytes").unwrap();
                replaced = true;
            }
        },
        |s| temp.remote(s),
    )
    .unwrap();
    assert_eq!(fs::read(&result[0]).unwrap(), b"original bytes");
}

#[test]
fn cancellation_interrupts_a_backpressured_socket() {
    let (mut writer, mut peer) = UnixStream::pair().unwrap();
    writer.set_nonblocking(true).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    // Fill the socket deterministically; the peer will not consume its backlog.
    loop {
        match writer.write(&[0; CHUNK]) {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
            Err(e) => panic!("{e}"),
        }
    }
    let stop = AtomicBool::new(false);
    thread::scope(|scope| {
        let (started, ready) = std::sync::mpsc::channel();
        let worker = scope.spawn(|| {
            struct SignallingWriter<'a> {
                stream: &'a mut UnixStream,
                started: Option<std::sync::mpsc::Sender<()>>,
            }
            impl Write for SignallingWriter<'_> {
                fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                    let result = self.stream.write(bytes);
                    if let Some(started) = self.started.take() {
                        started.send(()).unwrap();
                    }
                    result
                }
                fn flush(&mut self) -> io::Result<()> {
                    Ok(())
                }
            }
            write_bytes(
                &mut SignallingWriter {
                    stream: &mut writer,
                    started: Some(started),
                },
                b"x",
                &stop,
                &mut Instant::now(),
                |_| panic!("socket must remain full"),
            )
        });
        ready.recv_timeout(Duration::from_secs(3)).unwrap();
        stop.store(true, Ordering::Release);
        assert!(matches!(
            worker.join().unwrap(),
            Err(Error::UploadCancelled)
        ));
    });
    let mut byte = [1];
    peer.read_exact(&mut byte).unwrap();
    assert_eq!(byte, [0]);
}

#[test]
fn cleanup_uses_bounded_command_with_256_quoted_path_pairs() {
    let temp = Temp::new();
    let mut owned = Vec::new();
    for i in 0..256 {
        let dir = temp.0.join(format!("herdr-upload.{i:012}"));
        fs::create_dir(&dir).unwrap();
        let file = dir.join("'$(not-executed); file");
        fs::write(&file, b"x").unwrap();
        owned.push(StagedUpload {
            directory: dir.to_str().unwrap().to_owned(),
            file: Some(file.to_str().unwrap().to_owned()),
        });
    }
    cleanup(&owned, &mut |script| {
        assert!(script.len() < 1024);
        temp.remote(script)
    })
    .unwrap();
    assert!(temp.staged().is_empty());
}

#[test]
fn successful_upload_paths_can_be_cleaned_after_late_cancellation_and_retried() {
    let temp = Temp::new();
    let stop = AtomicBool::new(false);
    let paths = upload(
        &[
            temp.file("-a'$(not-executed); file.iso", b"bytes"),
            temp.file("other", b""),
        ],
        &stop,
        |_, _| {},
        |s| temp.remote(s),
    )
    .unwrap();
    stop.store(true, Ordering::Release);
    for _ in 0..2 {
        cleanup(&cleanup_paths(&paths).unwrap(), &mut |s| temp.remote(s)).unwrap();
        assert!(temp.staged().is_empty());
    }
    assert!(remove_uploaded_files("host", &[]).is_ok());
    cleanup(&[], &mut |_| panic!("empty cleanup must not spawn")).unwrap();
}

#[test]
fn cleanup_never_recursively_removes_unrelated_contents() {
    let temp = Temp::new();
    let paths = upload(
        &[temp.file("file", b"bytes")],
        &AtomicBool::new(false),
        |_, _| {},
        |s| temp.remote(s),
    )
    .unwrap();
    let dir = Path::new(&paths[0]).parent().unwrap();
    let unrelated = dir.join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    fs::write(unrelated.join("keep"), b"keep").unwrap();
    assert!(matches!(
        cleanup(&cleanup_paths(&paths).unwrap(), &mut |s| temp.remote(s)),
        Err(Error::UploadExit { .. })
    ));
    assert!(!Path::new(&paths[0]).exists());
    assert_eq!(fs::read(unrelated.join("keep")).unwrap(), b"keep");
}

#[test]
fn cleanup_refuses_replaced_staging_directory_and_does_not_follow_file_symlinks() {
    let temp = Temp::new();
    let paths = upload(
        &[temp.file("file", b"bytes")],
        &AtomicBool::new(false),
        |_, _| {},
        |s| temp.remote(s),
    )
    .unwrap();
    let dir = Path::new(&paths[0]).parent().unwrap();
    let moved = temp.0.join("moved");
    fs::rename(dir, &moved).unwrap();
    symlink(&moved, dir).unwrap();
    assert!(matches!(
        cleanup(&cleanup_paths(&paths).unwrap(), &mut |s| temp.remote(s)),
        Err(Error::UploadExit { .. })
    ));
    assert_eq!(fs::read(moved.join("file")).unwrap(), b"bytes");
    fs::remove_file(dir).unwrap();
    fs::rename(&moved, dir).unwrap();
    fs::remove_file(&paths[0]).unwrap();
    let outside = temp.file("outside", b"keep");
    symlink(&outside, &paths[0]).unwrap();
    cleanup(&cleanup_paths(&paths).unwrap(), &mut |s| temp.remote(s)).unwrap();
    assert_eq!(fs::read(outside).unwrap(), b"keep");
    assert!(!dir.exists());
}

/// A socket end some unrelated process inherited keeps EOF from ever arriving;
/// the script's own exit, with nothing stray in the buffer, must end the wait.
#[test]
fn an_inherited_socket_end_cannot_hold_a_finished_upload_open() {
    for (script, expected_ok) in [("exit 0", true), ("printf x; exit 0", false)] {
        let (mut stream, child_stream) = UnixStream::pair().unwrap();
        stream.set_nonblocking(true).unwrap();
        let leaked = child_stream.try_clone().unwrap();
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::from(OwnedFd::from(child_stream)))
            .stderr(Stdio::null());
        let mut child = ChildGuard(command.spawn().unwrap());
        let started = Instant::now();
        let result = finish(&mut stream, &mut child, &AtomicBool::new(false), started);
        assert!(started.elapsed() < IDLE / 2, "{script}: waited for EOF");
        if expected_ok {
            result.unwrap();
        } else {
            assert!(matches!(result, Err(Error::UploadResponse)), "{script}");
        }
        drop(leaked);
    }
}
