use super::*;

#[test]
fn accepts_real_bridge_machine_publications() -> anyhow::Result<()> {
    let mut reader = Reader::default();
    reader.accept(include_bytes!(
        "../../../../../fixtures/browser-initial.json"
    ))?;
    reader.accept(include_bytes!(
        "../../../../../fixtures/browser-machines.json"
    ))?;
    Ok(())
}

#[test]
fn rejects_invalid_registry_without_consuming_sequence() -> anyhow::Result<()> {
    let original: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../fixtures/browser-machines.json"
    ))?;
    let profile = serde_json::json!({
        "id": "aa5c3564-b0b3-4cc9-8067-4188af9c438a",
        "label": "Build", "sshTarget": "user@build", "enabled": true,
        "expectedEnvironmentId": "45eb5ba5-27d1-4b29-8203-7b885f83dbe9"
    });
    let mut valid = original.clone();
    valid["machines"]["machines"] = serde_json::json!([profile.clone()]);
    Reader::default().accept(&serde_json::to_vec(&valid)?)?;
    for bad in [
        serde_json::json!({"id": "not-a-uuid"}),
        serde_json::json!({"label": "bad\nlabel"}),
        serde_json::json!({"label": "x".repeat(81)}),
        serde_json::json!({"sshTarget": "x".repeat(256)}),
        serde_json::json!({"expectedEnvironmentId": "wrong"}),
        serde_json::json!({"ownerToken": "must-not-cross-boundary"}),
    ] {
        let mut value = valid.clone();
        for (key, item) in bad
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("test object"))?
        {
            value["machines"]["machines"][0][key] = item.clone();
        }
        let mut reader = Reader::default();
        assert!(reader.accept(&serde_json::to_vec(&value)?).is_err());
        reader.accept(&serde_json::to_vec(&valid)?)?;
    }
    let unique: Vec<_> = (0..65)
        .map(|index| {
            let mut item = profile.clone();
            item["id"] = serde_json::json!(format!("aa5c3564-b0b3-4cc9-8067-{index:012x}"));
            item["label"] = serde_json::json!(format!("Build {index}"));
            item
        })
        .collect();
    let mut maximum = valid.clone();
    maximum["machines"]["machines"] = serde_json::json!(&unique[..64]);
    Reader::default().accept(&serde_json::to_vec(&maximum)?)?;
    for profiles in [vec![profile.clone(); 2], unique] {
        let mut value = valid.clone();
        value["machines"]["machines"] = serde_json::json!(profiles);
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&value)?)
                .is_err()
        );
    }
    Ok(())
}
