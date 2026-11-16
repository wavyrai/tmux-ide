use super::*;

fn catalog_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let mut view = make_view(window, cx, sender);
    // Actual Home has catalog data, never an attached terminal or input lease.
    view.frame = None;
    view.painted_frame = None;
    view.input_geometry = None;
    view.input_cell_width = None;
    view.browser_state.frame = None;
    view.browser_state.input_ready = false;
    view.browser_state.selected_session = None;
    view.browser_state.selected_pane = None;
    view.browser_state.panes.clear();
    view.browser_state.regions.clear();
    view.browser_state.sessions = vec![
        choice("session-one", "Same name"),
        choice("session-two", "Same name"),
    ];
    view
}

#[gpui::test]
fn actual_home_card_click_uses_current_id_not_duplicate_label(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| catalog_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let home = cx.debug_bounds("tmux-home").unwrap();
    let card = cx.debug_bounds("tmux-home-session-1").unwrap();
    assert!(card.left() >= home.left() && card.right() <= home.right());
    assert!(card.size.height > px(0.));
    receiver.try_iter().for_each(drop);
    cx.simulate_click(card.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Session { request: 8, id } if id == "session-two")
    );
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| {
        assert_eq!(view.browser_state.surface, browser::Surface::Workspace);
        assert!(!view.browser_state.input_ready);
        assert!(view.frame.is_none());
    });
}

#[gpui::test]
fn actual_home_suppresses_stale_cards_and_disconnected_refresh(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| catalog_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(600.)));
    for phase in [browser::HomePhase::Loading, browser::HomePhase::Unavailable] {
        cx.update(|window, cx| {
            view.update(cx, |view, _| view.browser_state.home_phase = phase);
            window.draw(cx).clear(cx);
        });
        assert!(cx.debug_bounds("tmux-home").is_some());
        assert!(cx.debug_bounds("tmux-home-session-0").is_none());
        assert!(cx.debug_bounds("tmux-home-refresh").is_some());
    }
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.home_phase = browser::HomePhase::Live;
            view.browser_state.sessions.clear();
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tmux-home-session-0").is_none());
    assert!(cx.debug_bounds("tmux-home-refresh").is_some());
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state
                .sessions
                .push(choice("stale", "Old session"));
            view.browser_commands = None;
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tmux-home-session-0").is_none());
    assert!(cx.debug_bounds("tmux-home-refresh").is_none());
    // Only the fixture's initial presence notification was sent; rendering never
    // fabricates a session, refresh, reconnect, or terminal-input command.
    assert!(
        receiver
            .try_iter()
            .all(|command| matches!(command, browser::Command::Presence { .. }))
    );
}

#[gpui::test]
fn startup_loading_then_verified_empty_and_populated_catalog(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = catalog_view(window, cx, sender);
        view.browser_request = 0;
        // Exact constructor used by native startup, not a manually corrected fixture.
        view.browser_state = initial_state();
        view
    });
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |view, _| {
        assert_eq!(view.browser_state.status, "Loading sessions…");
        assert!(!live(&view.browser_state, true));
        assert!(!current(&view.browser_state, true, 0, 0, "session-one"));
    });
    assert!(cx.debug_bounds("tmux-home-session-0").is_none());
    assert!(cx.debug_bounds("home-new-session").is_none());
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let state = browser::State {
                request: 0,
                home_phase: browser::HomePhase::Live,
                status: "Choose a session".into(),
                ..Default::default()
            };
            view.apply_browser_state(Some(state), cx);
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tmux-home-session-0").is_none());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let mut state = view.browser_state.clone();
            state.sessions = vec![choice("verified-session", "Verified session")];
            view.apply_browser_state(Some(state), cx);
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tmux-home-session-0").is_some());
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn narrow_home_counts_refresh_without_changing_duplicate_label_identity(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = catalog_view(window, cx, sender);
        for session in &mut view.browser_state.sessions {
            session.label = "Long duplicate 界 label ".repeat(10);
        }
        view.browser_state.sessions[1].pane_count = Some(0);
        view
    });
    cx.simulate_resize(size(px(520.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-home-count-0").is_none());
    let count = cx.debug_bounds("tmux-home-count-1").unwrap();
    let card = cx.debug_bounds("tmux-home-session-1").unwrap();
    assert!(count.left() >= card.left() && count.right() <= card.right());
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.browser_state.sessions[1].pane_count_label().as_deref(),
            Some("0 panes")
        )
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.sessions[1].pane_count = Some(1);
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.browser_state.sessions[1].pane_count_label().as_deref(),
            Some("1 pane")
        )
    });
    receiver.try_iter().for_each(drop);
    let card = cx.debug_bounds("tmux-home-session-1").unwrap();
    cx.simulate_click(card.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::Session{request:8,id} if id=="session-two")
    );
    assert!(receiver.try_recv().is_err());
}

#[path = "agents.rs"]
mod agents;

/// The palettes are built once per theme, and follow a theme change at once
/// (perf plan, finding 2).
#[test]
fn palettes_follow_the_theme_they_were_built_for() {
    use crate::tmux_snapshot::design;
    let dark = crate::config::Theme::default();
    let mut light = dark.clone();
    light.background = 0xfafafa;
    light.foreground = 0x202020;
    let first = design::palette(&dark);
    assert_eq!(design::palette(&dark).bg, first.bg);
    assert_ne!(design::palette(&light).bg, first.bg);
    assert_eq!(
        design::palette(&dark).text,
        first.text,
        "switching back finds it again"
    );
    let home = palette(&dark, 0x101010);
    assert_ne!(palette(&light, 0xfafafa).text, home.text);
    assert_eq!(palette(&dark, 0x101010).text, home.text);
}

/// Home's palette follows a theme change on the same canvas too: Increase
/// Contrast or new colours over an unchanged window (review of step 1).
#[test]
fn home_palette_follows_a_theme_change_on_the_same_canvas() {
    let canvas = 0x101010;
    let base = crate::config::Theme::default();
    let inked = palette(&base, canvas);
    let mut recoloured = base.clone();
    recoloured.foreground = 0xd0a0a0;
    recoloured.muted = 0x9090c0;
    let changed = palette(&recoloured, canvas);
    assert_ne!(changed.text, inked.text);
    assert_eq!(changed.text_muted, ink_home(&recoloured, canvas).text_muted);
    let mut high = base.clone();
    high.contrast = crate::contrast::Contrast::High;
    let contrasted = palette(&high, canvas);
    let fresh = ink_home(&high, canvas);
    assert_eq!(
        (contrasted.text, contrasted.text_muted, contrasted.border),
        (fresh.text, fresh.text_muted, fresh.border),
        "Increase Contrast gets its own inks, not the last theme's"
    );
    assert_eq!(palette(&base, canvas).text, inked.text);
}
