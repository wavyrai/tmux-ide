//! Swapping panes by dragging a header, in a drawn window.
use super::*;
use crate::tmux_snapshot::pending_input::Target as InputTarget;

/// Two panes side by side, the left one selected.
fn side_by_side(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let mut view = make_view(window, cx, sender);
    let mut frame = view.frame.as_ref().unwrap().legacy().as_ref().clone();
    frame.width = 40;
    frame.height = 20;
    let mut blank = frame.cells[0].clone();
    blank.symbol = " ".into();
    blank.modifier = 0;
    blank.skip = false;
    frame.cells = vec![blank; 800];
    frame.cursor = None;
    frame.graphics.clear();
    let frame = Arc::new(frame);
    let display = || crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(frame.clone());
    view.frame = Some(display());
    view.painted_frame = Some(display());
    view.browser_state.frame = Some(display());
    view.browser_state.panes = vec![choice("pane-a", "Editor"), choice("pane-b", "Tests")];
    view.browser_state.regions = left_right();
    view.browser_state.selected_pane = Some("pane-a".into());
    view.browser_state.input_targets = vec![
        InputTarget {
            id: "pane-a".into(),
            token: "a-token".into(),
        },
        InputTarget {
            id: "pane-b".into(),
            token: "b-token".into(),
        },
    ];
    view
}

fn left_right() -> Vec<crate::tmux_snapshot::hit_regions::Region> {
    serde_json::from_str(r#"[{"id":"pane-a","left":0,"top":0,"width":19,"height":20},{"id":"pane-b","left":20,"top":0,"width":20,"height":20}]"#).unwrap()
}

fn right_left() -> Vec<crate::tmux_snapshot::hit_regions::Region> {
    serde_json::from_str(r#"[{"id":"pane-b","left":0,"top":0,"width":19,"height":20},{"id":"pane-a","left":20,"top":0,"width":20,"height":20}]"#).unwrap()
}

fn open(
    cx: &mut TestAppContext,
) -> (
    Entity<SnapshotView>,
    &mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| side_by_side(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    (view, cx, receiver)
}

/// The middle of pane-b's card, in window coordinates.
fn target_centre(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> Point<Pixels> {
    view.read_with(cx, |v, _| {
        let cards = v.pane_move_cards_for_test();
        let card = cards.iter().find(|(id, _)| id == "pane-b").unwrap().1;
        v.input_geometry.unwrap().0.origin + card.center()
    })
}

fn drag(cx: &mut VisualTestContext, from: Point<Pixels>, to: Point<Pixels>) {
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let step = from + point(px(6.), px(0.));
    cx.simulate_mouse_move(step, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn dragging_a_header_onto_another_pane_sends_one_swap(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx);
    let header = cx.debug_bounds("pane-card-header:pane-a").unwrap();
    let to = target_centre(&view, cx);
    drag(cx, header.center(), to);
    assert!(view.read_with(cx, |v, _| v.pointer.moving.dragging()));
    assert!(
        cx.debug_bounds("pane-move-preview").is_some(),
        "the preview is up"
    );
    assert!(cx.debug_bounds("pane-move-source").is_some());
    assert!(
        receiver.try_recv().is_err(),
        "nothing is sent before the drop"
    );
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    let command = receiver.try_recv().unwrap();
    assert!(matches!(
        command,
        browser::Command::PaneAction {
            request: 7,
            ref id,
            action: Action::Swap { ref target, ref target_token },
            ..
        } if id == "pane-a" && target == "pane-b" && target_token == "b-token"
    ));
    assert!(
        receiver.try_recv().is_err(),
        "one swap, and the drop clicks nothing"
    );
    // The layout shows the swap: it settles with Undo on the toast.
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.regions = right_left();
            v.browser_state.pane_actions = Some(browser::PaneActions {
                token: "next".into(),
                id: "pane-a".into(),
                zoomed: false,
            });
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("pane-move-toast").is_some());
    assert!(view.read_with(cx, |v, _| v.pointer.moving.undo.is_some()));
}

#[gpui::test]
fn cmd_z_swaps_back_once_and_only_while_the_layout_is_unchanged(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.pointer.moving.undo = Some(crate::tmux_snapshot::pane_move::Undo {
                request: 7,
                a: "pane-a".into(),
                b: "pane-b".into(),
                layout: left_right(),
            });
            v.terminal_focus.focus(window, cx);
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-z");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::PaneAction { action: Action::Swap { ref target, .. }, .. }
            if target == "pane-b"
    ));
    assert!(view.read_with(cx, |v, _| v.pointer.moving.undo.is_none()));
    // Nothing left to undo: Cmd-Z goes on as before, which sends nothing.
    cx.simulate_keystrokes("cmd-z");
    assert!(receiver.try_recv().is_err());
    // A layout that changed since the swap: nothing.
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.pointer.moving.gesture = None;
            v.browser_state.pane_actions = Some(browser::PaneActions {
                token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
                id: "pane-a".into(),
                zoomed: false,
            });
            v.pointer.moving.undo = Some(crate::tmux_snapshot::pane_move::Undo {
                request: 7,
                a: "pane-a".into(),
                b: "pane-b".into(),
                layout: right_left(),
            });
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-z");
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn a_click_on_a_header_still_selects_its_pane(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx);
    let header = cx.debug_bounds("pane-card-header:pane-b").unwrap();
    cx.simulate_mouse_down(header.center(), MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let near = header.center() + point(px(2.), px(1.));
    cx.simulate_mouse_move(near, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(near, MouseButton::Left, Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Pane { ref id, .. } if id == "pane-b")
    );
    assert!(view.read_with(cx, |v, _| v.pointer.moving.gesture.is_none()));
}

#[gpui::test]
fn esc_ends_the_drag_with_the_layout_unchanged(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx);
    let header = cx.debug_bounds("pane-card-header:pane-a").unwrap();
    let to = target_centre(&view, cx);
    drag(cx, header.center(), to);
    cx.simulate_keystrokes("escape");
    assert!(!view.read_with(cx, |v, _| v.pointer.moving.dragging()));
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    assert!(
        receiver
            .try_iter()
            .all(|c| !matches!(c, browser::Command::PaneAction { .. }))
    );
    assert!(view.read_with(cx, |v, _| v.browser_state.regions == left_right()));
}

#[gpui::test]
fn a_zoomed_window_never_starts_a_drag(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx);
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.pane_actions.as_mut().unwrap().zoomed = true;
        });
        window.draw(cx).clear(cx);
    });
    let header = cx.debug_bounds("pane-card-header:pane-a").unwrap();
    let to = target_centre(&view, cx);
    drag(cx, header.center(), to);
    assert!(!view.read_with(cx, |v, _| v.pointer.moving.dragging()));
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    assert!(
        receiver
            .try_iter()
            .all(|c| !matches!(c, browser::Command::PaneAction { .. }))
    );
}
