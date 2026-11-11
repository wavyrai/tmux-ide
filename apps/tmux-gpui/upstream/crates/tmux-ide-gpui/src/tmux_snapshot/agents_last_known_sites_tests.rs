//! Every site that draws agent state says "last known" once a drop has shown
//! its words (#362 follow-up, review round 2), and none does under the 8 s
//! or with the flag clear. Each test renders the site and reads the words it
//! painted.
#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::{
    browser,
    connection::{Clock, WORDS_AFTER},
    design::{InkProbes, TextProbes},
    fit_test_support::fixture_view,
};
use core::prelude::v1::test;
use gpui::{TestAppContext, VisualTestContext};
use std::{
    cell::Cell,
    collections::BTreeMap,
    rc::Rc,
    sync::Arc,
    sync::mpsc,
    time::{Duration, Instant},
};

/// When a site is drawn: the flag, and how long the drop has lasted.
#[derive(Clone, Copy, Debug)]
struct When {
    flag: bool,
    after: Duration,
}
/// Marked: past the words' 8 s with the flag set.
const MARKED: When = When {
    flag: true,
    after: Duration::from_secs(600),
};
/// Not marked: just under the words' 8 s, or the flag clear however long
/// the wait.
fn unmarked() -> [When; 2] {
    [
        When {
            flag: true,
            after: WORDS_AFTER - Duration::from_millis(100),
        },
        CURRENT,
    ]
}
/// The flag clear, long after the words.
const CURRENT: When = When {
    flag: false,
    after: Duration::from_secs(600),
};

fn clock(start: Instant) -> (Clock, Rc<Cell<Duration>>) {
    let wall = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    let offset = Rc::new(Cell::new(Duration::ZERO));
    let read = offset.clone();
    (
        Rc::new(move || (start + read.get(), wall + read.get())),
        offset,
    )
}
fn choice(id: &str, label: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: label.into(),
        pane_count: None,
        window_id: None,
        browser_icon: None,
        display_name_source: None,
        window_label: None,
    }
}
/// One agent waiting on the user, in `session`, on pane-a.
fn agent(session: &str) -> serde_json::Value {
    serde_json::json!({"key":"agent","sessionId":session,"paneId":"pane-a",
        "name":"Claude","sessionLabel":"Alpha","harness":"claude-code",
        "status":"BLOCKED","attention":true,"available":true})
}
fn roster(session: Option<&str>, row: serde_json::Value) -> serde_json::Value {
    let mut roster = serde_json::json!({"revision":1,"phase":"live","rows":[row],
        "observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,
        "note":null});
    if let Some(session) = session {
        roster["sessionId"] = session.into();
    }
    roster
}

/// A window in `state`, dropped (the lane paused when `flag`) for `after`;
/// `setup` runs first. Returns the words each site painted.
fn painted(
    cx: &mut TestAppContext,
    state: browser::State,
    when: When,
    setup: impl FnOnce(&mut SnapshotView, &mut Window, &mut Context<SnapshotView>),
) -> BTreeMap<String, String> {
    let (sender, _receiver) = mpsc::sync_channel(64);
    cx.update(|cx| cx.set_global(TextProbes::default()));
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    cx.simulate_resize(size(px(1000.), px(700.)));
    draw(&view, cx, when, setup)
}
fn draw(
    view: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    when: When,
    setup: impl FnOnce(&mut SnapshotView, &mut Window, &mut Context<SnapshotView>),
) -> BTreeMap<String, String> {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // The drop first, so a site set up afterwards (the close card)
            // reads the clock as it stands `when.after` into it.
            let (clock, at) = clock(Instant::now());
            view.connection.clock = clock;
            view.browser_state.agents_last_known = when.flag;
            view.browser_state.reconnect_attempt = Some(1);
            view.observe_connection(cx);
            at.set(when.after);
            setup(view, window, cx);
        })
    });
    cx.update(|_, cx| cx.global_mut::<TextProbes>().0.clear());
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|_, cx| cx.global::<TextProbes>().0.clone())
}
fn says(probes: &BTreeMap<String, String>, key: &str) -> String {
    probes
        .get(key)
        .unwrap_or_else(|| panic!("{key} not painted: {probes:#?}"))
        .clone()
}

fn workspace() -> browser::State {
    browser::State {
        surface: browser::Surface::Workspace,
        request: 7,
        input_ready: true,
        sessions: vec![choice("session-a", "Alpha")],
        panes: vec![choice("pane-a", "Editor")],
        selected_session: Some("session-a".into()),
        workspace_agents: Some(
            serde_json::from_value(roster(Some("session-a"), agent("session-a"))).unwrap(),
        ),
        ..Default::default()
    }
}

/// Two panes on a blank frame, so each has a header.
fn split(view: &mut SnapshotView, _: &mut Window, _: &mut Context<SnapshotView>) {
    let mut frame = view.frame.as_ref().unwrap().legacy().as_ref().clone();
    frame.width = 40;
    frame.height = 20;
    let mut blank = frame.cells[0].clone();
    blank.symbol = " ".into();
    blank.modifier = 0;
    blank.skip = false;
    frame.cells = vec![blank; 800];
    frame.cursor = None;
    frame.graphics.clear();
    let frame = crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(Arc::new(frame));
    view.frame = Some(frame.clone());
    view.painted_frame = Some(frame.clone());
    view.browser_state.frame = Some(frame);
    view.browser_state.panes = vec![choice("pane-a", "Editor"), choice("pane-b", "Shell")];
    view.browser_state.regions = serde_json::from_str(
        r#"[{"id":"pane-a","left":0,"top":0,"width":40,"height":9},
            {"id":"pane-b","left":0,"top":10,"width":40,"height":10}]"#,
    )
    .unwrap();
}

/// The sidebar's pane row, its spoken label, and the pane's header.
#[gpui::test]
fn the_sidebar_pane_row_and_the_pane_header_say_last_known(cx: &mut TestAppContext) {
    let probes = painted(cx, workspace(), MARKED, split);
    assert_eq!(
        says(&probes, "agent-state-Sidebar"),
        "Needs input · last known"
    );
    assert_eq!(
        says(&probes, "agent-state-Header"),
        "Needs input · last known"
    );
    assert!(
        says(&probes, "spoken-Claude").ends_with(", Needs input, last known"),
        "{probes:#?}"
    );
}
#[gpui::test]
fn the_sidebar_pane_row_and_the_pane_header_are_current_otherwise(cx: &mut TestAppContext) {
    for when in unmarked() {
        let probes = painted(cx, workspace(), when, split);
        assert_eq!(
            says(&probes, "agent-state-Sidebar"),
            "Needs input",
            "{when:?}"
        );
        assert_eq!(
            says(&probes, "agent-state-Header"),
            "Needs input",
            "{when:?}"
        );
        assert!(
            !says(&probes, "spoken-Claude").contains("last known"),
            "{when:?}"
        );
    }
}

/// The attention list (F7): each agent's line.
fn attention(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    view.browser_state.attention_supported = true;
    view.open_attention(window, cx);
    view.browser_state.attention_agents = Some(
        serde_json::from_value({
            let mut p = roster(None, agent("session-a"));
            p["scope"] = 1.into();
            p
        })
        .unwrap(),
    );
    view.refresh_picker(cx);
}
#[gpui::test]
fn the_attention_list_says_last_known(cx: &mut TestAppContext) {
    let probes = painted(cx, workspace(), MARKED, attention);
    assert!(
        says(&probes, "palette-row-0").ends_with(" · last known"),
        "{probes:#?}"
    );
}
#[gpui::test]
fn the_attention_list_is_current_otherwise(cx: &mut TestAppContext) {
    for when in unmarked() {
        let probes = painted(cx, workspace(), when, attention);
        let line = says(&probes, "palette-row-0");
        assert!(!line.contains("last known"), "{when:?} {line}");
    }
}

/// The close card claims neither working nor finished while the lane is
/// paused: it is open in the gap between the link and the re-read too.
fn close(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    view.browser_state.pane_actions = Some(browser::PaneActions {
        token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
        id: "pane-a".into(),
        zoomed: false,
    });
    view.input_interrupted = true;
    let target = crate::tmux_snapshot::pane_actions::Target::capture(&view.browser_state).unwrap();
    // Interrupted input with a reconnect counts as refused keys, which shows
    // the words at once; the card's own rule must hold before them too.
    view.input_interrupted = false;
    view.browser_state.agents_last_known = true;
    view.begin_pane_close(target, window, cx);
}
#[gpui::test]
fn the_close_card_says_it_may_still_be_running(cx: &mut TestAppContext) {
    // The flag alone decides here, at any length of drop.
    for after in [Duration::ZERO, Duration::from_secs(600)] {
        let probes = painted(
            cx,
            workspace(),
            When { flag: true, after },
            |view, window, cx| {
                close(view, window, cx);
                // At 0 s the words aren't up: only the flag can say "unknown".
                assert_eq!(
                    view.connection_mutes_titles(),
                    !after.is_zero(),
                    "{after:?}"
                );
            },
        );
        let body = says(&probes, "pane-close-body");
        assert!(
            body.starts_with("Claude isn't reporting its state, so it may still be running."),
            "{body}"
        );
    }
}
#[gpui::test]
fn the_close_card_says_working_when_current(cx: &mut TestAppContext) {
    let probes = painted(cx, workspace(), CURRENT, |view, window, cx| {
        close(view, window, cx);
        view.pane_close = None;
        view.browser_state.agents_last_known = false;
        let target =
            crate::tmux_snapshot::pane_actions::Target::capture(&view.browser_state).unwrap();
        view.begin_pane_close(target, window, cx);
    });
    let body = says(&probes, "pane-close-body");
    assert!(body.starts_with("Claude is working on this."), "{body}");
}

/// Home: the session's chip, the "N need input" pill and what it says, the
/// sidebar's Home row and the project's badge.
fn home(remote_away: bool) -> browser::State {
    let mut fleet: browser::fleet::Fleet = serde_json::from_value(serde_json::json!({
        "omittedGroups":0,"groups":[{"id":"remote","label":"Studio","state":"ready",
        "conflict":false,"omittedSessions":0,"sessions":[
        {"id":"remote-a","name":"Alpha","paneCount":1,"sessionId":"session-a",
         "selection":"70500000-0000-4000-8000-000000000001"}]}]}))
    .unwrap();
    if remote_away {
        fleet.groups[0].away = Some((Instant::now(), std::time::SystemTime::now()));
    }
    browser::State {
        surface: browser::Surface::Home,
        home_phase: browser::HomePhase::Live,
        request: 7,
        home_agents: Some(serde_json::from_value(roster(None, agent("session-a"))).unwrap()),
        fleet: Some(fleet),
        ..Default::default()
    }
}
fn home_view(view: &mut SnapshotView, _: &mut Window, _: &mut Context<SnapshotView>) {
    view.frame = None;
    view.painted_frame = None;
    view.browser_state.frame = None;
    view.browser_state.selected_pane = None;
    view.browser_state.regions.clear();
}
fn assert_home(probes: &BTreeMap<String, String>, marked: bool, when: &str) {
    let tag = |words: &str| {
        if marked {
            format!("{words} · last known")
        } else {
            words.to_owned()
        }
    };
    assert_eq!(
        says(probes, "home-agents-attention"),
        tag("1 needs input"),
        "{when}"
    );
    assert_eq!(
        says(probes, "spoken-home-agents-attention").contains("last known"),
        marked,
        "{when}"
    );
    assert_eq!(
        says(probes, "fleet-session-asks-0-0"),
        tag("· Needs input"),
        "{when}"
    );
    // The sidebar: Home's count (a project heading draws none), and the
    // agent's row under its project.
    let badges: Vec<_> = probes
        .iter()
        .filter(|(k, _)| k.starts_with("sidebar-badge-"))
        .map(|(_, v)| v.clone())
        .collect();
    assert_eq!(badges, [tag("1")], "{when}");
    assert_eq!(
        says(probes, "spoken-Home").contains("last known"),
        marked,
        "{when}"
    );
    assert_eq!(
        says(probes, "agent-state-Sidebar"),
        tag("Needs input"),
        "{when}"
    );
    assert_eq!(
        says(probes, "spoken-Claude").contains("last known"),
        marked,
        "{when}"
    );
}
#[gpui::test]
fn home_and_its_sidebar_say_last_known(cx: &mut TestAppContext) {
    let probes = painted(cx, home(false), MARKED, home_view);
    assert_home(&probes, true, "marked");
}
#[gpui::test]
fn home_and_its_sidebar_are_current_otherwise(cx: &mut TestAppContext) {
    for when in unmarked() {
        let probes = painted(cx, home(false), when, home_view);
        assert_home(&probes, false, &format!("{when:?}"));
    }
}
/// An away machine's agents are last known too, without this Mac's flag;
/// for its first quiet 8 s they are not.
#[gpui::test]
fn an_away_machines_agents_say_last_known(cx: &mut TestAppContext) {
    let probes = painted(cx, home(true), CURRENT, home_view);
    assert_home(&probes, true, "away");
    let probes = painted(
        cx,
        home(true),
        When {
            flag: false,
            after: Duration::from_secs(1),
        },
        home_view,
    );
    assert_home(&probes, false, "quiet");
}

/// Other states go muted when last known: a failed agent's cross, in the
/// sidebar, the header and on Home's chip, wears the muted ink instead of
/// its own colour.
fn failed(view: &mut SnapshotView) {
    let mut row = agent("session-a");
    row["status"] = "FAILED".into();
    row["attention"] = false.into();
    view.browser_state.workspace_agents =
        Some(serde_json::from_value(roster(Some("session-a"), row.clone())).unwrap());
    view.browser_state.home_agents = Some(serde_json::from_value(roster(None, row)).unwrap());
}
fn inks(cx: &mut TestAppContext, state: browser::State, when: When) -> BTreeMap<String, Hsla> {
    cx.update(|cx| cx.set_global(InkProbes::default()));
    let home = state.surface == browser::Surface::Home;
    painted(cx, state, when, move |view, window, cx| {
        failed(view);
        if home {
            home_view(view, window, cx);
        } else {
            split(view, window, cx);
        }
    });
    cx.update(|cx| cx.global::<InkProbes>().0.clone())
}
#[gpui::test]
fn other_states_are_muted_only_when_last_known(cx: &mut TestAppContext) {
    let _appearance = bezel_theme::lock_appearance();
    let theme = crate::config::Theme::default();
    let row: Row = serde_json::from_value({
        let mut row = agent("session-a");
        row["status"] = "FAILED".into();
        row["attention"] = false.into();
        row
    })
    .unwrap();
    let ink = |muted: bool, on: Plate| -> Hsla { rgb(color(&row, muted, &theme, on)).into() };
    let chip_muted: Hsla = rgb(theme.ink(theme.muted)).into();
    let chip_own: Hsla = rgb(color(&row, false, &theme, Plate::Chrome)).into();
    for (when, muted) in [(MARKED, true), (unmarked()[0], false), (CURRENT, false)] {
        let probes = inks(cx, workspace(), when);
        for on in [Plate::Sidebar, Plate::Header] {
            assert_eq!(
                probes.get(&format!("agent-glyph-{on:?}")).copied(),
                Some(ink(muted, on)),
                "{when:?} {on:?}"
            );
        }
        let probes = inks(cx, home(false), when);
        assert_eq!(
            probes.get("agent-chip-state").copied(),
            Some(if muted { chip_muted } else { chip_own }),
            "{when:?}"
        );
    }
}

/// An away machine's session open in the workspace: its agent's pane row,
/// that row's spoken label, the pane's header and the close card say "last
/// known" without this Mac's flag (review r2), and not in the machine's quiet
/// first second.
fn away_workspace(after: Duration) -> (browser::State, When) {
    namesake_workspace(after, true)
}
/// This Mac's session open (when `remote_open` is false) beside an away
/// remote with a session of the same live id; or that remote's session open.
fn namesake_workspace(after: Duration, remote_open: bool) -> (browser::State, When) {
    let mut state = workspace();
    let mut fleet: browser::fleet::Fleet = serde_json::from_value(serde_json::json!({
        "omittedGroups":0,"groups":[
        {"id":"remote","label":"Studio","state":"ready","conflict":false,"omittedSessions":0,
         "sessions":[{"id":"remote-a","name":"Alpha","paneCount":1,"sessionId":"session-a",
          "active":remote_open,"selection":"70500000-0000-4000-8000-000000000001"}]},
        {"id":"local","label":"Local","state":"ready","conflict":false,"omittedSessions":0,
         "sessions":[{"id":"local-a","name":"Alpha","paneCount":1,"sessionId":"session-a",
          "active":!remote_open,"selection":"70500000-0000-4000-8000-000000000002"}]}]}))
    .unwrap();
    fleet.groups[0].away = Some((Instant::now(), std::time::SystemTime::now()));
    state.fleet = Some(fleet);
    (state, When { flag: false, after })
}
#[gpui::test]
fn an_away_machines_open_session_says_last_known(cx: &mut TestAppContext) {
    for (after, marked) in [
        (Duration::from_secs(600), true),
        (Duration::from_secs(1), false),
    ] {
        let (state, when) = away_workspace(after);
        let probes = painted(cx, state, when, split);
        let tag = if marked {
            "Needs input · last known"
        } else {
            "Needs input"
        };
        assert_eq!(says(&probes, "agent-state-Sidebar"), tag, "{after:?}");
        assert_eq!(says(&probes, "agent-state-Header"), tag, "{after:?}");
        let spoken = probes
            .iter()
            .filter(|(k, _)| k.starts_with("spoken-"))
            .map(|(_, v)| v.as_str())
            .find(|v| v.contains("Needs input"))
            .unwrap_or_else(|| panic!("{probes:#?}"))
            .to_owned();
        assert_eq!(
            spoken.ends_with(", last known"),
            marked,
            "{after:?} {spoken}"
        );
        let (state, when) = away_workspace(after);
        let probes = painted(cx, state, when, |view, window, cx| {
            split(view, window, cx);
            close(view, window, cx);
            // The flag stays clear: only the machine is away.
            view.pane_close = None;
            view.browser_state.agents_last_known = false;
            let target =
                crate::tmux_snapshot::pane_actions::Target::capture(&view.browser_state).unwrap();
            view.begin_pane_close(target, window, cx);
        });
        let body = says(&probes, "pane-close-body");
        assert_eq!(
            body.contains("may still be running"),
            marked,
            "{after:?} {body}"
        );
    }
}

/// An agent joins its session within its own machine when the fleet
/// publication scopes it: another machine that is away, with a session of
/// the same live id, doesn't make a current agent "last known". Unscoped
/// (Home's roster) the join is by live id alone and errs toward the mark.
#[gpui::test]
fn the_away_join_stays_on_the_agents_machine(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let mut fleet: browser::fleet::Fleet = serde_json::from_value(serde_json::json!({
        "omittedGroups":0,"groups":[
        {"id":"local","label":"Local","state":"ready","conflict":false,"omittedSessions":0,
         "sessions":[{"id":"local-a","name":"Alpha","paneCount":1,"sessionId":"session-a"}]},
        {"id":"remote","label":"Studio","state":"ready","conflict":false,"omittedSessions":0,
         "sessions":[{"id":"remote-a","name":"Alpha","paneCount":1,"sessionId":"session-a"}]}]}))
    .unwrap();
    let start = Instant::now();
    fleet.groups[1].away = Some((start, std::time::SystemTime::now()));
    let mut publication = roster(None, agent("session-a"));
    publication["request"] = 7.into();
    publication["scope"] = 1.into();
    publication["selectedKey"] = serde_json::Value::Null;
    let mut publication: crate::tmux_snapshot::workspace_fleet_agents::Publication =
        serde_json::from_value(publication).unwrap();
    publication.sessions.insert(
        "agent".into(),
        crate::tmux_snapshot::workspace_fleet_agents::SessionScope {
            machine: "local".into(),
            server: "server".into(),
            generation: "generation".into(),
            session: "session-a".into(),
        },
    );
    let state = browser::State {
        fleet: Some(fleet),
        workspace_fleet_agents: Some(publication),
        ..workspace()
    };
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let row: Row = serde_json::from_value(agent("session-a")).unwrap();
    let (clock, at) = clock(start);
    view.update(cx, |view, _| view.connection.clock = clock);
    at.set(Duration::from_secs(600));
    view.read_with(cx, |view, _| assert!(!view.agent_last_known(&row)));
    view.update(cx, |view, _| {
        view.browser_state
            .workspace_fleet_agents
            .as_mut()
            .unwrap()
            .sessions
            .clear()
    });
    view.read_with(cx, |view, _| assert!(view.agent_last_known(&row)));
}

/// This Mac's open session beside an away machine with a session of the same
/// live id (`$0` on both is the usual case): the local agent is current on
/// its pane row, header, spoken label and close card (review r3).
#[gpui::test]
fn a_namesake_on_an_away_machine_leaves_the_open_session_current(cx: &mut TestAppContext) {
    let (state, when) = namesake_workspace(Duration::from_secs(600), false);
    let probes = painted(cx, state, when, split);
    assert_eq!(says(&probes, "agent-state-Sidebar"), "Needs input");
    assert_eq!(says(&probes, "agent-state-Header"), "Needs input");
    assert!(
        probes
            .iter()
            .filter(|(k, _)| k.starts_with("spoken-"))
            .all(|(_, v)| !v.contains("last known")),
        "{probes:#?}"
    );
    let (state, when) = namesake_workspace(Duration::from_secs(600), false);
    let probes = painted(cx, state, when, |view, window, cx| {
        split(view, window, cx);
        close(view, window, cx);
        view.pane_close = None;
        view.browser_state.agents_last_known = false;
        let target =
            crate::tmux_snapshot::pane_actions::Target::capture(&view.browser_state).unwrap();
        view.begin_pane_close(target, window, cx);
    });
    assert!(says(&probes, "pane-close-body").starts_with("Claude is working on this."));
}
