use super::*;
// Non-UTF-8 configuration roots only exist on POSIX; Windows paths are UTF-16.
#[cfg(unix)]
#[test]
fn local_origin_ignores_overrides_but_preserves_session_and_os_paths() {
    use std::os::unix::ffi::OsStringExt;
    let root = OsString::from_vec(b"/config-\xff".to_vec());
    let var = |name: &str| match name {
        "XDG_CONFIG_HOME" => Some(root.clone()),
        "HERDR_SESSION" => Some("work".into()),
        "HERDR_SOCKET_PATH" => Some("/forwarded/herdr.sock".into()),
        "HERDR_CLIENT_SOCKET_PATH" => Some("/forwarded-client.sock".into()),
        _ => None,
    };
    let expected = PathBuf::from(&root).join("herdr/sessions/work/herdr-client.sock");
    for target in [
        ConnectTarget::Local,
        ConnectTarget::Socket(expected.clone()),
        ConnectTarget::Socket("/forwarded.sock".into()),
    ] {
        assert_eq!(
            target.local_session_socket_path_with(var).unwrap(),
            expected
        );
    }
    assert_eq!(
        ConnectTarget::Session {
            name: "default".into(),
            development: true
        }
        .local_session_socket_path_with(var)
        .unwrap(),
        PathBuf::from(&root).join("herdr-dev/herdr-client.sock")
    );
    assert!(
        ConnectTarget::Ssh {
            target: "host".into(),
            session: "work".into()
        }
        .local_session_socket_path_with(var)
        .is_err()
    );
}
#[test]
fn inherited_socket_precedence_and_environment_changes() {
    let resolve = |target: &ConnectTarget, api: Option<&str>, client: Option<&str>| {
        target
            .socket_path_with(|name| match name {
                "HERDR_SOCKET_PATH" => api.map(Into::into),
                "HERDR_CLIENT_SOCKET_PATH" => client.map(Into::into),
                "XDG_CONFIG_HOME" => Some("/config".into()),
                "HERDR_SESSION" => Some("work".into()),
                // HERDR_SOCKET is not a discovery variable.
                "HERDR_SOCKET" => Some("/ignored.sock".into()),
                _ => None,
            })
            .unwrap()
    };
    assert_eq!(
        resolve(
            &ConnectTarget::Local,
            Some("/local/herdr.sock"),
            Some("/ignored.sock")
        ),
        Path::new("/local/herdr-client.sock")
    );
    assert_eq!(
        resolve(&ConnectTarget::Local, None, Some("/forwarded.sock")),
        Path::new("/forwarded.sock")
    );
    assert_eq!(
        resolve(&ConnectTarget::Local, None, None),
        Path::new("/config/herdr/sessions/work/herdr-client.sock")
    );
    assert_eq!(
        resolve(
            &ConnectTarget::Socket("/explicit.sock".into()),
            Some("/ignored.sock"),
            None
        ),
        Path::new("/explicit.sock")
    );
    assert_eq!(
        resolve(
            &ConnectTarget::Session {
                name: "default".into(),
                development: false
            },
            Some("/ignored.sock"),
            None
        ),
        Path::new("/config/herdr/herdr-client.sock")
    );
}
// Windows has no XDG layout by default, and the daemon binds the endpoint
// under the same root, so the fallbacks must stay in upstream's order.
#[cfg(windows)]
#[test]
fn windows_config_falls_back_to_roaming_app_data() {
    let environment = |names: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            names
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(*value))
        }
    };
    assert_eq!(
        ConnectTarget::Local
            .socket_path_with(environment(&[
                ("APPDATA", r"C:\Roaming"),
                ("HOME", r"C:\Home")
            ]))
            .unwrap(),
        PathBuf::from(r"C:\Roaming").join("herdr/herdr-client.sock")
    );
    assert_eq!(
        ConnectTarget::Local
            .socket_path_with(environment(&[("USERPROFILE", r"C:\Users\a")]))
            .unwrap(),
        PathBuf::from(r"C:\Users\a").join("AppData/Roaming/herdr/herdr-client.sock")
    );
    assert_eq!(
        ConnectTarget::Session {
            name: "work".into(),
            development: true,
        }
        .socket_path_with(environment(&[("HOME", r"C:\Home")]))
        .unwrap(),
        PathBuf::from(r"C:\Home").join(".config/herdr-dev/sessions/work/herdr-client.sock")
    );
}

#[test]
fn sessions_are_contained_and_default_is_not_nested() {
    let root = Path::new("/config/herdr");
    assert_eq!(
        session_socket(root, "default").unwrap(),
        root.join("herdr-client.sock")
    );
    assert_eq!(
        session_socket(root, "work.1").unwrap(),
        root.join("sessions/work.1/herdr-client.sock")
    );
    for name in ["", ".", "..", "../other", "a/b", "a b"] {
        assert!(!valid_session_name(name));
        assert!(session_socket(root, name).is_err());
    }
    assert!(!valid_session_name(&"a".repeat(65)));
    assert!(session_socket(root, &"a".repeat(65)).is_err());
    let target = ConnectTarget::Socket("/tmp/explicit.sock".into());
    assert_eq!(
        target.socket_path().unwrap(),
        PathBuf::from("/tmp/explicit.sock")
    );
}
