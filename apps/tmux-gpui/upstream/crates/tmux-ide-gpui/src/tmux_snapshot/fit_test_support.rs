//! Finish fixture viewport changes before testing unrelated chrome commands.
#![allow(clippy::unwrap_used)]
use super::{
    SnapshotView, browser, decode, display_frame::DisplayFrame, geometry, keys, presence::Presence,
};
use gpui::{Bounds, Context, Window, point, px, size};
use gpui::{Entity, VisualTestContext};
use std::sync::mpsc::Receiver;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, mpsc},
};

pub(super) fn settle(
    view: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    receiver: &Receiver<browser::Command>,
) -> (u16, u16) {
    assert!(
        receiver.try_recv().is_err(),
        "no command before viewport quiet interval"
    );
    let (expected, pixels, request, pane, already_fitted) = view.update(cx, |view, _| {
        let (cols, rows) = view.test_fitted_grid();
        let pixels = view.graphics.cell_pixels.get().unwrap();
        let request = view.browser_request;
        let pane = view.browser_state.selected_pane.clone().unwrap();
        let already_fitted = view.last_resize == Some((request, cols, rows));
        if !already_fitted {
            let fit = geometry::Fit {
                request,
                cols,
                rows,
                pixels,
            };
            assert!(
                view.fit_settle.ready(
                    fit,
                    view.last_resize,
                    false,
                    std::time::Instant::now() + std::time::Duration::from_millis(151),
                ),
                "renderer must already have scheduled this exact pending fit"
            );
            view.fit_settle.clear();
            assert!(!view.fit_settle.ready(
                fit,
                view.last_resize,
                false,
                std::time::Instant::now() - std::time::Duration::from_millis(151)
            ));
            assert!(view.fit_settle.due(std::time::Instant::now()));
        }
        ((cols, rows), pixels, request, pane, already_fitted)
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    if !already_fitted {
        let command = receiver.try_recv().unwrap();
        assert!(
            matches!(command, browser::Command::Input { input_target: None,
            request: owner, id, input: keys::Input::Resize { cols, rows, cell_width, cell_height, cell_width_milli, cell_height_milli }
        } if owner == request && id == pane && (cols, rows) == expected
            && (cell_width, cell_height, cell_width_milli, cell_height_milli)
                == (Some(pixels.0), Some(pixels.1), Some(pixels.2), Some(pixels.3))),
            "only exact current viewport geometry may settle"
        );
    }
    assert!(receiver.try_recv().is_err(), "only one settled command");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(
        receiver.try_recv().is_err(),
        "settled geometry must not repeat"
    );
    expected
}

/// A plain, unheld key press of `keystroke`, such as `"enter"` or `"cmd-a"`.
pub(super) fn key_down(keystroke: &str) -> gpui::KeyDownEvent {
    gpui::KeyDownEvent {
        keystroke: gpui::Keystroke::parse(keystroke).unwrap(),
        is_held: false,
        prefer_character_input: false,
        layout: None,
    }
}

/// The view every headless window test starts from: an acknowledged presence,
/// focus on the terminal, and the `snapshot.json` frame shown as pane-a, with
/// `state` carrying that frame, pane-a's region and pane-a selected.
pub(super) fn fixture_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
    browser_request: u64,
    mut state: browser::State,
) -> SnapshotView {
    let focus = cx.focus_handle();
    focus.focus(window, cx);
    let mut presence = Presence::new(true);
    presence.flush(&sender);
    presence.acknowledge(1);
    let frame =
        Arc::new(decode::frame(include_bytes!("../../../../../fixtures/snapshot.json")).unwrap());
    state.selected_pane = Some("pane-a".into());
    state.frame = Some(DisplayFrame::Legacy(frame.clone()));
    state.regions =
        serde_json::from_str(r#"[{"id":"pane-a","left":0,"top":0,"width":1,"height":1}]"#).unwrap();
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
        frame: Some(DisplayFrame::Legacy(frame.clone())),
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
        painted_frame: Some(DisplayFrame::Legacy(frame.clone())),
        pointer: Default::default(),
        selection: None,
        divider: None,
        wheel: crate::terminal::WheelRemainder::default(),
        browser_request,
        browser_state: state,
        browser_commands: Some(sender),
        _browser_task: None,
        _task: None,
        painter: Rc::new(RefCell::new(
            crate::terminal_painter::TerminalPainter::default(),
        )),
    }
}
