#![allow(clippy::unwrap_used)]
use super::*;

fn device(id: &str) -> SavedDevice {
    SavedDevice {
        provider: CloudProvider::ALL[0],
        id: id.into(),
        label: "Dev box".into(),
        account: "https://coder.example.com".into(),
        machine: "herdr-dev-box".into(),
        session: "default".into(),
        enabled: true,
    }
}

#[test]
fn saves_replace_by_provider_and_id_and_survive_reload() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join(FILE);
    assert!(read(&path).unwrap().is_empty());
    save_in(&path, device("w1")).unwrap();
    save_in(&path, device("w2")).unwrap();
    let mut renamed = device("w1");
    renamed.label = "Renamed".into();
    save_in(&path, renamed.clone()).unwrap();
    let saved = read(&path).unwrap();
    assert_eq!(saved.len(), 2);
    assert_eq!(saved[0], renamed);
    assert_eq!(
        saved[0].endpoint_id(),
        format!("{}:w1", CloudProvider::ALL[0].key())
    );
    assert_eq!(
        saved[0].target(),
        ConnectTarget::Cloud {
            provider: CloudProvider::ALL[0],
            account: "https://coder.example.com".into(),
            id: "w1".into(),
            machine: "herdr-dev-box".into(),
            session: "default".into(),
        }
    );
    let text = fs::read_to_string(&path).unwrap();
    assert!(
        text.contains(&format!(
            "\"provider\": \"{}\"",
            CloudProvider::ALL[0].key()
        )),
        "{text}"
    );
}

#[test]
fn invalid_or_oversized_documents_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE);
    for bad in [
        SavedDevice {
            id: "../x".into(),
            ..device("w")
        },
        SavedDevice {
            machine: "-oProxyCommand=x".into(),
            ..device("w")
        },
        SavedDevice {
            machine: "a b".into(),
            ..device("w")
        },
        SavedDevice {
            session: "a/b".into(),
            ..device("w")
        },
        SavedDevice {
            label: "line\nbreak".into(),
            ..device("w")
        },
        SavedDevice {
            account: String::new(),
            ..device("w")
        },
    ] {
        assert!(write(&path, vec![Entry::Known(bad)]).is_err());
    }
    for text in [
        r#"{"version":2,"devices":[]}"#,
        r#"{"version":1,"devices":[],"extra":1}"#,
        // A provider this build has, but an entry that is not one of its devices.
        &format!(
            r#"{{"version":1,"devices":[{{"provider":"{}","id":"w"}}]}}"#,
            CloudProvider::ALL[0].key()
        ),
        r#"{"version":1,"devices":[{"provider":"../x","id":"w"}]}"#,
        "not json",
    ] {
        fs::write(&path, text).unwrap();
        assert!(read(&path).is_err(), "{text}");
    }
    fs::write(&path, vec![b' '; LIMIT as usize + 1]).unwrap();
    assert!(read(&path).is_err());
    let many = (0..=MAX_DEVICES)
        .map(|i| Entry::Known(device(&format!("w{i}"))))
        .collect();
    assert!(write(&path, many).is_err());
}

#[test]
fn another_builds_providers_are_kept_but_not_offered() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE);
    let foreign = r#"{"provider":"nimbus","id":"n1","label":"Elsewhere","zone":"x"}"#;
    fs::write(&path, format!(r#"{{"version":1,"devices":[{foreign}]}}"#)).unwrap();
    assert!(read(&path).unwrap().is_empty());
    save_in(&path, device("w1")).unwrap();
    assert_eq!(read(&path).unwrap(), [device("w1")]);
    remove_in(&path, CloudProvider::ALL[0], "w1").unwrap();
    assert!(read(&path).unwrap().is_empty());
    let text = fs::read_to_string(&path).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        saved["devices"],
        serde_json::json!([serde_json::from_str::<serde_json::Value>(foreign).unwrap()]),
        "written back unchanged"
    );
}
