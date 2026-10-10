#![allow(clippy::unwrap_used)]
use super::{frame, options};
use core::prelude::v1::test;
use gpui::{prelude::*, *};
struct Fixture;
impl Render for Fixture {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
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
        let title = cx.debug_bounds("tmux-window-heading-text").unwrap();
        assert_eq!(title.left() + title.right(), header.left() + header.right());
        // Text line boxes may round to half pixels during layout.
        assert!((title.top() + title.bottom() - header.top() - header.bottom()).abs() <= px(1.));
        assert!(title.left() > header.left() && title.right() < header.right());
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
        window_label: Some("Long window label ".repeat(8)),
    };
    SnapshotView {
        presence,
        _activation: None,
        _appearance: None,
        last_system: None,
        glass: Default::default(),
        last_workspace_session: None,
        pending_session_open: None,
        frame: Some(frame.clone()),
        browsing: true,
        terminal_focus: cx.focus_handle(),
        input_interrupted: true,
        picker: None,
        pane_actions: None,
        new_session: None,
        new_session_queued: None,
        window_reveal: Default::default(),
        resize_gesture: Default::default(),
        last_resize: None,
        marked: String::new(),
        marked_selection: None,
        input_geometry: None,
        input_cell_width: None,
        painted_frame: None,
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
            frame: Some(frame),
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

#[test]
fn glass_tint_is_confined_to_chrome_and_fallback_is_opaque() {
    for color in [0x111111, 0xffffff, 0x2e3440] {
        let solid = super::sidebar_fill(color, false);
        let glass = super::sidebar_fill(color, true);
        assert_eq!(solid, rgb(color));
        assert_eq!(glass.r, solid.r);
        assert_eq!(glass.g, solid.g);
        assert_eq!(glass.b, solid.b);
        assert!(glass.a > 0. && glass.a < solid.a);
    }
}
