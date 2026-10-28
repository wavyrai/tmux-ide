#![allow(clippy::unwrap_used)]
use super::*;
use crate::pull_request::fixture;
use serde_json::json;

fn target() -> Target {
    Target::try_from(&fixture().unwrap()).unwrap()
}

fn token() -> Arc<SecretString> {
    Arc::new("fixture-token".into())
}

fn tracked() -> Actions {
    let mut actions = Actions::default();
    actions.track(Some(target()));
    actions
}

#[test]
fn a_target_comes_only_from_an_open_pull_request_with_its_identity() {
    let target = target();
    assert_eq!(
        (target.owner.as_str(), target.repo.as_str(), target.number),
        ("example", "project", 8)
    );
    let mut pr = fixture().unwrap();
    pr.state = State::Merged;
    assert!(matches!(Target::try_from(&pr), Err(Error::PrActionTarget)));
    for strip in [
        |pr: &mut PullRequest| pr.id.clear(),
        |pr: &mut PullRequest| pr.head_ref_oid.clear(),
        |pr: &mut PullRequest| pr.url = "https://example.com/example/project/pull/8".into(),
        |pr: &mut PullRequest| pr.url = "https://github.com/example/project/pull/9".into(),
        |pr: &mut PullRequest| pr.url = "https://github.com/example/project/pull/8/x".into(),
    ] {
        let mut pr = fixture().unwrap();
        strip(&mut pr);
        assert!(matches!(Target::try_from(&pr), Err(Error::PrActionTarget)));
    }
}

#[test]
fn a_merge_sends_one_mutation_naming_the_seen_head_and_is_not_retried() {
    let target = target();
    let mut sent = Vec::new();
    let result = perform(
        &target,
        Action::Merge(MergeMethod::Squash),
        |context, query, variables| {
            sent.push((context, query.to_owned(), variables));
            Err(Error::GitHubRejected("Head branch was modified".into()))
        },
    );
    assert!(
        matches!(result, Err(Error::GitHubRejected(reason)) if reason == "Head branch was modified")
    );
    assert_eq!(sent.len(), 1, "a refused merge is never sent again");
    let (context, query, variables) = &sent[0];
    assert_eq!(*context, "pr_merge");
    assert!(query.contains("expectedHeadOid"));
    assert_eq!(
        variables,
        &json!({
            "id": "PR_kwDOfixture8",
            "method": "SQUASH",
            "head": "0123456789abcdef0123456789abcdef01234567",
        })
    );
}

#[test]
fn a_merge_reply_must_name_the_same_pull_request() {
    let target = target();
    let reply = |state: &str, url: &str| json!({"data": {"mergePullRequest": {"pullRequest": {"state": state, "url": url}}}});
    let done = merged(&reply("MERGED", &target.url), &target).unwrap();
    assert_eq!(done.message, "Merged pull request #8");
    assert_eq!(done.url.as_deref(), Some(target.url.as_str()));
    let queued = merged(&reply("OPEN", &target.url), &target).unwrap();
    assert!(queued.message.contains("not merged yet"));
    assert!(matches!(
        merged(
            &reply("MERGED", "https://github.com/example/project/pull/9"),
            &target
        ),
        Err(Error::PrIdentity)
    ));
}

#[test]
fn a_posted_comment_is_a_success_even_when_its_link_is_unexpected() {
    let target = target();
    let mut sends = 0;
    let reply =
        |url: &str| json!({"data": {"addComment": {"commentEdge": {"node": {"url": url}}}}});
    let outcome = perform(
        &target,
        Action::Comment("Looks good".into()),
        |context, _, variables| {
            sends += 1;
            assert_eq!(context, "pr_comment");
            assert_eq!(
                variables,
                json!({"subject": "PR_kwDOfixture8", "body": "Looks good"})
            );
            Ok(reply(&format!("{}#issuecomment-42", target.url)))
        },
    )
    .unwrap();
    assert_eq!(sends, 1);
    assert_eq!(outcome.message, "Commented on pull request #8");
    assert!(outcome.url.unwrap().ends_with("#issuecomment-42"));
    for url in [
        "https://evil.example/#issuecomment-42",
        "https://github.com/example/project/pull/8#issuecomment-",
        "https://github.com/example/project/pull/8#issuecomment-4x",
    ] {
        let outcome = commented(&reply(url), &target);
        assert_eq!(outcome.message, "Commented on pull request #8");
        assert_eq!(outcome.url, None, "{url}");
    }
}

#[test]
fn the_conversation_is_cleaned_bounded_ordered_and_fenced_by_identity() {
    let target = target();
    let long = "x".repeat(2000);
    let response = json!({"data": {"repository": {"pullRequest": {
        "id": "PR_kwDOfixture8",
        "comments": {"nodes": [
            {"author": {"login": "alice"}, "body": "line one\nline\u{202e}two\u{1b}[31m", "createdAt": "2026-09-20T12:00:03Z"},
            {"author": null, "body": long, "createdAt": "2026-09-20T12:00:01Z"},
        ]},
        "reviews": {"nodes": [
            {"author": {"login": "bob"}, "state": "APPROVED", "body": "", "submittedAt": "2026-09-20T12:00:04Z"},
            {"author": {"login": "bob"}, "state": "COMMENTED", "body": "", "submittedAt": "2026-09-20T12:00:05Z"},
            {"author": {"login": "carol"}, "state": "PENDING", "body": "draft", "submittedAt": null},
        ]},
        "reviewThreads": {"nodes": [
            {"isResolved": true, "path": "src/main.rs", "comments": {"totalCount": 3, "nodes": [
                {"author": {"login": "dave"}, "body": "nit", "createdAt": "2026-09-20T12:00:02Z"}
            ]}},
            {"isResolved": false, "path": "src/empty.rs", "comments": {"totalCount": 0, "nodes": []}},
        ]},
    }}}});
    let comments = parse_conversation(&response, &target).unwrap();
    let authors: Vec<_> = comments.iter().map(|c| c.author.as_str()).collect();
    assert_eq!(authors, ["ghost", "dave", "alice", "bob"]);
    assert_eq!(comments[0].body.chars().count(), 512);
    assert_eq!(comments[2].body, "line one line two [31m");
    assert_eq!(
        comments[1].kind.label(),
        "on src/main.rs, 2 replies (resolved)"
    );
    assert_eq!(comments[3].kind, CommentKind::Review(Review::Approved));
    assert!(
        comments
            .iter()
            .all(|c| !c.body.chars().any(char::is_control))
    );

    let mut other = response.clone();
    other["data"]["repository"]["pullRequest"]["id"] = json!("PR_other");
    assert!(matches!(
        parse_conversation(&other, &target),
        Err(Error::PrIdentity)
    ));

    let many: Vec<_> = (0..60)
        .map(|i| json!({"author": {"login": "a"}, "body": format!("{i}"), "createdAt": format!("2026-09-20T12:{i:02}:00Z")}))
        .collect();
    let mut flood = response;
    flood["data"]["repository"]["pullRequest"]["comments"]["nodes"] = json!(many);
    let comments = parse_conversation(&flood, &target).unwrap();
    assert_eq!(comments.len(), COMMENT_LIMIT);
    assert_eq!(comments.last().unwrap().body, "59", "the newest are kept");
}

#[test]
fn actions_are_validated_before_they_are_queued_and_never_overlap() {
    let mut actions = Actions::default();
    assert!(matches!(
        actions.start(Action::Comment("hi".into()), &[], token()),
        Err(Error::PrActionTarget)
    ));
    let mut actions = tracked();
    for body in ["", "   ", &"x".repeat(BODY_LIMIT + 1)] {
        assert!(matches!(
            actions.start(Action::Comment(body.into()), &[], token()),
            Err(Error::PrCommentBody)
        ));
    }
    assert!(matches!(
        actions.start(
            Action::Merge(MergeMethod::Rebase),
            &[MergeMethod::Squash],
            token()
        ),
        Err(Error::PrMergeMethod)
    ));
    assert!(actions.running().is_none());
    actions
        .start(
            Action::Merge(MergeMethod::Squash),
            &[MergeMethod::Squash],
            token(),
        )
        .unwrap();
    assert_eq!(actions.running(), Some(&Action::Merge(MergeMethod::Squash)));
    assert!(matches!(
        actions.start(Action::Comment("again".into()), &[], token()),
        Err(Error::PrActionBusy)
    ));
    assert!(matches!(
        actions.load_comments(token()),
        Err(Error::PrActionBusy)
    ));
}

#[test]
fn a_comment_is_trimmed_and_a_queued_read_yields_to_it() {
    let mut actions = tracked();
    actions.load_comments(token()).unwrap();
    assert!(actions.loading());
    actions
        .start(Action::Comment("  ship it  ".into()), &[], token())
        .unwrap();
    assert!(!actions.loading());
    assert_eq!(actions.running(), Some(&Action::Comment("ship it".into())));
    assert!(matches!(
        actions.waiting,
        Some((_, Job::Run(Action::Comment(ref body)), _)) if body == "ship it"
    ));
}

#[test]
fn another_pull_request_drops_the_conversation_but_a_new_head_does_not() {
    let mut actions = tracked();
    actions.comments = Some(Vec::new());
    actions.outcome = Some(Outcome {
        message: "Commented on pull request #8".into(),
        url: None,
    });
    let generation = actions.generation.load(Ordering::Relaxed);
    let mut pushed = fixture().unwrap();
    pushed.head_ref_oid = "f".repeat(40);
    actions.track(Some(Target::try_from(&pushed).unwrap()));
    assert!(actions.comments().is_some());
    assert_eq!(actions.generation.load(Ordering::Relaxed), generation);
    assert_eq!(actions.target().unwrap().head, "f".repeat(40));

    actions.load_comments(token()).unwrap();
    let mut other = fixture().unwrap();
    other.number = 9;
    other.url = "https://github.com/example/project/pull/9".into();
    actions.track(Some(Target::try_from(&other).unwrap()));
    assert!(actions.comments().is_none());
    assert!(actions.outcome().is_none());
    assert!(!actions.loading());
    assert!(actions.waiting.is_none(), "the old read is not sent");
    assert!(actions.generation.load(Ordering::Relaxed) > generation);
}

#[test]
fn a_running_action_keeps_its_place_when_the_pull_request_changes() {
    let mut actions = tracked();
    actions
        .start(
            Action::Merge(MergeMethod::Merge),
            &MergeMethod::ALL,
            token(),
        )
        .unwrap();
    actions.track(None);
    assert!(actions.running().is_some());
    assert!(
        matches!(actions.waiting, Some((_, Job::Run(_), _))),
        "an explicit action is not dropped"
    );
}

#[test]
fn a_lost_worker_reports_instead_of_resending() {
    let mut actions = tracked();
    actions
        .start(Action::Comment("hello".into()), &[], token())
        .unwrap();
    // Simulate the request reaching a worker that then died.
    actions.waiting = None;
    actions.busy = true;
    let (requests, _) = mpsc::sync_channel(1);
    let (_, results) = mpsc::sync_channel(1);
    actions.worker = Some(Worker { requests, results });
    assert!(actions.poll());
    assert!(actions.running().is_none());
    assert!(actions.waiting.is_none());
    assert!(actions.take_settled());
    assert_eq!(
        actions.error(),
        Some(Error::PrActionWorker.to_string().as_str())
    );
}
