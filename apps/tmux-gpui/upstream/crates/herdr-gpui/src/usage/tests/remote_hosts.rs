use super::*;
use crate::usage::probe::{HostPath, Request, Shell};

/// A local `sh` standing in for the remote host: its home holds agent
/// sign-ins, and a fake `curl` on its PATH records what it was given.
struct FakeHost {
    root: tempfile::TempDir,
}

impl FakeHost {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(
            home.join(".codex/auth.json"),
            "{\n  \"tokens\": {\n    \"id_token\": \"id-fixture\",\n    \"access_token\": \"codex-fixture-token\",\n    \"account_id\": \"acct-fixture\"\n  }\n}\n",
        )
        .unwrap();
        let log = root.path().join("log");
        // Records its arguments and the -K config it read from fd 3, then
        // answers a fixed body; `-w` output is emulated.
        crate::test_executable::write(
            bin.join("curl"),
            format!(
                "#!/bin/sh\nprintf 'args: %s\\n' \"$*\" >> '{log}'\ncat <&3 >> '{log}'\nprintf '{{\"token\":\"minted-secret\",\"ok\":true}}'\ncase \"$*\" in *herdr-status*) printf '\\n@@herdr-status 200';; esac\n",
                log = log.display()
            ),
            0o755,
        )
        .unwrap();
        Self { root }
    }

    fn shell(&self) -> Shell {
        let mut command = std::process::Command::new("/bin/sh");
        command
            .arg("-s")
            .env_clear()
            .env("HOME", self.root.path().join("home"))
            .env("PATH", "/usr/bin:/bin")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        Shell::start(command).unwrap()
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.root.path().join("log")).unwrap_or_default()
    }
}

#[test]
fn remote_secrets_stay_on_the_host() {
    let host = FakeHost::new();
    let mut exec = Exec::Remote(host.shell());
    let mut jar = CookieJar::default();
    let codex = provider("codex");
    let mut probe = Probe::new(&mut exec, codex, None, &mut jar, Consent::Quiet);
    assert!(probe.is_remote());
    let auth = probe
        .file(&HostPath::env_or("CODEX_HOME", ".codex", "auth.json"))
        .unwrap();
    assert!(format!("{auth:?}").contains("remote"));
    let token = probe.field(&auth, &["tokens", "access_token"]).unwrap();
    assert_eq!(
        probe.text(&auth, &["tokens", "account_id"]).as_deref(),
        Some("acct-fixture")
    );
    assert!(probe.file(&HostPath::home("missing.json")).is_none());
    assert!(probe.exists(&HostPath::home(".codex")));
    assert!(!probe.exists(&HostPath::home("nowhere")));

    let response = probe
        .http(
            Request::post("https://example.com/usage?q=a+b")
                .bearer(&token)
                .header("X-Plain", "it's $HOME `x` \\ \"q\"")
                .json("{\"k\":\"v\"}"),
        )
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body, "{\"token\":\"minted-secret\",\"ok\":true}");

    let minted = probe
        .exchange(
            Request::get("https://example.com/mint").bearer(&token),
            &["token"],
        )
        .unwrap();
    assert!(format!("{minted:?}").contains("remote"));
    probe
        .http(Request::get("https://example.com/next").bearer(&minted))
        .unwrap();

    let log = host.log();
    for line in log.lines().filter(|line| line.starts_with("args: ")) {
        assert!(
            !line.contains("fixture") && !line.contains("minted"),
            "{line}"
        );
    }
    assert!(log.contains("header = \"Authorization: Bearer codex-fixture-token\""));
    assert!(log.contains("header = \"Authorization: Bearer minted-secret\""));
    // Literal text survives both the shell and curl's config quoting.
    assert!(
        log.contains(r#"header = "X-Plain: it's $HOME `x` \\ \"q\"""#),
        "{log}"
    );
    assert!(log.contains(r#"data-raw = "{\"k\":\"v\"}""#), "{log}");
    assert!(log.contains("request = \"POST\""));
    assert!(!log.contains("id-fixture"));
}

#[test]
fn remote_steps_report_failure_and_keep_the_session() {
    let host = FakeHost::new();
    let mut shell = host.shell();
    let output = shell
        .run("printf 'a\\nb'; false", Duration::from_secs(5))
        .unwrap();
    assert!(!output.success);
    assert_eq!(output.stdout, "a\nb");
    let output = shell.run("printf ok", Duration::from_secs(5)).unwrap();
    assert!(output.success);
    assert_eq!(output.stdout, "ok");
    assert!(matches!(
        shell.run("sleep 5", Duration::from_millis(200)),
        Err(Error::UsageTimeout)
    ));
    // A step that overran leaves the session unusable rather than out of step.
    assert!(shell.run("true", Duration::from_secs(5)).is_err());
}
