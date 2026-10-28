use super::*;

fn snapshot() -> ClientShellSnapshot {
    serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap()
}

#[test]
fn catalog_has_all_native_commands_and_gpui_shortcuts() {
    use Command::*;
    let expected: [(Command, &[&str]); 94] = [
        (OpenNotificationTarget, &["cmd-alt-n"]),
        (Logs, &[]),
        (NewWindow, &["cmd-alt-shift-n"]),
        (Workspace, &["cmd-shift-n"]),
        (NewWorktree, &["cmd-n"]),
        (WorktreeNotes, &[]),
        (EditWorktreeNote, &[]),
        (PreviousWorkspace, &[]),
        (NextWorkspace, &[]),
        (WorkspaceNumber(1), &[]),
        (WorkspaceNumber(2), &[]),
        (WorkspaceNumber(3), &[]),
        (WorkspaceNumber(4), &[]),
        (WorkspaceNumber(5), &[]),
        (WorkspaceNumber(6), &[]),
        (WorkspaceNumber(7), &[]),
        (WorkspaceNumber(8), &[]),
        (WorkspaceNumber(9), &[]),
        (RenameWorkspace, &[]),
        (CloseWorkspace, &[]),
        (Tab, &["cmd-t"]),
        (SplitRight, &["cmd-d"]),
        (SplitDown, &["cmd-shift-d"]),
        (NextTab, &["cmd-shift-]"]),
        (PreviousTab, &["cmd-shift-["]),
        (MoveTabPrevious, &[]),
        (MoveTabNext, &[]),
        (RenameTab, &[]),
        (FocusLeft, &["cmd-alt-left"]),
        (FocusRight, &["cmd-alt-right"]),
        (FocusUp, &["cmd-alt-up"]),
        (FocusDown, &["cmd-alt-down"]),
        (NextPane, &["cmd-alt-]"]),
        (PreviousPane, &["cmd-alt-["]),
        (LastPane, &[]),
        (SwapLeft, &[]),
        (SwapRight, &[]),
        (SwapUp, &[]),
        (SwapDown, &[]),
        (ResizeLeft, &[]),
        (ResizeRight, &[]),
        (ResizeUp, &[]),
        (ResizeDown, &[]),
        (ResizeMode, &[]),
        (RenamePane, &[]),
        (Zoom, &["cmd-shift-enter"]),
        (ClearPane, &["cmd-k"]),
        (Find, &["cmd-f"]),
        (FindNext, &["cmd-g"]),
        (FindPrevious, &["cmd-shift-g"]),
        (CopyMode, &["cmd-shift-c"]),
        (EditScrollback, &[]),
        (ClosePane, &["cmd-w"]),
        (CloseTab, &["cmd-shift-w"]),
        (TabNumber(1), &["cmd-1"]),
        (TabNumber(2), &["cmd-2"]),
        (TabNumber(3), &["cmd-3"]),
        (TabNumber(4), &["cmd-4"]),
        (TabNumber(5), &["cmd-5"]),
        (TabNumber(6), &["cmd-6"]),
        (TabNumber(7), &["cmd-7"]),
        (TabNumber(8), &["cmd-8"]),
        (TabNumber(9), &["cmd-9"]),
        (PreviousAgent, &[]),
        (NextAgent, &[]),
        (AgentNumber(1), &[]),
        (AgentNumber(2), &[]),
        (AgentNumber(3), &[]),
        (AgentNumber(4), &[]),
        (AgentNumber(5), &[]),
        (AgentNumber(6), &[]),
        (AgentNumber(7), &[]),
        (AgentNumber(8), &[]),
        (AgentNumber(9), &[]),
        (ToggleSidebar, &["cmd-b"]),
        (ToggleStatusBar, &[]),
        (IncreaseFontSize, &["cmd-=", "cmd-+"]),
        (DecreaseFontSize, &["cmd--"]),
        (ResetFontSize, &["cmd-0"]),
        (Settings, &["cmd-,"]),
        (ReloadConfig, &[]),
        (Keybinds, &["cmd-/"]),
        (Sessions, &["cmd-shift-s"]),
        (Themes, &[]),
        (WorkspacePicker, &["cmd-p"]),
        (Palette, &["cmd-shift-p"]),
        (Reconnect, &[]),
        (Quit, &["cmd-q"]),
        (About, &[]),
        (NewBrowserTab, &["cmd-shift-b"]),
        (InstallBrowserSkill, &[]),
        (SplitEditor, &["cmd-\\"]),
        (ToggleFullScreen, &["ctrl-cmd-f"]),
        (CycleWindows, &["cmd-`"]),
    ];
    assert_eq!(COMMANDS.len(), expected.len());
    let shortcuts: std::collections::HashSet<_> =
        COMMANDS.iter().flat_map(|info| info.shortcuts).collect();
    assert_eq!(
        shortcuts.len(),
        COMMANDS
            .iter()
            .map(|info| info.shortcuts.len())
            .sum::<usize>()
    );
    let names: std::collections::HashSet<_> = COMMANDS.iter().map(|info| info.name).collect();
    assert_eq!(names.len(), COMMANDS.len());
    for (info, (command, shortcuts)) in COMMANDS.iter().zip(expected) {
        assert_eq!(info.command, command);
        assert_eq!(info.shortcuts, shortcuts);
        assert!(!info.name.is_empty());
        assert!(!info.label.is_empty());
        let value = match command {
            TabNumber(number) => json!({"TabNumber": number}),
            WorkspaceNumber(number) => json!({"WorkspaceNumber": number}),
            AgentNumber(number) => json!({"AgentNumber": number}),
            _ => json!(format!("{command:?}")),
        };
        assert_eq!(serde_json::from_value::<Command>(value).unwrap(), command);
    }
}

/// `cmd--` is the one shortcut whose key is itself the separator, so it
/// exercises a parser branch no other entry reaches. Binding an unparseable
/// keystroke would fail at startup rather than here.
#[test]
fn every_catalog_shortcut_parses_as_a_keystroke() {
    for shortcut in COMMANDS.iter().flat_map(|info| info.shortcuts) {
        let keystroke =
            gpui::Keystroke::parse(shortcut).unwrap_or_else(|error| panic!("{shortcut}: {error}"));
        assert!(keystroke.modifiers.platform, "{shortcut}");
    }
    let minus = gpui::Keystroke::parse("cmd--").unwrap();
    assert_eq!(minus.key, "-");
    assert!(!minus.modifiers.shift);
}

#[test]
fn gui_commands_never_send_daemon_requests() {
    let s = snapshot();
    for command in [
        Command::OpenNotificationTarget,
        Command::Logs,
        Command::NewWindow,
        Command::NewWorktree,
        Command::Find,
        Command::FindNext,
        Command::FindPrevious,
        Command::CopyMode,
        Command::ToggleSidebar,
        Command::ToggleStatusBar,
        Command::IncreaseFontSize,
        Command::DecreaseFontSize,
        Command::ResetFontSize,
        Command::Settings,
        Command::Keybinds,
        Command::Sessions,
        Command::Themes,
        Command::WorkspacePicker,
        Command::Palette,
        Command::Reconnect,
        Command::Quit,
        Command::About,
        Command::NewBrowserTab,
        Command::InstallBrowserSkill,
        Command::SplitEditor,
        Command::ToggleFullScreen,
        Command::CycleWindows,
        Command::RenameTab,
        Command::LastPane,
        Command::ResizeMode,
        Command::RenamePane,
        Command::PreviousWorkspace,
        Command::NextWorkspace,
        Command::WorkspaceNumber(1),
        Command::RenameWorkspace,
        Command::CloseWorkspace,
        Command::PreviousAgent,
        Command::NextAgent,
        Command::AgentNumber(1),
        Command::ReloadConfig,
    ] {
        assert!(request(command, &s).is_none(), "{command:?}");
    }
}

#[test]
fn directional_focus_zoom_and_close_use_explicit_ids() {
    let s = snapshot();
    for (command, direction) in [
        (Command::FocusLeft, "left"),
        (Command::FocusRight, "right"),
        (Command::FocusUp, "up"),
        (Command::FocusDown, "down"),
    ] {
        assert_eq!(
            request(command, &s),
            Some((
                Method::PaneFocusDirection,
                json!({"pane_id": s.focused_pane_id, "direction": direction})
            ))
        );
    }
    assert_eq!(
        request(Command::Zoom, &s),
        Some((
            Method::PaneZoom,
            json!({"pane_id": s.focused_pane_id, "mode": "toggle"})
        ))
    );
    assert_eq!(
        request(Command::ClearPane, &s),
        Some((Method::PaneClear, json!({"pane_id": s.focused_pane_id})))
    );
    assert_eq!(
        request(Command::EditScrollback, &s),
        Some((
            Method::PaneEditScrollback,
            json!({"pane_id": s.focused_pane_id})
        ))
    );
    assert_eq!(
        request(Command::ClosePane, &s),
        Some((Method::PaneClose, json!({"pane_id": s.focused_pane_id})))
    );
    assert_eq!(
        request(Command::CloseTab, &s),
        Some((Method::TabClose, json!({"tab_id": s.focused_tab_id})))
    );
}

#[test]
fn pane_actions_reject_missing_removed_and_foreign_focus() {
    for case in 0..12 {
        let mut s = snapshot();
        match case {
            0 => s.focused_workspace_id = None,
            1 => s.focused_workspace_id = Some("removed".into()),
            2 => s.workspaces.clear(),
            3 => s.focused_tab_id = None,
            4 => s.focused_tab_id = Some("removed".into()),
            5 => s.tabs.clear(),
            6 => s.tabs[0].workspace_id = "foreign".into(),
            7 => s.focused_pane_id = None,
            8 => s.focused_pane_id = Some("removed".into()),
            9 => s.panes.clear(),
            10 => s.panes[0].workspace_id = "foreign".into(),
            11 => s.panes[0].tab_id = "foreign".into(),
            _ => unreachable!(),
        }
        for command in [
            Command::FocusLeft,
            Command::FocusRight,
            Command::FocusUp,
            Command::FocusDown,
            Command::NextPane,
            Command::PreviousPane,
            Command::Zoom,
            Command::ClearPane,
            Command::ClosePane,
            Command::SplitRight,
            Command::SplitDown,
            Command::ResizeLeft,
            Command::ResizeRight,
            Command::ResizeUp,
            Command::ResizeDown,
            Command::SwapLeft,
            Command::SwapRight,
            Command::SwapUp,
            Command::SwapDown,
        ] {
            assert!(request(command, &s).is_none(), "case {case}: {command:?}");
        }
        if case < 7 {
            for command in [
                Command::CloseTab,
                Command::NextTab,
                Command::PreviousTab,
                Command::MoveTabPrevious,
                Command::MoveTabNext,
            ] {
                assert!(request(command, &s).is_none(), "case {case}: {command:?}");
            }
        }
        if case < 3 {
            assert!(request(Command::TabNumber(1), &s).is_none());
        }
    }
}

#[test]
fn pane_cycle_uses_snapshot_order_within_current_tab_and_workspace() {
    let mut s = snapshot();
    let first = s.panes[0].clone();
    let mut second = first.clone();
    second.pane_id = "second".into();
    let mut third = first.clone();
    third.pane_id = "third".into();
    let mut other_tab = first.clone();
    other_tab.pane_id = "other-tab-pane".into();
    other_tab.tab_id = "other-tab".into();
    let mut other_workspace = first.clone();
    other_workspace.pane_id = "other-workspace-pane".into();
    other_workspace.workspace_id = "other-workspace".into();
    s.panes = vec![first.clone(), other_tab, second, other_workspace, third];
    for (focus, next, previous) in [
        (first.pane_id.as_str(), "second", "third"),
        ("second", "third", first.pane_id.as_str()),
        ("third", first.pane_id.as_str(), "second"),
    ] {
        s.focused_pane_id = Some(focus.into());
        for (command, target) in [(Command::NextPane, next), (Command::PreviousPane, previous)] {
            assert_eq!(
                request(command, &s),
                Some((Method::PaneFocus, json!({"pane_id": target})))
            );
        }
    }
    s.panes.truncate(1);
    s.focused_pane_id = Some(first.pane_id.clone());
    for command in [Command::NextPane, Command::PreviousPane] {
        assert_eq!(
            request(command, &s),
            Some((Method::PaneFocus, json!({"pane_id": first.pane_id})))
        );
    }
}

#[test]
fn numbered_tabs_use_positions_not_numbers_and_stay_in_workspace() {
    let mut s = snapshot();
    let base = s.tabs[0].clone();
    let tab = |id: &str, number, workspace: &str| {
        let mut tab = base.clone();
        tab.tab_id = id.into();
        tab.number = number;
        tab.workspace_id = workspace.into();
        tab
    };
    let workspace = base.workspace_id.clone();
    // Tab 3 closed and tab 4 moved before tab 2; each keeps its number.
    s.tabs = vec![
        tab("foreign", 1, "foreign"),
        tab("a", 1, &workspace),
        tab("c", 4, &workspace),
        tab("b", 2, &workspace),
        tab("d", 5, &workspace),
    ];
    let focus = |id: &str| Some((Method::TabFocus, json!({"tab_id": id})));
    assert_eq!(request(Command::TabNumber(1), &s), focus("a"));
    assert_eq!(request(Command::TabNumber(2), &s), focus("c"));
    assert_eq!(request(Command::TabNumber(3), &s), focus("b"));
    assert_eq!(request(Command::TabNumber(4), &s), focus("d"));
    for number in [0, 5, 9, 255] {
        assert!(request(Command::TabNumber(number), &s).is_none());
    }
    // Numeric selection needs a valid workspace, not a current tab or pane.
    s.focused_tab_id = None;
    s.focused_pane_id = None;
    assert!(request(Command::TabNumber(4), &s).is_some());
    s.tabs.clear();
    assert!(request(Command::TabNumber(1), &s).is_none());
}

#[test]
fn creation_uses_daemon_cwd_and_explicit_targets() {
    let s = snapshot();
    assert_eq!(
        request(Command::Workspace, &s).unwrap(),
        (
            Method::WorkspaceCreate,
            json!({"source_workspace_id": s.focused_workspace_id, "focus": true})
        )
    );
    assert_eq!(
        request(Command::Tab, &s).unwrap(),
        (
            Method::TabCreate,
            json!({"workspace_id": s.focused_workspace_id, "focus": true})
        )
    );
    for (command, direction) in [(Command::SplitRight, "right"), (Command::SplitDown, "down")] {
        assert_eq!(
            request(command, &s).unwrap(),
            (
                Method::PaneSplit,
                json!({"target_pane_id": s.focused_pane_id, "direction": direction, "focus": true})
            )
        );
    }
}

#[test]
fn empty_session_can_create_workspace_only() {
    let mut s = snapshot();
    s.focused_workspace_id = None;
    s.focused_tab_id = None;
    s.focused_pane_id = None;
    s.tabs.clear();
    assert_eq!(
        request(Command::Workspace, &s).unwrap().1,
        json!({"focus": true})
    );
    for info in COMMANDS
        .iter()
        .filter(|info| info.command != Command::Workspace)
    {
        assert!(request(info.command, &s).is_none(), "{:?}", info.command);
    }
}

#[test]
fn tab_cycle_ignores_missing_or_foreign_focus() {
    let mut s = snapshot();
    let mut tab = s.tabs[0].clone();
    tab.tab_id = "foreign-tab".into();
    tab.workspace_id = "other-workspace".into();
    s.tabs.push(tab);
    for focus in [None, Some("removed-tab"), Some("foreign-tab")] {
        s.focused_tab_id = focus.map(str::to_owned);
        for command in [Command::NextTab, Command::PreviousTab] {
            assert!(request(command, &s).is_none());
        }
    }
    s.tabs.clear();
    for command in [Command::NextTab, Command::PreviousTab] {
        assert!(request(command, &s).is_none());
    }
}

#[test]
fn tab_cycle_wraps_and_stays_in_workspace() {
    let mut s = snapshot();
    let mut tab = s.tabs[0].clone();
    tab.workspace_id = s.focused_workspace_id.clone().unwrap();
    tab.tab_id = "first".into();
    let mut second = tab.clone();
    second.tab_id = "second".into();
    let mut other = tab.clone();
    other.workspace_id = "other".into();
    s.tabs = vec![tab, other, second];
    s.focused_tab_id = Some("first".into());
    for command in [Command::NextTab, Command::PreviousTab] {
        assert_eq!(request(command, &s).unwrap().1, json!({"tab_id": "second"}));
    }
    s.focused_tab_id = Some("second".into());
    assert_eq!(
        request(Command::NextTab, &s).unwrap().1,
        json!({"tab_id": "first"})
    );
    s.tabs.truncate(1);
    s.focused_tab_id = Some("first".into());
    assert_eq!(
        request(Command::PreviousTab, &s).unwrap().1,
        json!({"tab_id": "first"})
    );
}

#[test]
fn resize_and_swap_target_the_focused_pane_by_direction() {
    let s = snapshot();
    for (command, method, direction) in [
        (Command::ResizeLeft, Method::PaneResize, "left"),
        (Command::ResizeRight, Method::PaneResize, "right"),
        (Command::ResizeUp, Method::PaneResize, "up"),
        (Command::ResizeDown, Method::PaneResize, "down"),
        (Command::SwapLeft, Method::PaneSwap, "left"),
        (Command::SwapRight, Method::PaneSwap, "right"),
        (Command::SwapUp, Method::PaneSwap, "up"),
        (Command::SwapDown, Method::PaneSwap, "down"),
    ] {
        assert_eq!(
            request(command, &s),
            Some((
                method,
                json!({"pane_id": s.focused_pane_id, "direction": direction})
            )),
            "{command:?}"
        );
    }
}

/// Herdr's TUI counts the insert index with the moving tab still in
/// place, and wraps a tab at either end around to the other.
#[test]
fn tab_moves_wrap_and_stay_in_workspace() {
    let mut s = snapshot();
    let mut tab = s.tabs[0].clone();
    tab.workspace_id = s.focused_workspace_id.clone().unwrap();
    let tabs: Vec<_> = ["a", "b", "c"]
        .into_iter()
        .map(|id| {
            let mut tab = tab.clone();
            tab.tab_id = id.into();
            tab
        })
        .collect();
    let mut foreign = tab.clone();
    foreign.tab_id = "foreign".into();
    foreign.workspace_id = "other".into();
    s.tabs = vec![tabs[0].clone(), foreign, tabs[1].clone(), tabs[2].clone()];
    for (focus, previous, next) in [("a", 3, 2), ("b", 0, 3), ("c", 1, 0)] {
        s.focused_tab_id = Some(focus.into());
        for (command, index) in [
            (Command::MoveTabPrevious, previous),
            (Command::MoveTabNext, next),
        ] {
            assert_eq!(
                request(command, &s),
                Some((
                    Method::TabMove,
                    json!({"tab_id": focus, "insert_index": index})
                )),
                "{focus} {command:?}"
            );
        }
    }
    // A lone tab has nowhere to go.
    s.tabs = vec![tabs[0].clone()];
    s.focused_tab_id = Some("a".into());
    assert!(request(Command::MoveTabNext, &s).is_none());
    assert!(request(Command::MoveTabPrevious, &s).is_none());
}
