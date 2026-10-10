use super::*;
use crate::config::SidebarLayout;
use crate::sidebar::layout_tests;

fn agent_layout(text: &str) -> AgentLayout {
    toml::from_str(text).unwrap()
}

fn space_layout(text: &str) -> SpaceLayout {
    toml::from_str(text).unwrap()
}

fn texts(rows: &[Vec<ResolvedToken>]) -> Vec<Vec<String>> {
    rows.iter()
        .map(|row| {
            row.iter()
                .map(|token| match &token.kind {
                    TokenKind::StateIcon => "<icon>".to_owned(),
                    TokenKind::GitStatus { ahead, behind } => format!("{ahead}/{behind}"),
                    kind => kind.text().unwrap().to_string(),
                })
                .collect()
        })
        .collect()
}

#[test]
fn agent_tokens_resolve_state_pane_titles_and_custom_values() {
    let mut snapshot = layout_tests::snapshot(1);
    let agent = &mut snapshot.agents[0];
    agent.agent_status = AgentStatus::Blocked;
    agent.state_labels = vec![("blocked".into(), "needs you".into())];
    agent.tokens = vec![("usage_ctx_ok".into(), "\u{2ec1} 54% 140k".into())];
    agent.terminal_title = Some("\u{2728} codex".into());
    agent.terminal_title_stripped = Some("codex".into());
    agent.title = Some("Fix sidebar".into());
    let layout = agent_layout(
        r#"rows = [["state_text", "pane"], ["terminal_title", "terminal_title_stripped"], ["$usage_ctx_ok", "$missing"], ["$missing"]]"#,
    );
    let rows = agent_rows(&layout, &snapshot.agents[0], &snapshot, None).unwrap();
    assert_eq!(
        texts(&rows),
        [
            vec!["needs you", "Fix sidebar"],
            vec!["\u{2728} codex", "codex"],
            vec!["\u{2ec1} 54% 140k"],
        ]
    );
    // Labels are untrusted display text: controls and bidi overrides go.
    snapshot.agents[0].state_labels =
        vec![("blocked".into(), "\u{1b}[31mneeds\u{202e} you\n".into())];
    let rows = agent_rows(&layout, &snapshot.agents[0], &snapshot, None).unwrap();
    assert_eq!(
        rows[0][0].kind,
        TokenKind::Text("[31mneeds you".into(), TextRole::Status)
    );
    // Without a label the wire status names the state; idle covers unknown.
    snapshot.agents[0].state_labels.clear();
    let rows = agent_rows(&layout, &snapshot.agents[0], &snapshot, None).unwrap();
    assert_eq!(
        rows[0][0].kind,
        TokenKind::Text("blocked".into(), TextRole::Status)
    );
    snapshot.agents[0].agent_status = AgentStatus::Unknown;
    let rows = agent_rows(&layout, &snapshot.agents[0], &snapshot, None).unwrap();
    assert_eq!(
        rows[0][0].kind,
        TokenKind::Text("idle".into(), TextRole::Status)
    );
    snapshot.agents[0].title = None;
    snapshot.panes = serde_json::from_value(serde_json::json!([{
        "pane_id": "p0", "workspace_id": "w0", "tab_id": "t0",
        "label": "shell", "cwd": null, "foreground_cwd": null,
        "focused": false, "right_click_passthrough": false
    }]))
    .unwrap();
    let rows = agent_rows(&layout, &snapshot.agents[0], &snapshot, None).unwrap();
    assert_eq!(
        rows[0][1].kind,
        TokenKind::Text("shell".into(), TextRole::Secondary)
    );
}

#[test]
fn rules_style_hide_and_replace_rows_per_agent() {
    let mut snapshot = layout_tests::snapshot(1);
    snapshot.agents[0].tokens = vec![("pct".into(), "85".into())];
    let layout = agent_layout(
        r##"rows = [[{ token = "agent", fg = "#111111", rules = [{ equals = "Claude Code", bold = true }] }]]
[rows_by_agent]
claude = [[{ token = "$pct", rules = [{ gt = 90, hide = true }, { gt = 80, fg = "#ff0000" }] }, { token = "workspace", rules = [{ contains = "herdr", hide = true }] }]]"##,
    );
    let rows = agent_rows(&layout, &snapshot.agents[0], &snapshot, None).unwrap();
    assert_eq!(
        rows,
        [vec![ResolvedToken {
            kind: TokenKind::Text("85".into(), TextRole::Muted),
            style: TokenStyle {
                fg: Some(0xff0000),
                bold: None,
                dim: None
            }
        }]]
    );
    snapshot.agents[0].tokens[0].1 = "95".into();
    assert_eq!(
        texts(&agent_rows(&layout, &snapshot.agents[0], &snapshot, None).unwrap()),
        [vec!["<icon>"]]
    );
    snapshot.agents[0].agent = Some("codex".into());
    let rows = agent_rows(&layout, &snapshot.agents[0], &snapshot, None).unwrap();
    assert_eq!(
        rows[0][0].style,
        TokenStyle {
            fg: Some(0x111111),
            bold: Some(true),
            dim: None
        }
    );
}

#[test]
fn space_rows_hide_git_details_under_a_parent_and_take_custom_tokens() {
    let layout = SidebarLayout::default().spaces;
    let context = |indented, ahead_behind, tokens| SpaceContext {
        label: "fix-sidebar",
        branch: Some("worktree/fix-sidebar"),
        status: AgentStatus::Working,
        ahead_behind,
        tokens,
        indented,
    };
    assert_eq!(
        texts(&space_rows(&layout, context(false, Some((2, 0)), &[]))),
        [
            vec!["<icon>", "fix-sidebar"],
            vec!["worktree/fix-sidebar", "2/0"]
        ]
    );
    assert_eq!(
        texts(&space_rows(&layout, context(false, Some((0, 0)), &[]))),
        [vec!["<icon>", "fix-sidebar"], vec!["worktree/fix-sidebar"]]
    );
    assert_eq!(
        texts(&space_rows(&layout, context(true, Some((2, 1)), &[]))),
        [vec!["<icon>", "fix-sidebar"]]
    );
    let tokens = [
        ("jj".to_owned(), "old".to_owned()),
        ("jj".to_owned(), "clean".to_owned()),
    ];
    let custom = space_layout(r#"rows = [["state_text", "$jj", "$none"]]"#);
    assert_eq!(
        texts(&space_rows(&custom, context(true, None, &tokens))),
        [vec!["working", "clean"]]
    );
}

#[test]
fn budgets_drop_leftmost_text_first_then_share_the_rest() {
    let fixed = |kind: &TokenKind| match kind {
        TokenKind::StateIcon => 1,
        TokenKind::GitStatus { .. } => 2,
        _ => 0,
    };
    let row = [
        ResolvedToken::unstyled(TokenKind::StateIcon),
        ResolvedToken::unstyled(TokenKind::Text("remote".into(), TextRole::Secondary)),
        ResolvedToken::unstyled(TokenKind::Text("herdr-gpui".into(), TextRole::Workspace)),
        ResolvedToken::unstyled(TokenKind::GitStatus {
            ahead: 1,
            behind: 0,
        }),
    ];
    // icon(1) + " " + remote(6) + " · " + herdr-gpui(10) + " " + git(2) = 24
    assert_eq!(
        budgets(&row, fixed, 30),
        [Some(1), Some(6), Some(10), Some(2)]
    );
    assert_eq!(
        budgets(&row, fixed, 20),
        [Some(1), Some(6), Some(6), Some(2)]
    );
    assert_eq!(budgets(&row, fixed, 8), [Some(1), None, Some(3), Some(2)]);
    assert_eq!(budgets(&row, fixed, 6), [Some(1), None, Some(1), Some(2)]);
    assert_eq!(budgets(&row, fixed, 4), [Some(1), None, None, Some(2)]);
    assert_eq!(budgets(&row, fixed, 0), [Some(1), None, None, Some(2)]);
    assert_eq!(budgets(&[], fixed, 5), Vec::<Option<usize>>::new());
}

#[test]
fn budgets_give_wide_state_labels_their_display_width() {
    // An emoji state label occupies two cells; a one-cell budget clips it to "…".
    let row = [
        ResolvedToken::unstyled(TokenKind::Text("🟡".into(), TextRole::Status)),
        ResolvedToken::unstyled(TokenKind::Text("~".into(), TextRole::Workspace)),
    ];
    assert_eq!(budgets(&row, |_| 0, 30), [Some(2), Some(1)]);
}
