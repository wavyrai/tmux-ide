use super::*;

#[test]
fn badge_colors_report_readiness_and_preserve_terminal_lifecycles() {
    let theme = crate::config::Theme::default();
    for (merge, review, checks, expected) in [
        ("CLEAN", "APPROVED", vec![], theme.palette[2]),
        ("CLEAN", "", vec!["SUCCESS", "SKIPPED"], theme.palette[2]),
        ("CLEAN", "", vec!["PENDING"], theme.palette[3]),
        ("CLEAN", "REVIEW_REQUIRED", vec![], theme.palette[3]),
        ("CLEAN", "CHANGES_REQUESTED", vec![], theme.palette[1]),
        (
            "CLEAN",
            "APPROVED",
            vec!["PENDING", "FAILURE"],
            theme.palette[1],
        ),
        (
            "DIRTY",
            "REVIEW_REQUIRED",
            vec!["PENDING"],
            theme.palette[1],
        ),
        ("UNSTABLE", "", vec![], theme.palette[1]),
        ("UNSTABLE", "", vec!["SUCCESS", "PENDING"], theme.palette[3]),
        ("UNSTABLE", "", vec!["PENDING", "FAILURE"], theme.palette[1]),
        ("BLOCKED", "", vec![], theme.palette[208]),
        ("BEHIND", "", vec![], theme.palette[208]),
        ("BLOCKED", "", vec!["PENDING"], theme.palette[3]),
        ("HAS_HOOKS", "", vec![], theme.palette[3]),
        ("UNKNOWN", "", vec![], theme.palette[3]),
        ("FUTURE_STATE", "", vec![], theme.palette[3]),
        ("DRAFT", "", vec![], theme.palette[3]),
    ] {
        let mut wire = response();
        wire[0]["mergeStateStatus"] = merge.into();
        wire[0]["reviewDecision"] = review.into();
        wire[0]["statusCheckRollup"] = checks
            .iter()
            .map(|state| serde_json::json!({"__typename": "StatusContext", "state": state}))
            .collect::<Vec<_>>()
            .into();
        let mut pr = parse(&wire.to_string(), "example", "project", "feature")
            .unwrap()
            .unwrap();
        assert_eq!(
            pr.color(&theme),
            theme.ink(expected),
            "{merge}, {review}, {checks:?}"
        );
        pr.is_draft = true;
        assert_eq!(pr.color(&theme), theme.ink(theme.muted));
        pr.state = State::Merged;
        assert_eq!(pr.color(&theme), theme.ink(theme.palette[5]));
        pr.state = State::Closed;
        assert_eq!(pr.color(&theme), theme.ink(theme.palette[1]));
    }
    // CheckRun status takes priority over a conclusion until completion, and a
    // failed check wins over pending checks and a nominally clean merge state.
    let mut pr = fixture().unwrap();
    pr.merge_state_status = MergeState::Clean;
    pr.review_decision = Default::default();
    assert_eq!(pr.color(&theme), theme.ink(theme.palette[1]));
    pr.status_check_rollup = serde_json::from_value(serde_json::json!([
        {"__typename":"CheckRun", "status":"IN_PROGRESS", "conclusion":"SUCCESS"}
    ]))
    .unwrap();
    assert_eq!(pr.color(&theme), theme.ink(theme.palette[3]));
}

#[test]
fn parses_identity_lifecycle_and_check_categories() {
    let mut pr = fixture().unwrap();
    assert_eq!(pr.checks(), "1 passed / 1 failed / 1 pending");
    assert_eq!(pr.lifecycle(), "Open");
    assert_eq!(pr.review(), "Review required");
    pr.is_draft = true;
    assert_eq!(pr.lifecycle(), "Draft");
    pr.state = State::Merged;
    assert_eq!(pr.lifecycle(), "Merged");
    pr.state = State::Closed;
    assert_eq!(pr.lifecycle(), "Closed");
    pr.status_check_rollup = Some(vec![]);
    assert_eq!(pr.checks(), "No checks reported");
    pr.status_check_rollup = serde_json::from_value(serde_json::json!([
        {"__typename":"CheckRun", "status":"COMPLETED", "conclusion":"SKIPPED"},
        {"__typename":"CheckRun", "status":"COMPLETED", "conclusion":"NEUTRAL"},
        {"__typename":"CheckRun", "status":"COMPLETED", "conclusion":"TIMED_OUT"},
        {"__typename":"CheckRun", "status":"COMPLETED", "conclusion":null}
    ]))
    .unwrap();
    assert_eq!(pr.checks(), "1 failed / 1 pending / 2 skipped");
    for (wire, label) in [
        ("CLEAN", "No merge conflicts"),
        ("DIRTY", "Merge conflicts"),
        ("BEHIND", "Branch behind base"),
        ("BLOCKED", "Merge blocked"),
        ("UNSTABLE", "Checks need attention"),
        ("DRAFT", "Not ready for review"),
        ("HAS_HOOKS", "Merge hooks required"),
        ("UNKNOWN", "Merge status unavailable"),
        // A status added upstream degrades instead of failing the lookup.
        ("FUTURE_VALUE", "Merge status unavailable"),
    ] {
        pr.merge_state_status = MergeState::from(wire.to_owned());
        assert_eq!(pr.merge_status(), label, "{wire}");
    }
}

#[test]
fn native_graphql_normalizes_nullable_reviews_and_bounded_checks() {
    let mut pr = response()[0].clone();
    pr["reviewDecision"] = serde_json::Value::Null;
    pr["commits"] = serde_json::json!({"nodes":[{"commit":{"statusCheckRollup":{"contexts":{
        "pageInfo":{"hasNextPage":true}, "nodes":[{"__typename":"StatusContext","state":"SUCCESS"}]
    }}}}]});
    let response = serde_json::json!({"data":{"repository":{"pullRequests":{"nodes":[pr]}}}});
    let pr = parse_graphql(response.clone(), "example", "project", "feature", None)
        .unwrap()
        .unwrap();
    assert_eq!(pr.review(), "No review decision");
    assert!(pr.checks_summary.contains("1 passed"));
    assert!(pr.checks_summary.contains("first 100"));
    assert!(parse_graphql(response, "wrong", "project", "feature", None).is_err());
    assert!(
        parse_graphql(
            serde_json::json!({"data":{"repository":null}}),
            "a",
            "b",
            "c",
            None
        )
        .is_err()
    );
    assert!(
        parse_graphql(
            serde_json::json!({"data":{"repository":{"pullRequests":{"nodes":[]}}}}),
            "a",
            "b",
            "c",
            None
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn rejects_malformed_ambiguous_oversized_and_mismatched_responses() {
    let parse_value =
        |v: &serde_json::Value| parse(&v.to_string(), "example", "project", "feature");
    assert!(
        parse("[]", "example", "project", "feature")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        parse_value(&response()).unwrap().unwrap().title,
        "Title  safe"
    );
    for (key, value) in [
        (
            "url",
            serde_json::json!("https://github.com.evil.test/example/project/pull/8"),
        ),
        (
            "url",
            serde_json::json!("https://github.com/example/project/pull/9"),
        ),
        (
            "url",
            serde_json::json!("http://github.com/example/project/pull/8"),
        ),
        ("headRefName", serde_json::json!("other")),
        ("headRepositoryOwner", serde_json::json!({"login":"fork"})),
        ("number", serde_json::json!(0)),
        ("additions", serde_json::json!(-1)),
        ("state", serde_json::json!("UNKNOWN")),
        ("isDraft", serde_json::Value::Null),
    ] {
        let mut v = response();
        v[0][key] = value;
        assert!(parse_value(&v).is_err(), "{key}");
    }
    let v = response();
    assert!(parse_value(&serde_json::json!([v[0], v[0]])).is_err());
    assert!(parse("{}", "a", "b", "c").is_err());
    assert!(parse(&" ".repeat(OUTPUT_LIMIT + 1), "a", "b", "c").is_err());
    assert_eq!(clean(&"x".repeat(2000)).len(), 512);
}

#[test]
fn checks_add_up_to_their_worst_outcome() {
    let mut pr = fixture().unwrap();
    // Failed outranks running and passed.
    assert_eq!(
        pr.checks_outcome(),
        Some(crate::pull_request::Outcome::Failed)
    );
    let rollup = pr.status_check_rollup.as_mut().unwrap();
    rollup.remove(1);
    assert_eq!(
        pr.checks_outcome(),
        Some(crate::pull_request::Outcome::Pending)
    );
    pr.status_check_rollup.as_mut().unwrap().pop();
    assert_eq!(
        pr.checks_outcome(),
        Some(crate::pull_request::Outcome::Passed)
    );
    pr.status_check_rollup = None;
    assert_eq!(pr.checks_outcome(), None);
}
