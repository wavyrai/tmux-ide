//! Opt-in screenshots of the real window, rendered offscreen to a Metal texture.
//! Run: `TMUX_IDE_CAPTURE_DIR=<dir> cargo test -p tmux-ide-gpui --lib visual_capture
//! -- --ignored --test-threads=1`. `TMUX_IDE_CAPTURE_THEMES` picks catalog ids.
//! Known gap: libtest runs every test off the main thread, even with
//! --test-threads=1, and MacPlatform::new panics there. It needs a main-thread entry.
#![allow(clippy::unwrap_used)]
use super::{
    SnapshotView,
    appearance::{Appearance, Colors, OptionItem, System},
    browser, decode,
    display_frame::DisplayFrame,
    presence::Presence,
};
use crate::tmux_snapshot::session_tabs::{Publication, Row};
use core::prelude::v1::test;
use gpui::*;
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Arc, mpsc},
};

const DEFAULT_THEMES: &str = "dark,light,dracula,solarized-light";

fn catalog_appearance(id: &str) -> Appearance {
    let presets: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("appearance/catalog.json")).unwrap();
    let Some(preset) = presets.iter().find(|p| p["id"] == id) else {
        panic!("unknown catalog theme {id}");
    };
    let system = if preset["mode"] == "light" {
        System::Light
    } else {
        System::Dark
    };
    let key = match system {
        System::Light => "light",
        System::Dark => "dark",
    };
    let theme: Colors = serde_json::from_value(preset[key].clone()).unwrap();
    let options = presets
        .iter()
        .map(|p| OptionItem {
            id: p["id"].as_str().unwrap().into(),
            name: p["name"].as_str().unwrap().into(),
        })
        .collect();
    let appearance = Appearance {
        selected: id.into(),
        system,
        theme,
        options,
        error: None,
    };
    assert!(appearance.valid(), "catalog theme {id} is invalid");
    appearance
}

fn session(id: &str, label: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: label.into(),
        pane_count: Some(2),
        window_id: None,
        browser_icon: None,
        window_label: None,
    }
}

fn pane(id: &str, window: &str, label: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: label.into(),
        pane_count: None,
        window_id: Some(window.into()),
        browser_icon: None,
        window_label: Some(label.into()),
    }
}

fn session_tabs() -> Publication {
    let token = |n: u128| uuid::Uuid::from_u128(n).to_string();
    let rows: Vec<Row> = [("tmux-ide", "This Mac"), ("site", "This Mac")]
        .iter()
        .enumerate()
        .map(|(index, (label, host))| {
            let n = index as u128;
            Row {
                id: token(n + 1),
                label: (*label).into(),
                host_label: (*host).into(),
                server_label: None,
                available: true,
                unread: false,
                activity: None,
                activate: token(n + 101),
                close: token(n + 201),
            }
        })
        .collect();
    Publication {
        request: 7,
        revision: 1,
        active: rows.first().map(|r| r.id.clone()),
        pending: None,
        next: rows.get(1).map(|r| r.activate.clone()),
        previous: rows.get(1).map(|r| r.activate.clone()),
        close_active: rows.first().map(|r| r.close.clone()),
        rows,
    }
}

fn capture_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
    appearance: Appearance,
) -> SnapshotView {
    let focus = cx.focus_handle();
    focus.focus(window, cx);
    let mut presence = Presence::new(true);
    presence.flush(&sender);
    presence.acknowledge(1);
    let frame =
        Arc::new(decode::frame(include_bytes!("../../../../../fixtures/snapshot.json")).unwrap());
    SnapshotView {
        graphics: Default::default(),
        presence,
        _activation: None,
        _appearance: None,
        last_system: Some(appearance.system),
        glass: Default::default(),
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
            request: 7,
            surface: browser::Surface::Workspace,
            input_ready: true,
            status: "Connected".into(),
            sessions: vec![
                session("session-a", "tmux-ide"),
                session("session-b", "site"),
                session("session-c", "bezel"),
                session("session-d", "notes"),
            ],
            panes: vec![
                pane("pane-a", "window-1", "editor"),
                pane("pane-b", "window-2", "server"),
                pane("pane-c", "window-3", "tests"),
            ],
            selected_session: Some("session-a".into()),
            selected_pane: Some("pane-a".into()),
            frame: Some(DisplayFrame::Legacy(frame)),
            regions: serde_json::from_str(
                r#"[{"id":"pane-a","left":0,"top":0,"width":1,"height":1}]"#,
            )
            .unwrap(),
            session_tabs: Some(session_tabs()),
            appearance: Some(appearance),
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

fn capture_theme(dir: &Path, id: &str) -> PathBuf {
    let mut cx = VisualTestAppContext::with_asset_source(
        gpui_platform::current_platform(false),
        Arc::new(crate::icons::Icons),
    );
    let (sender, receiver) = mpsc::sync_channel(1024);
    let appearance = catalog_appearance(id);
    let bounds = Bounds {
        origin: point(px(-10000.), px(-10000.)),
        size: size(px(1440.), px(900.)),
    };
    let handle = cx
        .update(|cx| {
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    focus: false,
                    show: true,
                    ..super::shell::options()
                },
                |window, cx| {
                    let view = cx.new(|cx| capture_view(window, cx, sender, appearance));
                    super::agent_spinner::window_root(view, window, cx)
                },
            )
        })
        .unwrap();
    // Two frames: the first measures the strip and the terminal geometry.
    for _ in 0..3 {
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, _| window.refresh())
            .unwrap();
    }
    cx.run_until_parked();
    receiver.try_iter().for_each(drop);
    let image = cx.capture_screenshot(handle.into()).unwrap();
    let path = dir.join(format!("{id}.png"));
    image
        .save_with_format(&path, image::ImageFormat::Png)
        .unwrap();
    cx.update_window(handle.into(), |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
    path
}

#[test]
#[ignore = "opt-in: set TMUX_IDE_CAPTURE_DIR and pass --ignored --test-threads=1"]
fn capture_window_in_catalog_themes() {
    let Some(dir) = std::env::var_os("TMUX_IDE_CAPTURE_DIR").map(PathBuf::from) else {
        return;
    };
    std::fs::create_dir_all(&dir).unwrap();
    let themes = std::env::var("TMUX_IDE_CAPTURE_THEMES").unwrap_or_else(|_| DEFAULT_THEMES.into());
    for id in themes.split(',').map(str::trim).filter(|id| !id.is_empty()) {
        let path = capture_theme(&dir, id);
        eprintln!("captured {}", path.display());
    }
}
