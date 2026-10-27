//! Blocking installer. Only `RestartGuard::commit` and its drop are UI-safe.
//! The service must retain a committed guard until application teardown.
//! After a committed attempt, `install-result.txt` in the retained private stage
//! records the outcome and recovery instructions. `archive.tar.gz` and any
//! `previous-installation` backup are retained; never blindly overwrite an
//! existing installation with that backup. No startup health ACK is assumed.

use super::error::{Result, UpdateError as Error};
use super::release;
use Error::Io as io;
use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        ffi::OsStringExt,
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

mod apply;
mod archive;
mod location;
mod signing;

pub(super) use apply::run_helper;
#[cfg(test)]
use apply::{record_result, remove_failed_linux_backup, replace};
use archive::extract;
#[cfg(test)]
use archive::{safe_link, safe_path};
use location::{detect, lock, owned};
pub(super) use location::{effective_uid, mac_bundle};
use signing::identity;

const HELPER: &str = "--herdr-apply-update";
const LIMIT: u64 = 1024 * 1024 * 1024;
const REQUEST_LIMIT: u64 = 256 * 1024;
const WAIT: Duration = Duration::from_secs(120);

fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Linux,
    Mac,
}

struct Installation {
    mode: Mode,
    destination: PathBuf,
    executable: PathBuf,
    uid: u32,
}

pub(super) struct Prepared {
    stage: TempDir,
    lease: File,
    installation: Installation,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    current_version: String,
    version: String,
    manifest: Vec<u8>,
    signature: Vec<u8>,
    args: Vec<Vec<u8>>,
    cwd: Vec<u8>,
    token: Vec<u8>,
}

fn private_directory(parent: &Path) -> Result<TempDir> {
    let dir = tempfile::Builder::new()
        .prefix(".herdr-update-")
        .tempdir_in(parent)
        .map_err(io)?;
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).map_err(io)?;
    Ok(dir)
}

// Drain both pipes concurrently, with a hard memory cap and a finite deadline.
fn output(command: &mut Command, cancel: &AtomicBool) -> Result<String> {
    check(cancel)?;
    command
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(io)?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        kill(&mut child);
        return Err(Error::MissingValidationPipes);
    };
    let (sender, receiver) = mpsc::sync_channel(2);
    let pipes: [Box<dyn Read + Send>; 2] = [Box::new(stdout), Box::new(stderr)];
    for pipe in pipes {
        let sender = sender.clone();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take(65537).read_to_end(&mut bytes).map(|_| bytes);
            let _ = sender.send(result);
        });
    }
    drop(sender);
    let start = Instant::now();
    let mut bytes = Vec::new();
    let mut received = 0;
    let result: Result<()> = (|| {
        loop {
            check(cancel)?;
            if start.elapsed() > Duration::from_secs(30) {
                break Err(Error::ValidationTimeout);
            }
            while let Ok(result) = receiver.try_recv() {
                let part = result.map_err(io)?;
                if bytes.len() + part.len() > 65536 {
                    return Err(Error::ValidationOutputLimit);
                }
                bytes.extend_from_slice(&part);
                received += 1;
            }
            match child.try_wait().map_err(io)? {
                Some(status) if !status.success() => {
                    break Err(Error::ValidationFailed(status));
                }
                Some(_) if received == 2 => break Ok(()),
                _ => thread::sleep(Duration::from_millis(10)),
            }
        }
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result?;
    String::from_utf8(bytes).map_err(Error::ValidationEncoding)
}

fn authenticate(request: &Request) -> Result<release::Offer> {
    if request.current_version != crate::APP_VERSION
        || release::parse_version(crate::APP_VERSION).is_none()
        || release::parse_version(&request.version) <= release::parse_version(crate::APP_VERSION)
    {
        return Err(Error::StaleRequest);
    }
    let manifest = release::verify_manifest(
        &request.manifest,
        &request.signature,
        option_env!("HERDR_UPDATE_PUBLIC_KEY").ok_or(Error::LocalBuild)?,
        &request.version,
    )?;
    let asset = manifest
        .assets
        .iter()
        .find(|asset| Some(asset.target.as_str()) == release::target())
        .ok_or(Error::MissingPlatformAsset)?
        .clone();
    Ok(release::Offer {
        manifest,
        asset,
        manifest_bytes: request.manifest.clone(),
        signature: request.signature.clone(),
    })
}

fn candidate(
    stage: &Path,
    installation: &Installation,
    offer: &release::Offer,
    cancel: &AtomicBool,
) -> Result<(TempDir, PathBuf)> {
    let archive = stage.join("archive.tar.gz");
    owned(&archive, installation.uid, false)?;
    release::verify_archive(&archive, &offer.asset, cancel)?;
    let tree = private_directory(stage)?;
    let name = format!(
        "herdr-gpui-{}-{}",
        offer.manifest.version, offer.asset.target
    );
    let path = extract(&archive, tree.path(), installation.mode, &name, cancel)?;
    if installation.mode == Mode::Mac {
        if owned(&path.join("Contents/MacOS/Herdr"), installation.uid, false)?.mode() & 0o111 == 0 {
            return Err(Error::BundleNotExecutable);
        }
        let old = identity(&installation.destination, crate::APP_VERSION, cancel)?;
        if identity(&path, &offer.manifest.version, cancel)? != old {
            return Err(Error::SigningIdentityChanged);
        }
    }
    Ok((tree, path))
}

pub(super) fn prepare(
    offer: &release::Offer,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, u64),
) -> Result<Prepared> {
    check(cancel)?;
    let installation = detect(cancel)?;
    let lease = lock(&installation)?;
    let stage = private_directory(
        installation
            .destination
            .parent()
            .ok_or(Error::MissingInstallationParent)?,
    )?;
    let mut token = vec![0; 32];
    File::open("/dev/urandom")
        .map_err(io)?
        .read_exact(&mut token)
        .map_err(io)?;
    let request = Request {
        current_version: crate::APP_VERSION.into(),
        version: offer.manifest.version.clone(),
        manifest: offer.manifest_bytes.clone(),
        signature: offer.signature.clone(),
        args: env::args_os().skip(1).map(OsString::into_vec).collect(),
        cwd: env::current_dir().map_err(io)?.into_os_string().into_vec(),
        token,
    };
    let authenticated = authenticate(&request)?;
    if authenticated != *offer {
        return Err(Error::UnauthenticatedOffer);
    }
    let bytes = serde_json::to_vec(&request)?;
    if bytes.len() as u64 > REQUEST_LIMIT {
        return Err(Error::RestartArgumentsLimit);
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(stage.path().join("request.json"))
        .map_err(io)?;
    file.write_all(&bytes).map_err(io)?;
    file.sync_all().map_err(io)?;
    release::download(
        &authenticated,
        &stage.path().join("archive.tar.gz"),
        cancel,
        progress,
    )?;
    candidate(stage.path(), &installation, &authenticated, cancel)?;
    check(cancel)?;
    Ok(Prepared {
        stage,
        lease,
        installation,
    })
}

fn read_request(stage: &Path, uid: u32) -> Result<Request> {
    let path = stage.join("request.json");
    owned(&path, uid, false)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(io)?
        .take(REQUEST_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > REQUEST_LIMIT {
        return Err(Error::RequestLimit);
    }
    let request: Request = serde_json::from_slice(&bytes)?;
    if request.token.len() != 32
        || request.args.iter().any(|arg| arg.contains(&0))
        || request.cwd.contains(&0)
    {
        return Err(Error::MalformedRequest);
    }
    Ok(request)
}

enum Control {
    Commit,
    Close,
}

/// Drop only closes a pipe and notifies the background owner. The pipe has one
/// writer and receives at most 39 bytes, so commit cannot fill its buffer.
pub(super) struct RestartGuard {
    control: mpsc::Sender<Control>,
    input: Option<ChildStdin>,
    instruction: Vec<u8>,
    committed: bool,
}

impl RestartGuard {
    /// Call only once the UI has decided to quit. Retain the guard until teardown.
    pub(super) fn commit(&mut self) -> Result<()> {
        if self.committed {
            return Ok(());
        }
        self.input
            .as_mut()
            .ok_or(Error::MissingControlPipe)?
            .write_all(&self.instruction)
            .map_err(io)?;
        self.control
            .send(Control::Commit)
            .map_err(|_| Error::HelperOwnerStopped)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for RestartGuard {
    fn drop(&mut self) {
        drop(self.input.take());
        let _ = self.control.send(Control::Close);
    }
}

fn kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

pub(super) fn install_and_restart(prepared: Prepared, cancel: &AtomicBool) -> Result<RestartGuard> {
    check(cancel)?;
    let request = read_request(prepared.stage.path(), prepared.installation.uid)?;
    let mut child = Command::new(&prepared.installation.executable)
        .arg(HELPER)
        .arg(prepared.stage.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(io)?;
    let Some(stdout) = child.stdout.take() else {
        kill(&mut child);
        return Err(Error::MissingHelperOutput);
    };
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(6).read_to_end(&mut bytes).map(|_| bytes);
        let _ = ready_tx.send(result);
    });
    let start = Instant::now();
    loop {
        if let Err(error) = check(cancel) {
            kill(&mut child);
            return Err(error);
        }
        if start.elapsed() > WAIT {
            kill(&mut child);
            return Err(Error::HelperTimeout);
        }
        match ready_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Ok(bytes)) if bytes == b"READY\n" => break,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Ok(Err(source)) => {
                kill(&mut child);
                return Err(Error::Io(source));
            }
            _ => {
                kill(&mut child);
                return Err(Error::HelperNotReady);
            }
        }
    }
    let mut instruction = b"COMMIT\n".to_vec();
    instruction.extend_from_slice(&request.token);
    let (guard, _owner) = own_helper(prepared, child, instruction);
    Ok(guard)
}

fn own_helper(
    mut prepared: Prepared,
    mut child: Child,
    instruction: Vec<u8>,
) -> (RestartGuard, thread::JoinHandle<()>) {
    // Once the helper is armed, unwinding or process teardown must not remove
    // its input. Cancellation explicitly cleans up only after killing/reaping it.
    prepared.stage.disable_cleanup(true);
    let input = child.stdin.take();
    let (control, receiver) = mpsc::channel();
    let owner = thread::spawn(move || {
        let mut committed = false;
        while let Ok(message) = receiver.recv() {
            match message {
                Control::Commit => committed = true,
                Control::Close => break,
            }
        }
        if !committed {
            kill(&mut child);
            let _ = prepared.stage.close();
            return;
        }
        // If the process exits before this worker runs, OS descriptor teardown
        // still closes the barrier and releases the lease; staging survives.
        let _stage = prepared.stage.keep();
        drop(prepared.lease);
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if start.elapsed() < WAIT => thread::sleep(Duration::from_millis(10)),
                _ => {
                    kill(&mut child);
                    break;
                }
            }
        }
    });
    (
        RestartGuard {
            control,
            input,
            instruction,
            committed: false,
        },
        owner,
    )
}

#[cfg(test)]
mod tests;
