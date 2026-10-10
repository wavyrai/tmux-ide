use super::*;
use crate::worktree_notes::{Checkout, Notes};

fn note(cx: &mut App, endpoint: &str, branch: &str, text: &str) {
    Notes::update(cx, |notes| {
        notes.set(
            Checkout {
                endpoint: endpoint.into(),
                repo_key: "repo/main".into(),
                branch: branch.into(),
            },
            text,
        )
    });
}

fn listed(view: &HerdrWindow) -> Vec<(String, String, Action)> {
    let palette = view.menu.palette.as_ref().unwrap();
    palette
        .filtered
        .iter()
        .map(|hit| &palette.entries[hit.index])
        .map(|entry| {
            (
                entry.label.to_string(),
                entry.detail.to_string(),
                entry.action.clone(),
            )
        })
        .collect()
}

#[gpui::test]
fn the_notes_filter_lists_open_noted_checkouts_and_goes_to_them(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut remote = crate::endpoint::Endpoint::new(
            "ssh:box".into(),
            "Box".into(),
            herdr_client::ConnectTarget::Ssh {
                target: "unused".into(),
                session: "default".into(),
            },
            true,
        );
        remote.live.snapshot = Some(Arc::new(snapshot()));
        remote.live.status = crate::state::ConnectionStatus::Connected;
        view.endpoints.push(remote);
        view
    });
    cx.update(|window, cx| {
        // A note on a branch no workspace has open has nowhere to go.
        note(cx, "ssh:box", "gone", "closed long ago");
        note(cx, "ssh:box", "main", "waiting on the FX rates PR");
        view.update(cx, |view, cx| view.open_palette(Filter::Notes, window, cx));
    });
    cx.run_until_parked();
    view.update_in(cx, |view, window, cx| {
        let rows = listed(view);
        assert_eq!(
            rows.len(),
            1,
            "{:?}",
            rows.iter().map(|r| &r.0).collect::<Vec<_>>()
        );
        let (label, detail, action) = rows.into_iter().next().unwrap();
        assert_eq!(label, "repo");
        assert_eq!(detail, "Box  waiting on the FX rates PR");
        assert!(matches!(
            &action,
            Action::Note { endpoint, workspace, .. }
                if endpoint == "ssh:box" && workspace == "w1"
        ));
        // Go To leaves note rows to their own filter.
        view.set_palette_filter(Filter::Navigation, cx);
        assert!(
            listed(view)
                .iter()
                .all(|(_, _, action)| matches!(action, Action::Go { .. }))
        );
        view.activate_palette(action, window, cx);
        assert!(view.menu.page.is_none(), "a valid row closes the picker");
        assert_eq!(view.endpoints[view.selected_endpoint].id, "ssh:box");
        // The host has no connection yet, so navigation waits for it.
        assert_eq!(
            view.pending_navigation,
            Some(NavigationTarget::Workspace("w1".into()))
        );
    });
}

#[gpui::test]
fn the_note_text_is_searchable_from_the_whole_palette(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        note(
            cx,
            crate::endpoint::LOCAL,
            "main",
            "rebase after the currency refactor",
        );
        view.update(cx, |view, cx| view.open_palette(Filter::All, window, cx));
    });
    cx.simulate_input("currency refactor");
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let rows = listed(view);
        assert!(matches!(rows.first(), Some((_, _, Action::Note { .. }))));
    });
}

#[gpui::test]
fn an_open_palette_lists_a_note_added_after_it_opened(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.open_palette(Filter::Notes, window, cx))
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| assert!(listed(view).is_empty()));
    // As another window's dialog would: only the shared notes change.
    cx.update(|_, cx| note(cx, crate::endpoint::LOCAL, "main", "added elsewhere"));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let rows = listed(view);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "added elsewhere");
    });
}
