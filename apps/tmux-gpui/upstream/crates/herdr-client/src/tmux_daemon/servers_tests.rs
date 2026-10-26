#![allow(clippy::unwrap_used)]
use super::*;
fn online() -> serde_json::Value {
    serde_json::json!({"state":"online","label":" primary ","serverId":"tmux-server.0123456789abcdef0123456789abcdef","generation":"d9c81ebd-5785-45a3-9206-a2aa497d68fc"})
}
fn resource(entries: Vec<serde_json::Value>) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"version":1,"servers":entries})).unwrap()
}
#[test]
fn projects_online_scope_and_offline_without_granting_generation() {
    let result = parse(&resource(vec![online()])).unwrap();
    assert!(
        matches!(&result[0],ServerRegistration::Online {label,scope} if label=="primary" && scope.generation=="d9c81ebd-5785-45a3-9206-a2aa497d68fc")
    );
    let mut offline = online();
    offline["state"] = "offline".into();
    offline["generation"] = serde_json::Value::Null;
    assert!(matches!(
        &parse(&resource(vec![offline])).unwrap()[0],
        ServerRegistration::Offline { .. }
    ));
}
#[test]
fn rejects_duplicates_bad_generations_and_unknown_authority_fields() {
    assert!(parse(&resource(vec![online(), online()])).is_err());
    for (key, value) in [
        ("generation", serde_json::json!("stale")),
        ("serverId", serde_json::json!("/tmp/socket")),
        ("label", serde_json::json!("bad\nlabel")),
        ("extra", serde_json::json!(true)),
        ("state", serde_json::json!("offline")),
    ] {
        let mut entry = online();
        entry[key] = value;
        assert!(parse(&resource(vec![entry])).is_err());
    }
}
