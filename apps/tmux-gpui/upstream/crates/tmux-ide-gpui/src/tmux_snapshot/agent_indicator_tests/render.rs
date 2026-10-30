#![allow(clippy::unwrap_used)]
//! Window-level spinner tests. They run against both sides of the change: only
//! `mount.rs` (how production mounts the window content) differs.
use super::mount::{frame, mount, observe_overlay, painted, slot_colors};
use crate::tmux_snapshot::{SnapshotView, browser, decode, presence::Presence};
use core::prelude::v1::test;
use gpui::{prelude::*, *};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, mpsc},
    time::Duration,
};
fn choice(id: &str, label: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: label.into(),
        pane_count: None,
        window_id: None,
        browser_icon: None,
        window_label: None,
    }
}
fn make_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let focus = cx.focus_handle();
    focus.focus(window, cx);
    let mut presence = Presence::new(true);
    presence.flush(&sender);
    presence.acknowledge(1);
    let frame = Arc::new(
        decode::frame(include_bytes!("../../../../../../fixtures/snapshot.json")).unwrap(),
    );
    SnapshotView {
        graphics: Default::default(),
        presence,
        _activation: None,
        _appearance: None,
        last_system: None,
        chrome: Default::default(),
        last_workspace_session: None,
        pending_session_open: None,
        header_controls: Default::default(),
        frame: Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
            frame.clone(),
        )),
        browsing: true,
        terminal_focus: focus,
        input_interrupted: false,
        pending_input: None,
        picker: None,
        attention: Default::default(),
        palette: Default::default(),
        session_history: Default::default(),
        session_tabs: Default::default(),
        workspace_fleet_agents: Default::default(),
        home_filter: None,
        pane_actions: None,
        browser_address: None,
        new_session: None,
        new_session_queued: None,
        agent_animation: Default::default(),
        sidebar_hidden: false,
        sidebar_keyboard: Default::default(),
        developer_mode: Default::default(),
        terminal_font: Default::default(),
        window_reveal: Default::default(),
        resize_gesture: Default::default(),
        last_resize: None,
        fit_settle: Default::default(),
        marked: String::new(),
        marked_selection: None,
        input_geometry: Some((
            Bounds::new(point(px(0.), px(0.)), size(px(500.), px(500.))),
            Bounds::default(),
        )),
        input_cell_width: Some(10.),
        painted_focus: None,
        painted_frame: Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
            frame.clone(),
        )),
        pointer: Default::default(),
        selection: None,
        divider: None,
        wheel: crate::terminal::WheelRemainder::default(),
        browser_request: 7,
        browser_state: browser::State {
            request: 7,
            surface: browser::Surface::Home,
            home_phase: browser::HomePhase::Live,
            input_ready: true,
            sessions: vec![choice("session-a", "Session Alpha")],
            panes: vec![choice("pane-a", "Editor")],
            selected_session: Some("session-a".into()),
            selected_pane: Some("pane-a".into()),
            frame: Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
                frame,
            )),
            regions: serde_json::from_str(
                r#"[{"id":"pane-a","left":0,"top":0,"width":1,"height":1}]"#,
            )
            .unwrap(),
            ..Default::default()
        },
        browser_commands: Some(sender),
        _browser_task: None,
        _task: None,
        painter: Rc::new(RefCell::new(
            crate::terminal_painter::TerminalPainter::default(),
        )),
    }
}
struct Host {
    snapshot: Entity<SnapshotView>,
    content: AnyView,
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.content.clone())
    }
}
/// A Home surface with one working agent, mounted the way production mounts it.
fn open(cx: &mut TestAppContext) -> (Entity<SnapshotView>, &mut VisualTestContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (host, cx) = cx.add_window_view(|window, cx| {
        let snapshot = cx.new(|cx| {
            let mut view = make_view(window, cx, sender);
            view.browser_state.home_agents = Some(serde_json::from_value(serde_json::json!({"revision":5,"phase":"live","rows":[
                {"key":"busy","sessionId":"s","paneId":"p1","name":"Busy","sessionLabel":"Session","status":"WORKING","attention":false,"available":true}],
                "observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap());
            view
        });
        let content = mount(snapshot.clone(), window, cx);
        Host { snapshot, content }
    });
    cx.simulate_resize(size(px(520.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let snapshot = host.read_with(cx, |host, _| host.snapshot.clone());
    (snapshot, cx)
}
/// One spinner period with nothing else changing. Returns the spinner frame and
/// whether `SnapshotView` rendered: every render rebuilds the Home search
/// controls, so a cleared `home_filter` comes back only through a render.
fn period(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> (usize, bool) {
    cx.update(|_, cx| snapshot.update(cx, |view, _| view.home_filter = None));
    std::thread::sleep(Duration::from_millis(85));
    cx.update(|_, cx| snapshot.update(cx, |view, cx| view.tick_agent_indicators(cx)));
    cx.executor().advance_clock(Duration::from_millis(85));
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|_, cx| {
        let view = snapshot.read(cx);
        (frame(view), view.home_filter.is_some())
    })
}
#[gpui::test]
fn a_spinner_tick_does_not_render_snapshot_view(cx: &mut TestAppContext) {
    let (snapshot, cx) = open(cx);
    let mut last = cx.update(|_, cx| frame(snapshot.read(cx)));
    for tick in 0..4 {
        let (now, rendered) = period(&snapshot, cx);
        assert_ne!(now, last, "the spinner stopped animating at tick {tick}");
        assert!(!rendered, "SnapshotView rendered for spinner tick {tick}");
        last = now;
    }
    // Positive control: the render probe does see a real SnapshotView render.
    cx.update(|_, cx| {
        snapshot.update(cx, |view, cx| {
            view.home_filter = None;
            cx.notify();
        })
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.update(|_, cx| snapshot.read(cx).home_filter.is_some()));
}
#[gpui::test]
fn an_occluded_window_does_not_tick_and_resumes_when_shown(cx: &mut TestAppContext) {
    let (snapshot, cx) = open(cx);
    period(&snapshot, cx);
    cx.simulate_visibility_change(WindowVisibility::Hidden);
    cx.run_until_parked();
    let hidden = cx.update(|_, cx| frame(snapshot.read(cx)));
    for tick in 0..4 {
        let (now, _) = period(&snapshot, cx);
        assert_eq!(now, hidden, "the spinner ticked while occluded ({tick})");
    }
    cx.simulate_visibility_change(WindowVisibility::Visible);
    cx.run_until_parked();
    let (shown, _) = period(&snapshot, cx);
    assert_ne!(shown, hidden, "the spinner did not resume when shown");
}
/// Draws once and reports whether `SnapshotView` rendered (see `period`).
fn rendered_after(
    snapshot: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    change: impl FnOnce(&mut SnapshotView, &mut Context<SnapshotView>),
) -> bool {
    cx.update(|_, cx| {
        snapshot.update(cx, |view, cx| {
            view.home_filter = None;
            change(view, cx);
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|_, cx| snapshot.read(cx).home_filter.is_some())
}
// The cached root only re-renders SnapshotView when it is notified. These pin
// the paths that change what it draws without a spinner tick.
#[gpui::test]
fn a_published_theme_change_repaints_the_cached_view_and_the_spinner(cx: &mut TestAppContext) {
    let (snapshot, cx) = open(cx);
    period(&snapshot, cx);
    let before = cx.update(|_, cx| slot_colors(snapshot.read(cx)));
    let appearance: crate::tmux_snapshot::appearance::Appearance = serde_json::from_value(serde_json::json!({
        "selected":"custom","system":"dark","options":[],"error":null,
        "theme":{"canvas":1,"background":2,"foreground":3,"cursor":4,"surface":5,"active":6,"muted":7,"accent":8,"palette":vec![0x00c853u32;256]}
    })).unwrap();
    assert!(
        rendered_after(&snapshot, cx, |view, cx| {
            let mut state = view.browser_state.clone();
            state.appearance = Some(appearance);
            view.apply_browser_state(Some(state), cx);
        }),
        "a theme publication did not re-render SnapshotView"
    );
    let (theme, after) = cx.update(|_, cx| {
        let view = snapshot.read(cx);
        (view.theme(), slot_colors(view))
    });
    let working: Hsla = rgb(theme.ink(theme.palette[4])).into();
    assert_eq!(after, vec![working]);
    assert_ne!(before, after, "the spinner kept the old theme's colour");
}
#[gpui::test]
fn a_terminal_font_change_re_renders_the_cached_view(cx: &mut TestAppContext) {
    let (snapshot, cx) = open(cx);
    period(&snapshot, cx);
    assert!(rendered_after(&snapshot, cx, |view, cx| view.invalidate_font_geometry(cx)));
    assert!(
        !rendered_after(&snapshot, cx, |_, _| {}),
        "control: no change, no render"
    );
}
#[gpui::test]
fn a_spinner_tick_invalidates_and_paints_the_overlay(cx: &mut TestAppContext) {
    let (snapshot, cx) = open(cx);
    let notified = Rc::new(std::cell::Cell::new(0));
    let _subscription = cx
        .update(|_, cx| observe_overlay(&snapshot, notified.clone(), cx))
        .expect("no spinner overlay is mounted");
    for tick in 0..3 {
        let before = notified.get();
        cx.update(|_, cx| painted(snapshot.read(cx)));
        let (frame, _) = period(&snapshot, cx);
        assert!(
            notified.get() > before,
            "tick {tick} did not invalidate the overlay"
        );
        let painted = cx.update(|_, cx| painted(snapshot.read(cx)));
        assert!(
            !painted.is_empty()
                && painted.iter().all(|painted| painted.as_ref()
                    == crate::tmux_snapshot::agent_indicator::FRAMES[frame]),
            "tick {tick} did not paint frame {frame}: {painted:?}"
        );
    }
}
