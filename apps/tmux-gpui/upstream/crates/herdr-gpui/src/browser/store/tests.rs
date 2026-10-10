#![allow(clippy::unwrap_used)]
use super::*;

fn url(value: &str) -> Option<Location> {
    Some(Location::Web {
        url: super::super::WebUrl::try_from(value).unwrap(),
    })
}

#[test]
fn tabs_belong_to_one_workspace_of_one_daemon() {
    let mut store = Store::default();
    let local = Scope::local("/tmp/herdr-client.sock".as_ref());
    let remote = Scope::endpoint("ssh:box");
    let a = store
        .open(local.clone(), "w_1", url("http://localhost:3000"), None)
        .unwrap();
    let b = store
        .open(remote.clone(), "w_1", url("https://example.com/"), None)
        .unwrap();
    assert_ne!(a, b);
    let ids = |scope, workspace| {
        store
            .in_workspace(scope, workspace)
            .map(|tab| tab.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&local, "w_1"), [a]);
    assert_eq!(ids(&remote, "w_1"), [b]);
    assert!(ids(&local, "w_2").is_empty());
    assert_eq!(store.get(a).unwrap().title, "localhost");
    let blank = store.open(local, "w_1", None, None).unwrap();
    assert_eq!(store.get(blank).unwrap().title, "New Tab");
}

#[test]
fn a_moved_tab_lands_beside_another_of_its_workspace() {
    let mut store = Store::default();
    let scope = Scope::endpoint("local");
    let open =
        |store: &mut Store, workspace| store.open(scope.clone(), workspace, None, None).unwrap();
    let a = open(&mut store, "w_1");
    let other = open(&mut store, "w_2");
    let b = open(&mut store, "w_1");
    let c = open(&mut store, "w_1");
    let ids = |store: &Store| {
        store
            .in_workspace(&scope, "w_1")
            .map(|tab| tab.id)
            .collect::<Vec<_>>()
    };
    assert!(store.move_tab(c, Beside::Before(a)));
    assert_eq!(ids(&store), [c, a, b]);
    assert!(store.move_tab(c, Beside::After(b)));
    assert_eq!(ids(&store), [a, b, c]);
    // Where it already stands, beside itself, or beside a missing tab,
    // nothing moves.
    assert!(!store.move_tab(c, Beside::After(b)));
    assert!(!store.move_tab(b, Beside::Before(b)));
    assert!(!store.move_tab(b, Beside::Before(TabId::test(999))));
    assert_eq!(ids(&store), [a, b, c]);
    assert_eq!(
        store
            .in_workspace(&scope, "w_2")
            .map(|tab| tab.id)
            .collect::<Vec<_>>(),
        [other]
    );
}

#[test]
fn visits_update_address_and_a_clean_title() {
    let mut store = Store::default();
    let scope = Scope::endpoint("local");
    let id = store
        .open(scope, "w_1", url("https://a.test/"), None)
        .unwrap();
    assert!(store.visited(id, url("https://b.test/x"), Some(" Docs\u{7}\n ")));
    let tab = store.get(id).unwrap();
    assert_eq!(tab.location, url("https://b.test/x"));
    assert_eq!(tab.title, "Docs");
    assert!(!store.visited(id, None, Some("")));
    assert!(!store.visited(id, None, Some("Docs")));
    assert!(store.visited(id, None, Some("\u{202e}txt.exe")));
    assert_eq!(store.get(id).unwrap().title, "txt.exe");
    let long = "x".repeat(MAX_TITLE_CHARS * 2);
    assert!(store.visited(id, None, Some(&long)));
    assert_eq!(store.get(id).unwrap().title.len(), MAX_TITLE_CHARS);
}

#[test]
fn closing_a_workspace_only_touches_the_named_daemon() {
    let mut store = Store::default();
    let (one, two) = (Scope::endpoint("local"), Scope::endpoint("ssh:x"));
    let gone = store
        .open(one.clone(), "w_gone", url("https://a.test/"), None)
        .unwrap();
    let kept = store
        .open(one.clone(), "w_1", url("https://a.test/"), None)
        .unwrap();
    let other = store
        .open(two, "w_gone", url("https://a.test/"), None)
        .unwrap();
    let closed = ["w_gone".to_owned()];
    assert!(store.has_workspaces(&one, &closed));
    assert!(store.forget_workspaces(&one, &closed));
    assert!(!store.has_workspaces(&one, &closed));
    assert!(!store.forget_workspaces(&one, &closed));
    assert!(store.get(gone).is_none());
    assert!(store.get(kept).is_some() && store.get(other).is_some());
    assert!(store.close(kept).is_some());
    assert!(store.close(kept).is_none());
}

#[test]
fn saved_tabs_round_trip_and_invalid_files_are_rejected() {
    let mut store = Store::default();
    let id = store
        .open(
            Scope::endpoint("local"),
            "w_1",
            url("https://a.test/"),
            None,
        )
        .unwrap();
    let bytes = serde_json::to_vec(&Saved {
        tabs: store.tabs.clone(),
    })
    .unwrap();
    let restored = Store::with_tabs(parse(&bytes).unwrap(), None);
    assert_eq!(restored.tabs, store.tabs);
    // New tabs never reuse a restored ID.
    assert!(restored.next > id.0);
    for invalid in [
        r#"{"tabs":[{"id":0,"scope":"local","workspace_id":"w","location":{"kind":"web","url":"file:///etc/passwd"},"title":""}]}"#,
        r#"{"tabs":[{"id":0,"scope":"local","workspace_id":"","location":{"kind":"web","url":"https://a.test/"},"title":""}]}"#,
        r#"{"tabs":[{"id":0,"scope":"local","workspace_id":"w","location":null,"title":"","origin":""}]}"#,
        r#"{"tabs":"#,
    ] {
        assert!(parse(invalid.as_bytes()).is_err(), "{invalid}");
    }
}

#[test]
fn an_agent_reopening_its_page_reuses_the_tab() {
    let mut store = Store::default();
    let scope = Scope::endpoint("local");
    let page = url("https://a.test/");
    let mine = store
        .open(scope.clone(), "w_1", page.clone(), Some("w_1:p1".into()))
        .unwrap();
    let theirs = store
        .open(scope.clone(), "w_1", page.clone(), Some("w_1:p2".into()))
        .unwrap();
    let page = page.unwrap();
    assert_eq!(
        store.opened_before(&scope, "w_1", Some("w_1:p1"), &page),
        Some(mine)
    );
    assert_eq!(
        store.opened_before(&scope, "w_1", Some("w_1:p2"), &page),
        Some(theirs)
    );
    assert_eq!(store.opened_before(&scope, "w_1", None, &page), None);
    assert_eq!(
        store.opened_before(&scope, "w_2", Some("w_1:p1"), &page),
        None
    );
    let ids: Vec<_> = store.opened_by("w_1:p1").map(|tab| tab.id).collect();
    assert_eq!(ids, [mine]);
}

#[test]
fn the_store_is_bounded() {
    let mut store = Store::default();
    for _ in 0..MAX_TABS {
        assert!(
            store
                .open(Scope::endpoint("local"), "w", url("https://a.test/"), None)
                .is_some()
        );
    }
    assert!(
        store
            .open(Scope::endpoint("local"), "w", url("https://a.test/"), None)
            .is_none()
    );
}
