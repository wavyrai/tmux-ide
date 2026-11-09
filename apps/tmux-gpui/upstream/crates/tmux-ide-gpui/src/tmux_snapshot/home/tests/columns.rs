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
    let strip = cx
        .debug_bounds("home-status-warning")
        .or_else(|| cx.debug_bounds("home-status-error"))
        .or_else(|| cx.debug_bounds("home-status-subtitle"))
        .unwrap();
    assert!(header.bottom() <= strip.top());
    assert!(strip.bottom() <= nav.top());
    assert!((strip.left() - title.left()).abs() <= px(1.));
    assert!(receiver.try_recv().is_err());
}
