use super::*;
use crate::tmux_snapshot::session_tabs::{Publication, Row};

fn retained(count: usize) -> Publication {
    let rows: Vec<_> = (0..count)
        .map(|index| {
            let token = |offset| uuid::Uuid::from_u128(index as u128 + offset).to_string();
            Row {
                id: token(1),
                label: "Duplicate session with a deliberately long title".into(),
                host_label: "A machine with a long name".into(),
                server_label: Some("Default".into()),
                available: true,
                unread: false,
                activity: None,
                activate: token(101),
                close: token(201),
            }
        })
        .collect();
    Publication {
        request: 7,
        revision: 1,
        active: rows.first().map(|r| r.id.clone()),
        pending: None,
        next: None,
        previous: None,
        close_active: rows.first().map(|r| r.close.clone()),
        rows,
    }
}

#[gpui::test]
fn compact_titlebar_keeps_controls_and_context_without_session_tabs(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.session_tabs = Some(retained(8));
        view.browser_state.status = "Connected".into();
        view
    });
    for width in [640., 1000.] {
        cx.simulate_resize(size(px(width), px(400.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let home = cx.debug_bounds("application-home").unwrap();
        let sidebar = cx.debug_bounds("sidebar-toggle").unwrap();
        let add = cx.debug_bounds("workspace-new-window").unwrap();
        let tabs = cx.debug_bounds("workspace-window-strip").unwrap();
        assert!(cx.debug_bounds("retained-session-tabs").is_none());
        assert!(sidebar.right() <= home.left());
        assert!(home.right() <= tabs.left());
        assert_eq!(home.center().y, tabs.center().y);
        assert!(cx.debug_bounds("application-new-session").is_none());
        assert!(tabs.right() <= add.left());
        assert!(add.right() <= px(width));
        let canvas = view.read_with(cx, |v, _| v.input_geometry.unwrap().0);
        receiver.try_iter().for_each(drop);
        cx.update(|window, cx| {
            view.update(cx, |v, _| v.browser_state.session_tabs = None);
            window.draw(cx).clear(cx);
        });
        assert_eq!(
            view.read_with(cx, |v, _| v.input_geometry.unwrap().0),
            canvas
        );
        assert!(receiver.try_recv().is_err());
    }
}

#[gpui::test]
fn window_transition_keeps_tab_strip_geometry(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.status = "Connected".into();
        view
    });
    for width in [640., 1000.] {
        cx.simulate_resize(size(px(width), px(400.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let before = cx.debug_bounds("workspace-window-strip").unwrap();
        cx.update(|window, cx| {
            view.update(cx, |v, _| {
                v.browser_state.retained_preview = true;
                v.browser_state.input_ready = false;
                v.browser_state.status = "Switching window…".into();
            });
            window.draw(cx).clear(cx);
        });
        assert_eq!(cx.debug_bounds("workspace-window-strip").unwrap(), before);
        assert!(cx.debug_bounds("tmux-status-viewport").is_none());
        assert!(!view.read_with(cx, |v, _| v.browser_state.input_ready));
        cx.update(|window, cx| {
            view.update(cx, |v, _| {
                v.browser_state.retained_preview = false;
                v.browser_state.input_ready = true;
                v.browser_state.status = "Connected".into();
            });
            window.draw(cx).clear(cx);
        });
        assert_eq!(cx.debug_bounds("workspace-window-strip").unwrap(), before);
    }
}

#[gpui::test]
fn actual_window_click_keeps_strip_geometry_before_worker_reply(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        let frame = crate::tmux_snapshot::display_frame::DisplayFrame::Native(Arc::new(
            crate::terminal_painter::NativeFrame {
                width: 1,
                height: 1,
                cursor: None,
                rows: vec![Arc::from([herdr_client::protocol::CellData {
                    symbol: "x".into(),
                    fg: 0,
                    bg: 0,
                    modifier: 0,
                    skip: false,
                    hyperlink: None,
                }])],
            },
        ));
        view.frame = Some(frame.clone());
        view.browser_state.frame = Some(frame);
        view.browser_state.status = "Connected".into();
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    let before = cx.debug_bounds("workspace-window-strip").unwrap();
    let target = cx.debug_bounds("workspace-window-1").unwrap();
    cx.simulate_click(target.center(), Modifiers::default());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Pane { request: 8, .. }
    ));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(cx.debug_bounds("workspace-window-strip").unwrap(), before);
    assert!(cx.debug_bounds("tmux-status-viewport").is_none());
    assert!(view.read_with(cx, |v, _| v.browser_state.retained_preview));
    assert!(!view.read_with(cx, |v, _| v.browser_state.input_ready));
}
