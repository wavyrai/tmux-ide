#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;

// Symlink and permission fixtures require POSIX semantics.
#[cfg(unix)]
#[test]
fn storage_errors_retain_operation_paths_sources_and_redacted_display() {
    use std::error::Error as _;
    let root = env::temp_dir().join(format!("herdr-storage-errors-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let catalog = root.join("endpoints.json");
    let selection = root.join("endpoint-selection.json");
    let bytes = br#"{"version":1,"secret-field":true}"#;
    fs::write(&catalog, bytes).unwrap();
    fs::write(&selection, bytes).unwrap();
    for (path, error, display) in [
        (
            &catalog,
            load_path(&catalog).unwrap_err(),
            "invalid endpoint catalog schema",
        ),
        (
            &selection,
            read_selection(&selection).err().unwrap(),
            "invalid endpoint selection schema",
        ),
    ] {
        let Error::Storage {
            operation,
            path: actual,
            source,
        } = &error
        else {
            panic!("missing storage context")
        };
        assert_eq!(*operation, StorageOperation::Decode);
        assert_eq!(actual, path);
        assert!(matches!(
            source.as_ref(),
            Error::CatalogSchema(_) | Error::SelectionSchema(_)
        ));
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(error.to_string(), display);
        let source = error
            .source()
            .unwrap()
            .source()
            .unwrap()
            .downcast_ref::<serde_json::Error>()
            .unwrap();
        assert!(source.to_string().contains("secret-field"));
    }
    let impossible = catalog.join("child.json");
    let error = load_path(&impossible).unwrap_err();
    let Error::Storage {
        operation, path, ..
    } = &error
    else {
        panic!("missing storage context")
    };
    assert_eq!(*operation, StorageOperation::Open);
    assert_eq!(*path, impossible);
    let source = error
        .source()
        .unwrap()
        .source()
        .unwrap()
        .downcast_ref::<io::Error>()
        .unwrap();
    assert_eq!(error.kind(), source.kind());
    assert!(source.raw_os_error().is_some());
    assert!(!error.to_string().contains(root.to_str().unwrap()));

    fs::write(&catalog, br#"{"version":1}"#).unwrap();
    fs::remove_file(&selection).unwrap();
    std::os::unix::fs::symlink(&catalog, &selection).unwrap();
    let error = store_selection(&catalog, None).unwrap_err();
    assert!(
        matches!(&error, Error::Storage { operation: StorageOperation::Validate, path, source }
        if path == &selection && matches!(source.as_ref(), Error::StorageDestinationNotFile))
    );
    assert_eq!(
        error.to_string(),
        "storage destination is not a regular file"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn schema_errors_keep_sources_but_redact_display() {
    use std::error::Error as _;
    let bytes = br#"{"version":1,"secret-field":true}"#;
    let error = parse(bytes).unwrap_err();
    assert!(matches!(error, Error::CatalogSchema(_)));
    assert_eq!(error.to_string(), "invalid endpoint catalog schema");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    let source = error
        .source()
        .unwrap()
        .downcast_ref::<serde_json::Error>()
        .unwrap();
    assert!(source.to_string().contains("secret-field"));

    let source = serde_json::from_slice::<Selection>(bytes).err().unwrap();
    let error = Error::SelectionSchema(source);
    assert_eq!(error.to_string(), "invalid endpoint selection schema");
    assert!(error.source().unwrap().is::<serde_json::Error>());
    assert!(matches!(
        parse(&vec![b' '; 65537]),
        Err(Error::CatalogLimit)
    ));
    assert!(matches!(
        validate_target("-oSecret"),
        Err(Error::InvalidSshTarget)
    ));
}

// Symlink and permission fixtures require POSIX semantics.
#[cfg(unix)]
#[test]
fn selection_roundtrip_fallbacks_and_independent_clients() {
    use std::os::unix::fs::PermissionsExt;
    let root = env::temp_dir().join(format!("herdr-selection-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("endpoints.json");
    let selection = root.join("endpoint-selection.json");
    let id = "0123456789abcdef0123456789abcdef";
    let catalog = json!({"version":1,"ssh":[{"id":id,"label":"Build","target":"build","session":"default","enabled":true}]});
    fs::write(&path, catalog.to_string()).unwrap();
    assert_eq!(load_with_selection(&path).unwrap().1, None);
    store_selection(&path, Some(id)).unwrap();
    let first_client = load_with_selection(&path).unwrap();
    assert_eq!(first_client.1.as_deref(), Some(id));
    assert_eq!(
        fs::metadata(&selection).unwrap().permissions().mode() & 0o777,
        0o600
    );
    store_selection(&path, None).unwrap();
    assert_eq!(load_with_selection(&path).unwrap().1, None);
    assert_eq!(first_client.1.as_deref(), Some(id));
    assert_eq!(load_path(&path).unwrap(), first_client.0);
    assert_eq!(fs::read_to_string(&path).unwrap(), catalog.to_string());
    let before = fs::read(&selection).unwrap();
    assert!(store_selection(&path, Some("missing")).is_err());
    assert_eq!(fs::read(&selection).unwrap(), before);
    for bad in [
        "not json".into(),
        json!({"version":2,"selected_profile":id}).to_string(),
        json!({"version":1,"selected_profile":id,"unknown":"secret"}).to_string(),
        json!({"version":1,"selected_profile":"missing"}).to_string(),
        " ".repeat(65537),
    ] {
        fs::write(&selection, bad).unwrap();
        let (hosts, selected) = load_with_selection(&path).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(selected, None);
    }
    store_selection(&path, Some(id)).unwrap();
    let mut disabled = catalog.clone();
    disabled["ssh"][0]["enabled"] = json!(false);
    fs::write(&path, disabled.to_string()).unwrap();
    assert_eq!(load_with_selection(&path).unwrap().1, None);
    assert!(store_selection(&path, Some(id)).is_err());
    fs::write(&path, json!({"version":1}).to_string()).unwrap();
    assert_eq!(load_with_selection(&path).unwrap().1, None);
    let mut legacy = catalog;
    legacy["selected_profile"] = json!(id);
    fs::write(&path, legacy.to_string()).unwrap();
    fs::remove_file(&selection).unwrap();
    assert_eq!(load_with_selection(&path).unwrap().1.as_deref(), Some(id));
    fs::write(&selection, "bad").unwrap();
    assert_eq!(load_with_selection(&path).unwrap().1.as_deref(), Some(id));
    store_selection(&path, None).unwrap();
    assert_eq!(load_with_selection(&path).unwrap().1, None);
    fs::remove_dir_all(root).unwrap();
}

// Symlink and permission fixtures require POSIX semantics.
#[cfg(unix)]
#[test]
fn selection_write_refuses_nonfiles_without_touching_other_state() {
    let root = env::temp_dir().join(format!("herdr-selection-failure-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let catalog = root.join("endpoints.json");
    let selection = root.join("endpoint-selection.json");
    let other = root.join("other");
    fs::write(&other, "untouched").unwrap();
    std::os::unix::fs::symlink(&other, &selection).unwrap();
    assert!(store_selection(&catalog, None).is_err());
    assert_eq!(fs::read_to_string(&other).unwrap(), "untouched");
    fs::remove_file(&selection).unwrap();
    fs::create_dir(&selection).unwrap();
    assert!(store_selection(&catalog, None).is_err());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
    assert!(store_selection(&other.join("endpoints.json"), None).is_err());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn paths_use_state_and_explicit_development() {
    let environment = |state: Option<&str>, home: Option<&str>| {
        let (state, home) = (state.map(OsString::from), home.map(OsString::from));
        move |name: &str| match name {
            "XDG_STATE_HOME" => state.clone(),
            "HOME" => home.clone(),
            _ => None,
        }
    };
    assert_eq!(
        catalog_path(false, environment(Some("/state"), Some("/home"))),
        PathBuf::from("/state/herdr/client/endpoints.json")
    );
    assert_eq!(
        catalog_path(true, environment(None, Some("/home"))),
        PathBuf::from("/home/.local/state/herdr-dev/client/endpoints.json")
    );
    for (development, app) in [(false, "herdr"), (true, "herdr-dev")] {
        assert_eq!(
            catalog_path(development, environment(Some("/state"), None))
                .with_file_name("endpoint-selection.json"),
            PathBuf::from(format!("/state/{app}/client/endpoint-selection.json"))
        );
        assert_eq!(
            catalog_path(development, environment(None, None)),
            env::temp_dir().join(format!("{app}-state/client/endpoints.json"))
        );
    }
}

// Windows has no XDG layout by default, and the daemon reads the catalog
// from the same place, so the fallbacks must stay in upstream's order.
#[cfg(windows)]
#[test]
fn windows_state_falls_back_to_local_app_data() {
    let environment = |names: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            names
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(*value))
        }
    };
    assert_eq!(
        catalog_path(
            false,
            environment(&[("LOCALAPPDATA", r"C:\Local"), ("HOME", r"C:\Home")])
        ),
        PathBuf::from(r"C:\Local").join("herdr/client/endpoints.json")
    );
    assert_eq!(
        catalog_path(false, environment(&[("USERPROFILE", r"C:\Users\a")])),
        PathBuf::from(r"C:\Users\a").join("AppData/Local/herdr/client/endpoints.json")
    );
    assert_eq!(
        catalog_path(true, environment(&[("HOME", r"C:\Home")])),
        PathBuf::from(r"C:\Home").join(".local/state/herdr-dev/client/endpoints.json")
    );
}
#[test]
fn schema_limits_and_security() {
    let host = json!({"id":"0123456789abcdef0123456789abcdef", "label":"Build", "target":"ssh://dev@[::1]:2222", "session":"agents", "enabled":false});
    let valid = json!({"version":1,"ssh":[host.clone()]});
    assert!(parse(valid.to_string().as_bytes()).is_ok());
    for (field, value) in [
        ("password", json!("secret")),
        ("id", json!("BAD")),
        ("session", json!("../escape")),
        ("target", json!("-oProxyCommand=bad")),
        ("target", json!("ssh://dev:secret@host")),
        ("label", json!("\n")),
    ] {
        let mut bad = valid.clone();
        bad["ssh"][0][field] = value;
        assert!(parse(bad.to_string().as_bytes()).is_err(), "{field}");
    }
    assert!(
        parse(
            json!({"version":1,"ssh":[host.clone(),host]})
                .to_string()
                .as_bytes()
        )
        .is_err()
    );
    assert!(parse(json!({"version":2}).to_string().as_bytes()).is_err());
    assert!(
        parse(
            json!({"version":1,"selected_profile":"missing"})
                .to_string()
                .as_bytes()
        )
        .is_err()
    );
    assert!(parse(&vec![b' '; 65537]).is_err());
    let mut oversized = valid.clone();
    oversized["ssh"] = json!(vec![valid["ssh"][0].clone(); 65]);
    assert!(parse(oversized.to_string().as_bytes()).is_err());
    for field in ["label", "target"] {
        let mut oversized = valid.clone();
        oversized["ssh"][0][field] = json!("x".repeat(1025));
        assert!(parse(oversized.to_string().as_bytes()).is_err());
    }
    let mut selected = valid.clone();
    selected["selected_profile"] = valid["ssh"][0]["id"].clone();
    assert!(parse(selected.to_string().as_bytes()).is_err());
    selected["ssh"][0]["enabled"] = json!(true);
    assert!(parse(selected.to_string().as_bytes()).is_ok());
    assert!(
        matches!(load_path(&env::temp_dir().join(format!("herdr-missing-catalog-{}", std::process::id()))), Ok(hosts) if hosts.is_empty())
    );
}
