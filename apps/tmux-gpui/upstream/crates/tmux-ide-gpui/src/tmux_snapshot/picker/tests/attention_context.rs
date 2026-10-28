use super::*;
#[test]
fn attention_context_search_preserves_exact_scope_revision_and_key() {
    let mut state = browser::State {
        request: 7,
        attention_supported: true,
        ..Default::default()
    };
    state.attention_agents=Some(serde_json::from_value(serde_json::json!({"scope":2,"revision":9,"phase":"live","rows":[{"key":"a","sessionId":"s","paneId":"p","name":"Same","sessionLabel":"Session","machineLabel":"First","projectName":"Unique project","status":"IDLE","attention":true,"available":true},{"key":"b","sessionId":"s","paneId":"p2","name":"Same","sessionLabel":"Session","machineLabel":"Second","status":"IDLE","attention":true,"available":true}],"observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap());
    let matches = super::super::attention::rows(&state, Some((7, 2)), "unique project");
    assert_eq!(matches.len(), 1);
    assert!(matches!(&matches[0].target,Target::Attention{scope:2,revision:9,key} if key=="a"));
    assert!(matches[0].label.contains("First · Session"));
    assert!(current(&state, &matches[0].target));
    state.attention_agents.as_mut().unwrap().roster.revision = 10;
    assert!(!current(&state, &matches[0].target));
}
