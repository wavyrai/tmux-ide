//! Executable test fixtures written without the Linux `ETXTBSY` race.
//!
//! A sibling test thread that forks while this process holds a fixture open
//! for writing hands its child a copy of that descriptor until the child's own
//! exec, and Linux refuses to run a file that any process has open for
//! writing. Writing from a single-threaded `/bin/sh` child keeps the test
//! process from ever opening the fixture for writing.

use std::{ffi::OsStr, io, os::unix::ffi::OsStrExt, os::unix::fs::PermissionsExt, path::Path};

/// Writes `contents` to `path` from a child shell, then sets `mode`.
pub(crate) fn write(
    path: impl AsRef<Path>,
    contents: impl AsRef<[u8]>,
    mode: u32,
) -> io::Result<()> {
    let path = path.as_ref();
    let status = std::process::Command::new("/bin/sh")
        .args(["-c", "printf '%s' \"$1\" > \"$2\"", "write-test-executable"])
        .arg(OsStr::from_bytes(contents.as_ref()))
        .arg(path)
        .status()?;
    if !status.success() {
        return Err(io::Error::other(format!(
            "writing {} failed: {status}",
            path.display()
        )));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}
