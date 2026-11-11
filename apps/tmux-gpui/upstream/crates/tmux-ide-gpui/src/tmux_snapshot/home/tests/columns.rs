use super::*;

#[gpui::test]
fn the_filter_row_sits_over_the_table_at_every_width(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../fixtures/home-fleet.json"
            ))
            .unwrap(),
        );
        view
    });
    receiver.try_iter().for_each(drop);
    for width in [1400., 800.] {
        cx.simulate_resize(size(px(width), px(1000.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let nav = cx.debug_bounds("home-fleet-nav").unwrap();
        let table = cx.debug_bounds("home-fleet-column").unwrap();
        let agents = cx.debug_bounds("home-agents-column").unwrap();
        let header = cx.debug_bounds("home-header").unwrap();
        assert!(nav.left() >= header.left() && table.right() <= header.right());
        // One row of filters over the table (#746).
        assert!(table.top() > nav.bottom(), "{width}");
        assert_eq!(table.left(), nav.left());
        let all = cx.debug_bounds("home-nav-all").unwrap();
        let favourites = cx.debug_bounds("home-nav-favourites").unwrap();
        assert_eq!(all.top(), favourites.top());
        assert!(all.right() <= favourites.left());
        // Agents sit under the table, in its column.
        assert_eq!(
            (agents.left(), agents.right()),
            (table.left(), table.right())
        );
        // The title and the one primary action sit in the header line.
        let title = cx.debug_bounds("home-title").unwrap();
        let new = cx.debug_bounds("home-new-local-session").unwrap();
        assert!(title.left() <= nav.left() + px(1.));
        assert!(new.top() >= header.top() && new.bottom() <= header.bottom());
    }
    assert!(receiver.try_recv().is_err());
}

/// Home shows the sidebar with its Home row selected when the window leaves
/// the table room, and hides it in a narrow window (#746).
#[gpui::test]
fn home_keeps_the_sidebar_beside_a_wide_table(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(1200.), px(800.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let sidebar = cx.debug_bounds("tmux-sidebar-viewport").unwrap();
    let home = cx.debug_bounds("tmux-sidebar-home").unwrap();
    let page = cx.debug_bounds("tmux-home").unwrap();
    assert!(home.left() >= sidebar.left() && home.right() <= sidebar.right());
    assert!(page.left() >= sidebar.right());
    cx.simulate_resize(size(px(800.), px(800.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-sidebar-viewport").is_none());
    assert!(receiver.try_recv().is_err());
}

/// New session wears the theme's one accent; its words read on it.
#[test]
fn text_on_the_accent_is_whichever_of_white_and_the_background_reads_better() {
    use crate::tmux_snapshot::new_session::on_accent;
    // Linen's clay takes white; Linen Dark's lighter clay its dark background.
    assert_eq!(on_accent(0x984822, 0xf7f4ee), 0xffffff);
    assert_eq!(on_accent(0xe0874f, 0x211f1b), 0x211f1b);
    for (accent, background) in [(0x984822, 0xf7f4ee), (0xe0874f, 0x211f1b)] {
        assert!(crate::contrast::ratio(on_accent(accent, background), accent) >= 4.5);
    }
}

fn fleet_with_agents(view: &mut SnapshotView) {
    view.browser_state.fleet = Some(
        serde_json::from_slice(include_bytes!(
            "../../../../../../../fixtures/home-fleet.json"
        ))
        .unwrap(),
    );
    view.browser_state.home_agents = Some(
        serde_json::from_value(serde_json::json!({
            "revision":1,"phase":"live","observedSessions":2,"totalSessions":2,
            "truncatedSessions":0,"truncatedRows":0,"note":null,
            "rows":[
                {"key":"a","sessionId":"$0","paneId":"p0","name":"Codex","sessionLabel":"x",
                 "harness":"codex","status":"BLOCKED","attention":true,"available":true},
                {"key":"b","sessionId":"$1","paneId":"p1","name":"Claude","sessionLabel":"x",
                 "harness":"claude-code","status":"WORKING","attention":false,"available":true}
            ]
        }))
        .unwrap(),
    );
}

/// Agents sit in their own column under an "Agents" heading (#746), and the
/// column gives way before a session's name does in a narrow window.
#[gpui::test]
fn agents_have_their_own_column(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        fleet_with_agents(&mut view);
        view
    });
    receiver.try_iter().for_each(drop);
    for width in [1400., 800.] {
        cx.simulate_resize(size(px(width), px(900.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let heading = cx.debug_bounds("fleet-columns-agents").unwrap();
        let cell = cx.debug_bounds("fleet-session-agents-0-0").unwrap();
        let label = cx.debug_bounds("fleet-session-label-0-0").unwrap();
        let windows = cx.debug_bounds("fleet-session-status-0-0").unwrap();
        let session = cx.debug_bounds("fleet-session-0-0").unwrap();
        let columns = cx.debug_bounds("fleet-columns").unwrap();
        eprintln!(
            "{width}: heading {heading:?} cell {cell:?} label {label:?} row {session:?} cols {columns:?}"
        );
        assert_eq!(heading.left(), cell.left(), "{width}");
        assert_eq!(heading.size.width, cell.size.width, "{width}");
        // The column is its own, not a tail of the name's cell.
        let name = cx.debug_bounds("fleet-session-name-0-0").unwrap();
        assert!(name.right() <= cell.left(), "{width}");
        assert!(label.right() <= cell.left(), "{width}");
        assert!(cell.right() <= windows.left(), "{width}");
        assert!(
            label.size.width >= px(super::super::fleet::NAME_MIN) - px(1.),
            "{width}"
        );
    }
    assert!(receiver.try_recv().is_err());
}

/// A needs-input agent's chip is the accent wash with its words in the
/// accent; a working agent keeps its outlined chip and badge (#746).
#[gpui::test]
fn a_needs_input_chip_wears_the_accent_wash(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        fleet_with_agents(&mut view);
        view
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(1400.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(
        cx.debug_bounds("fleet-session-asks-0-0").is_some(),
        "Codex asks"
    );
    assert!(
        cx.debug_bounds("fleet-session-asks-0-1").is_none(),
        "Claude works"
    );
    let asks = cx.debug_bounds("fleet-session-agents-0-0").unwrap();
    let works = cx.debug_bounds("fleet-session-agents-0-1").unwrap();
    assert!(asks.size.width > px(0.) && works.size.width > px(0.));
}

/// The wash's words read at 4.6:1 in every catalog variant.
#[test]
fn needs_input_words_read_on_their_wash_in_every_variant() {
    use super::super::fleet_rows::needs_input_chip;
    let presets: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../appearance/catalog.json")).unwrap();
    let mut variants = 0;
    for preset in &presets {
        for system in ["dark", "light"] {
            let appearance: crate::tmux_snapshot::appearance::Appearance =
                serde_json::from_value(serde_json::json!({
                    "selected": preset["id"], "system": system, "error": null,
                    "options": [{"id": preset["id"], "name": "x"}],
                    "theme": preset[system]
                }))
                .unwrap();
            let theme = appearance.native();
            let canvas = preset[system]["canvas"].as_u64().unwrap() as u32;
            let (wash, ink) = needs_input_chip(&theme, canvas);
            variants += 1;
            assert_ne!(wash, canvas, "{} ({system}): the wash shows", preset["id"]);
            assert!(
                crate::contrast::ratio(ink, wash) >= 4.6 - 0.01,
                "{} ({system})",
                preset["id"]
            );
        }
    }
    assert_eq!(variants, 54);
}

/// A fault's strip has one place: under the toolbar, over the filter row,
/// spanning the column from Home's title (#746).
#[gpui::test]
fn the_status_slot_sits_between_the_toolbar_and_the_filters(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../fixtures/home-fleet.json"
            ))
            .unwrap(),
        );
        view.browser_state.local_setup = Some(browser::local_setup::Setup {
            phase: browser::local_setup::Phase::Failed,
        });
        view
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(1400.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let header = cx.debug_bounds("home-header").unwrap();
    let title = cx.debug_bounds("home-title").unwrap();
    let nav = cx.debug_bounds("home-fleet-nav").unwrap();
    // r3: failed setup is the act card, in the same slot.
    let strip = cx.debug_bounds("home-act-card").unwrap();
    assert!(header.bottom() <= strip.top());
    assert!(strip.bottom() <= nav.top());
    assert!((strip.left() - title.left()).abs() <= px(1.));
    assert!(receiver.try_recv().is_err());
}

/// Home's sidebar (#746): every project has a tile, its agents sit under it
/// with their state, and the catalog does not repeat projects the fleet
/// lists.
#[test]
fn homes_sidebar_lists_each_project_once_with_its_agents_and_a_tile() {
    use crate::tmux_snapshot::browser_ui::sidebar::{Kind, Target, rows};
    let mut state = browser::State {
        surface: browser::Surface::Home,
        // The current server's catalog: the same sessions the fleet lists.
        sessions: vec![choice("$0", "same"), choice("$1", "same")],
        ..Default::default()
    };
    let mut view_state = state.clone();
    {
        // Reuse the agents fixture's fleet and roster.
        view_state.fleet = Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../fixtures/home-fleet.json"
            ))
            .unwrap(),
        );
        view_state.home_agents = Some(
            serde_json::from_value(serde_json::json!({
                "revision":3,"phase":"live","observedSessions":2,"totalSessions":2,
                "truncatedSessions":0,"truncatedRows":0,"note":null,
                "rows":[{"key":"a","sessionId":"$0","paneId":"p0","name":"Codex",
                    "sessionLabel":"x","harness":"codex","status":"BLOCKED",
                    "attention":true,"available":true}]
            }))
            .unwrap(),
        );
    }
    state = view_state;
    let listed = rows(&state);
    // No bare catalog rows on Home while a machine lists them.
    assert!(
        !listed
            .iter()
            .any(|r| matches!(r.target, Some(Target::Session(_)))),
        "{:?}",
        listed.iter().map(|r| &r.label).collect::<Vec<_>>()
    );
    // Each project heading has its tile: a favicon or the terminal glyph.
    for heading in listed
        .iter()
        .filter(|r| r.kind == Kind::Heading && r.target.is_some())
    {
        assert!(
            heading.favicon.is_some() || heading.icon.is_some(),
            "{}",
            heading.label
        );
    }
    // Codex sits under $0's heading, with its key for the needs-input pill.
    let first = listed
        .iter()
        .position(|r| r.kind == Kind::Heading && r.target.is_some())
        .unwrap();
    let agent = &listed[first + 1];
    assert_eq!(agent.label, "Codex");
    assert_eq!(agent.agent.as_deref(), Some("a"));
    assert_eq!(
        agent.target,
        Some(Target::HomeAgent {
            revision: 3,
            key: "a".into()
        })
    );
    assert_eq!(
        listed[first].attention, 1,
        "the project counts its waiting agent"
    );
}

#[test]
fn homes_sidebar_keeps_catalog_projects_no_single_ready_machine_lists() {
    use crate::tmux_snapshot::browser_ui::sidebar::{Target, rows};
    let fleet: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../../../fixtures/home-fleet.json"
    ))
    .unwrap();
    let catalog = |fleet: serde_json::Value| {
        let state = browser::State {
            surface: browser::Surface::Home,
            sessions: vec![choice("$0", "same"), choice("$1", "same")],
            fleet: Some(serde_json::from_value(fleet).unwrap()),
            ..Default::default()
        };
        rows(&state)
            .iter()
            .filter_map(|r| match &r.target {
                Some(Target::Session(id)) => Some(id.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert!(catalog(fleet.clone()).is_empty(), "one ready match dedupes");
    // Two sessions on the ready machine carry $0: ambiguous, so it stays.
    let mut twice = fleet.clone();
    let mut copy = twice["groups"][0]["sessions"][0].clone();
    copy["id"] = "session-9".into();
    twice["groups"][0]["sessions"]
        .as_array_mut()
        .unwrap()
        .push(copy);
    assert_eq!(catalog(twice), ["$0"]);
    // A machine that isn't ready doesn't list the catalog's projects.
    let mut waiting = fleet;
    waiting["groups"][0]["state"] = "connecting".into();
    assert_eq!(catalog(waiting), ["$0", "$1"]);
}

/// An agent under its project on Home sits on the pane rows' kind tile, its
/// name past the project's own (#746).
#[gpui::test]
fn homes_agent_rows_sit_on_the_pane_rows_tile(cx: &mut TestAppContext) {
    use crate::tmux_snapshot::browser_ui::sidebar::{Kind, rows};
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        fleet_with_agents(&mut view);
        view.browser_state.sessions.clear();
        view
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(1200.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let listed = view.update(cx, |view, _| rows(&view.browser_state));
    let heading = listed
        .iter()
        .position(|r| r.kind == Kind::Heading && r.target.is_some())
        .unwrap();
    let agent = heading + 1;
    assert_eq!(listed[agent].label, "Codex");
    let tile = cx
        .debug_bounds(format!("tmux-sidebar-tile-{agent}").leak())
        .unwrap();
    // #746 v3: an 18 pt tile.
    assert_eq!(tile.size.width, px(18.));
    let heading_label = cx
        .debug_bounds(format!("tmux-sidebar-label-{heading}").leak())
        .unwrap();
    let agent_label = cx
        .debug_bounds(format!("tmux-sidebar-label-{agent}").leak())
        .unwrap();
    assert!(
        agent_label.left() > heading_label.left(),
        "{agent_label:?} {heading_label:?}"
    );
}

/// A live Home's reconnect line and its Retry, and its fault strip, take the
/// same slot: under the toolbar, over the filter row, from Home's title
/// (#746, as the reconnect fix draws them).
#[gpui::test]
fn only_a_fault_uses_the_status_slot_a_reconnect_does_not(cx: &mut TestAppContext) {
    for fault in [false, true] {
        let (sender, receiver) = mpsc::sync_channel(64);
        let (_, cx) = cx.add_window_view(|window, cx| {
            let mut view = make_view(window, cx, sender);
            fleet_with_agents(&mut view);
            view.browser_state.home_phase = browser::HomePhase::Live;
            if fault {
                view.browser_state.home_fault = true;
                view.browser_state.status = "Home stopped. Reopen tmux-ide.".into();
            } else {
                view.browser_state.reconnect_attempt = Some(2);
                view.browser_state.status = "Reconnecting… attempt 2".into();
            }
            view
        });
        receiver.try_iter().for_each(drop);
        cx.simulate_resize(size(px(1400.), px(900.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let header = cx.debug_bounds("home-header").unwrap();
        let title = cx.debug_bounds("home-title").unwrap();
        let nav = cx.debug_bounds("home-fleet-nav").unwrap();
        // r1: a reconnect shows in the footer slot, not here, and has no Retry.
        if !fault {
            assert!(cx.debug_bounds("home-status-subtitle").is_none());
            assert!(cx.debug_bounds("tmux-reconnect-retry").is_none());
            continue;
        }
        let line = cx
            .debug_bounds("home-status-warning")
            .or_else(|| cx.debug_bounds("home-act-card"))
            .unwrap_or_else(|| panic!("the status line (fault: {fault})"));
        assert!(header.bottom() <= line.top(), "fault: {fault}");
        assert!(line.bottom() <= nav.top(), "fault: {fault}");
        assert!(
            (line.left() - title.left()).abs() <= px(1.),
            "fault: {fault}"
        );
        assert!(cx.debug_bounds("tmux-reconnect-retry").is_none());
    }
}

/// Home's sidebar agent rows take their state from Home's roster: with no
/// workspace fleet publication, Claude's row still draws its glyph (#746).
#[gpui::test]
fn homes_sidebar_agent_rows_draw_their_state_from_homes_roster(cx: &mut TestAppContext) {
    use crate::tmux_snapshot::design::InkProbes;
    let (sender, receiver) = mpsc::sync_channel(64);
    cx.update(|cx| cx.set_global(InkProbes::default()));
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        fleet_with_agents(&mut view);
        view.browser_state.sessions.clear();
        view
    });
    receiver.try_iter().for_each(drop);
    assert!(view.read_with(cx, |v, _| v.browser_state.workspace_fleet_agents.is_none()));
    cx.simulate_resize(size(px(1200.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let painted = cx.update(|_, cx| {
        cx.global::<InkProbes>()
            .0
            .contains_key("agent-glyph-Sidebar")
    });
    assert!(painted, "Claude's working glyph in the sidebar");
}

/// An agent Home's roster lists as unavailable keeps its row, with no target
/// to click (#746).
#[test]
fn an_unavailable_home_agent_row_has_no_target() {
    use crate::tmux_snapshot::browser_ui::sidebar::rows;
    let mut view_state = browser::State {
        surface: browser::Surface::Home,
        fleet: Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../fixtures/home-fleet.json"
            ))
            .unwrap(),
        ),
        ..Default::default()
    };
    for available in [true, false] {
        view_state.home_agents = Some(
            serde_json::from_value(serde_json::json!({
                "revision":3,"phase":"live","observedSessions":1,"totalSessions":1,
                "truncatedSessions":0,"truncatedRows":0,"note":null,
                "rows":[{"key":"a","sessionId":"$0","paneId":"p0","name":"Codex",
                    "sessionLabel":"x","harness":"codex","status":"WORKING",
                    "attention":false,"available":available}]
            }))
            .unwrap(),
        );
        let listed = rows(&view_state);
        let agent = listed.iter().find(|r| r.label == "Codex").unwrap();
        assert_eq!(agent.agent.as_deref(), Some("a"));
        assert_eq!(agent.target.is_some(), available, "available: {available}");
    }
}

/// Below 900pt Home hides its sidebar, and the top row agrees: its controls
/// stop spanning the sidebar's width (#746).
#[gpui::test]
fn the_top_row_and_the_sidebar_agree_on_homes_width_rule(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    for (width, shown) in [(1200., true), (800., false)] {
        cx.simulate_resize(size(px(width), px(800.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let sidebar = cx.debug_bounds("tmux-sidebar-viewport");
        let cluster = cx.debug_bounds("sidebar-top-row").unwrap();
        let spans =
            (cluster.right() - px(crate::tmux_snapshot::browser_ui::SIDEBAR_WIDTH)).abs() <= px(1.);
        assert_eq!(sidebar.is_some(), shown, "sidebar at {width}");
        assert_eq!(spans, shown, "top row at {width}: {cluster:?}");
    }
}

/// The filters are a tab list of tabs, the chosen one selected (#746).
#[gpui::test]
fn the_filters_are_a_tab_list_with_the_chosen_tab_selected(cx: &mut TestAppContext) {
    use crate::tmux_snapshot::home::fleet_nav::View;
    use gpui::accesskit::{Node, Role as A11y};
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        fleet_with_agents(&mut view);
        view
    });
    view.update(cx, |view, cx| {
        let list = view.fleet_nav_list();
        assert_eq!(list.a11y_role(), Some(A11y::TabList));
        for selected in [true, false] {
            let tab = view.fleet_nav_row(0, &View::All, selected, cx);
            assert_eq!(tab.a11y_role(), Some(A11y::Tab));
            let mut node = Node::new(A11y::Tab);
            tab.write_a11y_info(&mut node);
            assert_eq!(node.is_selected(), Some(selected));
            assert_eq!(node.label(), Some("All sessions"));
        }
    });
}
