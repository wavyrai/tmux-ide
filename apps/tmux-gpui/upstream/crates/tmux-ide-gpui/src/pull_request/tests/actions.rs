use super::*;
use crate::pull_request::{MergeMethod, Outcome};

#[test]
fn action_identity_check_names_and_merge_methods_are_validated() {
    let mut pr = response()[0].clone();
    pr["id"] = serde_json::json!("PR_kwDOabc-_=");
    pr["headRefOid"] = serde_json::json!("a".repeat(40));
    pr["commits"] = serde_json::json!({"nodes":[{"commit":{"statusCheckRollup":{"contexts":{
        "nodes":[
            {"__typename":"CheckRun","name":"build\u{1b}[2J\u{202e}","status":"COMPLETED","conclusion":"SUCCESS"},
            {"__typename":"StatusContext","context":"x".repeat(400),"state":"PENDING"}
        ]
    }}}}]});
    let reply = |pr: &serde_json::Value| {
        serde_json::json!({"data":{"repository":{
            "mergeCommitAllowed": false, "squashMergeAllowed": true, "rebaseMergeAllowed": true,
            "pullRequests":{"nodes":[pr]}
        }}})
    };
    let parsed = parse_graphql(reply(&pr), "example", "project", "feature", None)
        .unwrap()
        .unwrap();
    assert_eq!(parsed.id, "PR_kwDOabc-_=");
    assert_eq!(parsed.head_ref_oid, "a".repeat(40));
    assert_eq!(
        parsed.merge_methods,
        [MergeMethod::Squash, MergeMethod::Rebase]
    );
    let checks: Vec<_> = parsed.check_list().collect();
    assert_eq!(checks[0], ("build [2J ", Outcome::Passed));
    assert_eq!(checks[1].0.chars().count(), 128);
    // Identifiers are sent back to GitHub, so malformed ones are dropped
    // rather than rewritten, and a missing setting allows nothing.
    for (id, oid) in [
        ("PR kw", "A".repeat(40)),
        (&*"x".repeat(129), "a".repeat(41)),
        ("", "g".repeat(40)),
    ] {
        pr["id"] = serde_json::json!(id);
        pr["headRefOid"] = serde_json::json!(oid);
        let mut reply = reply(&pr);
        reply["data"]["repository"]["squashMergeAllowed"] = serde_json::Value::Null;
        reply["data"]["repository"]["rebaseMergeAllowed"] = serde_json::json!("true");
        let parsed = parse_graphql(reply, "example", "project", "feature", None)
            .unwrap()
            .unwrap();
        assert!(parsed.id.is_empty() && parsed.head_ref_oid.is_empty());
        assert!(parsed.merge_methods.is_empty());
    }
}
