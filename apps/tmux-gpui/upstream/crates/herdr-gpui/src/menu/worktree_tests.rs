#![allow(clippy::unwrap_used)]

use super::{
    Page, WorkspaceAction,
    worktree_source::{Pending, Tab, item_request, pick_request},
};
use crate::{
    HerdrWindow,
    repo_items::{Branch, Item, Kind, Origin},
    sidebar,
};
use gpui::{Entity, VisualTestContext};

mod branch_only;
mod dialog_entry;
mod github_listings;
mod local_listings;
mod name_field;

fn origin() -> Origin {
    Origin {
        owner: "penso".into(),
        repo: "herdr-gpui".into(),
    }
}

fn items() -> Vec<Item> {
    vec![
        Item {
            kind: Kind::PullRequest,
            number: 48,
            title: "Centre the worktree dialog".into(),
            url: "https://github.com/penso/herdr-gpui/pull/48".into(),
            author: "penso".into(),
            head: Some("worktree/rapid-forest".into()),
            fork_owner: None,
            draft: false,
        },
        Item {
            kind: Kind::PullRequest,
            number: 51,
            title: "Fork contribution".into(),
            url: "https://github.com/penso/herdr-gpui/pull/51".into(),
            author: "outsider".into(),
            head: Some("patch-1".into()),
            fork_owner: Some("outsider".into()),
            draft: true,
        },
        Item {
            kind: Kind::Issue,
            number: 1255,
            title: "bug: agent end message is empty".into(),
            url: "https://github.com/penso/herdr-gpui/issues/1255".into(),
            author: "penso".into(),
            head: None,
            fork_owner: None,
            draft: false,
        },
    ]
}

/// Open the new worktree dialog on the repository workspace, already on `tab`
/// and with a listing in hand, so the tabs never reach GitHub or the disk.
fn open_dialog(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, connected: bool, tab: Tab) {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
            view.live.status = crate::state::ConnectionStatus::Connected;
            // The listing reads a checkout, so it is owned-local-socket only.
            view.live.local_daemon_peer = true;
            view.menu.reset();
            view.menu.github = if connected {
                crate::github::Auth::connected_fixture()
            } else {
                Default::default()
            };
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
            if connected {
                let source = view.menu.worktree.as_mut().unwrap();
                source.install(origin(), items());
                view.select_worktree_tab(tab, window, cx);
            }
        });
    });
    draw(cx);
}

/// GPUI double-buffers frames and their debug bounds, so a selector that was
/// painted two frames ago is still readable. Draw both buffers before asking
/// whether something is on screen.
fn draw(cx: &mut VisualTestContext) {
    for _ in 0..2 {
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
        });
    }
}

fn tab(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) -> Tab {
    cx.update(|_, cx| view.read(cx).menu.worktree.as_ref().unwrap().tab)
}
