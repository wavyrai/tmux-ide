//! A review lives in a tab: opened once per checkout, restored with the
//! other tabs, and gone when its tab closes.
use super::window;
use crate::browser::{Location, ReviewCheckout, Store, scope};

fn checkout() -> ReviewCheckout {
    ReviewCheckout {
        repo_key: "/work/repo/.git".into(),
        branch: "feature".into(),
        checkout: Some("/work/repo".into()),
    }
}

#[gpui::test]
fn a_restored_review_tab_gets_its_state_and_a_closed_one_loses_it(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    // A review tab as the last run saved it: in the store, with no state.
    let id = cx.update(|_, cx| {
        let tab_scope = scope(&view.read(cx).endpoints[0]);
        Store::update(cx, |store| {
            store.open(
                tab_scope,
                "w0",
                Some(Location::Review {
                    checkout: checkout(),
                }),
                None,
            )
        })
        .unwrap()
    });
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            assert!(view.reviews.is_empty());
            view.poll_reviews(cx);
            // Made and reading; the next tick does not make another.
            assert_eq!(view.reviews.len(), 1);
            let request = view.reviews[&id].request;
            assert!(request > 0, "a read started");
            view.poll_reviews(cx);
            assert_eq!(view.reviews[&id].request, request);
        })
    });
    cx.update(|_, cx| {
        Store::update(cx, |store| store.close(id));
        view.update(cx, |view, cx| {
            view.poll_reviews(cx);
            assert!(view.reviews.is_empty());
        })
    });
}

#[test]
fn saved_review_tabs_are_checked_when_read() {
    // Absolute on every platform: Windows needs a drive, Unix a root.
    let root = std::env::temp_dir().join("repo");
    let repo = root.join(".git");
    let (root, repo) = (root.to_str().unwrap(), repo.to_str().unwrap());
    let saved = |repo_key: &str, branch: &str, checkout: Option<&str>| {
        serde_json::json!({
            "kind": "review",
            "checkout": { "repo_key": repo_key, "branch": branch, "checkout": checkout },
        })
        .to_string()
    };
    let location: Location = serde_json::from_str(&saved(repo, "main", Some(root))).unwrap();
    assert!(!location.is_page());
    assert_eq!(location.default_title(), "Review \u{00b7} main");
    for bad in [
        saved("relative", "main", None),
        saved(repo, "", None),
        saved(repo, "a\nb", None),
        saved(repo, "main", Some("relative")),
    ] {
        assert!(serde_json::from_str::<Location>(&bad).is_err(), "{bad}");
    }
}
