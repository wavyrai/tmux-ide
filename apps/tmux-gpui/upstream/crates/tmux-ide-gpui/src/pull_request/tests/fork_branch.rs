use super::*;
use crate::{pull_request::parse_numbered, repo_items::fork_branch_number};

fn numbered(pr: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"data":{"repository":{"squashMergeAllowed":true,"pullRequest":pr}}})
}

fn fork_pr() -> serde_json::Value {
    let mut pr = response()[0].clone();
    pr["headRefName"] = "fix/plugin-shortcut-reference".into();
    pr["isCrossRepository"] = true.into();
    pr["headRepositoryOwner"] = serde_json::json!({"login":"contributor"});
    pr["headRepository"] = serde_json::json!({"name":"project"});
    pr
}

#[test]
fn fork_branch_names_carry_only_a_canonical_number() {
    assert_eq!(fork_branch_number("pr/285"), Some(285));
    for branch in [
        "pr/", "pr/0", "pr/012", "pr/12a", "pr/+1", "pr/1/x", "pr285", "feature",
    ] {
        assert_eq!(fork_branch_number(branch), None, "{branch}");
    }
}

#[test]
fn fork_branch_finds_its_pull_request_by_number() {
    let pr = parse_numbered(numbered(fork_pr()), "example", "project", 8)
        .unwrap()
        .unwrap();
    assert_eq!(pr.number, 8);
    assert_eq!(pr.url, "https://github.com/example/project/pull/8");
    assert_eq!(pr.head_ref_name, "fix/plugin-shortcut-reference");
    assert_eq!(pr.merge_methods, [crate::pull_request::MergeMethod::Squash]);
}

#[test]
fn fork_branch_rejects_same_repository_missing_and_mismatched_pulls() {
    assert!(
        parse_numbered(numbered(serde_json::Value::Null), "example", "project", 8)
            .unwrap()
            .is_none()
    );
    // A same-repository PR has a real branch name, so `pr/8` was not made for it.
    let mut same = fork_pr();
    same["isCrossRepository"] = false.into();
    assert!(
        parse_numbered(numbered(same), "example", "project", 8)
            .unwrap()
            .is_none()
    );
    let mut deleted = fork_pr();
    deleted["headRepository"] = serde_json::Value::Null;
    assert!(
        parse_numbered(numbered(deleted), "example", "project", 8)
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        parse_numbered(numbered(fork_pr()), "example", "project", 9),
        Err(Error::PrIdentity)
    ));
    let mut elsewhere = fork_pr();
    elsewhere["url"] = "https://github.com/other/project/pull/8".into();
    assert!(matches!(
        parse_numbered(numbered(elsewhere), "example", "project", 8),
        Err(Error::PrIdentity)
    ));
}
