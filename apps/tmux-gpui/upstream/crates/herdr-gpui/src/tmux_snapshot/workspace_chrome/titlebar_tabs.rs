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
fn retained_tabs_share_titlebar_and_leave_fixed_controls_usable(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.session_tabs = Some(retained(8));
        view
    });
    for width in [640., 1000.] {
        cx.simulate_resize(size(px(width), px(400.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let home = cx.debug_bounds("application-home").unwrap();
        let strip = cx.debug_bounds("retained-session-tabs").unwrap();
        let first = cx.debug_bounds("retained-session-0").unwrap();
        let browse = cx.debug_bounds("application-browse").unwrap();
        let sidebar = cx.debug_bounds("sidebar-toggle").unwrap();
        let body = cx.debug_bounds("tmux-shell-body").unwrap();
        assert!(home.right() <= strip.left());
        assert!(strip.size.width > px(0.));
        assert!(strip.right() <= browse.left());
        assert!(browse.right() <= sidebar.left());
        assert!(sidebar.right() <= px(width));
        assert!(browse.size.width > px(0.) && sidebar.size.width > px(0.));
        assert_eq!(
            home.center().y,
            first.center().y,
            "retained tabs belong on the Home row"
        );
        assert!(
            strip.bottom() <= body.top(),
            "no retained strip may occupy body height"
        );
        if let Some(header) = cx.debug_bounds("titlebar") {
            assert_eq!(header.bottom(), body.top());
            assert!(home.left() >= px(if cfg!(target_os = "macos") { 80. } else { 8. }));
        }
    }
    receiver.try_iter().for_each(drop);
    let browse = cx.debug_bounds("application-browse").unwrap();
    cx.simulate_click(browse.center(), Modifiers::default());
    assert!(view.read_with(cx, |v, _| v.picker.is_some()));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn retained_titlebar_close_dispatches_only_its_capability(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.session_tabs = Some(retained(2));
        view
    });
    cx.simulate_resize(size(px(1000.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    let close = cx.debug_bounds("close-retained-session-0").unwrap();
    cx.simulate_click(close.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::SessionTab {
        request: 8, from_request: 7, revision: 1, action
    } if action == uuid::Uuid::from_u128(201).to_string())
    );
    assert!(
        receiver.try_recv().is_err(),
        "close must not activate the tab or send terminal input"
    );
}

#[gpui::test]
fn retained_titlebar_activation_uses_current_token_from_home(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.surface = browser::Surface::Home;
        view.browser_state.home_phase = browser::HomePhase::Live;
        // Retained active ID may remain populated while Home is selected.
        view.browser_state.session_tabs = Some(retained(2));
        view.frame = None;
        view.painted_frame = None;
        view.browser_state.frame = None;
        view.browser_state.input_ready = false;
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    let row = cx.debug_bounds("retained-session-0").unwrap();
    let close = cx.debug_bounds("close-retained-session-0").unwrap();
    // Hit the label half, not the nested close control.
    let hit = point(row.left() + px(20.), row.center().y);
    assert!(hit.x < close.left());
    cx.simulate_click(hit, Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::SessionTab {
        request: 8, from_request: 7, revision: 1, action
    } if action == uuid::Uuid::from_u128(101).to_string())
    );
    assert!(receiver.try_recv().is_err());
}
