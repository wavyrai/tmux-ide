use super::*;
use crate::usage::probe::Shell;

const REPORT: &str = r#"{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0.5}]}]}}}"#;

/// A local `sh` standing in for a host where Antigravity was once installed:
/// its data directory exists and a fake `agy` on the PATH records each run.
struct AgyHost {
    root: tempfile::TempDir,
}

impl AgyHost {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(home.join(".gemini/antigravity")).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        crate::test_executable::write(
            bin.join("agy"),
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{log}'\ncase \"$1\" in --version) echo 1.2.0;; *) printf '%s' '{REPORT}';; esac\n",
                log = root.path().join("log").display()
            ),
            0o755,
        )
        .unwrap();
        Self { root }
    }

    fn fetch(&self, consent: Consent) -> Option<crate::Result<Report>> {
        let mut command = std::process::Command::new("/bin/sh");
        command
            .arg("-s")
            .env_clear()
            .env("HOME", self.root.path().join("home"))
            .env("PATH", "/usr/bin:/bin")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let mut exec = Exec::Remote(Shell::start(command).unwrap());
        let mut jar = CookieJar::default();
        let antigravity = provider("antigravity");
        let mut probe = Probe::new(&mut exec, antigravity, None, &mut jar, consent);
        antigravity.service().fetch(&mut probe)
    }

    fn runs(&self) -> String {
        std::fs::read_to_string(self.root.path().join("log")).unwrap_or_default()
    }
}

/// A signed-out `agy` opens a browser to sign in, so a merely detected
/// install must never be run on a background refresh (#320).
#[test]
fn detected_antigravity_never_runs_agy() {
    let host = AgyHost::new();
    assert!(host.fetch(Consent::Quiet).is_none());
    assert_eq!(
        host.runs(),
        "",
        "agy was run for a provider nobody asked for"
    );
}

#[test]
fn listed_antigravity_reads_the_agy_report() {
    let host = AgyHost::new();
    let report = host
        .fetch(Consent::Ask { browsers: false })
        .unwrap()
        .unwrap();
    assert_eq!(report.windows.len(), 1);
    assert!(host.runs().contains("-p /usage --output-format json"));
}
