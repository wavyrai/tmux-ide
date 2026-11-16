use super::*;
use std::{
    io::Read,
    process::{Child, Command, Stdio},
    thread,
};
struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn drain(reader: &mut impl Read, output: &mut Vec<u8>) -> Result<bool, LocalSetupError> {
    let mut bytes = [0; 1024];
    loop {
        match reader.read(&mut bytes) {
            Ok(0) => return Ok(true),
            Ok(n) => {
                if output.len() + n > 4096 {
                    return Err(LocalSetupError::Response);
                }
                output.extend_from_slice(&bytes[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
}
/// Run one command of a setup run. It may use what is left of the run's own
/// deadline and no more: the welcome reads a run that stopped at that deadline
/// as a time-out and anything shorter as "stopped before it answered", so a
/// shorter limit per command (it was 15 s) made a hung `update` the second kind.
/// `now` is the clock the deadline is measured on (tests move it).
pub(super) fn run(
    installation: &LocalSetupInstallation,
    args: &[&str],
    cancel: &AtomicBool,
    deadline: Instant,
    now: &dyn Fn() -> Instant,
) -> Result<Vec<u8>, LocalSetupError> {
    let check = |cancel: &AtomicBool, deadline: Instant| check_at(cancel, deadline, now());
    check(cancel, deadline)?;
    let mut child = Owned(
        Command::new(&installation.node)
            .arg(&installation.cli)
            .args(args)
            .current_dir(&installation.home)
            .env("HOME", &installation.home)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
    );
    let mut stdout = child.0.stdout.take().ok_or(LocalSetupError::Process)?;
    let mut stderr = child.0.stderr.take().ok_or(LocalSetupError::Process)?;
    for fd in [
        &stdout as &dyn std::os::fd::AsFd,
        &stderr as &dyn std::os::fd::AsFd,
    ] {
        let flags = rustix::fs::fcntl_getfl(fd).map_err(std::io::Error::from)?;
        rustix::fs::fcntl_setfl(fd, flags | rustix::fs::OFlags::NONBLOCK)
            .map_err(std::io::Error::from)?;
    }
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let mut status = None;
    loop {
        check(cancel, deadline)?;
        let out_done = drain(&mut stdout, &mut output)?;
        let err_done = drain(&mut stderr, &mut errors)?;
        if status.is_none() {
            status = child.0.try_wait()?;
        }
        if let Some(status) = status {
            if !status.success() {
                return Err(LocalSetupError::Process);
            }
            if out_done && err_done {
                return Ok(output);
            }
        }
        thread::sleep(Duration::from_millis(10).min(deadline.saturating_duration_since(now())));
    }
}
