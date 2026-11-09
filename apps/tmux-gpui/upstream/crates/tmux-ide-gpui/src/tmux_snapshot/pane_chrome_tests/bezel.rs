//! The header's controls on Bezel's plain ghost buttons: a hover wash, and a
//! click that never takes focus off the terminal.
#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::browser;
use herdr_client::tmux_daemon::{BrowserAction, BrowserState};
use std::sync::mpsc;

fn choice(id: &str) -> Choice {
    Choice {
        id: id.into(),
        label: id.into(),
        pane_count: None,
        window_id: Some("window-a".into()),
        browser_icon: None,
        window_label: None,
    }
}

pub(super) fn observed() -> BrowserState {
    BrowserState {
        version: 1,
        instance: "12345678-1234-4234-8234-123456789abc".into(),
        pane: "%3".into(),
        tab: 1,
        revision: 7,
        enabled: true,
        url: "https://example.com".into(),
        title: "Example".into(),
        loading: false,
        can_go_back: true,
        can_go_forward: false,
    }
}

/// Three panes in one window, pane-a selected and scrolled back so its mode
/// button shows, pane-b resting, pane-c a browser with its toolbar.
pub(super) fn header_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let mut view = crate::tmux_snapshot::fit_test_support::fixture_view(
        window,
        cx,
        sender,
        7,
        State {
            request: 7,
            surface: browser::Surface::Workspace,
            selected_session: Some("session-a".into()),
            pane_actions: Some(browser::PaneActions {
                token: "pane-a-actions".into(),
                id: "pane-a".into(),
                zoomed: false,
            }),
            input_ready: true,
            ..Default::default()
        },
    );
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
    let frame = crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(Arc::new(frame));
    view.frame = Some(frame.clone());
    view.painted_frame = Some(frame.clone());
    view.browser_state.frame = Some(frame);
    view.browser_state.panes = vec![choice("pane-a"), choice("pane-b"), choice("pane-c")];
    view.browser_state.regions = serde_json::from_str(
        r#"[{"id":"pane-a","left":0,"top":0,"width":40,"height":6},
            {"id":"pane-b","left":0,"top":7,"width":40,"height":6},
            {"id":"pane-c","left":0,"top":14,"width":40,"height":6}]"#,
    )
    .unwrap();
    view.browser_state.history_offset = 12;
    view.browser_state
        .browser_controls
        .insert("pane-c".into(), observed());
    view
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

/// The hover washes painted inside `bounds`, at any opacity: a dimmed
/// control paints its fills at a lower alpha.
fn washes(cx: &mut VisualTestContext, bounds: Bounds<Pixels>, wash: Hsla) -> usize {
    let (quads, scale) = cx.update(|window, _| (window.painted_quads(), window.scale_factor()));
    let bounds = bounds.scale(scale);
    quads
        .iter()
        .filter(|quad| {
            bounds.contains(&quad.bounds.center())
                && quad
                    .background
                    .as_solid()
                    .is_some_and(|bg| bg.a > 0. && (bg.h, bg.s, bg.l) == (wash.h, wash.s, wash.l))
        })
        .count()
}

#[gpui::test]
fn hovering_each_header_control_paints_bezels_wash(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    receiver.try_iter().for_each(drop);
    let wash = view.read_with(cx, |v, _| {
        crate::tmux_snapshot::design::palette(&v.theme()).element_hover
    });
    for selector in [
        "pane-mode:pane-a",
        "pane-split-right:pane-a",
        "pane-split-down:pane-a",
        "pane-expand:pane-a",
        "pane-close:pane-a",
        "browser-back",
        "browser-address",
    ] {
        let bounds = cx.debug_bounds(selector).unwrap();
        cx.simulate_mouse_move(point(px(1.), px(690.)), None, Modifiers::none());
        draw(cx);
        assert_eq!(washes(cx, bounds, wash), 0, "{selector} at rest");
        cx.simulate_mouse_move(bounds.center(), None, Modifiers::none());
        draw(cx);
        assert_eq!(washes(cx, bounds, wash), 1, "{selector} hovered");
    }
    // An unavailable toolbar button stays still under the pointer.
    let forward = cx.debug_bounds("browser-forward").unwrap();
    cx.simulate_mouse_move(forward.center(), None, Modifiers::none());
    draw(cx);
    assert_eq!(
        washes(cx, forward, wash),
        0,
        "browser-forward is unavailable"
    );
}

#[gpui::test]
fn clicking_header_controls_keeps_the_terminal_focused(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    receiver.try_iter().for_each(drop);
    let focused = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| view.read(cx).terminal_focus.is_focused(window))
    };
    // A real click: the pointer arrives first, so the control is hovered when
    // the press lands, which is when a focusable element would take focus.
    let click = |cx: &mut VisualTestContext, at: Point<Pixels>| {
        cx.simulate_mouse_move(at, None, Modifiers::none());
        draw(cx);
        cx.simulate_click(at, Modifiers::default());
    };
    assert!(focused(cx));

    let back = cx.debug_bounds("browser-back").unwrap();
    click(cx, back.center());
    let sent: Vec<_> = receiver.try_iter().collect();
    assert!(
        matches!(sent.as_slice(), [browser::Command::BrowserControls { id, command: Some(command), .. }]
            if id == "pane-c" && command.action == BrowserAction::Back),
        "only the toolbar acts, the header under it does not select pane-c"
    );
    assert!(focused(cx), "browser-back");
    draw(cx);

    let mode = cx.debug_bounds("pane-mode:pane-a").unwrap();
    click(cx, mode.center());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Input { id, .. } if id == "pane-a"
    ));
    assert!(focused(cx), "pane-mode");
    draw(cx);

    let split = cx.debug_bounds("pane-split-right:pane-b").unwrap();
    click(cx, split.center());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Pane { id, .. } if id == "pane-b"
    ));
    assert!(focused(cx), "pane-split-right");
}

/// A pane title is a button named after its pane that points a screen
/// reader to its actions: right-click, Control-click, or F5. It offers no
/// "show menu" action, which VoiceOver on macOS cannot send (#746).
#[gpui::test]
fn titles_tell_a_screen_reader_where_the_pane_actions_are(cx: &mut TestAppContext) {
    use gpui::accesskit::{Action, Node, Role as A11y};
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    receiver.try_iter().for_each(drop);
    view.update(cx, |view, _| {
        let header = Header {
            id: "pane-b".into(),
            left: 0,
            width: 40,
            row: Some(6),
        };
        let title = view.pane_title_a11y(div().id("title"), &header);
        assert_eq!(title.a11y_role(), Some(A11y::Button));
        let mut node = Node::new(A11y::Button);
        title.write_a11y_info(&mut node);
        assert_eq!(node.label(), Some("pane-b"));
        assert_eq!(node.description(), Some(TITLE_HINT));
        assert!(TITLE_HINT.contains("F5"));
        assert!(!node.supports_action(Action::ShowContextMenu));
    });
}

/// The split buttons tell a screen reader their shortcuts, as their
/// tooltips show them.
#[test]
fn header_buttons_tell_a_screen_reader_their_shortcuts() {
    use gpui::accesskit::{Node, Role as A11y};
    for (intent, keys) in [
        (HeaderIntent::SplitRight, Some("⌘D")),
        (HeaderIntent::SplitDown, Some("⌘⇧D")),
        (HeaderIntent::Expand, Some("⌘⇧↵")),
        (HeaderIntent::Close, None),
    ] {
        let (_, _, hint, face_keys) = face(intent, false).unwrap();
        let button = button_a11y(div().id("button"), hint, face_keys);
        assert_eq!(button.a11y_role(), Some(A11y::Button));
        let mut node = Node::new(A11y::Button);
        button.write_a11y_info(&mut node);
        assert_eq!(node.label(), Some(hint));
        assert_eq!(node.keyboard_shortcut(), keys, "{hint}");
    }
}
