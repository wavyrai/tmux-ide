//! Fixed editor launcher. Runs only on the owner worker after an explicit action;
//! paths never enter a shell, and the short-lived launcher is always reaped.
use super::{EditorTarget, Error, ServerClient};
#[cfg(any(target_os = "macos", all(test, unix)))]
use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
impl ServerClient {
    pub fn open_editor(&self, target: &EditorTarget) -> Result<(), Error> {
        self.assert_current()?;
        #[cfg(target_os = "macos")]
        {
            let deadline = Instant::now() + Duration::from_secs(8);
            let context = self.editor_context(target)?;
            let directory = std::path::Path::new(context.directory());
            if !directory.is_absolute()
                || !std::fs::metadata(directory)
                    .map_err(Error::EditorLaunchIo)?
                    .is_dir()
            {
                return Err(Error::EditorLaunchFailed);
            }
            self.assert_current()?;
            self.daemon.verify_current()?;
            let mut command = Command::new("/usr/bin/open");
            command.arg("-b").arg("com.microsoft.VSCode").arg(directory);
            launch(command, deadline, || self.assert_current())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = target;
            Err(Error::UnsupportedPlatform)
        }
    }
}
#[cfg(any(target_os = "macos", all(test, unix)))]
struct Launcher(Child);
#[cfg(any(target_os = "macos", all(test, unix)))]
impl Drop for Launcher {
    fn drop(&mut self) {
        // This process is /usr/bin/open, never the editor application itself.
        // Kill also covers cancelled/expired requests; wait prevents zombies.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[cfg(any(target_os = "macos", all(test, unix)))]
fn launch(
    mut command: Command,
    deadline: Instant,
    current: impl Fn() -> Result<(), Error>,
) -> Result<(), Error> {
    current()?;
    if Instant::now() >= deadline {
        return Err(Error::EditorLaunchExpired);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = Launcher(command.spawn().map_err(Error::EditorLaunchIo)?);
    loop {
        current()?;
        if Instant::now() >= deadline {
            return Err(Error::EditorLaunchExpired);
        }
        if let Some(status) = child.0.try_wait().map_err(Error::EditorLaunchIo)? {
            current()?;
            return if status.success() {
                Ok(())
            } else {
                Err(Error::EditorLaunchFailed)
            };
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[cfg(all(test, unix))]
#[path = "editor_launch_tests.rs"]
mod tests;
