use super::*;
use serde_json::json;
fn publication(sequence: u64, request: u64) -> serde_json::Value {
    json!({"version":1,"inputReady":false,"connection":"a","sequence":sequence,"request":request,
        "sessions":[{"id":"s","label":"Session"}],"panes":[],"selectedSession":"s",
        "selectedPane":null,"status":"Choose a pane","snapshot":null})
}
#[test]
fn rejects_replaced_helper_and_old_requests() -> anyhow::Result<()> {
    let mut reader = Reader::default();
    reader.accept(&serde_json::to_vec(&publication(1, 3))?)?;
    assert!(
        reader
            .accept(&serde_json::to_vec(&publication(2, 2))?)
            .is_err()
    );
    let mut replaced = publication(2, 3);
    replaced["connection"] = json!("b");
    assert!(reader.accept(&serde_json::to_vec(&replaced)?).is_err());
    reader.accept(&serde_json::to_vec(&publication(3, 4))?)?;
    Ok(())
}
#[test]
fn rejects_duplicate_choices_and_unselected_frames() -> anyhow::Result<()> {
    let mut value = publication(1, 0);
    value["sessions"] = json!([{"id":"s","label":"One"},{"id":"s","label":"Two"}]);
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    let mut value = publication(1, 0);
    value["snapshot"] =
        serde_json::from_str(include_str!("../../../../../fixtures/snapshot.json"))?;
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    Ok(())
}

/// Opt-in replay of a private browser publication trace; never prints payloads.
#[test]
#[ignore = "requires TMUX_GPUI_PUBLICATION_TRACE from an isolated fixture"]
fn replay_isolated_publication_trace() -> anyhow::Result<()> {
    use std::io::BufRead;
    let path = std::env::var("TMUX_GPUI_PUBLICATION_TRACE")?;
    let file = std::fs::File::open(path)?;
    let mut reader = Reader::default();
    let mut count = 0;
    for (index, line) in BufReader::new(file).split(b'\n').enumerate() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        reader.accept(&line).map_err(|error| {
            anyhow::anyhow!(
                "Publication {} rejected: {}",
                index + 1,
                rejection_reason(&error)
            )
        })?;
        count += 1;
    }
    anyhow::ensure!(count > 0, "Trace must contain publications");
    eprintln!("Accepted {count} isolated publications");
    Ok(())
}

#[test]
fn rejection_diagnostic_does_not_echo_untrusted_json() -> anyhow::Result<()> {
    let error = serde_json::from_str::<u64>("\"private-terminal-content\"")
        .err()
        .ok_or_else(|| anyhow::anyhow!("a string must not decode as a sequence number"))?;
    assert_eq!(
        rejection_reason(&Error::Json(error)),
        "invalid JSON or schema"
    );
    assert_eq!(
        rejection_reason(&Error::Invalid("Invalid pane actions")),
        "Invalid pane actions"
    );
    Ok(())
}

#[test]
fn diagnostic_versions_follow_publication_request_and_clear_when_not_live() -> anyhow::Result<()> {
    let mut wire = publication(1, 3);
    wire["panes"] = json!([{"id":"p","label":"Pane"}]);
    wire["selectedPane"] = json!("p");
    wire["inputReady"] = json!(true);
    wire["snapshot"] = serde_json::from_str(include_str!("../../../../../fixtures/snapshot.json"))?;
    wire["diagnostics"] = json!({"daemonVersion":"2.9.7"});
    let mut reader = Reader::default();
    let live = reader.accept(&serde_json::to_vec(&wire)?)?;
    assert_eq!(
        live.diagnostics
            .and_then(|value| value.daemon_version)
            .as_deref(),
        Some("2.9.7")
    );
    let unavailable = reader.accept(&serde_json::to_vec(&publication(2, 4))?)?;
    assert!(unavailable.diagnostics.is_none());
    wire["sequence"] = json!(3);
    assert!(reader.accept(&serde_json::to_vec(&wire)?).is_err());
    let mut invalid = publication(4, 4);
    invalid["diagnostics"] = json!({"daemonVersion":"2.9.7"});
    assert!(reader.accept(&serde_json::to_vec(&invalid)?).is_err());
    Ok(())
}
