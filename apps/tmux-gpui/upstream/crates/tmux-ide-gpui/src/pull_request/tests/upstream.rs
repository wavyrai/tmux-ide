use super::*;

#[test]
fn upstream_matches_renamed_fork_branch_and_rejects_unrelated_heads() {
    let head = super::super::fetch::upstream_head("pr/138", |key| {
        Ok(match key {
            "branch.pr/138.remote" => Some("contributor".into()),
            "branch.pr/138.merge" => Some("refs/heads/feat/inline-ime-preedit".into()),
            "remote.contributor.url" => Some("git@github.com:renga-kogahara/herdr-gpui.git".into()),
            _ => panic!("unexpected config read: {key}"),
        })
    })
    .unwrap()
    .unwrap();
    assert_eq!(head.branch, "feat/inline-ime-preedit");
    let mut pr = response()[0].clone();
    pr["headRefName"] = head.branch.clone().into();
    pr["headRepositoryOwner"] = serde_json::json!({"login":"renga-kogahara"});
    pr["headRepository"] = serde_json::json!({"name":"herdr-gpui"});
    let graphql =
        |nodes| serde_json::json!({"data":{"repository":{"pullRequests":{"nodes":nodes}}}});
    let parse = |nodes| {
        parse_graphql(
            graphql(nodes),
            "example",
            "project",
            &head.branch,
            Some(&head),
        )
    };
    let mut stranger = pr.clone();
    stranger["headRepositoryOwner"] = serde_json::json!({"login":"stranger"});
    assert!(parse(serde_json::json!([stranger])).unwrap().is_none());
    assert_eq!(
        parse(serde_json::json!([stranger, pr]))
            .unwrap()
            .unwrap()
            .number,
        8
    );
    let mut wrong_repo = pr.clone();
    wrong_repo["headRepository"] = serde_json::json!({"name":"different-fork"});
    assert!(parse(serde_json::json!([wrong_repo])).unwrap().is_none());
    let mut wrong_branch = pr.clone();
    wrong_branch["headRefName"] = "pr/138".into();
    assert!(parse(serde_json::json!([wrong_branch])).unwrap().is_none());
    assert!(matches!(
        parse(serde_json::json!([pr, pr])),
        Err(Error::PrAmbiguous)
    ));
    let mut truncated = graphql(serde_json::json!([pr]));
    truncated["data"]["repository"]["pullRequests"]["pageInfo"] =
        serde_json::json!({"hasNextPage":true});
    assert!(matches!(
        parse_graphql(truncated, "example", "project", &head.branch, Some(&head)),
        Err(Error::PrAmbiguous)
    ));
}

#[test]
fn no_upstream_preserves_origin_owner_and_local_branch_matching() {
    let head = super::super::fetch::upstream_head("feature", |_| Ok(None)).unwrap();
    assert!(head.is_none());
    let graphql =
        |nodes| serde_json::json!({"data":{"repository":{"pullRequests":{"nodes":nodes}}}});
    assert!(
        parse_graphql(
            graphql(response()),
            "example",
            "project",
            "feature",
            head.as_ref()
        )
        .unwrap()
        .is_some()
    );
    let mut fork = response();
    fork[0]["headRepositoryOwner"] = serde_json::json!({"login":"stranger"});
    assert!(matches!(
        parse_graphql(graphql(fork), "example", "project", "feature", None),
        Err(Error::PrIdentity)
    ));
    assert!(matches!(
        parse_graphql(graphql(response()), "example", "project", "pr/138", None),
        Err(Error::PrIdentity)
    ));
}

#[test]
fn unsupported_upstream_and_config_errors_do_not_fall_back() {
    for merge in ["refs/heads/feature", "refs/pull/138/head"] {
        assert!(
            super::super::fetch::upstream_head("feature", |key| Ok(Some(
                match key {
                    "branch.feature.remote" => "fork",
                    "branch.feature.merge" => merge,
                    "remote.fork.url" => "https://other.example/owner/repo.git",
                    _ => panic!("unexpected key"),
                }
                .into()
            )))
            .is_err()
        );
    }
    assert!(matches!(
        super::super::fetch::upstream_head("feature", |_| Err(Error::PrCancelled)),
        Err(Error::PrCancelled)
    ));
}
