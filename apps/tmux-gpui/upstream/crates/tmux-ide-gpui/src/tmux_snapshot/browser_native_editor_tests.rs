#![allow(clippy::unwrap_used)]
use super::*;
const ID: &str = "12345678-1234-4234-8234-123456789abc";
fn begin(editor: &mut Editor, now: u64) -> Request {
    editor
        .begin(
            ReadContext {
                id: ID,
                request: 1,
                pane: "pane",
                token: "token",
                presence: 4,
            },
            Lifetime {
                generation: ID.into(),
                incarnation: "one".into(),
            },
            now,
        )
        .unwrap()
}
fn response(request: &Request) -> Response {
    Response::parse(&serde_json::to_vec(&serde_json::json!({"type":"native-editor-result","version":1,"id":request.id,"request":request.request,"sequence":request.sequence,"operationId":request.operation_id,"status":"opened"})).unwrap()).unwrap()
}
#[test]
fn cancellation_and_timeout_consume_once_without_replaying_read() {
    let mut editor = Editor::default();
    let request = begin(&mut editor, 100);
    assert!(editor.cancel_if(true, 8099).is_none());
    let cancel = editor.cancel_if(true, 8100).unwrap();
    assert_eq!(cancel.operation_id, request.operation_id);
    assert!(editor.cancel_if(true, 8101).is_none());
    assert!(editor.response(response(&request)).is_none());
    let next = begin(&mut editor, 9000);
    assert!(next.sequence > request.sequence);
    assert!(editor.cancel_if(false, 9001).is_some());
    assert!(editor.response(response(&next)).is_none());
}
#[test]
fn stale_response_cannot_settle_replacement_and_command_has_no_owner_or_path() {
    let mut editor = Editor::default();
    let old = begin(&mut editor, 0);
    editor.cancel();
    let current = begin(&mut editor, 1);
    assert!(editor.response(response(&old)).is_none());
    let encoded = serde_json::to_value(&current).unwrap();
    assert_eq!(encoded.as_object().unwrap().len(), 9);
    assert!(encoded.get("token").is_none() && encoded.get("directory").is_none());
    assert_eq!(
        editor.response(response(&current)),
        Some("Folder open request sent to VS Code")
    );
    assert!(editor.response(response(&current)).is_none());
}
#[test]
fn malformed_results_are_rejected_and_pending_request_not_overwritten() {
    let mut editor = Editor::default();
    let original = begin(&mut editor, 0);
    assert!(
        editor
            .begin(
                ReadContext {
                    id: ID,
                    request: 2,
                    pane: "other",
                    token: "token",
                    presence: 4
                },
                Lifetime {
                    generation: ID.into(),
                    incarnation: "two".into()
                },
                1
            )
            .is_none()
    );
    assert!(Response::parse(b"{}").is_none());
    assert!(Response::parse(&vec![b' '; 2049]).is_none());
    assert!(editor.response(response(&original)).is_some());
}

#[test]
fn metadata_versions_require_exact_attachment_and_presence_and_validate_strings() {
    let value = serde_json::json!({"id":ID,"request":1,"pane":"pane","generation":ID,"presenceRevision":4,"versions":{"daemonVersion":"2.9.10","tmuxVersion":"3.6a"}});
    let diagnostics: Diagnostics = serde_json::from_value(value.clone()).unwrap();
    assert!(diagnostics.valid());
    assert!(diagnostics.versions(ID, 1, "pane", ID, 4).is_some());
    assert!(diagnostics.versions(ID, 2, "pane", ID, 4).is_none());
    assert!(diagnostics.versions(ID, 1, "other", ID, 4).is_none());
    assert!(diagnostics.versions(ID, 1, "pane", ID, 5).is_none());
    let mut invalid = value;
    invalid["versions"]["daemonVersion"] = serde_json::json!("private error path");
    assert!(serde_json::from_value::<Diagnostics>(invalid).is_err());
}

#[test]
fn queued_response_is_bounded_correlated_and_discarded_on_cancel() {
    let mut editor = Editor::default();
    let stale = begin(&mut editor, 0);
    editor.cancel();
    let current = begin(&mut editor, 1);
    assert!(!editor.receive(response(&stale)));
    assert!(editor.receive(response(&current)));
    assert!(!editor.receive(response(&current)));
    editor.cancel();
    assert!(editor.finish_response().is_none());
    let next = begin(&mut editor, 2);
    assert!(editor.receive(response(&next)));
    assert_eq!(
        editor.finish_response(),
        Some("Folder open request sent to VS Code")
    );
    assert!(editor.finish_response().is_none());
}
