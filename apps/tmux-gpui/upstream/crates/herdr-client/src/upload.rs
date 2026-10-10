use crate::{Error, Result, catalog::validate_target};
use std::{path::PathBuf, sync::atomic::AtomicBool};

const LINE_LIMIT: usize = 4096;

/// Stage regular files on a POSIX SSH host, preserving each basename.
///
/// Blocking: call only on a background worker, including cancellation/cleanup.
/// Accepts at most 256 paths; symlinks to regular files are followed. Names must
/// be UTF-8 without controls. Progress is cumulative local bytes streamed, not
/// remote durability or daemon acknowledgement. The callback must not block.
/// A successful result contains raw absolute paths (shell-quote before pasting).
/// Nothing is returned on partial failure; owned directories are cleaned up on
/// a best-effort basis, with cleanup errors retained in `Error::UploadCleanup`.
///
/// Files are private temporary files under remote `${TMPDIR:-/tmp}`. They are
/// not daemon-owned and persist after success until user/OS cleanup. This is not
/// a durable backup or a snapshot of concurrently modified local files. Linux
/// and macOS clients only; no new runtime, daemon connection, or UI join.
/// If a successful result is no longer wanted, call [`remove_uploaded_files`]
/// on a background worker using the original target and unchanged result paths.
pub fn upload_files(
    target: &str,
    paths: &[PathBuf],
    cancelled: &AtomicBool,
    progress: impl FnMut(u64, u64),
) -> Result<Vec<String>> {
    validate_target(target)?;
    if paths.len() > 256 {
        return Err(Error::UploadPathLimit);
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        posix::upload(paths, cancelled, progress, |script| {
            crate::ssh::command(target, script)
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (paths, cancelled, progress);
        Err(Error::UploadUnsupported)
    }
}

/// Remove temporary files previously returned by [`upload_files`].
///
/// Blocking: run on a background worker, never on the UI thread. Use the original
/// upload target, not the current UI host, and only unchanged returned paths.
/// This handles successful uploads delivered after cancellation or target loss.
/// Shape validation is not proof of provenance; never pass arbitrary remote
/// paths or assume this API can defend against a malicious remote account.
///
/// Validates the entire batch (at most 256 paths) before spawning SSH. Deletes
/// only each exact file and its empty `herdr-upload.<12 alphanumeric>` directory;
/// never recursively deletes. Missing files/directories are already clean;
/// nonempty directories and symlink staging directories cause failure. Cleanup
/// can partially succeed before an I/O/remote error and may be retried with the
/// same paths. It uses the shared SSH trust policy and a 30-second no-progress
/// timeout, without a cancellation flag. Empty batches do not spawn SSH.
pub fn remove_uploaded_files(target: &str, paths: &[String]) -> Result<()> {
    validate_target(target)?;
    let owned = cleanup_paths(paths)?;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        posix::cleanup(&owned, &mut |script| crate::ssh::command(target, script))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = owned;
        Err(Error::UploadUnsupported)
    }
}

struct StagedUpload {
    directory: String,
    // None until exclusive creation has been acknowledged by the remote.
    file: Option<String>,
}

impl StagedUpload {
    fn validate(&self) -> Result<()> {
        if !valid_directory(&self.directory)
            || self
                .file
                .as_ref()
                .is_some_and(|file| uploaded_directory(file) != Some(self.directory.as_str()))
        {
            return Err(Error::UploadCleanupPath);
        }
        Ok(())
    }
}

fn cleanup_paths(paths: &[String]) -> Result<Vec<StagedUpload>> {
    if paths.len() > 256 {
        return Err(Error::UploadPathLimit);
    }
    paths
        .iter()
        .map(|path| {
            if path.len() > LINE_LIMIT {
                return Err(Error::UploadCleanupPath);
            }
            let (dir, _) = path.rsplit_once('/').ok_or(Error::UploadCleanupPath)?;
            let staged = StagedUpload {
                directory: dir.to_owned(),
                file: Some(path.clone()),
            };
            staged.validate()?;
            Ok(staged)
        })
        .collect()
}

fn uploaded_directory(path: &str) -> Option<&str> {
    if path.len() > LINE_LIMIT || path.chars().any(char::is_control) {
        return None;
    }
    // Split the raw POSIX spelling, not Path::components which normalizes away
    // repeated separators and '.', and has host-specific behavior on Windows.
    let (dir, name) = path.rsplit_once('/')?;
    (valid_directory(dir) && !matches!(name, "" | "." | "..")).then_some(dir)
}

fn valid_directory(dir: &str) -> bool {
    if !dir.starts_with('/') || dir.len() > LINE_LIMIT || dir.chars().any(char::is_control) {
        return false;
    }
    if dir[1..].split('/').any(|s| matches!(s, "" | "." | "..")) {
        return false;
    }
    dir.rsplit('/')
        .next()
        .and_then(|s| s.strip_prefix("herdr-upload."))
        .is_some_and(|s| s.len() == 12 && s.bytes().all(|b| b.is_ascii_alphanumeric()))
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    #[test]
    fn cleanup_rejects_entire_invalid_batches_before_ssh() {
        for path in [
            "",
            "/",
            "/tmp",
            "/tmp/herdr-upload.abcdefghijkl",
            "/tmp/herdr-upload.abcdefghijkl/",
            "/tmp/herdr-upload.abcdefghijkl/.",
            "/tmp/herdr-upload.abcdefghijkl/..",
            "/tmp/herdr-upload.abcdefghijkl/../file",
            "/tmp/../herdr-upload.abcdefghijkl/file",
            "/tmp/./herdr-upload.abcdefghijkl/file",
            "//tmp/herdr-upload.abcdefghijkl/file",
            "/tmp//herdr-upload.abcdefghijkl/file",
            "/tmp/herdr-upload.abcdefghijkl//file",
            "tmp/herdr-upload.abcdefghijkl/file",
            "/tmp/herdr-upload.short/file",
            "/tmp/herdr-upload.abcdefghijk;/file",
            "/tmp/herdr-upload.abcdefghijklm/file",
            "/tmp/herdr-upload.abcdefghijkl/sub/file",
            "/tmp/herdr-upload.abcdefghijkl/file\nother",
            "/tmp/herdr-upload.abcdefghijkl/file\0",
            "/tmp\r/herdr-upload.abcdefghijkl/file",
            "/tmp/herdr-upload.abcdefghijkl/\u{85}",
        ] {
            let paths = vec![
                "/tmp/herdr-upload.123456ABCDEF/valid.iso".into(),
                path.into(),
            ];
            let result = remove_uploaded_files("host", &paths);
            assert!(
                matches!(result, Err(Error::UploadCleanupPath)),
                "{path:?}: {result:?}"
            );
        }
        assert!(matches!(
            remove_uploaded_files(
                "host",
                &[format!(
                    "/tmp/herdr-upload.abcdefghijkl/{}",
                    "x".repeat(LINE_LIMIT)
                )]
            ),
            Err(Error::UploadCleanupPath)
        ));
        assert!(matches!(
            remove_uploaded_files("host", &vec![String::new(); 257]),
            Err(Error::UploadPathLimit)
        ));
        assert!(matches!(
            remove_uploaded_files("-bad", &[]),
            Err(Error::InvalidSshTarget)
        ));
    }

    #[test]
    fn cleanup_accepts_only_raw_generated_path_shape() {
        for path in [
            "/tmp/herdr-upload.abcdefghijkl/file.iso",
            "/herdr-upload.123456ABCDEF/file",
            "/a ' $ x/herdr-upload.123456ABCDEF/-a'$(not-executed); file",
        ] {
            assert!(cleanup_paths(&[path.into()]).is_ok());
        }
        assert!(cleanup_paths(&[]).is_ok());
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod posix {
    use super::*;
    use crate::{
        StorageOperation,
        ssh::{ChildGuard, quote},
    };
    use std::{
        fs::File,
        io::{self, Read, Write},
        net::Shutdown,
        os::{fd::OwnedFd, unix::net::UnixStream},
        process::{Command, Stdio},
        sync::atomic::Ordering,
        thread,
        time::{Duration, Instant},
    };

    const CHUNK: usize = 65536;
    const POLL: Duration = Duration::from_millis(10);
    const IDLE: Duration = Duration::from_secs(30);

    struct Source {
        file: File,
        name: String,
        len: u64,
    }

    fn check(cancelled: &AtomicBool, last: Instant) -> Result<()> {
        if cancelled.load(Ordering::Acquire) {
            return Err(Error::UploadCancelled);
        }
        if last.elapsed() >= IDLE {
            return Err(Error::UploadTimeout);
        }
        Ok(())
    }

    fn prepare(paths: &[PathBuf], cancelled: &AtomicBool) -> Result<(Vec<Source>, u64)> {
        let mut sources = Vec::with_capacity(paths.len());
        for path in paths {
            check(cancelled, Instant::now())?;
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
                .ok_or(Error::UploadName)?;
            // Inspect the opened descriptor, not a racy metadata-before-open.
            // Nonblocking open prevents a FIFO (including a symlink) hanging us.
            let file = File::from(
                rustix::fs::open(
                    path,
                    rustix::fs::OFlags::RDONLY
                        | rustix::fs::OFlags::NONBLOCK
                        | rustix::fs::OFlags::CLOEXEC,
                    rustix::fs::Mode::empty(),
                )
                .map_err(|e| {
                    Error::storage(StorageOperation::Open, path, Error::UploadIo(e.into()))
                })?,
            );
            check(cancelled, Instant::now())?;
            let metadata = file.metadata().map_err(|e| {
                Error::storage(StorageOperation::Metadata, path, Error::UploadIo(e))
            })?;
            if !metadata.is_file() {
                return Err(Error::UploadNotFile);
            }
            sources.push(Source {
                file,
                name: name.to_owned(),
                len: metadata.len(),
            });
        }
        check(cancelled, Instant::now())?;
        let total = total_size(sources.iter().map(|s| s.len))?;
        Ok((sources, total))
    }

    fn total_size(sizes: impl IntoIterator<Item = u64>) -> Result<u64> {
        sizes.into_iter().try_fold(0u64, |total, size| {
            total.checked_add(size).ok_or(Error::UploadSizeOverflow)
        })
    }

    fn receive_command(name: &str, len: u64) -> String {
        shell(&format!(
            r#"umask 077
dir=
file=
complete=0
trap 'if [ "$complete" != 1 ] && [ -n "$dir" ]; then if [ -n "$file" ]; then rm -f -- "$file"; fi; rmdir -- "$dir"; fi' 0
trap 'exit 1' HUP INT TERM
base=$(CDPATH= cd -P -- "${{TMPDIR:-/tmp}}" && pwd -P) || exit 1
dir=$(mktemp -d "${{base%/}}/herdr-upload.XXXXXXXXXXXX") || exit 1
printf 'herdr-upload-ready:1\n%s\n' "$dir" || exit 1
IFS= read -r accept || exit 1
[ "$accept" = accept ] || exit 1
destination="$dir/"{name}
set -C
exec 3> "$destination" || exit 1
file=$destination
printf 'herdr-upload-created:1\n%s\n' "$file" || exit 1
cat >&3 || exit 1
exec 3>&-
bytes=$(wc -c < "$file" | tr -d '[:space:]') || exit 1
[ "$bytes" = {len} ] || exit 1
printf 'herdr-upload-complete:1\n%s\n' "$file" || exit 1
complete=1
"#,
            name = quote(name)
        ))
    }

    fn shell(script: &str) -> String {
        format!("/bin/sh -c {}", quote(script))
    }

    fn spawn(mut command: Command) -> Result<(UnixStream, ChildGuard)> {
        let (stream, child_stream) = UnixStream::pair().map_err(Error::UploadIo)?;
        stream.set_nonblocking(true).map_err(Error::UploadIo)?;
        command
            .stdin(Stdio::from(OwnedFd::from(
                child_stream.try_clone().map_err(Error::UploadIo)?,
            )))
            .stdout(Stdio::from(OwnedFd::from(child_stream)))
            // Remote diagnostics may contain secrets or terminal controls.
            .stderr(Stdio::null());
        let child = ChildGuard(command.spawn().map_err(Error::UploadIo)?);
        Ok((stream, child))
    }

    fn retry(error: &io::Error) -> bool {
        matches!(
            error.kind(),
            io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
        )
    }

    fn line(stream: &mut impl Read, cancelled: &AtomicBool, last: &mut Instant) -> Result<String> {
        let mut bytes = Vec::new();
        loop {
            check(cancelled, *last)?;
            let mut byte = [0];
            match stream.read(&mut byte) {
                Ok(0) => return Err(Error::UploadResponse),
                Ok(_) => {
                    *last = Instant::now();
                    if byte[0] == b'\n' {
                        return String::from_utf8(bytes).map_err(|_| Error::UploadResponse);
                    }
                    if bytes.len() >= LINE_LIMIT {
                        return Err(Error::UploadResponse);
                    }
                    bytes.push(byte[0]);
                }
                Err(e) if retry(&e) => thread::sleep(POLL),
                Err(e) => return Err(Error::UploadIo(e)),
            }
        }
    }

    fn write_bytes(
        writer: &mut impl Write,
        mut bytes: &[u8],
        cancelled: &AtomicBool,
        last: &mut Instant,
        mut written: impl FnMut(u64),
    ) -> Result<()> {
        while !bytes.is_empty() {
            check(cancelled, *last)?;
            match writer.write(bytes) {
                Ok(0) => return Err(Error::UploadIo(io::ErrorKind::WriteZero.into())),
                Ok(n) => {
                    *last = Instant::now();
                    bytes = &bytes[n..];
                    written(n as u64);
                }
                Err(e) if retry(&e) => thread::sleep(POLL),
                Err(e) => return Err(Error::UploadIo(e)),
            }
        }
        Ok(())
    }

    fn copy(
        source: &mut impl Read,
        writer: &mut impl Write,
        len: u64,
        cancelled: &AtomicBool,
        last: &mut Instant,
        mut written: impl FnMut(u64),
    ) -> Result<()> {
        let mut remaining = len;
        let mut buffer = [0u8; CHUNK];
        loop {
            check(cancelled, *last)?;
            let size = remaining.min(CHUNK as u64) as usize;
            // One extra byte detects growth without ever streaming beyond len.
            match source.read(&mut buffer[..size.max(1)]) {
                Ok(0) if remaining == 0 => return Ok(()),
                Ok(0) => return Err(Error::UploadSourceChanged),
                Ok(_) if remaining == 0 => return Err(Error::UploadSourceChanged),
                Ok(n) => {
                    check(cancelled, *last)?;
                    write_bytes(writer, &buffer[..n], cancelled, last, &mut written)?;
                    remaining -= n as u64;
                }
                Err(e) if retry(&e) => thread::sleep(POLL),
                Err(e) => return Err(Error::UploadIo(e)),
            }
        }
    }

    fn finish(
        stream: &mut UnixStream,
        child: &mut ChildGuard,
        cancelled: &AtomicBool,
        last: Instant,
    ) -> Result<()> {
        let mut eof = false;
        loop {
            check(cancelled, last)?;
            let mut byte = [0];
            if !eof {
                match stream.read(&mut byte) {
                    Ok(0) => eof = true,
                    Ok(_) => return Err(Error::UploadResponse),
                    Err(e) if retry(&e) => {}
                    Err(e) => return Err(Error::UploadIo(e)),
                }
            }
            if let Some(status) = child.0.try_wait().map_err(Error::UploadIo)? {
                if !status.success() {
                    return Err(Error::UploadExit { status });
                }
                if eof {
                    return Ok(());
                }
                // The script has exited, so nothing of ours writes any more, and
                // whatever it wrote is already buffered. EOF itself can be held
                // back indefinitely: macOS marks a socket pair close-on-exec only
                // after creating it, so a process another thread spawns in
                // between inherits the child's end and keeps it open.
                return match stream.read(&mut byte) {
                    Ok(0) => Ok(()),
                    Ok(_) => Err(Error::UploadResponse),
                    Err(e) if retry(&e) => Ok(()),
                    Err(e) => Err(Error::UploadIo(e)),
                };
            }
            thread::sleep(POLL);
        }
    }

    pub(super) fn upload(
        paths: &[PathBuf],
        cancelled: &AtomicBool,
        mut progress: impl FnMut(u64, u64),
        mut command: impl FnMut(&str) -> Command,
    ) -> Result<Vec<String>> {
        let (sources, total) = prepare(paths, cancelled)?;
        let mut owned = Vec::new();
        let mut sent = 0;
        progress(0, total);
        let result = (|| {
            let mut paths = Vec::with_capacity(sources.len());
            for mut source in sources {
                check(cancelled, Instant::now())?;
                let mut last = Instant::now();
                let (mut stream, mut child) =
                    spawn(command(&receive_command(&source.name, source.len)))?;
                if line(&mut stream, cancelled, &mut last)? != "herdr-upload-ready:1" {
                    return Err(Error::UploadResponse);
                }
                let dir = line(&mut stream, cancelled, &mut last)?;
                if !valid_directory(&dir) {
                    return Err(Error::UploadResponse);
                }
                let remote = format!("{dir}/{}", source.name);
                let index = owned.len();
                owned.push(StagedUpload {
                    directory: dir,
                    file: None,
                });
                if remote.len() > LINE_LIMIT {
                    return Err(Error::UploadResponse);
                }
                write_bytes(&mut stream, b"accept\n", cancelled, &mut last, |_| {})?;
                if line(&mut stream, cancelled, &mut last)? != "herdr-upload-created:1"
                    || line(&mut stream, cancelled, &mut last)? != remote
                {
                    return Err(Error::UploadResponse);
                }
                // Until both lines arrive, rollback may only remove the empty
                // directory. The remote trap owns its file even if this ACK is lost.
                owned[index].file = Some(remote.clone());
                copy(
                    &mut source.file,
                    &mut stream,
                    source.len,
                    cancelled,
                    &mut last,
                    |n| {
                        sent += n;
                        progress(sent, total);
                    },
                )?;
                check(cancelled, last)?;
                stream.shutdown(Shutdown::Write).map_err(Error::UploadIo)?;
                if line(&mut stream, cancelled, &mut last)? != "herdr-upload-complete:1"
                    || line(&mut stream, cancelled, &mut last)? != remote
                {
                    return Err(Error::UploadResponse);
                }
                finish(&mut stream, &mut child, cancelled, last)?;
                paths.push(remote);
            }
            check(cancelled, Instant::now())?;
            Ok(paths)
        })();
        match result {
            Ok(paths) => Ok(paths),
            Err(source) => {
                if owned.is_empty() {
                    return Err(source);
                }
                // Cancellation stops data immediately, not the rollback. One
                // bounded cleanup child handles the entire batch, never a replay.
                let cleanup = cleanup(&owned, &mut command);
                match cleanup {
                    Ok(()) => Err(source),
                    Err(cleanup) => Err(Error::UploadCleanup {
                        source: Box::new(source),
                        cleanup: Box::new(cleanup),
                    }),
                }
            }
        }
    }

    pub(super) fn cleanup(
        owned: &[StagedUpload],
        command: &mut impl FnMut(&str) -> Command,
    ) -> Result<()> {
        for staged in owned {
            staged.validate()?;
        }
        if owned.is_empty() {
            return Ok(());
        }
        // Stream paths as data, avoiding command-line size limits at 256 files.
        // No recursive deletion: remove only the exact staged basename, then
        // its empty directory. A missing directory is already clean.
        let script = shell(
            r#"failed=0
while IFS= read -r dir; do
    IFS= read -r file || exit 1
    if [ -L "$dir" ]; then
        failed=1
    elif [ -d "$dir" ]; then
        if [ -n "$file" ]; then rm -f -- "$file" || failed=1; fi
        rmdir -- "$dir" || { [ ! -d "$dir" ] || failed=1; }
    elif [ -e "$dir" ]; then
        failed=1
    fi
done
exit "$failed"
"#,
        );
        let mut last = Instant::now();
        let stop = AtomicBool::new(false);
        let (mut stream, mut child) = spawn(command(&script))?;
        for staged in owned {
            write_bytes(
                &mut stream,
                format!(
                    "{}\n{}\n",
                    staged.directory,
                    staged.file.as_deref().unwrap_or("")
                )
                .as_bytes(),
                &stop,
                &mut last,
                |_| {},
            )?;
        }
        stream.shutdown(Shutdown::Write).map_err(Error::UploadIo)?;
        finish(&mut stream, &mut child, &stop, last)
    }

    #[cfg(test)]
    #[allow(clippy::unwrap_used, clippy::expect_used)]
    mod tests {
        include!("upload_tests.rs");
    }
}
