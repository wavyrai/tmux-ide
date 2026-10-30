#![allow(clippy::unwrap_used)]
use super::{frame, options};
use core::prelude::v1::test;
use gpui::{prelude::*, *};
#[path = "shell_tests/status_geometry.rs"]
mod status_geometry;
struct Fixture;
impl Render for Fixture {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        frame(
            div()
                .size_full()
                .flex()
                .child(
                    div()
                        .debug_selector(|| "test-nav".into())
                        .w(px(224.))
                        .h_full()
                        .flex_none(),
                )
                .child(
                    div()
                        .debug_selector(|| "test-terminal".into())
                        .flex_1()
                        .min_w_0()
                        .h_full(),
                ),
            window,
            cx,
        )
    }
}
#[test]
fn browser_window_uses_existing_chrome_and_minimum_geometry() {
    let options = options();
    assert_eq!(options.window_min_size, Some(size(px(640.), px(400.))));
    assert_eq!(options.app_owns_titlebar_drag, cfg!(target_os = "macos"));
    assert_eq!(
        options.titlebar.unwrap().appears_transparent,
        cfg!(target_os = "macos")
    );
}
#[gpui::test]
fn native_header_does_not_overlap_terminal_or_navigation(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Fixture);
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    let body = cx.debug_bounds("tmux-shell-body").unwrap();
    let nav = cx.debug_bounds("test-nav").unwrap();
    let terminal = cx.debug_bounds("test-terminal").unwrap();
    assert_eq!(nav.top(), body.top());
    assert_eq!(terminal.top(), body.top());
    assert_eq!(nav.right(), terminal.left());
    assert!(terminal.size.width > px(300.));
    assert!(terminal.bottom() <= body.bottom());
    if let Some(header) = cx.debug_bounds("titlebar") {
        assert!(header.bottom() <= body.top());
    }
}

fn browser_fixture(
    cx: &mut Context<super::super::SnapshotView>,
    sender: std::sync::mpsc::SyncSender<super::super::browser::Command>,
) -> super::super::SnapshotView {
    use super::super::{SnapshotView, browser, decode, presence::Presence};
    use std::{cell::RefCell, rc::Rc, sync::Arc};
    let frame =
        Arc::new(decode::frame(include_bytes!("../../../../../fixtures/snapshot.json")).unwrap());
    let mut presence = Presence::new(true);
    presence.flush(&sender);
    presence.acknowledge(1);
    let pane = browser::Choice {
        id: "pane-a".into(),
        label: "Long selected terminal title ".repeat(8),
        pane_count: None,
        window_id: Some("window-a".into()),
        browser_icon: None,
        window_label: Some("Long window label ".repeat(8)),
    };
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
        terminal_focus: cx.focus_handle(),
        input_interrupted: true,
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
        input_geometry: None,
        input_cell_width: None,
        painted_focus: None,
        painted_frame: None,
        pointer: Default::default(),
        selection: None,
        divider: None,
        wheel: crate::terminal::WheelRemainder::default(),
        browser_request: 7,
        browser_state: browser::State {
            surface: browser::Surface::Workspace,
            input_ready: true,
            selected_pane: Some(pane.id.clone()),
            panes: vec![pane],
            status: "Keyboard ready".into(),
            frame: Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
                frame,
            )),
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
#[gpui::test]
fn real_browser_keeps_long_status_and_terminal_usable_at_minimum_width(cx: &mut TestAppContext) {
    use super::super::{browser::Command, keys::Input};
    let (sender, receiver) = std::sync::mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|_, cx| browser_fixture(cx, sender));
    while receiver.try_recv().is_ok() {}
    // The long second status is accepted by the browser's 256-byte wire bound.
    for (width, status, interrupted) in [
        (640., "Keyboard ready".to_owned(), true),
        (
            640.,
            "Connection unavailable — refresh the catalog. ".repeat(5),
            true,
        ),
        (1000., "Keyboard ready".to_owned(), false),
    ] {
        assert!(status.len() <= 256);
        cx.update(|_, cx| {
            view.update(cx, |view, _| {
                view.browser_state.status = status;
                view.input_interrupted = interrupted;
                view.developer_mode.enabled = true;
            })
        });
        cx.simulate_resize(size(px(width), px(400.)));
        cx.update(|window, cx| {
            window.refresh();
            let _ = window.draw(cx);
        });
        let body = cx.debug_bounds("tmux-shell-body").unwrap();
        let status = cx.debug_bounds("tmux-status-viewport").unwrap();
        let title = cx.debug_bounds("tmux-selected-title").unwrap();
        let canvas = cx.update(|_, cx| view.read(cx).input_geometry.unwrap().0);
        assert!(status.left() >= body.left() && status.right() <= body.right());
        assert!(status.size.height <= px(96.));
        assert!(
            canvas.bottom() <= status.top(),
            "status must not overlap the terminal canvas"
        );
        assert!(title.right() <= status.left());
        assert!(
            canvas.bottom() <= body.bottom(),
            "width={width} interrupted={interrupted} body={body:?} canvas={canvas:?} status={status:?} title={title:?}"
        );
        assert!(
            canvas.size.height >= px(crate::terminal::CELL_HEIGHT * 5.),
            "real browser must retain at least five terminal rows at minimum size: {canvas:?}"
        );
        assert!(canvas.size.width > px(300.));
    }
    while let Ok(command) = receiver.try_recv() {
        assert!(
            matches!(
                command,
                Command::Input {
                    input: Input::Resize { .. },
                    ..
                }
            ),
            "layout must not offer terminal text or switch selection"
        );
    }
}

#[gpui::test]
fn normal_ready_workspace_reserves_status_lane_without_hiding_errors(cx: &mut TestAppContext) {
    let (sender, receiver) = std::sync::mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|_, cx| browser_fixture(cx, sender));
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.input_interrupted = false;
            view.developer_mode.enabled = false;
        });
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tmux-status-viewport").is_none());
    assert!(cx.debug_bounds("tmux-selected-title").is_none());
    let quiet = cx.update(|_, cx| view.read(cx).input_geometry.unwrap().0);
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.developer_mode.enabled = true);
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tmux-status-viewport").is_some());
    let technical = cx.update(|_, cx| view.read(cx).input_geometry.unwrap().0);
    assert!(cx.debug_bounds("tmux-status-viewport").unwrap().top() >= technical.bottom());
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.developer_mode.enabled = false;
            view.browser_state.status = "Copy failed — try again".into();
        });
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tmux-status-viewport").is_some());
    assert!(cx.debug_bounds("tmux-selected-title").is_none());
    assert_eq!(
        cx.update(|_, cx| view.read(cx).input_geometry.unwrap().0),
        quiet
    );
    while let Ok(command) = receiver.try_recv() {
        assert!(
            matches!(
                command,
                super::super::browser::Command::Input {
                    input: super::super::keys::Input::Resize { .. },
                    ..
                }
            ),
            "presentation may resize but must not send text or navigate"
        );
    }
}

#[gpui::test]
fn accessibility_policy_reaches_the_rendered_window(cx: &mut TestAppContext) {
    let (sender, receiver) = std::sync::mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|_, cx| {
        let mut view = browser_fixture(cx, sender);
        view.chrome.force(false);
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|_, cx| {
        let installed = bezel_theme::Theme::of(cx);
        assert!(!installed.vibrancy && !installed.glass);
        assert_eq!(
            installed.window_background_appearance(),
            WindowBackgroundAppearance::Opaque
        );
    });
    // And the window itself was told, not just the palette.
    assert_eq!(
        super::super::chrome::passed_to_window(),
        Some(WindowBackgroundAppearance::Opaque)
    );
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.chrome.force(true));
        window.refresh();
        window.draw(cx).clear(cx);
    });
    cx.update(|_, cx| assert!(bezel_theme::Theme::of(cx).vibrancy));
    assert_eq!(
        super::super::chrome::passed_to_window(),
        Some(WindowBackgroundAppearance::Blurred)
    );
}

#[path = "shell_tests/fullscreen.rs"]
mod fullscreen;

#[path = "shell_tests/content_geometry.rs"]
mod content_geometry;
