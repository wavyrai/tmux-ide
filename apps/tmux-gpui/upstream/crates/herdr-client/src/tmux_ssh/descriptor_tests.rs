#![allow(clippy::unwrap_used)]
use super::*;
fn value() -> serde_json::Value {
    serde_json::json!({"version":1,"daemon":{"pid":123,"port":4111,"protocolVersion":4,"productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"secret-fixture"}})
}
#[test]
fn descriptor_is_bounded_strict_and_never_echoes_secrets() {
    let descriptor = RemoteDescriptor::parse(&serde_json::to_vec(&value()).unwrap(), None).unwrap();
    assert_eq!(descriptor.product_version(), "2.9.12");
    for (key, bad_value) in [
        ("authToken", serde_json::json!(null)),
        ("authToken", serde_json::json!("secret\r\ninjection")),
        ("pid", serde_json::json!(0)),
        ("bindHostname", serde_json::json!("remote.example")),
        ("environmentId", serde_json::json!(null)),
        ("kind", serde_json::json!("remote-forward")),
    ] {
        let mut bad = value();
        bad["daemon"][key] = bad_value;
        let error = RemoteDescriptor::parse(&serde_json::to_vec(&bad).unwrap(), None)
            .err()
            .unwrap();
        assert_eq!(error, Error::Descriptor);
        assert!(!error.to_string().contains("secret"));
    }
    assert!(RemoteDescriptor::parse(&vec![b' '; 32769], None).is_err());
    assert!(RemoteDescriptor::parse(b"banner\n{}", None).is_err());
    assert!(RemoteDescriptor::parse(&[255], None).is_err());
}
#[test]
fn protocol_failures_and_environment_mismatch_stay_typed() {
    for (wire, code) in [
        ("daemon-missing", RemoteFailure::DaemonMissing),
        ("incompatible", RemoteFailure::Incompatible),
        ("unavailable", RemoteFailure::Unavailable),
    ] {
        let bytes =
            serde_json::to_vec(&serde_json::json!({"version":1,"error":{"code":wire}})).unwrap();
        assert!(
            matches!(RemoteDescriptor::parse(&bytes, None), Err(Error::Remote(actual)) if actual == code)
        );
    }
    let mut v = value();
    v["daemon"]["protocolVersion"] = 5.into();
    assert!(matches!(
        RemoteDescriptor::parse(&serde_json::to_vec(&v).unwrap(), None),
        Err(Error::Incompatible(5))
    ));
    let expected = "d9c81ebd-5785-45a3-9206-a2aa497d68fc";
    assert!(matches!(
        RemoteDescriptor::parse(&serde_json::to_vec(&value()).unwrap(), Some(expected)),
        Err(Error::Environment)
    ));
    let mut v = value();
    v["daemon"]["environmentId"] = expected.into();
    assert!(
        RemoteDescriptor::parse(
            &serde_json::to_vec(&v).unwrap(),
            Some(&expected.to_uppercase())
        )
        .is_ok()
    );
}
#[test]
fn provenance_is_optional_but_validated_when_present() {
    let mut v = value();
    v["daemon"]["supervisionId"] = "native.manual-1".into();
    v["daemon"]["provenance"] = serde_json::json!({"launcher":"headless","supervisor":"manual","parentPid":0,"stdout":{"kind":"pipe"},"stderr":{"kind":"file","path":"/tmp/log"}});
    assert!(RemoteDescriptor::parse(&serde_json::to_vec(&v).unwrap(), None).is_ok());
    v["daemon"]["provenance"]["stdout"]["kind"] = "arbitrary".into();
    assert!(RemoteDescriptor::parse(&serde_json::to_vec(&v).unwrap(), None).is_err());
}
