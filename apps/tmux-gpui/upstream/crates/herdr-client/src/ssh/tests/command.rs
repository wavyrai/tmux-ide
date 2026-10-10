use super::*;

#[test]
fn an_application_command_carries_the_same_bridge_handshake() {
    let root = std::env::temp_dir().join(format!("herdr-client-command-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let binary = root.join("herdr");
    crate::test_executable::write(
        &binary,
        r#"#!/bin/sh
if [ "$1" = status ]; then
    printf '%s\n' '{"endpoint_protocol_generation":1,"endpoint_capabilities":["surface_interest","presentation_effects_fence","health_check"]}'
    exit 0
fi
[ "$1" = --session ] && [ "$2" = work ] && [ "$3" = remote-client-bridge ] && [ -z "$4" ] || exit 1
IFS= read -r hello || exit 1
printf '%s\n' "$hello"
"#,
        0o700,
    )
    .unwrap();
    // Stand in for `coder ssh -- <workspace>`: run the appended remote command.
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", r#"eval "$1""#, "sh"])
        .env("PATH", &root)
        .env("HOME", &root);
    let Bridge { mut stream, child } =
        connect_command(command, "work", &AtomicBool::new(false)).unwrap();
    stream.write_all(b"hello\n").unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut response = [0; 6];
    stream.read_exact(&mut response).unwrap();
    assert_eq!(&response, b"hello\n");
    drop(child);
    std::fs::remove_dir_all(root).unwrap();
    assert!(matches!(
        connect_command(Command::new("true"), "../bad", &AtomicBool::new(false)),
        Err(Error::InvalidSession)
    ));
}
