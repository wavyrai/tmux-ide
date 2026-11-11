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

fn header(cx: &mut VisualTestContext, id: &str) -> Point<Pixels> {
    cx.debug_bounds(Box::leak(format!("pane-card-header:{id}").into_boxed_str()))
        .unwrap()
        .center()
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

fn swaps(receiver: &mpsc::Receiver<browser::Command>) -> usize {
    receiver
        .try_iter()
        .filter(|c| {
            matches!(
                c,
                browser::Command::PaneAction {
                    action: Action::Swap { .. },
                    ..
                }
            )
        })
        .count()
}

/// The swap names the target as the preview showed it: a pane replaced
/// under the same id and place before the drop is not the one swapped, and
/// the transport refuses the old token (review of #364).
#[gpui::test]
fn the_swap_names_the_target_the_preview_showed(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx);
    let to = target_centre(&view, cx);
    let from = header(cx, "pane-a");
    drag(cx, from, to);
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.input_targets[1].token = "b-new-lifetime".into();
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::PaneAction {
            action: Action::Swap { ref target_token, .. },
            ..
        } if target_token == "b-token"
    ));
}

fn press_at(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> bool {
    let at = header(cx, "pane-a");
    let press = MouseDownEvent {
        button: MouseButton::Left,
        position: at,
        modifiers: Modifiers::default(),
        click_count: 1,
        first_mouse: false,
    };
    view.update(cx, |v, cx| {
        v.pane_move_press("pane-a", &press, cx);
        let started = v.pointer.moving.gesture.is_some();
        v.pointer.moving.gesture = None;
        started
    })
}

/// Each state that rules a drag out at the press, through the view's own
/// reading of the window (review of #364).
#[gpui::test]
fn a_press_starts_no_drag_while_the_window_cant_take_one(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx);
    assert!(press_at(&view, cx), "control: a drag can start");
    type Setup = fn(&mut SnapshotView);
    let cases: [(&str, Setup); 3] = [
        ("held frame", |v| v.browser_state.retained_preview = true),
        ("reconnecting", |v| {
            v.browser_state.reconnect_attempt = Some(1)
        }),
        ("pane action pending", |v| {
            v.browser_state.pane_actions = None
        }),
    ];
    for (name, setup) in cases {
        let saved = view.read_with(cx, |v, _| v.browser_state.clone());
        view.update(cx, |v, _| setup(v));
        assert!(!press_at(&view, cx), "{name}");
        view.update(cx, |v, _| v.browser_state = saved);
    }
    // The palette open.
    cx.simulate_keystrokes("f5");
    assert!(view.read_with(cx, |v, _| v.picker.is_some()));
    assert!(!press_at(&view, cx), "palette open");
    cx.simulate_keystrokes("escape");
    assert!(press_at(&view, cx), "control: closed again");
}

/// Drags onto pane-b, applies `change` mid-drag, and checks the drag ended
/// and the drop sent nothing (review of #364).
fn ends_the_drag(cx: &mut TestAppContext, change: fn(&mut SnapshotView)) {
    let (view, cx, receiver) = open(cx);
    let to = target_centre(&view, cx);
    let from = header(cx, "pane-a");
    drag(cx, from, to);
    assert!(view.read_with(cx, |v, _| v.pointer.moving.dragging()));
    cx.update(|window, cx| {
        view.update(cx, |v, _| change(v));
        window.draw(cx).clear(cx);
    });
    assert!(!view.read_with(cx, |v, _| v.pointer.moving.dragging()));
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    assert_eq!(swaps(&receiver), 0);
}

#[gpui::test]
fn a_reconnect_mid_drag_ends_it(cx: &mut TestAppContext) {
    ends_the_drag(cx, |v| v.browser_state.reconnect_attempt = Some(1));
}

#[gpui::test]
fn a_held_frame_mid_drag_ends_it(cx: &mut TestAppContext) {
    ends_the_drag(cx, |v| v.browser_state.retained_preview = true);
}

#[gpui::test]
fn focus_lost_mid_drag_ends_it(cx: &mut TestAppContext) {
    ends_the_drag(cx, |v| v.presence.set_active(false));
}

#[gpui::test]
fn a_session_change_mid_drag_ends_it(cx: &mut TestAppContext) {
    ends_the_drag(cx, |v| {
        v.browser_state.selected_session = Some("session-b".into())
    });
}

#[gpui::test]
fn zoom_mid_drag_ends_it(cx: &mut TestAppContext) {
    ends_the_drag(cx, |v| {
        v.browser_state.pane_actions.as_mut().unwrap().zoomed = true
    });
}

/// Keys during a drag never reach the terminal, and Esc ends it. Once it
/// has ended, typing reaches the terminal again.
#[gpui::test]
fn keys_during_a_drag_never_reach_the_terminal(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.input_interrupted = false;
            v.pending_input = None;
            v.terminal_focus.focus(window, cx);
        });
        window.draw(cx).clear(cx);
    });
    // The fixture types: a key sends input.
    cx.simulate_keystrokes("x");
    assert!(
        receiver
            .try_iter()
            .any(|c| matches!(c, browser::Command::Input { .. })),
        "control: typing reaches the terminal"
    );
    let to = target_centre(&view, cx);
    let from = header(cx, "pane-a");
    drag(cx, from, to);
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("x y enter");
    assert!(
        receiver.try_recv().is_err(),
        "nothing typed during the drag"
    );
    cx.simulate_keystrokes("escape");
    assert!(!view.read_with(cx, |v, _| v.pointer.moving.dragging()));
    assert!(
        receiver.try_recv().is_err(),
        "Esc ends the drag, nothing else"
    );
}

/// Focus lost mid-drag ends it, so a user who comes back can type.
#[gpui::test]
fn coming_back_after_focus_loss_types_again(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx);
    let to = target_centre(&view, cx);
    let from = header(cx, "pane-a");
    drag(cx, from, to);
    cx.update(|window, cx| {
        view.update(cx, |v, _| v.presence.set_active(false));
        window.draw(cx).clear(cx);
        view.update(cx, |v, _| v.presence.set_active(true));
        window.draw(cx).clear(cx);
    });
    assert!(!view.read_with(cx, |v, _| v.pointer.moving.dragging()));
}

/// The button coming up outside the window, or never coming up where we see
/// it, ends the drag without a swap.
#[gpui::test]
fn a_release_outside_the_window_ends_the_drag(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx);
    let to = target_centre(&view, cx);
    let from = header(cx, "pane-a");
    drag(cx, from, to);
    cx.simulate_mouse_up(
        point(px(-40.), px(-40.)),
        MouseButton::Left,
        Modifiers::default(),
    );
    assert!(!view.read_with(cx, |v, _| v.pointer.moving.dragging()));
    assert_eq!(swaps(&receiver), 0);
    // The up went to another app: the next move, with no button, ends it.
    draw(cx);
    let from = header(cx, "pane-a");
    drag(cx, from, to);
    cx.simulate_mouse_move(to, None, Modifiers::default());
    assert!(!view.read_with(cx, |v, _| v.pointer.moving.dragging()));
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    assert_eq!(swaps(&receiver), 0);
}

/// A mouse-mode program gets no mouse reports from a drag that starts on a
/// header.
#[gpui::test]
fn a_drag_sends_no_mouse_reports(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx);
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.input_interrupted = false;
            v.browser_state.pointer_modes = Some(crate::tmux_snapshot::decode::PointerModes {
                protocol: crate::tmux_snapshot::decode::MouseProtocol::Any,
                encoding: crate::tmux_snapshot::decode::MouseEncoding::Sgr,
                alternate: false,
            });
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let to = target_centre(&view, cx);
    let from = header(cx, "pane-a");
    drag(cx, from, to);
    cx.simulate_keystrokes("escape");
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    assert!(!receiver.try_iter().any(|c| matches!(
        c,
        browser::Command::Input {
            input: crate::tmux_snapshot::keys::Input::Mouse(_),
            ..
        }
    )));
}

/// A cancelled drag selects again the pane that was selected before it; a
/// header click would send the same command.
#[gpui::test]
fn a_cancelled_drag_gives_back_the_old_selection(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx);
    let from = header(cx, "pane-b");
    let to = view.read_with(cx, |v, _| {
        let cards = v.pane_move_cards_for_test();
        let card = cards.iter().find(|(id, _)| id == "pane-a").unwrap().1;
        v.input_geometry.unwrap().0.origin + card.center()
    });
    drag(cx, from, to);
    assert!(
        receiver
            .try_iter()
            .any(|c| matches!(c, browser::Command::Pane { ref id, .. } if id == "pane-b")),
        "the drag selects its source"
    );
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.selected_pane = Some("pane-b".into())
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("escape");
    draw(cx);
    let sent: Vec<browser::Command> = receiver.try_iter().collect();
    assert!(
        sent.iter()
            .any(|c| matches!(c, browser::Command::Pane { id, .. } if id == "pane-a")),
        "pane-a is selected again"
    );
    assert!(
        sent.iter()
            .all(|c| matches!(c, browser::Command::Pane { .. })),
        "only selection"
    );
}

#[gpui::test]
fn cmd_shift_z_never_swaps_back(cx: &mut TestAppContext) {
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
    cx.simulate_keystrokes("cmd-shift-z");
    assert_eq!(swaps(&receiver), 0);
    assert!(view.read_with(cx, |v, _| v.pointer.moving.undo.is_some()));
}
