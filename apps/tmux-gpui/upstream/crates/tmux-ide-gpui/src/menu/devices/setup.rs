//! Delegate provisioning to the installed Herdr CLI. A host that already runs
//! a compatible Herdr is saved without a terminal; anything that needs SSH or
//! installation prompts runs in a local workspace, so no remote installer
//! policy is duplicated here.
use crate::{Error, Result};
use herdr_client::{Destination, HostProbe, SavedHost};
use std::{
    collections::BTreeMap,
    io::Read,
    process::{Command, ExitStatus, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

/// `machine add` connects, starts the remote server, and verifies it.
const SAVE_TIMEOUT: Duration = Duration::from_secs(120);
/// Enough for the CLI's final error line without retaining remote output.
const SAVE_STDERR_LIMIT: u64 = 8 * 1024;
/// `machine remove` and `machine rename` edit one local file.
const REMOVE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a claim keeps this process from adding its host again after a
/// terminal setup starts: that setup can take this long to finish its prompts.
const CLAIM_TTL: Duration = Duration::from_secs(15 * 60);

/// Hosts that some window of this process is adding. Herdr's `machine add`
/// neither locks the catalog nor refuses duplicates, so this is what keeps two
/// windows, or two clicks, from adding the same host at once.
static CLAIMS: Mutex<Vec<(Destination, String, Instant)>> = Mutex::new(Vec::new());

/// This process is adding one host and session. Dropping it releases the
/// host, unless `hold` kept it for a terminal setup that is still running.
#[derive(Debug)]
pub(super) struct Claim {
    destination: Destination,
    session: String,
    held: bool,
}

impl Claim {
    fn acquire(destination: Destination, session: &str, now: Instant) -> Result<Self> {
        let mut claims = CLAIMS.lock().unwrap_or_else(|error| error.into_inner());
        claims.retain(|(.., since)| now.duration_since(*since) < CLAIM_TTL);
        if claims.iter().any(|(claimed, claimed_session, _)| {
            *claimed == destination && claimed_session == session
        }) {
            return Err(Error::DeviceAdding);
        }
        claims.push((destination.clone(), session.to_owned(), now));
        Ok(Self {
            destination,
            session: session.to_owned(),
            held: false,
        })
    }

    /// A claim on a host no other test uses, for tests that never resolve SSH.
    #[cfg(test)]
    pub(super) fn fixture(host: &str) -> Self {
        let destination = Destination {
            user: "test".into(),
            host: host.into(),
            port: 22,
        };
        Self::acquire(destination, "default", Instant::now()).unwrap_or(Self {
            destination: Destination {
                user: "test".into(),
                host: host.into(),
                port: 22,
            },
            session: "default".into(),
            held: true,
        })
    }

    /// Keep the host claimed until `CLAIM_TTL`, because the terminal that runs
    /// `machine add` outlives this dialog and cannot report when it finishes.
    pub(super) fn hold(mut self) {
        self.held = true;
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        if self.held {
            return;
        }
        let mut claims = CLAIMS.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(index) = claims.iter().position(|(claimed, session, _)| {
            *claimed == self.destination && *session == self.session
        }) {
            claims.remove(index);
        }
    }
}

/// Resolve the request's host, claim it for this process, then check the
/// catalog on disk. Claiming first means a concurrent add in this process sees
/// the claim even before the catalog changes. Blocks on `ssh -G` and the
/// catalog file: call it from the background executor.
pub(super) fn claim(request: &Request) -> Result<Claim> {
    let destination = herdr_client::resolve_destination(&request.target)?;
    let claim = Claim::acquire(destination, &request.session, Instant::now())?;
    ensure_unsaved(request, &claim, &load_catalog()?, resolve)?;
    Ok(claim)
}

/// Claim a saved host while it is removed, so an add of the same host from
/// this process cannot run at the same time. Blocks on `ssh -G`.
pub(super) fn claim_saved(target: &str, session: &str) -> Result<Claim> {
    let destination = herdr_client::resolve_destination(target)?;
    Claim::acquire(destination, session, Instant::now())
}

/// Forget a saved device with `herdr machine remove`. The CLI only edits the
/// local catalog; it never connects, so the host's own Herdr keeps running.
/// Blocks on a process: call it from the background executor.
pub(super) fn remove(id: &str) -> Result<()> {
    remove_with(crate::daemon::executable().as_os_str(), id)
}

fn remove_with(executable: &std::ffi::OsStr, id: &str) -> Result<()> {
    if !herdr_client::valid_profile_id(id) {
        return Err(Error::DeviceSetupInput("This device has no saved profile."));
    }
    let (status, _, stderr) = run_cli(executable, &["machine", "remove", id], REMOVE_TIMEOUT)?;
    if status.success() {
        return Ok(());
    }
    Err(Error::DeviceRemove {
        status,
        detail: last_line(&stderr),
    })
}

/// Rename a saved device with `herdr machine rename`, which edits only the
/// local catalog. Blocks on a process: call it from the background executor.
pub(super) fn rename(id: &str, label: &str) -> Result<()> {
    rename_with(crate::daemon::executable().as_os_str(), id, label)
}

fn rename_with(executable: &std::ffi::OsStr, id: &str, label: &str) -> Result<()> {
    if !herdr_client::valid_profile_id(id) {
        return Err(Error::DeviceSetupInput("This device has no saved profile."));
    }
    // The `=` form keeps a label that starts with `-` from reading as a flag.
    let (status, _, stderr) = run_cli(
        executable,
        &["machine", "rename", id, &format!("--label={label}")],
        REMOVE_TIMEOUT,
    )?;
    if status.success() {
        return Ok(());
    }
    Err(Error::DeviceRename {
        status,
        detail: last_line(&stderr),
    })
}

/// Check the catalog on disk again, right before a step that saves.
pub(super) fn verify_unsaved(request: &Request, claim: &Claim) -> Result<()> {
    ensure_unsaved(request, claim, &load_catalog()?, resolve)
}

/// Device setup is refused for development catalogs, so this is the catalog
/// `machine add` writes: the terminal command restores the same state root.
fn load_catalog() -> Result<Vec<SavedHost>> {
    Ok(herdr_client::load_saved_hosts(false)?)
}

fn resolve(target: &str) -> Option<Destination> {
    herdr_client::resolve_destination(target).ok()
}

/// The first saved profile, in catalog order, that reaches the claimed host
/// and session. `machine add` appends, so the first one is the oldest.
fn first_saved<'a>(
    request: &Request,
    claim: &Claim,
    hosts: &'a [SavedHost],
    resolve: impl Fn(&str) -> Option<Destination>,
) -> Option<&'a SavedHost> {
    hosts.iter().find(|host| {
        host.session == request.session
            && (host.target == request.target
                || resolve(&host.target).as_ref() == Some(&claim.destination))
    })
}

fn ensure_unsaved(
    request: &Request,
    claim: &Claim,
    hosts: &[SavedHost],
    resolve: impl Fn(&str) -> Option<Destination>,
) -> Result<()> {
    match first_saved(request, claim, hosts, resolve) {
        Some(host) => Err(Error::DeviceExists(host.label.clone())),
        None => Ok(()),
    }
}

/// Herdr caps device labels at this many bytes.
const LABEL_LIMIT: usize = 128;

/// The label a device is saved or renamed with. An empty one names the device
/// after its SSH target as typed, such as `user@host` or an address.
pub(super) fn device_label(label: &str, target: &str) -> Result<String> {
    let label = label.trim();
    let label = if label.is_empty() {
        let target = target.trim();
        let target = target.strip_prefix("ssh://").unwrap_or(target);
        // A long target is shortened on a character boundary to fit.
        let mut end = target.len().min(LABEL_LIMIT);
        while !target.is_char_boundary(end) {
            end -= 1;
        }
        &target[..end]
    } else {
        label
    };
    if label.is_empty() || label.len() > LABEL_LIMIT || label.chars().any(char::is_control) {
        return Err(Error::DeviceSetupInput(
            "Device names are at most 128 bytes, without control characters.",
        ));
    }
    Ok(label.to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Request {
    target: String,
    label: String,
    session: String,
}

impl Request {
    pub(super) fn new(target: &str, label: &str, session: &str) -> Result<Self> {
        let target = target.trim();
        let label = label.trim();
        let session = session.trim();
        if target.is_empty()
            || target.len() > 1024
            || target.starts_with('-')
            || target
                .strip_prefix("ssh://")
                .unwrap_or(target)
                .rsplit_once('@')
                .is_some_and(|(user, _)| user.contains(':'))
            || target.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(Error::DeviceSetupInput(
                "Enter an SSH target such as user@hostname or an SSH alias.",
            ));
        }
        let label = device_label(label, target)?;
        let session = if session.is_empty() {
            "default"
        } else {
            session
        };
        if session.len() > 64
            || matches!(session, "." | "..")
            || !session
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err(Error::DeviceSetupInput(
                "Session names use letters, digits, dots, underscores, or hyphens (at most 64 bytes), excluding '.' and '..'.",
            ));
        }
        Ok(Self {
            target: target.into(),
            label,
            session: session.into(),
        })
    }

    pub(super) fn target(&self) -> &str {
        &self.target
    }

    pub(super) fn label(&self) -> &str {
        &self.label
    }

    /// Whether a saved device connects the same way: Herdr's `machine add` saves
    /// a new profile every time, so the same host would otherwise appear twice.
    pub(super) fn same_host(&self, target: &str, session: &str) -> bool {
        target == self.target && session == self.session
    }

    /// Blocks on SSH: call it from the background executor.
    pub(super) fn probe(&self) -> Result<HostProbe> {
        Ok(herdr_client::probe_host(&self.target, &self.session)?)
    }

    fn arguments(&self) -> [&str; 7] {
        [
            "machine",
            "add",
            &self.target,
            "--label",
            &self.label,
            "--remote-session",
            &self.session,
        ]
    }
}

// The command is typed into a terminal shell.
// Single-quote each argument so labels/SSH aliases never become shell syntax.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Prefix of the workspace variables that carry the GUI's environment to the
/// setup command.
const STAGED_PREFIX: &str = "HERDR_GPUI_SETUP_";

/// What a local workspace needs to run setup interactively.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TerminalSetup {
    /// The line typed into the workspace shell. A shell still in canonical
    /// mode truncates typed input (1024 bytes on macOS), so it never inlines
    /// unbounded values such as `PATH`.
    pub(super) command: String,
    /// Launch environment for the workspace, which the command expands.
    pub(super) environment: BTreeMap<String, String>,
}

fn shell_command(
    executable: &str,
    request: &Request,
    environment: &[(String, String)],
) -> TerminalSetup {
    let mut words = vec![quote("env")];
    // The daemon's shell does not inherit the GUI's environment. Clear
    // optional overrides and the staging variables before restoring this
    // window's exact catalog roots.
    let names = ["HERDR_CONFIG_PATH", "XDG_STATE_HOME", "XDG_CONFIG_HOME"]
        .map(String::from)
        .into_iter()
        .chain(
            environment
                .iter()
                .map(|(key, _)| format!("{STAGED_PREFIX}{key}")),
        );
    for name in names {
        words.extend([quote("-u"), quote(&name)]);
    }
    // Keys are fixed variable names, so the double quotes only expand the
    // staged value, which the shell passes on verbatim.
    words.extend(
        environment
            .iter()
            .map(|(key, _)| format!("\"{key}=${STAGED_PREFIX}{key}\"")),
    );
    words.push(quote(executable));
    words.extend(request.arguments().into_iter().map(quote));
    TerminalSetup {
        command: words.join(" "),
        environment: environment
            .iter()
            .map(|(key, value)| (format!("{STAGED_PREFIX}{key}"), value.clone()))
            .collect(),
    }
}

/// Runs `machine add` without a terminal, for a host whose probe found a
/// compatible Herdr: the CLI starts a stopped server itself. Blocks on SSH, so
/// call it from the background executor. Stdin is closed, so any approval the
/// CLI would need fails instead of waiting for input nobody can see.
pub(super) fn save(request: &Request, claim: &Claim) -> Result<()> {
    save_with(
        crate::daemon::executable(),
        request,
        claim,
        load_catalog,
        resolve,
    )
}

/// The catalog is checked right before `machine add` and again after it. A
/// client outside this process can still save the same host in between,
/// because the CLI takes no lock; if so, the profile saved second is removed.
/// Every client applies that same rule, so exactly one profile survives even
/// when both notice the duplicate.
fn save_with(
    executable: impl AsRef<std::ffi::OsStr>,
    request: &Request,
    claim: &Claim,
    load: impl Fn() -> Result<Vec<SavedHost>>,
    resolve: impl Fn(&str) -> Option<Destination> + Copy,
) -> Result<()> {
    let executable = executable.as_ref();
    ensure_unsaved(request, claim, &load()?, resolve)?;
    let (status, stdout, stderr) = run_cli(executable, &request.arguments(), SAVE_TIMEOUT)?;
    if !status.success() {
        return Err(Error::DeviceSetup {
            status,
            detail: last_line(&stderr),
        });
    }
    // Without the ID the CLI printed, there is no profile known to be ours.
    let Some(id) = saved_id(&stdout) else {
        return Ok(());
    };
    let hosts = load()?;
    match first_saved(request, claim, &hosts, resolve) {
        Some(first) if first.id != id => {
            remove_with(executable, &id)?;
            Err(Error::DeviceExists(first.label.clone()))
        }
        _ => Ok(()),
    }
}

/// The profile ID from `Saved SSH machine <id>. Remote server is ready.`
fn saved_id(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout).lines().find_map(|line| {
        let id = line.strip_prefix("Saved SSH machine ")?.split('.').next()?;
        herdr_client::valid_profile_id(id).then(|| id.to_owned())
    })
}

/// Runs the CLI with closed stdin and a deadline, keeping bounded stdout and
/// stderr.
fn run_cli(
    executable: &std::ffi::OsStr,
    args: &[&str],
    timeout: Duration,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>)> {
    run_bounded(executable, args, timeout, SAVE_STDERR_LIMIT)
}

/// Runs a program with closed stdin and a deadline, keeping at most `limit`
/// bytes of each of stdout and stderr. Both pipes are drained so a chatty
/// program never blocks on a full one. A missed deadline kills the program and
/// returns `DeviceSetupTimeout`. Blocks: call it from the background executor.
pub(super) fn run_bounded(
    executable: &std::ffi::OsStr,
    args: &[&str],
    timeout: Duration,
    limit: u64,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::Builder::new()
            .name("herdr-device-cli".into())
            .spawn(move || {
                let mut output = Vec::new();
                if let Some(mut pipe) = pipe {
                    let _ = (&mut pipe).take(limit).read_to_end(&mut output);
                    let _ = std::io::copy(&mut pipe, &mut std::io::sink());
                }
                output
            })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    )?;
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    )?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::DeviceSetupTimeout);
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    Ok((status, stdout, stderr))
}

/// The CLI ends with its most specific error; earlier lines are progress.
pub(super) fn last_line(output: &[u8]) -> String {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(300)
        .collect()
}

/// The shell command a local workspace runs to set the host up interactively.
pub(super) fn terminal_command(request: &Request) -> Result<TerminalSetup> {
    if cfg!(windows) {
        return Err(Error::DeviceSetupInput(
            "Saved SSH devices are unavailable on Windows.",
        ));
    }
    let executable = crate::daemon::executable();
    let executable = executable.to_str().ok_or(Error::DeviceSetupInput(
        "The Herdr executable path must be UTF-8.",
    ))?;
    let mut environment = Vec::new();
    for key in [
        "HOME",
        "PATH",
        "HERDR_CONFIG_PATH",
        "XDG_STATE_HOME",
        "XDG_CONFIG_HOME",
    ] {
        if let Some(value) = std::env::var_os(key) {
            environment.push((
                key.into(),
                value
                    .into_string()
                    .map_err(|_| Error::DeviceSetupInput("The setup environment must be UTF-8."))?,
            ));
        }
    }
    Ok(shell_command(executable, request, &environment))
}

#[cfg(test)]
mod tests;
