use super::*;
fn publication() -> anyhow::Result<serde_json::Value> {
    let mut value: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/browser-fleet.json"))?;
    value["surface"] = serde_json::json!("home");
    let group = &mut value["fleet"]["groups"][0];
    group["servers"] = serde_json::json!([{"id":"server-a","label":"Empty","state":"online","generation":"11111111-1111-4111-8111-111111111111","selection":"22222222-2222-4222-8222-222222222222"},{"id":"server-b","label":"Offline","state":"offline","generation":null,"selection":null}]);
    group["omittedServers"] = 0.into();
    Ok(value)
}
#[test]
fn server_wire_is_optional_bounded_and_selected_identity_exact() -> anyhow::Result<()> {
    let mut value = publication()?;
    let group = &value["fleet"]["groups"][0];
    value["selectedServer"] = serde_json::json!({"machineId":group["id"],"machineLabel":group["label"],"serverId":"server-a","generation":"11111111-1111-4111-8111-111111111111","label":"Empty"});
    let state = Reader::default().accept(&serde_json::to_vec(&value)?)?;
    assert!(state.selected_server.is_some());
    for field in [
        "machineId",
        "machineLabel",
        "serverId",
        "generation",
        "label",
    ] {
        let mut bad = value.clone();
        bad["selectedServer"][field] = "wrong".into();
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&bad)?)
                .is_err()
        );
    }
    for mutation in 0..4 {
        let mut bad = value.clone();
        match mutation {
            0 => {
                bad["fleet"]["groups"][0]["servers"][1]["selection"] =
                    "33333333-3333-4333-8333-333333333333".into()
            }
            1 => bad["fleet"]["groups"][0]["servers"][1]["id"] = "server-a".into(),
            2 => bad["fleet"]["groups"][0]["servers"][0]["generation"] = serde_json::Value::Null,
            _ => bad["surface"] = "workspace".into(),
        }
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&bad)?)
                .is_err()
        );
    }
    value["selectedServer"] = serde_json::Value::Null;
    let mut unknown = value.clone();
    unknown["fleet"]["groups"][0]["sessions"][0]["serverId"] = "not-published".into();
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&unknown)?)
            .is_err()
    );
    unknown["fleet"]["groups"][0]["sessions"][0]["serverId"] = serde_json::Value::Null;
    Reader::default().accept(&serde_json::to_vec(&unknown)?)?;

    let server = value["fleet"]["groups"][0]["servers"][1].clone();
    let servers: Vec<_> = (0..32)
        .map(|i| {
            let mut s = server.clone();
            s["id"] = format!("server-{i}").into();
            s
        })
        .collect();
    value["fleet"]["groups"][0]["servers"] = serde_json::json!(servers);
    Reader::default().accept(&serde_json::to_vec(&value)?)?;
    value["fleet"]["groups"][0]["servers"].as_array_mut().ok_or_else(|| anyhow::anyhow!("servers"))?.push(serde_json::json!({"id":"extra","label":"Offline","state":"offline","generation":null,"selection":null}));
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    Ok(())
}
