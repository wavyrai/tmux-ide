use super::*;

#[test]
fn a_refusal_shows_github_reason_cleaned_and_bounded() {
    let errors = serde_json::json!([
        {"type": "UNPROCESSABLE", "message": "Head branch\nwas modified.\u{202e} Review and try again."},
        {"message": "second"}
    ]);
    assert_eq!(
        rejection(&errors).as_deref(),
        Some("Head branch was modified.  Review and try again.")
    );
    let long = serde_json::json!([{"message": "x".repeat(5000)}]);
    assert_eq!(rejection(&long).unwrap().chars().count(), 240);
    for errors in [
        serde_json::json!([]),
        serde_json::json!([{"message": "   "}]),
        serde_json::json!([{"message": 7}]),
        serde_json::json!({"message": "not a list"}),
    ] {
        assert_eq!(rejection(&errors), None, "{errors}");
    }
}
