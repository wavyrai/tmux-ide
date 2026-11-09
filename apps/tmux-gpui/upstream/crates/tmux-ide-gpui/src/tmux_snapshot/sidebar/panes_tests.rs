#![allow(clippy::unwrap_used)]
use super::*;
use browser::NameSource;
use core::prelude::v1::test;

fn pane(id: &str, window: &str, label: &str, source: Option<NameSource>) -> browser::Choice {
    browser::Choice {
        pane_count: None,
        id: id.into(),
        label: label.into(),
        window_id: Some(window.into()),
        window_label: Some(format!("{window} name")),
        browser_icon: None,
        display_name_source: source,
    }
}

fn roster(rows: serde_json::Value) -> browser::home_agents::WorkspaceRoster {
    serde_json::from_value(
        serde_json::json!({"sessionId":"s","revision":1,"phase":"live",
        "rows":rows,"observedSessions":1,"totalSessions":1,"truncatedSessions":0,
        "truncatedRows":0,"note":null}),
    )
    .unwrap()
}

fn agent(pane: &str, name: &str, harness: &str, status: &str) -> serde_json::Value {
    serde_json::json!({"key":format!("agent-{pane}"),"sessionId":"s","paneId":pane,"name":name,
        "sessionLabel":"tmux-ide","harness":harness,"status":status,"attention":false,
        "available":true})
}

fn state(panes: Vec<browser::Choice>) -> browser::State {
    browser::State {
        surface: browser::Surface::Workspace,
        selected_session: Some("s".into()),
        selected_pane: Some("claude".into()),
        panes,
        ..Default::default()
    }
}

#[test]
fn one_window_lists_its_panes_with_kind_icons_and_agent_names() {
    let mut s = state(vec![
        pane(
            "claude",
            "w1",
            "Tighten pane header spacing",
            Some(NameSource::Title),
        ),
        pane("codex", "w1", "generated-name", Some(NameSource::Generated)),
        pane("nvim", "w1", "nvim", Some(NameSource::Process)),
        pane("shell", "w1", "brisk-otter", Some(NameSource::Generated)),
    ]);
    s.workspace_agents = Some(roster(serde_json::json!([
        agent("claude", "Claude", "claude-code", "WORKING"),
        agent("codex", "Codex", "codex", "BLOCKED"),
    ])));
    let rows = rows(&s, 0);
    let seen: Vec<_> = rows
        .iter()
        .map(|r| (r.label.as_str(), r.icon, r.kind, r.selected))
        .collect();
    assert_eq!(
        seen,
        [
            // An agent's task title is its pane title.
            (
                "Tighten pane header spacing",
                Some("icons/agent-claude.svg"),
                Kind::Item,
                true
            ),
            // An agent with no title of its own shows its name.
            ("Codex", Some("icons/agent-codex.svg"), Kind::Item, false),
            ("nvim", Some("icons/neovim.svg"), Kind::Item, false),
            ("brisk-otter", Some("icons/terminal.svg"), Kind::Item, false),
        ]
    );
    assert!(rows.iter().all(|r| matches!(
        &r.target,
        Some(Target::Pane { session, id }) if session == "s" && Some(id) == r.pane.as_ref()
    )));
}

#[test]
fn several_windows_get_subheadings_that_are_labels_not_targets() {
    let s = state(vec![
        pane("a", "w1", "one", None),
        pane("b", "w2", "two", None),
        pane("c", "w1", "three", None),
    ]);
    let rows = rows(&s, 0);
    let seen: Vec<_> = rows.iter().map(|r| (r.kind, r.label.as_str())).collect();
    assert_eq!(
        seen,
        [
            (Kind::Window, "w1 name"),
            (Kind::Item, "one"),
            (Kind::Item, "three"),
            (Kind::Window, "w2 name"),
            (Kind::Item, "two"),
        ]
    );
    assert!(
        rows.iter()
            .filter(|r| r.kind == Kind::Window)
            .all(|r| r.target.is_none())
    );
}

#[test]
fn an_agent_is_found_only_in_its_own_session_and_pane() {
    let mut s = state(vec![pane("claude", "w1", "x", None)]);
    let mut other = roster(serde_json::json!([agent(
        "claude",
        "Claude",
        "claude-code",
        "IDLE"
    )]));
    other.session_id = "elsewhere".into();
    other.roster.rows[0].session_id = "elsewhere".into();
    s.workspace_agents = Some(other);
    assert!(pane_agent(&s, "claude").is_none());
    s.workspace_agents = Some(roster(serde_json::json!([agent(
        "claude",
        "Claude",
        "claude-code",
        "IDLE"
    )])));
    let (found, unavailable) = pane_agent(&s, "claude").unwrap();
    assert_eq!(found.name, "Claude");
    assert!(!unavailable);
    assert!(pane_agent(&s, "missing").is_none());
    s.workspace_agents.as_mut().unwrap().roster.phase = Phase::Loading;
    assert!(
        pane_agent(&s, "claude").unwrap().1,
        "a loading roster is unavailable"
    );
}
