use super::*;

#[test]
fn timeout_kills_shell_and_descendant_group() {
    let (dir, path) = shell("/bin/sleep 60 &\nprintf '%s %s' \"$$\" \"$!\" > \"$0.pids\"\nwait");
    let (reader, writer) = UnixStream::pair().unwrap();
    reader.set_nonblocking(true).unwrap();
    let child = Command::new(path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .process_group(0)
        .spawn()
        .unwrap();
    // Shell startup can exceed the timeout under parallel test load. Observe the
    // actual descendant before exercising the same collection/cleanup as capture.
    let ready = Instant::now() + Duration::from_secs(10);
    let pids = loop {
        if let Ok(text) = std::fs::read_to_string(dir.path().join("shell.pids"))
            && text.split_whitespace().count() == 2
        {
            break Some(text);
        }
        if Instant::now() >= ready {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let result = collect(
        child,
        reader,
        b"START",
        b"END",
        Duration::from_millis(50),
        LIMIT,
    );
    assert!(matches!(result, Err(ProbeError::Timeout)));
    let pids = pids.expect("fixture shell must start before timeout cleanup is tested");
    for pid in pids.split_whitespace() {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let output = Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", pid])
                .output()
                .unwrap();
            let state = String::from_utf8(output.stdout).unwrap();
            if state.trim().is_empty() || state.trim().starts_with('Z') {
                break;
            }
            assert!(Instant::now() < deadline, "process {pid} survived: {state}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
