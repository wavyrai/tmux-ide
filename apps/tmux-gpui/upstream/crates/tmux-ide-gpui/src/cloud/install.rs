//! Checking for, and on explicit approval installing, Herdr on a cloud
//! machine the user just created or attached. This is the one place the GUI
//! installs anything remotely: it runs Herdr's published installer, which
//! verifies the release checksum, through the provider's remote command (such
//! as `coder ssh`). Background reconnects never call it. Output is bounded and
//! kept only for the failure message.

use super::{Error, Result};
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const OUTPUT_LIMIT: usize = 8 * 1024;
const TAIL_LINES: usize = 6;
/// The installer script's exit code when the workspace has no `curl`.
const NO_CURL: i32 = 4;

/// Same search as the connection bridge, so "installed" means "the bridge
/// will find it". Paths stay in shell variables; nothing discovered is eval'd.
const PROBE: &str = r#"candidate=$(command -v herdr 2>/dev/null || :)
case "$candidate" in /*/mise/shims/herdr) candidate=;; /*) ;; *) candidate=;; esac
for path in "$candidate" "$HOME/.local/bin/herdr" /opt/homebrew/bin/herdr /usr/local/bin/herdr /home/linuxbrew/.linuxbrew/bin/herdr "$HOME/.nix-profile/bin/herdr" "/etc/profiles/per-user/$USER/bin/herdr" /nix/var/nix/profiles/default/bin/herdr /run/current-system/sw/bin/herdr; do
    if [ -n "$path" ] && [ -x "$path" ]; then exit 0; fi
done
exit 3"#;

const INSTALL: &str = r#"command -v curl >/dev/null 2>&1 || { echo "curl is required to install Herdr" >&2; exit 4; }
curl -fsSL https://herdr.dev/install.sh | sh"#;

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remote(script: &str) -> String {
    format!("/bin/sh -c {}", quote(script))
}

struct Finished {
    code: Option<i32>,
    output: String,
}

/// Keep the last `OUTPUT_LIMIT` bytes a pipe produced, draining it to EOF so
/// a chatty child can never block on a full pipe.
fn drain(
    mut pipe: impl Read + Send + 'static,
    into: Arc<Mutex<Vec<u8>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0; 4096];
        while let Ok(read) = pipe.read(&mut chunk) {
            if read == 0 {
                break;
            }
            let mut tail = into.lock().unwrap_or_else(|error| error.into_inner());
            tail.extend_from_slice(&chunk[..read]);
            let excess = tail.len().saturating_sub(OUTPUT_LIMIT);
            tail.drain(..excess);
        }
    })
}

fn run(mut command: Command, timeout: Duration, cancelled: &impl Fn() -> bool) -> Result<Finished> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(Error::Process)?;
    let output = Arc::new(Mutex::new(Vec::new()));
    let readers = [
        child.stdout.take().map(|pipe| drain(pipe, output.clone())),
        child.stderr.take().map(|pipe| drain(pipe, output.clone())),
    ];
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(Error::Process)? {
            break Ok(status);
        }
        if cancelled() {
            break Err(Error::Cancelled);
        }
        if Instant::now() >= deadline {
            break Err(Error::InstallTimeout);
        }
        thread::sleep(Duration::from_millis(100));
    };
    let status = match status {
        Ok(status) => status,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            // A grandchild may still hold the pipes open; the readers end
            // when it does, and their output is not needed here, so waiting
            // for them would stall cancellation on that process's lifetime.
            return Err(error);
        }
    };
    for reader in readers.into_iter().flatten() {
        let _ = reader.join();
    }
    let bytes = output.lock().unwrap_or_else(|error| error.into_inner());
    Ok(Finished {
        code: status.code(),
        output: tail(&bytes),
    })
}

/// The last few printable lines, for a failure message a person can act on.
fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            // Drop terminal escapes and other controls from untrusted output.
            let mut clean = String::with_capacity(line.len());
            let mut escape = false;
            for c in line.chars() {
                match c {
                    '\u{1b}' => escape = true,
                    c if escape => escape = !c.is_ascii_alphabetic(),
                    c if c.is_control() => {}
                    c => clean.push(c),
                }
            }
            clean.trim().to_owned()
        })
        .filter(|line| !line.is_empty())
        .collect();
    lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n")
}

/// Whether the machine already has a Herdr the bridge can run. `ssh` is the
/// provider's remote command, such as `coder ssh … <workspace>`; the probe is
/// appended.
pub(crate) fn installed(mut ssh: Command, cancelled: &impl Fn() -> bool) -> Result<bool> {
    ssh.arg(remote(PROBE));
    let finished = run(ssh, PROBE_TIMEOUT, cancelled)?;
    match finished.code {
        Some(0) => Ok(true),
        Some(3) => Ok(false),
        _ => Err(Error::Install(if finished.output.is_empty() {
            "the remote command could not reach the machine".into()
        } else {
            finished.output
        })),
    }
}

/// Run Herdr's installer on the machine. Only called after the user approved it.
pub(crate) fn install(mut ssh: Command, cancelled: &impl Fn() -> bool) -> Result<()> {
    tracing::info!(
        category = "cloud_install",
        "Installing Herdr on a cloud machine"
    );
    ssh.arg(remote(INSTALL));
    let finished = run(ssh, INSTALL_TIMEOUT, cancelled)?;
    match finished.code {
        Some(0) => Ok(()),
        Some(NO_CURL) => Err(Error::Install(
            "the machine has no curl; add it to its image or install Herdr there manually".into(),
        )),
        _ => Err(Error::Install(if finished.output.is_empty() {
            "the installer did not finish".into()
        } else {
            finished.output
        })),
    }
}

#[cfg(all(test, unix))]
mod tests;
