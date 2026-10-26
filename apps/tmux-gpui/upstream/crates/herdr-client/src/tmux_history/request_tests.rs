#![allow(clippy::unwrap_used)]
use super::*;
fn capture() -> serde_json::Value {
    serde_json::json!({"version":1,"liveSessionId":format!("live-session.{}","a".repeat(20)),"proof":{"workspaceName":"fixture","semanticPaneId":"pane.first","generation":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","incarnation":"first","revision":4,"stateHash":"0123456789abcdef"},"operation":{"kind":"capture","historyIndex":2}})
}
fn parse(value: &serde_json::Value) -> Result<AnchorRequest> {
    AnchorRequest::parse(&serde_json::to_vec(value).unwrap())
}
#[test]
fn operation_and_proof_shapes_cannot_be_mixed_or_extended() {
    let valid = capture();
    assert!(parse(&valid).is_ok());
    for field in ["revision", "stateHash"] {
        let mut bad = valid.clone();
        bad["proof"].as_object_mut().unwrap().remove(field);
        assert!(parse(&bad).is_err());
    }
    let mut resolve = valid;
    resolve["operation"] =
        serde_json::json!({"kind":"resolve","token":"d9c81ebd-5785-45a3-9206-a2aa497d68fc"});
    assert!(parse(&resolve).is_err());
    for field in ["revision", "stateHash"] {
        resolve["proof"].as_object_mut().unwrap().remove(field);
    }
    let request = parse(&resolve).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&request.body().unwrap()).unwrap(),
        resolve
    );
    resolve["proof"]["revision"] = serde_json::Value::Null;
    assert!(parse(&resolve).is_err());
    assert!(AnchorRequest::parse(&vec![b' '; 16 * 1024 + 1]).is_err());
}
#[test]
fn resolved_response_must_match_requested_identity_and_operation() {
    let value = capture();
    let proof: Proof = serde_json::from_value(value["proof"].clone()).unwrap();
    let resolved = AnchorResult::Resolved {
        proof: proof.clone(),
        history_index: 2,
    };
    assert!(parse(&value).unwrap().check_result(&resolved).is_err());
    let mut value = value;
    value["operation"] =
        serde_json::json!({"kind":"resolve","token":"d9c81ebd-5785-45a3-9206-a2aa497d68fc"});
    for field in ["revision", "stateHash"] {
        value["proof"].as_object_mut().unwrap().remove(field);
    }
    let request = parse(&value).unwrap();
    request.check_result(&resolved).unwrap();
    let mut wrong = proof;
    wrong.incarnation = "replacement".into();
    assert!(
        request
            .check_result(&AnchorResult::Resolved {
                proof: wrong,
                history_index: 2
            })
            .is_err()
    );
    assert!(
        request
            .check_result(&AnchorResult::Captured {
                token: "d9c81ebd-5785-45a3-9206-a2aa497d68fc".into()
            })
            .is_err()
    );
}
