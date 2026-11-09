//! `<theme>+mock` (#746): the session window as the approved mockup draws it.
//! The open project lists its panes (a Claude pane at work, Neovim and two
//! shells in two windows); another project's Codex waits for input; three
//! panes are on screen. Dev-only, behind the `visual-capture` feature.
use super::{DisplayFrame, browser, decode};
use anyhow::{Result, anyhow};
use std::sync::Arc;

const SCOPE: &str = "22222222-2222-4222-8222-222222222222";

fn pane(id: &str, window: &str, name: &str, label: &str, source: &str) -> Result<browser::Choice> {
    Ok(serde_json::from_value(serde_json::json!({
        "paneCount": null, "id": id, "label": label, "windowId": window,
        "windowLabel": name, "displayNameSource": source
    }))?)
}

fn favicon(letter: &str, fill: &str) -> serde_json::Value {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="{fill}"/><text x="8" y="12" font-size="10" font-family="Helvetica" font-weight="700" text-anchor="middle" fill="#fff">{letter}</text></svg>"##
    );
    serde_json::json!({"mime": "image/svg+xml", "data": STANDARD.encode(svg)})
}

/// The fleet, its agents, and the open session's panes and agents.
pub(super) fn with_mock_fleet(mut state: browser::State) -> Result<browser::State> {
    let session = |id: &str, name: &str, live: &str, n: u8, active: bool, icon: Option<_>| {
        let mut s = serde_json::json!({"id": id, "name": name, "sessionId": live,
            "serverId": "default", "paneCount": 2, "active": active,
            "selection": format!("{n}{n}{n}{n}{n}{n}{n}{n}-{n}{n}{n}{n}-4{n}{n}{n}-8{n}{n}{n}-{n}{n}{n}{n}{n}{n}{n}{n}{n}{n}{n}{n}")});
        if let Some(icon) = icon {
            s["favicon"] = icon;
        }
        s
    };
    state.fleet = Some(serde_json::from_value(serde_json::json!({
        "preferences": {"revision": 1, "phase": "ready", "error": null},
        "omittedGroups": 0,
        "groups": [{
            "id": "this-mac", "label": "This Mac", "state": "ready", "conflict": false,
            "collapsed": false, "omittedSessions": 0, "omittedServers": 0,
            "servers": [{"id": "default", "label": "default", "state": "online",
                "generation": SCOPE, "selection": "33333333-3333-4333-8333-333333333333"}],
            "sessions": [
                session("fleet-a", "tmux-ide", "session-a", 4, true, Some(favicon("T", "#2f6f5e"))),
                session("fleet-b", "sfora", "session-b", 5, false, Some(favicon("S", "#3b5fa8"))),
                session("fleet-c", "bezel", "session-c", 6, false, None),
                session("fleet-d", "notes", "session-d", 7, false, None),
            ]
        }]
    }))?);
    let agent = |key: &str, session: &str, pane: &str, name: &str, harness: &str, status: &str| {
        serde_json::json!({"key": key, "sessionId": session, "paneId": pane, "name": name,
            "sessionLabel": "x", "harness": harness, "status": status,
            "attention": status == "BLOCKED", "available": true})
    };
    let mut fleet: super::super::workspace_fleet_agents::Publication = serde_json::from_value(
        serde_json::json!({
            "request": state.request, "scope": 1, "revision": 1, "phase": "live",
            "selectedKey": null, "observedSessions": 4, "totalSessions": 4,
            "truncatedSessions": 0, "truncatedRows": 0, "note": null,
            "rows": [
                agent("codex", "session-b", "pane-x", "Fix flaky watch reconnect test", "codex", "BLOCKED"),
                agent("claude-bezel", "session-c", "pane-y", "Port nav rows to Selection", "claude-code", "DONE"),
            ]
        }),
    )?;
    for (key, session) in [("codex", "session-b"), ("claude-bezel", "session-c")] {
        fleet.sessions.insert(
            key.into(),
            super::super::workspace_fleet_agents::SessionScope {
                machine: "this-mac".into(),
                server: "default".into(),
                generation: SCOPE.into(),
                session: session.into(),
            },
        );
    }
    state.workspace_fleet_agents = Some(fleet);
    state.workspace_agents = Some(serde_json::from_value(serde_json::json!({
        "sessionId": "session-a", "revision": 1, "phase": "live",
        "rows": [agent("claude", "session-a", "pane-claude", "Claude", "claude-code", "WORKING")],
        "observedSessions": 1, "totalSessions": 1, "truncatedSessions": 0,
        "truncatedRows": 0, "note": null
    }))?);
    state.panes = vec![
        pane(
            "pane-claude",
            "w-main",
            "main",
            "Tighten pane header spacing",
            "title",
        )?,
        pane("pane-nvim", "w-main", "main", "nvim", "process")?,
        pane("pane-shell", "w-main", "main", "cargo test", "title")?,
        pane(
            "pane-release",
            "w-release",
            "release",
            "quiet-harbor",
            "generated",
        )?,
    ];
    state.selected_pane = Some("pane-claude".into());
    state.session_tabs = None;
    Ok(state)
}

/// One run of text in an ANSI colour (None: the default foreground).
type Run<'a> = (&'a str, Option<u8>, bool);

const CLAUDE: &[&[Run]] = &[
    &[
        ("> ", Some(8), false),
        (
            "Make the pane header one quiet line and keep the",
            None,
            false,
        ),
    ],
    &[("  actions on the right.", None, false)],
    &[],
    &[
        ("● ", Some(2), false),
        ("Read", None, true),
        ("(pane_chrome.rs)", None, false),
    ],
    &[("  ⎿  Read 794 lines", Some(8), false)],
    &[],
    &[
        ("● ", Some(2), false),
        (
            "The header row carries the title and two buttons. I'll",
            None,
            false,
        ),
    ],
    &[(
        "  add split right and split down beside zoom and close.",
        None,
        false,
    )],
    &[],
    &[
        ("● ", Some(2), false),
        ("Update", None, true),
        ("(pane_chrome/buttons.rs)", None, false),
    ],
    &[(
        "  ⎿  Updated with 18 additions and 6 removals",
        Some(8),
        false,
    )],
    &[
        ("     61  ", Some(8), false),
        (
            "-        HeaderIntent::Menu => return None,",
            Some(1),
            false,
        ),
    ],
    &[
        ("     61  ", Some(8), false),
        ("+        HeaderIntent::SplitRight => (", Some(2), false),
    ],
    &[
        ("     62  ", Some(8), false),
        (
            "+            \"split-right\", \"icons/split.svg\",",
            Some(2),
            false,
        ),
    ],
    &[],
    &[
        ("● ", Some(2), false),
        ("Bash", None, true),
        ("(cargo test -p tmux-ide-gpui pane_chrome)", None, false),
    ],
    &[("  ⎿  test result: ok. 18 passed; 0 failed", Some(8), false)],
    &[],
    &[
        ("✻ Checking the narrow layout… ", Some(3), false),
        ("(38s · esc to interrupt)", Some(8), false),
    ],
];
const NVIM: &[&[Run]] = &[
    &[
        ("  9 ", Some(8), false),
        ("pub", Some(5), false),
        ("(super) ", None, false),
        ("fn ", Some(5), false),
        ("title_weight", Some(4), false),
        ("(focused: ", None, false),
        ("bool", Some(6), false),
        (") -> ", None, false),
        ("FontWeight", Some(6), false),
        (" {", None, false),
    ],
    &[
        (" 10 ", Some(8), false),
        ("    if", Some(5), false),
        (" focused {", None, false),
    ],
    &[
        (" 11 ", Some(8), false),
        ("        FontWeight", Some(6), false),
        ("::SEMIBOLD", None, false),
    ],
    &[
        (" 12 ", Some(8), false),
        ("    } ", None, false),
        ("else", Some(5), false),
        (" {", None, false),
    ],
    &[
        (" 13 ", Some(8), false),
        ("        FontWeight", Some(6), false),
        ("::NORMAL", None, false),
    ],
    &[(" 14 ", Some(8), false), ("    }", None, false)],
    &[(" 15 ", Some(8), false), ("}", None, false)],
    &[(" 16 ", Some(8), false)],
    &[
        (" 17 ", Some(8), false),
        ("/// Split right, split down, zoom, close.", Some(8), false),
    ],
    &[
        (" 18 ", Some(8), false),
        ("const ", Some(5), false),
        ("SLOT", Some(3), false),
        (": ", None, false),
        ("f32", Some(6), false),
        (" = ", None, false),
        ("28.", Some(3), false),
        (";", None, false),
    ],
    &[("  ~", Some(8), false)],
    &[("  ~", Some(8), false)],
];
const SHELL: &[&[Run]] = &[
    &[
        ("~/Developer/tmux-ide ", Some(2), false),
        ("main ", Some(8), false),
        ("❯ ", Some(5), false),
        ("cargo test -p tmux-ide-gpui sidebar", None, false),
    ],
    &[
        ("   Compiling ", Some(2), true),
        ("tmux-ide-gpui v2.9.20", None, false),
    ],
    &[
        ("    Finished ", Some(2), true),
        (
            "`test` profile [unoptimized + debuginfo] in 41.2s",
            None,
            false,
        ),
    ],
    &[],
    &[
        ("test result: ", None, false),
        ("ok", Some(2), false),
        (". 60 passed; 0 failed; 0 ignored", None, false),
    ],
    &[],
    &[
        ("~/Developer/tmux-ide ", Some(2), false),
        ("main ", Some(8), false),
        ("❯ ", Some(5), false),
    ],
];

fn write(grid: &mut [serde_json::Value], left: usize, top: usize, width: usize, lines: &[&[Run]]) {
    for (dy, runs) in lines.iter().enumerate() {
        let Some(row) = grid
            .get_mut(top + dy)
            .and_then(|r| r["cells"].as_array_mut())
        else {
            continue;
        };
        let mut x = left;
        for (text, color, bold) in runs.iter() {
            for ch in text.chars() {
                if x >= left + width || x >= row.len() {
                    break;
                }
                row[x] = serde_json::json!({
                    "grapheme": ch.to_string(), "width": 1,
                    "attributes": if *bold { 1 } else { 0 },
                    "foreground": color.map_or(serde_json::json!({"kind": "default"}),
                        |index| serde_json::json!({"kind": "indexed", "index": index})),
                    "background": {"kind": "default"}
                });
                x += 1;
            }
        }
    }
}

/// The three visible panes at the window's measured grid: Neovim over a
/// shell on the left, the Claude pane on the right.
pub(super) fn with_mock_panes(
    mut state: browser::State,
    cols: usize,
    rows: usize,
) -> Result<browser::State> {
    let blank = serde_json::json!({"grapheme": " ", "width": 1, "attributes": 0,
        "foreground": {"kind": "default"}, "background": {"kind": "default"}});
    let mut grid: Vec<_> = (0..rows)
        .map(|_| serde_json::json!({"cells": vec![blank.clone(); cols], "wrapped": false}))
        .collect();
    let left = cols * 47 / 100;
    let top = rows * 55 / 100;
    write(&mut grid, 0, 0, left, NVIM);
    write(&mut grid, 0, top + 1, left, SHELL);
    write(&mut grid, left + 1, 0, cols - left - 1, CLAUDE);
    let mut snapshot: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/snapshot.json"))?;
    snapshot["grid"] = grid.into();
    snapshot["cols"] = cols.into();
    snapshot["rows"] = rows.into();
    snapshot["cursor"] = serde_json::json!({"x": left + 3, "y": 21, "hidden": false,
        "style": "bar", "blink": false});
    let frame = Arc::new(
        decode::frame(&serde_json::to_vec(&snapshot)?)
            .map_err(|error| anyhow!("mock frame: {error}"))?,
    );
    state.frame = Some(DisplayFrame::Legacy(frame));
    state.regions = serde_json::from_value(serde_json::json!([
        {"id": "pane-nvim", "left": 0, "top": 0, "width": left, "height": top},
        {"id": "pane-shell", "left": 0, "top": top + 1, "width": left, "height": rows - top - 1},
        {"id": "pane-claude", "left": left + 1, "top": 0, "width": cols - left - 1, "height": rows}
    ]))?;
    Ok(state)
}
