//! WSL distributions on this Windows machine. Each one runs the same POSIX
//! bridge, probe, and session scripts an SSH host does, through `wsl.exe`
//! instead of `ssh`, so a daemon inside a distribution is reached over the
//! child's standard streams. Nothing here installs Herdr, edits a
//! distribution, or boots one the caller did not name.
//!
//! Every `wsl.exe` call is bounded: a distribution waiting on a first-run prompt
//! or a pending update makes `wsl.exe` print nothing and never exit.
use crate::{Error, Result, session_socket};
#[cfg(windows)]
use crate::{
    limits::POLL,
    sessions::{
        RemoteSession, delete_command, delete_script, parse_session_list, session_list_script,
    },
    ssh::{self, ChildGuard, HostProbe},
    transport::Stream,
};
use std::{path::Path, sync::atomic::AtomicBool};
#[cfg(windows)]
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};

/// Docker Desktop's internal distributions run its engine, not a user's shell.
#[cfg(any(windows, test))]
const INTERNAL_PREFIX: &str = "docker-desktop";

/// Whether `name` can be a distribution name: what `wsl --import` accepts. It is
/// also safe as an endpoint ID and as one `wsl.exe` argument.
pub fn valid_distro(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub(crate) fn validate(distro: &str, session: &str) -> Result<()> {
    if !valid_distro(distro) {
        return Err(Error::InvalidWslDistro);
    }
    session_socket(Path::new(""), session).map(drop)
}

/// The user distributions in `wsl.exe --list --quiet` output, default first.
/// `wsl.exe` writes UTF-16LE unless it honors `WSL_UTF8`, which older builds
/// ignore, so either encoding is accepted. Lines that are not distribution
/// names, such as the message printed when none is installed, are dropped.
#[cfg(any(windows, test))]
pub(crate) fn parse_distro_list(output: &[u8]) -> Vec<String> {
    let utf16 = output.starts_with(&[0xff, 0xfe]) || output.get(1) == Some(&0);
    let text = if utf16 {
        let units: Vec<u16> = output
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(output).into_owned()
    };
    let mut distros: Vec<String> = Vec::new();
    for line in text.lines() {
        let name = line
            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0')
            .trim_start_matches('*')
            .trim();
        if valid_distro(name)
            && !name.starts_with(INTERNAL_PREFIX)
            && !distros.iter().any(|known| known == name)
        {
            distros.push(name.to_owned());
        }
    }
    distros
}

/// How long listing distributions may take. Starting the WSL service from cold
/// takes a few seconds; one that takes this long is wedged.
#[cfg(windows)]
const LIST_TIMEOUT: Duration = Duration::from_secs(20);

/// A session listing boots the distribution when it is stopped.
#[cfg(windows)]
const SESSIONS_TIMEOUT: Duration = Duration::from_secs(30);

/// `wsl.exe` from the system directory, never a `PATH` lookup that another
/// program could shadow. No console window opens for it, its own messages are
/// UTF-8, and it starts from a local directory: an inherited working directory
/// on a WSL share that has since disappeared makes the spawn itself fail.
#[cfg(windows)]
fn wsl_exe() -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let system = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut command = Command::new(system.join("System32").join("wsl.exe"));
    command
        .env("WSL_UTF8", "1")
        .current_dir(&system)
        .creation_flags(CREATE_NO_WINDOW);
    command
}

/// `script` under the distribution's `/bin/sh` in the default user's home.
/// `--exec` hands the arguments to the program untouched; without it `wsl.exe`
/// expands `$VARIABLES` in them first, which would rewrite the script.
#[cfg(windows)]
fn command(distro: &str, script: &str) -> Command {
    let mut command = wsl_exe();
    command.args([
        "--distribution",
        distro,
        "--cd",
        "~",
        "--exec",
        "/bin/sh",
        "-c",
        script,
    ]);
    command
}

/// The distributions installed for this user, the default first. Blocks for at
/// most `LIST_TIMEOUT`: call it from a background thread.
#[cfg(windows)]
pub fn list_distros() -> Result<Vec<String>> {
    let mut command = wsl_exe();
    command.args(["--list", "--quiet"]);
    // With no distribution installed, or the WSL feature turned off, `wsl.exe`
    // fails with a message and no names: that is an empty list, not an error.
    let (_, output) = ssh::run(&mut command, LIST_TIMEOUT, || false).map_err(wsl_error)?;
    Ok(parse_distro_list(&output))
}

#[cfg(not(windows))]
pub fn list_distros() -> Result<Vec<String>> {
    Err(Error::WslUnsupported)
}

/// What a distribution offers for `session`, learned without installing,
/// upgrading, or starting anything beyond the distribution itself. Blocks for
/// at most the probe timeout: call it from a background thread.
#[cfg(windows)]
pub fn probe_distro(distro: &str, session: &str) -> Result<HostProbe> {
    validate(distro, session)?;
    let (status, output) = ssh::run(
        &mut command(distro, &ssh::probe_script(session)),
        ssh::PROBE_TIMEOUT,
        || false,
    )
    .map_err(wsl_error)?;
    ssh::classify_probe(&output).ok_or(Error::WslCommand(status))
}

#[cfg(not(windows))]
pub fn probe_distro(distro: &str, session: &str) -> Result<crate::HostProbe> {
    validate(distro, session)?;
    Err(Error::WslUnsupported)
}

/// The sessions a distribution's Herdr owns, as its own CLI lists them. Blocks:
/// call it from a background thread.
#[cfg(windows)]
pub fn list_distro_sessions(distro: &str) -> Result<Vec<RemoteSession>> {
    validate(distro, "default")?;
    let (_, output) = ssh::run(
        &mut command(distro, &session_list_script()),
        SESSIONS_TIMEOUT,
        || false,
    )
    .map_err(wsl_error)?;
    parse_session_list(&output).map_err(wsl_error)
}

#[cfg(not(windows))]
pub fn list_distro_sessions(distro: &str) -> Result<Vec<crate::RemoteSession>> {
    validate(distro, "default")?;
    Err(Error::WslUnsupported)
}

/// Stop and delete a named session inside a distribution after the user
/// confirmed it. Blocks: call it from a background thread.
#[cfg(windows)]
pub fn delete_distro_session(distro: &str, name: &str) -> Result<()> {
    validate(distro, name)?;
    crate::sessions::validate_delete(name)?;
    delete_command(
        command(distro, &delete_script(name)),
        Duration::from_secs(45),
    )
}

#[cfg(not(windows))]
pub fn delete_distro_session(distro: &str, name: &str) -> Result<()> {
    validate(distro, name)?;
    crate::sessions::validate_delete(name)?;
    Err(Error::WslUnsupported)
}

/// Attach to `session` inside `distro` through upstream's remote client bridge,
/// which starts that session's server when it is down, as it does over SSH.
#[cfg(windows)]
pub(crate) fn connect(
    distro: &str,
    session: &str,
    stop: &AtomicBool,
) -> Result<(Stream, ChildGuard)> {
    validate(distro, session)?;
    let mut command = command(distro, &ssh::bridge_script(session));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Distribution diagnostics are unbounded and may carry secrets.
        .stderr(Stdio::null());
    let mut child = ChildGuard(command.spawn()?);
    let (Some(stdin), Some(stdout)) = (child.0.stdin.take(), child.0.stdout.take()) else {
        return Err(Error::WslClosed);
    };
    let mut stream = Stream::from_child(stdin, stdout);
    stream.set_read_timeout(Some(POLL))?;
    ssh::handshake(&mut stream, stop).map_err(wsl_error)?;
    Ok((stream, child))
}

#[cfg(not(windows))]
pub(crate) fn connect(
    distro: &str,
    session: &str,
    _stop: &AtomicBool,
) -> Result<(crate::Stream, crate::ssh::ChildGuard)> {
    validate(distro, session)?;
    Err(Error::WslUnsupported)
}

/// The shared bridge and runner report SSH failures; say WSL instead, since the
/// remedies differ.
#[cfg(windows)]
fn wsl_error(error: Error) -> Error {
    match error {
        Error::SshClosed => Error::WslClosed,
        Error::SshTimeout => Error::WslTimeout,
        other => other,
    }
}

mod catalog;
pub use catalog::{
    WslHost, WslHosts, add_wsl_host, load_wsl_hosts, remove_wsl_host, store_wsl_selection,
};

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
