#![allow(clippy::unwrap_used)]
use super::*;
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("native-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn namespace(&self) -> LocalConfigNamespace {
        LocalConfigNamespace {
            env: BTreeMap::new(),
            home: self.0.clone(),
            cwd: self.0.clone(),
            record: None,
        }
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn set(ns: &mut LocalConfigNamespace, key: &str, value: impl Into<String>) {
    ns.env.insert(key.into(), value.into());
}
fn isolated(s: &Scratch) -> LocalConfigNamespace {
    let mut ns = s.namespace();
    set(&mut ns, "TMUX_IDE_RUNTIME_MODE", "test");
    set(
        &mut ns,
        "TMUX_IDE_HOME",
        s.0.join("isolated").to_str().unwrap(),
    );
    set(&mut ns, "TMUX_IDE_TMUX_SOCKET_NAME", "owned-config");
    set(&mut ns, "TMUX_IDE_CLEANUP_TOKEN", "owned-config-token");
    ns
}
#[test]
fn production_and_isolated_defaults_match_local_namespace() {
    let s = Scratch::new();
    let mut ns = s.namespace();
    set(&mut ns, "TMUX_IDE_RUNTIME_MODE", "production");
    set(
        &mut ns,
        "TMUX_IDE_HOME",
        s.0.join("alternate").to_str().unwrap(),
    );
    assert_eq!(ns.resolve(), Some(s.0.join(".tmux-ide/config.json")));
    let mut ns = isolated(&s);
    for mode in ["test", "smoke", "testdrive", "performance"] {
        set(&mut ns, "TMUX_IDE_RUNTIME_MODE", mode);
        assert_eq!(ns.resolve(), Some(s.0.join("isolated/config.json")));
    }
    set(&mut ns, "TMUX_IDE_CONFIG", "./settings/../custom.json");
    assert_eq!(ns.resolve(), Some(s.0.join("custom.json")));
}
#[test]
fn isolated_guard_failures_never_gain_explicit_config_authority() {
    let s = Scratch::new();
    for (key, value) in [
        ("TMUX_IDE_HOME", ""),
        ("TMUX_IDE_TMUX_SOCKET_NAME", "default"),
        ("TMUX_IDE_TMUX_SOCKET_NAME", "bad/name"),
        ("TMUX_IDE_CLEANUP_TOKEN", "short"),
        ("TMUX_IDE_RUNTIME_MODE", "invalid"),
        ("TMUX_IDE_TMUX_SOCKET_PATH", "/tmp/socket"),
    ] {
        let mut ns = isolated(&s);
        set(
            &mut ns,
            "TMUX_IDE_CONFIG",
            s.0.join("explicit.json").to_str().unwrap(),
        );
        set(&mut ns, key, value);
        assert!(ns.resolve().is_none(), "{key}");
    }
    for key in [
        "TMUX_IDE_HOME",
        "TMUX_IDE_REGISTRY_DIR",
        "TMUX_IDE_DAEMON_INFO_DIR",
    ] {
        let mut ns = isolated(&s);
        set(&mut ns, key, s.0.join(".tmux-ide/escape").to_str().unwrap());
        assert!(ns.resolve().is_none());
    }
}
#[test]
fn custom_record_requires_matching_daemon_namespace_or_explicit_config() {
    let s = Scratch::new();
    let mut ns = isolated(&s);
    ns.record = Some(s.0.join("other/daemon.json"));
    assert!(ns.resolve().is_none());
    set(
        &mut ns,
        "TMUX_IDE_DAEMON_INFO_DIR",
        s.0.join("other").to_str().unwrap(),
    );
    assert!(ns.resolve().is_some());
    set(&mut ns, "TMUX_IDE_DAEMON_INFO_DIR", "");
    assert!(ns.resolve().is_none());
    set(&mut ns, "TMUX_IDE_CONFIG", "explicit.json");
    assert_eq!(ns.resolve(), Some(s.0.join("explicit.json")));
}
#[cfg(unix)]
#[test]
fn resolution_rechecks_symlink_ancestors_instead_of_caching_identity() {
    use std::os::unix::fs::symlink;
    let s = Scratch::new();
    fs::create_dir(s.0.join(".tmux-ide")).unwrap();
    fs::create_dir(s.0.join("owned")).unwrap();
    let link = s.0.join("alias");
    symlink(s.0.join("owned"), &link).unwrap();
    let mut ns = isolated(&s);
    set(
        &mut ns,
        "TMUX_IDE_HOME",
        link.join("future").to_str().unwrap(),
    );
    assert!(ns.resolve().is_some());
    fs::remove_file(&link).unwrap();
    symlink(s.0.join(".tmux-ide"), &link).unwrap();
    assert!(ns.resolve().is_none());
}
#[derive(serde::Deserialize)]
struct Case {
    name: String,
    env: BTreeMap<String, String>,
    home: PathBuf,
    cwd: PathBuf,
    expected: Option<PathBuf>,
}
#[test]
#[ignore = "requires generated, isolated TypeScript namespace parity fixtures"]
fn native_config_namespace_matches_typescript_reference() {
    assert_eq!(
        std::env::var("TMUX_IDE_NAMESPACE_PARITY").as_deref(),
        Ok("owned-fixtures")
    );
    let file = std::env::var_os("TMUX_IDE_NAMESPACE_CASES").unwrap();
    let bytes = fs::read(file).unwrap();
    assert!(bytes.len() < 1024 * 1024);
    let cases: Vec<Case> = serde_json::from_slice(&bytes).unwrap();
    assert!(cases.len() >= 20 && cases.len() < 256);
    for case in cases {
        let ns = LocalConfigNamespace {
            env: case.env,
            home: case.home,
            cwd: case.cwd,
            record: None,
        };
        assert_eq!(ns.resolve(), case.expected, "{}", case.name);
    }
}

#[cfg(unix)]
#[test]
fn invalid_namespace_environment_is_rejected_instead_of_dropped() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    assert!(
        capture_environment([(
            OsString::from("TMUX_IDE_RUNTIME_MODE"),
            OsString::from_vec(vec![255])
        )])
        .is_none()
    );
    assert!(
        capture_environment([(
            OsString::from_vec(b"TMUX_IDE_TESTDRIVE_\xff".to_vec()),
            OsString::from("yes")
        )])
        .is_none()
    );
    assert!(
        capture_environment([(OsString::from("UNRELATED"), OsString::from_vec(vec![255]))])
            .is_some()
    );
}

#[test]
fn daemon_record_uses_validated_namespace_without_config_location_redirects() {
    let s = Scratch::new();
    let mut ns = s.namespace();
    assert_eq!(ns.daemon_record(), Some(s.0.join(".tmux-ide/daemon.json")));
    set(&mut ns, "TMUX_IDE_CONFIG", "custom.json");
    assert_eq!(ns.daemon_record(), Some(s.0.join(".tmux-ide/daemon.json")));
    let mut ns = isolated(&s);
    assert_eq!(ns.daemon_record(), Some(s.0.join("isolated/daemon.json")));
    set(&mut ns, "TMUX_IDE_REGISTRY_DIR", "registry");
    assert_eq!(ns.daemon_record(), Some(s.0.join("registry/daemon.json")));
    set(&mut ns, "TMUX_IDE_DAEMON_INFO_DIR", "records");
    assert_eq!(ns.daemon_record(), Some(s.0.join("records/daemon.json")));
    ns.env.remove("TMUX_IDE_CLEANUP_TOKEN");
    assert!(ns.daemon_record().is_none());
    let mut ns = isolated(&s);
    set(
        &mut ns,
        "TMUX_IDE_DAEMON_INFO_DIR",
        s.0.join(".tmux-ide").to_str().unwrap(),
    );
    assert!(ns.daemon_record().is_none());
}
