//! Dev-only screenshots of the real window, rendered offscreen to a Metal
//! texture, so they need no display. Built only with the `visual-capture`
//! feature; run through `examples/capture_window.rs` on the main thread.
use super::{
    SnapshotView,
    appearance::{Appearance, Colors, OptionItem, System},
    browser, decode,
    display_frame::DisplayFrame,
    presence::Presence,
    session_tabs::{Publication, Row},
};
use anyhow::{Context as _, anyhow};
use gpui::*;
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Arc, mpsc},
};

const WIDTH: f32 = 1440.;
const HEIGHT: f32 = 900.;

/// Saves `<dir>/<theme>.png` for each catalog theme id, in order.
#[doc(hidden)]
pub fn capture_catalog_themes(dir: &Path, themes: &[&str]) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let mut cx = VisualTestAppContext::with_asset_source(
        gpui_platform::current_platform(false),
        Arc::new(crate::icons::Icons),
    );
    for id in themes {
        let path = capture_theme(&mut cx, dir, id)?;
        eprintln!("captured {}", path.display());
    }
    Ok(())
}

fn catalog_appearance(id: &str) -> Result<Appearance> {
    let presets: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("appearance/catalog.json"))?;
    let preset = presets
        .iter()
        .find(|p| p["id"] == id)
        .ok_or_else(|| anyhow!("unknown catalog theme {id}"))?;
    let system = if preset["mode"] == "light" {
        System::Light
    } else {
        System::Dark
    };
    let key = match system {
        System::Light => "light",
        System::Dark => "dark",
    };
    let theme: Colors = serde_json::from_value(preset[key].clone())?;
    let options = presets
        .iter()
        .map(|p| OptionItem {
            id: p["id"].as_str().unwrap_or_default().into(),
            name: p["name"].as_str().unwrap_or_default().into(),
        })
        .collect();
    let appearance = Appearance {
        selected: id.into(),
        system,
        theme,
        options,
        error: None,
    };
    if !appearance.valid() {
        return Err(anyhow!("catalog theme {id} is invalid"));
    }
    Ok(appearance)
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

/// Terminal size in cells: about what a 1440x900 window's workspace holds.
const COLS: usize = 132;
const ROWS: usize = 44;

/// The fixture terminal frame, padded with blank cells to [`COLS`]x[`ROWS`].
fn fixture_frame() -> Result<Vec<u8>> {
    let mut snapshot: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/snapshot.json"))?;
    let blank = serde_json::json!({
        "grapheme": " ", "width": 1, "attributes": 0,
        "foreground": {"kind": "default"}, "background": {"kind": "default"}
    });
    let grid = snapshot["grid"]
        .as_array_mut()
        .ok_or_else(|| anyhow!("fixture grid"))?;
    grid.resize_with(ROWS, || serde_json::json!({"cells": [], "wrapped": false}));
    for row in grid.iter_mut() {
        let cells = row["cells"]
            .as_array_mut()
            .ok_or_else(|| anyhow!("fixture row"))?;
        cells.resize(COLS, blank.clone());
    }
    snapshot["cols"] = COLS.into();
    snapshot["rows"] = ROWS.into();
    Ok(serde_json::to_vec(&snapshot)?)
}

/// The browsing state a connected window shows: sessions in the sidebar,
/// tmux windows in the titlebar strip, the fixture frame in the workspace.
fn browser_state(appearance: Appearance) -> Result<browser::State> {
    let frame = Arc::new(
        decode::frame(&fixture_frame()?).map_err(|error| anyhow!("fixture frame: {error}"))?,
    );
    Ok(browser::State {
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
        regions: serde_json::from_value(serde_json::json!([
            {"id": "pane-a", "left": 0, "top": 0, "width": COLS, "height": ROWS}
        ]))?,
        session_tabs: Some(session_tabs()),
        appearance: Some(appearance),
        ..Default::default()
    })
}

fn capture_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
    state: browser::State,
) -> SnapshotView {
    let focus = cx.focus_handle();
    focus.focus(window, cx);
    let mut presence = Presence::new(true);
    presence.flush(&sender);
    presence.acknowledge(1);
    SnapshotView {
        graphics: Default::default(),
        presence,
        _activation: None,
        _appearance: None,
        last_system: state.appearance.as_ref().map(|a| a.system),
        chrome: Default::default(),
        last_workspace_session: None,
        pending_session_open: None,
        header_controls: Default::default(),
        frame: state.frame.clone(),
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
        browser_state: state,
        browser_commands: Some(sender),
        _browser_task: None,
        _task: None,
        painter: Rc::new(RefCell::new(
            crate::terminal_painter::TerminalPainter::default(),
        )),
    }
}

/// The fleet sidebar (machine, server and session rows), with one session's
/// agent waiting on the user, so the attention badge shows.
fn with_fleet(mut state: browser::State) -> Result<browser::State> {
    state.fleet = Some(serde_json::from_value(serde_json::json!({
        "preferences": {"revision": 1, "phase": "ready", "error": null},
        "omittedGroups": 0,
        "groups": [{
            "id": "this-mac", "label": "This Mac", "state": "ready", "conflict": false,
            "collapsed": false, "collapseAction": "11111111-1111-4111-8111-111111111111",
            "omittedSessions": 0, "omittedServers": 0,
            "servers": [{"id": "default", "label": "default", "state": "online",
                "generation": "22222222-2222-4222-8222-222222222222",
                "selection": "33333333-3333-4333-8333-333333333333"}],
            "sessions": [
                {"id": "fleet-a", "name": "tmux-ide", "sessionId": "session-a", "serverId": "default",
                 "paneCount": 3, "selection": "44444444-4444-4444-8444-444444444444", "active": true},
                {"id": "fleet-b", "name": "site", "sessionId": "session-b", "serverId": "default",
                 "paneCount": 2, "selection": "55555555-5555-4555-8555-555555555555"},
                {"id": "fleet-c", "name": "bezel", "sessionId": "session-c", "serverId": "default",
                 "paneCount": 1, "selection": "66666666-6666-4666-8666-666666666666"}
            ]
        }]
    }))?);
    let mut agents: super::workspace_fleet_agents::Publication =
        serde_json::from_value(serde_json::json!({
            "request": state.request, "scope": 1, "revision": 1, "phase": "live",
            "selectedKey": null, "observedSessions": 1, "totalSessions": 1,
            "truncatedSessions": 0, "truncatedRows": 0, "note": null,
            "rows": [{"key": "agent-b", "sessionId": "session-b", "paneId": "pane-b",
                "name": "Claude", "sessionLabel": "site", "projectName": "site",
                "status": "BLOCKED", "attention": true, "available": true}]
        }))?;
    agents.sessions.insert(
        "agent-b".into(),
        super::workspace_fleet_agents::SessionScope {
            machine: "this-mac".into(),
            server: "default".into(),
            generation: "22222222-2222-4222-8222-222222222222".into(),
            session: "session-b".into(),
        },
    );
    state.workspace_fleet_agents = Some(agents);
    Ok(state)
}

/// Two panes of one window: the upper scrolled back, so its header offers
/// Back to live; the lower a browser whose page just refused a click.
fn with_browser(mut state: browser::State) -> Result<browser::State> {
    if let Some(pane) = state.panes.iter_mut().find(|pane| pane.id == "pane-b") {
        pane.window_id = Some("window-1".into());
    }
    state.regions = serde_json::from_value(serde_json::json!([
        {"id": "pane-a", "left": 0, "top": 0, "width": COLS, "height": 23},
        {"id": "pane-b", "left": 0, "top": 24, "width": COLS, "height": ROWS - 24}
    ]))?;
    state.history_offset = 12;
    state.browser_controls.insert(
        "pane-b".into(),
        herdr_client::tmux_daemon::BrowserState {
            version: 1,
            instance: "12345678-1234-4234-8234-123456789abc".into(),
            pane: "%2".into(),
            tab: 1,
            revision: 1,
            enabled: true,
            url: "https://tmux-ide.dev/docs".into(),
            title: "tmux-ide docs".into(),
            loading: false,
            can_go_back: true,
            can_go_forward: false,
        },
    );
    state
        .browser_marks
        .insert("pane-b".into(), super::browser_toolbar::Mark::Rejected(1));
    Ok(state)
}

fn capture_theme(cx: &mut VisualTestAppContext, dir: &Path, id: &str) -> Result<PathBuf> {
    // `<theme>+fleet` shows the fleet sidebar with an attention badge,
    // `<theme>+palette` the command palette open over the workspace,
    // `<theme>+machine` the Add machine dialog, `<theme>+home` Home, and
    // `<theme>+browser` a split window with a browser pane's toolbar.
    let mut parts = id.split('+');
    let theme = parts.next().unwrap_or(id);
    let extras: Vec<&str> = parts.collect();
    let fleet = extras.contains(&"fleet");
    let palette = extras.contains(&"palette");
    let machine = extras.contains(&"machine");
    let home = extras.contains(&"home");
    let browser_pane = extras.contains(&"browser");
    let appearance = catalog_appearance(theme)?;
    // Transparent where the theme is vibrant, so translucent chrome keeps its alpha.
    let background = super::design::palette(&appearance.native()).window_background_appearance();
    let state = browser_state(appearance)?;
    let state = if fleet { with_fleet(state)? } else { state };
    let mut state = if browser_pane {
        with_browser(state)?
    } else {
        state
    };
    if home {
        state.surface = browser::Surface::Home;
    }
    let (sender, receiver) = mpsc::sync_channel(1024);
    let bounds = Bounds {
        origin: point(px(-10000.), px(-10000.)),
        size: size(px(WIDTH), px(HEIGHT)),
    };
    let handle = cx.update(|cx| {
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_background: background,
                focus: false,
                show: false,
                ..super::shell::options()
            },
            |window, cx| {
                let view = cx.new(|cx| capture_view(window, cx, sender, state));
                if palette {
                    view.update(cx, |view, cx| view.open_picker(window, cx));
                }
                if machine {
                    view.update(cx, |view, cx| view.open_add_machine_for_capture(window, cx));
                }
                super::agent_spinner::window_root(view, window, cx)
            },
        )
    })?;
    // Later frames see the measured strip and terminal geometry from earlier ones.
    for _ in 0..3 {
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, _| window.refresh())?;
    }
    cx.run_until_parked();
    receiver.try_iter().for_each(drop);
    let image = cx.capture_screenshot(handle.into())?;
    let path = dir.join(format!("{id}.png"));
    image
        .save_with_format(&path, image::ImageFormat::Png)
        .with_context(|| format!("save {}", path.display()))?;
    cx.update_window(handle.into(), |_, window, _| window.remove_window())?;
    cx.run_until_parked();
    Ok(path)
}
