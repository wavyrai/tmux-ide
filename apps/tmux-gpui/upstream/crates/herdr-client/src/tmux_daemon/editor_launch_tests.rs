#![allow(clippy::unwrap_used)]
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
#[test]
fn retired_or_expired_action_never_starts_launcher() {
    // A missing executable would report IO if it were started.
    let missing = || Command::new("/does-not-exist-native-editor-fixture");
    assert!(matches!(
        launch(missing(), Instant::now() + Duration::from_secs(1), || Err(
            Error::Retired
        )),
        Err(Error::Retired)
    ));
    assert!(matches!(
        launch(missing(), Instant::now(), || Ok(())),
        Err(Error::EditorLaunchExpired)
    ));
}
#[test]
fn failed_launcher_does_not_report_editor_opened() {
    assert!(matches!(
        launch(
            Command::new("/usr/bin/false"),
            Instant::now() + Duration::from_secs(2),
            || Ok(())
        ),
        Err(Error::EditorLaunchFailed)
    ));
    assert!(
        launch(
            Command::new("/usr/bin/true"),
            Instant::now() + Duration::from_secs(2),
            || Ok(())
        )
        .is_ok()
    );
}
#[test]
fn cancellation_reaps_only_the_owned_launcher() {
    let root = super::super::tests::Sandbox::new();
    let pidfile = root.0.join("pid");
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("echo $$ > \"$1\"; exec /bin/sleep 30")
        .arg("fixture")
        .arg(&pidfile);
    let checks = AtomicUsize::new(0);
    let result = launch(command, Instant::now() + Duration::from_secs(3), || {
        checks.fetch_add(1, Ordering::Relaxed);
        if pidfile.exists() {
            Err(Error::Retired)
        } else {
            Ok(())
        }
    });
    assert!(matches!(result, Err(Error::Retired)));
    let pid = std::fs::read_to_string(pidfile).unwrap();
    let status = Command::new("/bin/kill")
        .args(["-0", pid.trim()])
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(
        !status.success(),
        "owned launcher must be reaped before returning"
    );
    assert!(checks.load(Ordering::Relaxed) >= 2);
}

#[test]
fn running_launcher_has_a_deadline() {
    let mut command = Command::new("/bin/sleep");
    command.arg("30");
    assert!(matches!(
        launch(command, Instant::now() + Duration::from_millis(100), || Ok(
            ()
        )),
        Err(Error::EditorLaunchExpired)
    ));
}
