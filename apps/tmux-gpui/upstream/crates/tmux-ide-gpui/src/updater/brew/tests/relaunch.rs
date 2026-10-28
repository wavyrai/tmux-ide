use super::super::{EXECUTABLE, Error as UpdateError, runnable, schedule_relaunch};
use std::{
    ffi::OsString,
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};

const BUNDLE_ID: &str = "so.pen.herdr-gpui.test";

struct Reap(Option<Child>);

impl Drop for Reap {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Stand-ins for the tools the waiter runs. Each appends one whole line per
/// call to `events`, so a reader never needs more than complete lines.
struct Tools {
    root: tempfile::TempDir,
    bundle: PathBuf,
}

impl Tools {
    fn new() -> anyhow::Result<Self> {
        let root = tempfile::tempdir()?;
        let bundle = root.path().join("Applications/Herdr App.app");
        fs::create_dir_all(&bundle)?;
        let bin = root.path().join("bin");
        fs::create_dir(&bin)?;
        let events = root.path().join("events");
        let record = format!("printf '%s\\n' \"$0 $*\" >> '{}'\n", events.display());
        let open_fails = root.path().join("open-fails");
        let running = root.path().join("running");
        let tools = [
            (
                "open",
                format!("{record}[ ! -e '{}' ]\n", open_fails.display()),
            ),
            ("logger", record.clone()),
            ("osascript", record),
            (
                "lsappinfo",
                format!("[ -e '{0}' ] && cat '{0}'\nexit 0\n", running.display()),
            ),
        ];
        for (name, body) in tools {
            let path = bin.join(name);
            fs::write(&path, format!("#!/bin/sh\n{body}"))?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        }
        Ok(Self { root, bundle })
    }

    fn search_path(&self) -> OsString {
        let mut path = self.root.path().join("bin").into_os_string();
        path.push(":/usr/bin:/bin");
        path
    }

    fn schedule(&self, pid: u32, limit: Duration) -> anyhow::Result<()> {
        schedule_relaunch(pid, &self.bundle, BUNDLE_ID, self.search_path(), limit)?;
        Ok(())
    }

    fn tool(&self, name: &str, args: &str) -> String {
        format!(
            "{} {args}",
            self.root.path().join("bin").join(name).display()
        )
    }

    fn logged(&self, message: &str) -> String {
        self.tool("logger", &format!("-t herdr-gpui -- relaunch: {message}"))
    }

    fn opened(&self, flags: &str) -> String {
        self.tool("open", &format!("{flags}-- {}", self.bundle.display()))
    }

    fn alert(&self, message: &str) -> String {
        self.tool(
            "osascript",
            &format!(
                "-e on run argv -e display alert (item 1 of argv) giving up after 300 -e end run {message}"
            ),
        )
    }

    /// Complete lines recorded so far. A line still being written is not one.
    fn events(&self) -> Vec<String> {
        let text = fs::read_to_string(self.root.path().join("events")).unwrap_or_default();
        text.split_inclusive('\n')
            .filter_map(|line| line.strip_suffix('\n'))
            .map(str::to_owned)
            .collect()
    }

    fn wait_for(&self, line: &str) -> anyhow::Result<Vec<String>> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let events = self.events();
            if events.iter().any(|event| event == line) {
                return Ok(events);
            }
            thread::sleep(Duration::from_millis(20));
        }
        anyhow::bail!("timed out waiting for {line:?}; saw {:?}", self.events())
    }
}

fn opens(events: &[String]) -> usize {
    events
        .iter()
        .filter(|event| event.contains("/bin/open "))
        .count()
}

#[test]
fn relaunch_waits_for_the_running_app_then_opens_the_same_bundle() -> anyhow::Result<()> {
    let tools = Tools::new()?;
    let watched = Command::new("/bin/sleep").arg("30").spawn()?;
    let pid = watched.id();
    let mut watched = Reap(Some(watched));
    tools.schedule(pid, Duration::from_secs(600))?;
    tools.wait_for(&tools.logged(&format!("waiting for {pid} to exit")))?;
    thread::sleep(Duration::from_millis(150));
    anyhow::ensure!(
        opens(&tools.events()) == 0,
        "opened while the old instance was still running"
    );
    if let Some(child) = watched.0.as_mut() {
        child.kill()?;
        child.wait()?;
    }
    let events = tools.wait_for(&tools.logged("opened"))?;
    anyhow::ensure!(
        events.contains(&tools.opened("")),
        "expected a plain open, saw {events:?}"
    );
    anyhow::ensure!(opens(&events) == 1, "opened more than once: {events:?}");
    anyhow::ensure!(!events.iter().any(|event| event.contains("osascript")));
    Ok(())
}

#[test]
fn relaunch_alerts_instead_of_opening_when_the_app_never_exits() -> anyhow::Result<()> {
    let tools = Tools::new()?;
    tools.schedule(std::process::id(), Duration::ZERO)?;
    tools.wait_for(&tools.alert(
        "Herdr did not quit in time to restart. Quit Herdr, then open it again to finish the update.",
    ))?;
    thread::sleep(Duration::from_millis(100));
    let events = tools.events();
    anyhow::ensure!(
        events.contains(&tools.logged(&format!("gave up: {} did not exit", std::process::id()))),
        "give-up was not logged: {events:?}"
    );
    anyhow::ensure!(opens(&events) == 0, "gave up by launching anyway");
    Ok(())
}

#[test]
fn relaunch_starts_a_new_instance_when_another_copy_holds_the_bundle_id() -> anyhow::Result<()> {
    let tools = Tools::new()?;
    fs::write(
        tools.root.path().join("running"),
        "ASN:0x0-0x1-\"Herdr\":\n",
    )?;
    let watched = Command::new("/bin/sleep").arg("30").spawn()?;
    let pid = watched.id();
    drop(Reap(Some(watched)));
    tools.schedule(pid, Duration::from_secs(600))?;
    let events = tools.wait_for(&tools.logged("opened -n"))?;
    anyhow::ensure!(
        events.contains(&tools.opened("-n ")),
        "expected open -n, saw {events:?}"
    );
    Ok(())
}

#[test]
fn relaunch_retries_then_alerts_when_open_keeps_failing() -> anyhow::Result<()> {
    let tools = Tools::new()?;
    fs::write(tools.root.path().join("open-fails"), "")?;
    let watched = Command::new("/bin/sleep").arg("30").spawn()?;
    let pid = watched.id();
    drop(Reap(Some(watched)));
    tools.schedule(pid, Duration::from_secs(600))?;
    let events = tools.wait_for(
        &tools.alert("Herdr was updated but could not restart. Open Herdr from Applications."),
    )?;
    anyhow::ensure!(opens(&events) == 3, "expected three attempts: {events:?}");
    anyhow::ensure!(
        events.contains(&tools.logged("open failed")),
        "failure was not logged: {events:?}"
    );
    anyhow::ensure!(!events.contains(&tools.logged("opened")));
    Ok(())
}

#[test]
fn relaunch_refuses_a_bundle_without_a_runnable_executable() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let bundle = root.path().join("Herdr.app");
    let executable = bundle.join(EXECUTABLE);
    fs::create_dir_all(&bundle)?;
    let missing = runnable(&bundle);
    anyhow::ensure!(
        matches!(&missing, Err(UpdateError::RelaunchMissing(path)) if path == &executable),
        "missing executable was accepted: {missing:?}"
    );
    fs::create_dir_all(bundle.join("Contents/MacOS"))?;
    fs::write(&executable, "")?;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o644))?;
    anyhow::ensure!(
        matches!(runnable(&bundle), Err(UpdateError::RelaunchMissing(_))),
        "non-executable file was accepted"
    );
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))?;
    runnable(&bundle)?;
    Ok(())
}
