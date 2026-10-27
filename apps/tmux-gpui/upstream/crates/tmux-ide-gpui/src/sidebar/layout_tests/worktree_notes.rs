use super::*;
use crate::{
    menu::{Page, WorkspaceAction},
    worktree_notes::{Checkout, Notes},
};

const BRANCH: &str = "worktree/sidebar-child";

/// A connected window over six workspaces, three of them one repository's
/// checkouts.
fn connected(window: &mut Window, cx: &mut Context<HerdrWindow>) -> HerdrWindow {
    let mut view = fixture_window(window, cx);
    view.live.snapshot = Some(Arc::new(snapshot(6)));
    view.live.status = crate::state::ConnectionStatus::Connected;
    view.live.supports_surface = true;
    view.endpoints[0].live = view.live.clone();
    view
}

fn checkout() -> Checkout {
    Checkout {
        endpoint: crate::endpoint::LOCAL.into(),
        repo_key: REPO_KEY.into(),
        branch: BRANCH.into(),
    }
}

#[gpui::test]
fn a_note_marks_its_row_and_reads_on_a_line_beneath_it(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| connected(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    cx.simulate_resize(size(px(800.), px(700.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let row = cx.debug_bounds("row-sidebar-child").unwrap();
    let next = "row-sidebar-child-with-a-long-readable-branch-name";
    let below = cx.debug_bounds(next).unwrap();
    assert!(cx.debug_bounds("note-line-local-w4").is_none());
    assert!(cx.debug_bounds("note-sidebar-child").is_none());

    cx.update(|_, cx| {
        Notes::update(cx, |notes| notes.set(checkout(), "wait for the FX PR"));
    });
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let line = cx.debug_bounds("note-line-local-w4").unwrap();
    assert!(cx.debug_bounds("note-sidebar-child").is_some());
    // The row keeps its size; the note takes a line of its own beneath it,
    // and the rows after it make room.
    assert_eq!(cx.debug_bounds("row-sidebar-child").unwrap(), row);
    assert_eq!(line.top(), row.bottom());
    assert!(line.left() >= row.left() && line.right() <= row.right());
    assert_eq!(
        cx.debug_bounds(next).unwrap().top(),
        below.top() + line.size.height
    );
    // Only the noted checkout carries it.
    assert!(cx.debug_bounds("note-line-local-w5").is_none());

    // The line opens the note to edit, with the note as its draft.
    cx.simulate_click(line.center(), Modifiers::default());
    cx.run_until_parked();
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.page, Some(Page::Dialog(WorkspaceAction::Note)));
        assert_eq!(
            view.menu.input.as_ref().map(|input| input.text.as_str()),
            Some("wait for the FX PR")
        );
    });
    cx.simulate_keystrokes("backspace");
    cx.simulate_input("rebase first");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    cx.update(|_, cx| {
        assert!(view.read(cx).menu.page.is_none());
        let notes = Notes::of(cx).unwrap();
        assert_eq!(
            notes.get(crate::endpoint::LOCAL, REPO_KEY, BRANCH),
            Some("rebase first")
        );
    });

    // Saving it empty removes the note, and the line with it.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.edit_worktree_note(
                crate::endpoint::LOCAL,
                "w4",
                point(px(0.), px(0.)),
                window,
                cx,
            )
        })
    });
    cx.simulate_keystrokes("backspace enter");
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("note-line-local-w4").is_none());
    assert_eq!(cx.debug_bounds(next).unwrap(), below);
}

#[gpui::test]
fn only_git_checkouts_on_a_branch_offer_a_note(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(connected);
    for (workspace, offered) in [("w0", false), ("w3", true), ("w4", true)] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.open_workspace_menu(workspace, point(px(0.), px(0.)), window, cx);
                assert_eq!(view.menu.page, Some(Page::Workspace), "{workspace}");
                assert_eq!(
                    crate::menu::workspace_tests::offers_note(view),
                    offered,
                    "{workspace}"
                );
                view.dismiss_menu(window, cx);
            })
        });
    }
    // The shortcut says why a plain folder has none, rather than doing nothing.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.focused_workspace_id = Some("w0".into());
            view.edit_focused_worktree_note(window, cx);
            assert!(view.menu.page.is_none());
            assert!(view.flash.is_some());
        })
    });
}
