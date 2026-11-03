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
/// Home's captures (card #684): the owner's window size.
const HOME_SIZE: (f32, f32) = (1560., 1010.);

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
    fixture_frame_sized(COLS, ROWS)
}

fn fixture_frame_sized(cols: usize, rows: usize) -> Result<Vec<u8>> {
    let mut snapshot: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/snapshot.json"))?;
    let blank = serde_json::json!({
        "grapheme": " ", "width": 1, "attributes": 0,
        "foreground": {"kind": "default"}, "background": {"kind": "default"}
    });
    let grid = snapshot["grid"]
        .as_array_mut()
        .ok_or_else(|| anyhow!("fixture grid"))?;
    grid.resize_with(rows, || serde_json::json!({"cells": [], "wrapped": false}));
    for row in grid.iter_mut() {
        let cells = row["cells"]
            .as_array_mut()
            .ok_or_else(|| anyhow!("fixture row"))?;
        cells.resize(cols, blank.clone());
    }
    snapshot["cols"] = cols.into();
    snapshot["rows"] = rows.into();
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

/// Which Home the capture shows (#705): the owner's own screenshot (Local
/// with p1, p3 and p8, no agents), the two-machine fleet with favicons and
/// agents, or a connected Local with no sessions.
#[derive(Clone, Copy, PartialEq)]
enum HomeFixture {
    One,
    Fleet,
    Empty,
}

/// A small project favicon for the fixture, as the daemon would send it.
fn fixture_favicon(svg: &str) -> serde_json::Value {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    serde_json::json!({"mime": "image/svg+xml", "data": STANDARD.encode(svg)})
}

/// Home's fleet for the capture. Activity is relative to now, so the rows
/// read "now", "12 min ago" and so on whenever the capture runs.
fn with_home_fleet(mut state: browser::State, fixture: HomeFixture) -> Result<browser::State> {
    let token =
        |n: u128| uuid::Uuid::from_u128(0x6840_0000_0000_4000_8000_0000_0000_0000 + n).to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as i64;
    let leaf = fixture_favicon(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#16a34a"/><path d="M9 21c0-7 5-12 14-12-1 9-5 14-12 14l-2 2" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg>"##,
    );
    let hex = fixture_favicon(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M16 2 28 9v14l-12 7-12-7V9z" fill="#2563eb"/><path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill="#93c5fd"/></svg>"##,
    );
    let sun = fixture_favicon(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="16" fill="#f59e0b"/><circle cx="16" cy="16" r="7" fill="#fff7ed"/></svg>"##,
    );
    let stack = fixture_favicon(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#111827"/><path d="M8 11h16M8 16h16M8 21h10" stroke="#e5e7eb" stroke-width="2.5" stroke-linecap="round"/></svg>"##,
    );
    let session = |id: String, name: &str, windows: u64, panes: u64, ago: i64, n: u128| {
        serde_json::json!({"id": id, "name": name, "paneCount": panes, "windowCount": windows,
            "lastActivity": now - ago, "favoriteAction": token(100 + n), "serverId": "default",
            "sessionId": format!("${n}"), "selection": token(200 + n)})
    };
    let local_sessions: Vec<serde_json::Value> = match fixture {
        HomeFixture::Empty => Vec::new(),
        HomeFixture::One => vec![
            {
                let mut p1 = session("local-p1".into(), "p1", 2, 3, 5, 1);
                p1["active"] = true.into();
                p1["favicon"] = leaf.clone();
                p1
            },
            session("local-p3".into(), "p3", 1, 1, 12 * 60, 2),
            {
                let mut p8 = session("local-p8".into(), "p8", 3, 5, 2 * 3600, 3);
                p8["favicon"] = hex.clone();
                p8
            },
        ],
        HomeFixture::Fleet => vec![session("local-0".into(), "0", 1, 2, 3 * 3600, 4)],
    };
    let mut groups = vec![serde_json::json!(
        {"id": "local", "label": "Local", "state": "ready", "conflict": false,
         "collapsed": false, "collapseAction": token(1), "omittedSessions": 0, "omittedServers": 0,
         "servers": [{"id": "default", "label": "default", "state": "online",
            "generation": token(2), "selection": token(3)}],
         "sessions": local_sessions})];
    if fixture == HomeFixture::Fleet {
        let spark: Vec<serde_json::Value> = [
            ("devstack", 3, 3, 30, true, Some(&stack)),
            ("site", 2, 2, 60, true, Some(&sun)),
            ("demo", 1, 3, 8 * 60, false, None),
            ("api", 2, 4, 25 * 60, false, Some(&hex)),
            ("growth", 1, 1, 3600, false, Some(&leaf)),
            ("lint", 1, 3, 2 * 3600, false, None),
            ("bezel", 2, 2, 3 * 3600, false, None),
            ("docs", 1, 1, 26 * 3600, false, None),
            ("infra", 2, 3, 30 * 3600, false, None),
            ("notes", 1, 1, 3 * 86_400, false, None),
            ("scratch", 1, 1, 9 * 86_400, false, None),
        ]
        .iter()
        .enumerate()
        .map(|(i, (name, windows, panes, ago, favorite, icon))| {
            let mut row = session(
                format!("spark-{name}"),
                name,
                *windows,
                *panes,
                *ago,
                10 + i as u128,
            );
            row["favorite"] = (*favorite).into();
            row["active"] = (*name == "devstack").into();
            if let Some(icon) = icon {
                row["favicon"] = (*icon).clone();
            }
            row
        })
        .collect();
        groups.push(serde_json::json!(
            {"id": "spark", "label": "spark", "state": "ready", "conflict": false,
             "collapsed": false, "collapseAction": token(6), "disconnect": token(7),
             "omittedSessions": 0, "omittedServers": 0,
             "servers": [{"id": "default", "label": "default", "state": "online",
                "generation": token(8), "selection": token(9)}],
             "sessions": spark}));
    }
    state.fleet = Some(serde_json::from_value(serde_json::json!({
        "preferences": {"revision": 1, "phase": "ready", "error": null},
        "omittedGroups": 0,
        "groups": groups,
    }))?);
    state.selected_server = Some(browser::fleet::SelectedServer {
        machine_id: "local".into(),
        machine_label: "Local".into(),
        server_id: "default".into(),
        generation: token(2),
        label: "default".into(),
    });
    let rows = if fixture == HomeFixture::Fleet {
        serde_json::json!([
            {"key": "agent-a", "sessionId": "$10", "paneId": "pane-a", "name": "Claude",
             "sessionLabel": "devstack", "harness": "claude-code", "status": "WORKING",
             "attention": false, "available": true},
            {"key": "agent-b", "sessionId": "$11", "paneId": "pane-b", "name": "Codex",
             "sessionLabel": "site", "harness": "codex", "status": "BLOCKED",
             "attention": true, "available": true}
        ])
    } else {
        serde_json::json!([])
    };
    state.home_agents = Some(serde_json::from_value(serde_json::json!({
        "revision": 1, "phase": "live", "observedSessions": 2, "totalSessions": 12,
        "truncatedSessions": 0, "truncatedRows": 0, "note": null, "rows": rows
    }))?);
    state.surface = browser::Surface::Home;
    Ok(state)
}

/// Two panes of one window: the upper scrolled back, so its header offers
/// Back to live; the lower a browser whose page just refused a click.
/// The owner's window (31 Oct capture): about 1560x1010, two panes side by
/// side, the right one focused. The first frames run at [`COLS`]x[`ROWS`];
/// the grid is then refitted to what the window's workspace holds.
const OWNER_WIDTH: f32 = 1560.;
const OWNER_HEIGHT: f32 = 1010.;

fn with_owner_split(mut state: browser::State, cols: usize, rows: usize) -> Result<browser::State> {
    let frame = Arc::new(
        decode::frame(&fixture_frame_sized(cols, rows)?)
            .map_err(|error| anyhow!("fixture frame: {error}"))?,
    );
    state.frame = Some(DisplayFrame::Legacy(frame));
    if let Some(pane) = state.panes.iter_mut().find(|pane| pane.id == "pane-b") {
        pane.window_id = Some("window-1".into());
    }
    let left = cols / 2;
    state.regions = serde_json::from_value(serde_json::json!([
        {"id": "pane-a", "left": 0, "top": 0, "width": left, "height": rows},
        {"id": "pane-b", "left": left + 1, "top": 0, "width": cols - left - 1, "height": rows}
    ]))?;
    state.selected_pane = Some("pane-b".into());
    Ok(state)
}

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
    // `<theme>+browser` a split window with a browser pane's toolbar, and
    // `<theme>+owner` the owner's window size with two panes side by side.
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
    let owner = extras.contains(&"owner");
    let state = if owner {
        with_owner_split(state, COLS, ROWS)?
    } else {
        state
    };
    let mut state = if browser_pane {
        with_browser(state)?
    } else {
        state
    };
    if extras.contains(&"agents") {
        state.workspace_agents = Some(serde_json::from_value(serde_json::json!({
            "sessionId": "session-a", "revision": 1, "phase": "loading",
            "rows": [{"key": "agent-a", "sessionId": "session-a", "paneId": "pane-a",
                "name": "Claude", "sessionLabel": "tmux-ide", "status": "WORKING",
                "attention": false, "available": true}],
            "observedSessions": 1, "totalSessions": 3, "truncatedSessions": 2,
            "truncatedRows": 4, "note": "Two servers did not answer"
        }))?);
    }
    if home {
        state.surface = browser::Surface::Home;
    }
    // `+home-b` is Home (#684, #705): `+one` the owner's one machine, `+empty`
    // no sessions, otherwise the two-machine fleet; `+spark` picks spark.
    let home_b = extras.contains(&"home-b");
    if home_b {
        let fixture = if extras.contains(&"one") {
            HomeFixture::One
        } else if extras.contains(&"empty") {
            HomeFixture::Empty
        } else {
            HomeFixture::Fleet
        };
        state = with_home_fleet(state, fixture)?;
    }
    let spark = extras.contains(&"spark");
    let (width, height) = if home_b { HOME_SIZE } else { (WIDTH, HEIGHT) };
    // `+home-empty` is Home with a live catalog and no sessions, `+home-error`
    // with local setup failed, and `+home-warning` with the catalog unavailable.
    for extra in &extras {
        match *extra {
            "home-empty" => state.sessions.clear(),
            "home-error" => {
                state.local_setup = Some(browser::local_setup::Setup {
                    phase: browser::local_setup::Phase::Failed,
                })
            }
            "home-warning" => {
                state.home_phase = browser::HomePhase::Unavailable;
                state.status = "The local daemon could not be reached. Check the tmux-ide daemon, then Refresh sessions.".into();
            }
            _ => continue,
        }
        state.surface = browser::Surface::Home;
    }
    let (sender, receiver) = mpsc::sync_channel(1024);
    let root: Rc<RefCell<Option<Entity<SnapshotView>>>> = Default::default();
    let bounds = Bounds {
        origin: point(px(-10000.), px(-10000.)),
        size: if owner {
            size(px(OWNER_WIDTH), px(OWNER_HEIGHT))
        } else {
            size(px(width), px(height))
        },
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
                let view = cx.new(|cx| {
                    let mut view = capture_view(window, cx, sender, state);
                    view.sidebar_hidden = home_b;
                    if spark {
                        view.prepare_home_filter(cx);
                        if let Some(controls) = &mut view.home_filter {
                            controls.fleet_view =
                                super::home::fleet_nav::View::Machine("spark".into());
                            controls.table_cursor = Some(("spark".into(), "spark-devstack".into()));
                            controls.fleet_table.clone().focus(window, cx);
                        }
                    }
                    view
                });
                *root.borrow_mut() = Some(view.clone());
                if palette {
                    view.update(cx, |view, cx| view.open_picker(window, cx));
                }
                if machine {
                    view.update(cx, |view, cx| view.open_add_machine(window, cx));
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
    if owner && let Some(view) = root.borrow().clone() {
        cx.update(|cx| {
            view.update(cx, |view, _| -> Result<()> {
                let (Some((canvas, _)), Some(width)) = (view.input_geometry, view.input_cell_width)
                else {
                    return Err(anyhow!("owner capture: no terminal geometry"));
                };
                let overhead = view
                    .card_layout(width)
                    .map_or(size(px(0.), px(0.)), |l| l.overhead());
                let (cols, rows) = super::geometry::cell_grid(
                    f32::from(canvas.size.width - overhead.width),
                    f32::from(canvas.size.height - overhead.height),
                    width,
                    view.terminal_height(),
                )
                .ok_or_else(|| anyhow!("owner capture: no fit"))?;
                let state = with_owner_split(
                    std::mem::take(&mut view.browser_state),
                    cols.into(),
                    rows.into(),
                )?;
                view.frame = state.frame.clone();
                view.browser_state = state;
                Ok(())
            })
        })?;
        for _ in 0..3 {
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, _| window.refresh())?;
        }
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
