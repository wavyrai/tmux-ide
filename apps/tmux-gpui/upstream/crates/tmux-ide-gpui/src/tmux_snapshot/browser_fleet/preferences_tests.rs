#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn preference_wire_legacy_bounds_and_global_token_uniqueness() {
    let mut v: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../../fixtures/browser-fleet.json"
    ))
    .unwrap();
    let parse =
        |v: &serde_json::Value| serde_json::from_value::<Fleet>(v["fleet"].clone()).unwrap();
    assert!(parse(&v).valid());
    v["fleet"]["preferences"] = serde_json::json!({"revision":1,"phase":"ready","error":null});
    let action = "11111111-1111-4111-8111-111111111111";
    v["fleet"]["groups"][0]["collapseAction"] = action.into();
    assert!(parse(&v).valid());
    v["fleet"]["groups"][0]["sessions"][0]["favoriteAction"] = action.into();
    assert!(!parse(&v).valid());
    v["fleet"]["groups"][0]["sessions"][0]["favoriteAction"] = serde_json::Value::Null;
    for phase in ["loading", "saving", "failed", "unavailable"] {
        v["fleet"]["preferences"]["phase"] = phase.into();
        assert!(!parse(&v).valid());
    }
    v["fleet"]["groups"][0]["collapseAction"] = serde_json::Value::Null;
    v["fleet"]["preferences"]["revision"] = 0.into();
    assert!(parse(&v).valid());
    v["fleet"]["preferences"]["revision"] = 9_007_199_254_740_992u64.into();
    assert!(!parse(&v).valid());
}
