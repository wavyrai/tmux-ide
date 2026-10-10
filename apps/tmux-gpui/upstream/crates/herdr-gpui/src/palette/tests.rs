use super::*;
use core::prelude::v1::test;
use gpui::TestAppContext;
use herdr_client::protocol::ClientShellCommand;

mod background_ranking;
mod go_to_search;
mod notes;

fn matches_query(text: &str, query: &str) -> bool {
    let entries = [Entry::new(
        text.into(),
        String::new(),
        "",
        Action::Native(Command::Palette),
        None,
    )];
    !search::rank(
        &entries,
        [0],
        &search::Query::parse(query),
        &mut search::matcher(),
    )
    .is_empty()
}

fn snapshot() -> ClientShellSnapshot {
    serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap()
}

#[gpui::test]
fn notification_command_is_searchable_and_targetless_activation_is_inert(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.show_toast_preview(herdr_client::protocol::SemanticNotificationKind::Custom, cx);
            let selected = view.selected_endpoint;
            view.open_palette(Filter::All, window, cx);
            view.filter_palette("Open Notification Target", cx);
            let palette = view.menu.palette.as_ref().unwrap();
            assert_eq!(palette.filtered[0].highlights.label, [0..4, 5..17, 18..24]);
            let action = palette.selected_entry().unwrap().action.clone();
            assert!(matches!(
                action,
                Action::Native(Command::OpenNotificationTarget)
            ));
            view.activate_palette(action, window, cx);
            assert!(view.menu.page.is_none());
            assert!(view.pending_navigation.is_none());
            assert_eq!(view.selected_endpoint, selected);
            assert_eq!(view.endpoints[selected].toasts.entries.len(), 1);
        })
    });
    cx.update(|window, cx| {
        crate::bind_keys(cx);
        window.focus(&view.read(cx).focus.clone(), cx);
        window.draw(cx).clear(cx);
        window.dispatch_keystroke(Keystroke::parse("cmd-alt-n").unwrap(), cx);
        assert!(view.read(cx).pending_navigation.is_none());
        assert_eq!(view.read(cx).endpoints[0].toasts.entries.len(), 1);
    });
}

#[gpui::test]
fn command_badges_mark_daemon_commands_and_go_to_badges_mark_agent_status(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.commands = vec![ClientShellCommand {
                command_id: "build".into(),
                action: ClientShellCommandAction::Shell,
                description: None,
                binding_label: String::new(),
                binding_labels: Vec::new(),
            }];
        })
    });
    for filter in [Filter::Navigation, Filter::Commands] {
        cx.update(|window, cx| view.update(cx, |view, cx| view.open_palette(filter, window, cx)));
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            let palette = view.menu.palette.as_ref().unwrap();
            let entries: Vec<_> = palette
                .filtered
                .iter()
                .map(|hit| &palette.entries[hit.index])
                .collect();
            assert!(!entries.is_empty());
            for entry in &entries {
                let expected = match entry.action {
                    Action::Native(_) => "GUI action",
                    Action::Configured(..) => "Herdr command",
                    Action::Go {
                        target: NavigationTarget::Pane(_),
                        ..
                    } => "waiting",
                    Action::Go { .. } => "Workspace",
                    Action::Project(_) => "Project",
                    Action::Note { .. } => "Note",
                };
                assert_eq!(entry.badge, expected, "{}", entry.label);
            }
            assert_eq!(
                entries
                    .iter()
                    .any(|entry| matches!(entry.action, Action::Go { .. })),
                filter == Filter::Navigation
            );
        });
        cx.update(|window, cx| view.update(cx, |view, cx| view.dismiss_menu(window, cx)));
    }
}

#[gpui::test]
fn clear_pane_is_offered_and_sent_only_when_the_daemon_advertises_it(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    for supported in [false, true] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.live.supports_pane_clear = supported;
                view.open_palette(Filter::All, window, cx);
                let offered = view
                    .menu
                    .palette
                    .as_ref()
                    .unwrap()
                    .entries
                    .iter()
                    .any(|entry| matches!(entry.action, Action::Native(Command::ClearPane)));
                assert_eq!(offered, supported);
                view.dismiss_menu(window, cx);
            })
        });
    }
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.supports_pane_clear = false;
            view.local_error = None;
            view.command(Command::ClearPane, window, cx);
            assert!(
                view.local_error
                    .as_deref()
                    .is_some_and(|error| error.contains("newer Herdr"))
            );
            assert!(view.activation_deadline.is_none(), "nothing was sent");
        })
    });
}

#[gpui::test]
fn go_to_rejects_a_disabled_or_missing_host_and_keeps_the_palette_open(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_palette(Filter::Navigation, window, cx);
            let boot = view.live.snapshot.as_ref().unwrap().boot_id.clone();
            for endpoint in ["missing-host", crate::endpoint::LOCAL] {
                if endpoint == crate::endpoint::LOCAL {
                    view.endpoints[0].enabled = false;
                }
                view.activate_palette(
                    Action::Go {
                        endpoint: endpoint.into(),
                        boot: boot.clone(),
                        target: NavigationTarget::Pane("w1:p1".into()),
                    },
                    window,
                    cx,
                );
                let palette = view.menu.palette.as_ref().unwrap();
                assert_eq!(
                    palette.error.as_deref(),
                    Some(Error::PaletteHostUnavailable.to_string().as_str())
                );
                assert!(view.pending_navigation.is_none());
            }
        })
    });
}

#[gpui::test]
fn go_to_lists_the_selected_host_first_and_switches_host_for_a_remote_row(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut remote = crate::endpoint::Endpoint::new(
            "ssh:box".into(),
            "Box".into(),
            herdr_client::ConnectTarget::Ssh {
                target: "unused".into(),
                session: "default".into(),
            },
            true,
        );
        remote.live.snapshot = Some(Arc::new(snapshot()));
        remote.live.status = crate::state::ConnectionStatus::Connected;
        view.endpoints.push(remote);
        view
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_palette(Filter::Navigation, window, cx);
            let palette = view.menu.palette.as_ref().unwrap();
            let entries: Vec<_> = palette
                .filtered
                .iter()
                .map(|hit| &palette.entries[hit.index])
                .collect();
            let hosts: Vec<_> = entries
                .iter()
                .map(|entry| match &entry.action {
                    Action::Go { endpoint, .. } => endpoint.as_str(),
                    _ => panic!("Go To lists only destinations"),
                })
                .collect();
            let local = hosts
                .iter()
                .take_while(|host| **host == crate::endpoint::LOCAL)
                .count();
            assert!(local > 0 && local < hosts.len());
            assert!(hosts[local..].iter().all(|host| *host == "ssh:box"));
            assert!(entries[..local].iter().all(|e| !e.detail.contains("Box")));
            assert!(entries[local..].iter().all(|e| e.detail.starts_with("Box")));
            let remote_pane = entries[local..]
                .iter()
                .find(|entry| {
                    matches!(
                        entry.action,
                        Action::Go {
                            target: NavigationTarget::Pane(_),
                            ..
                        }
                    )
                })
                .unwrap()
                .action
                .clone();
            let Action::Go { target, .. } = &remote_pane else {
                unreachable!()
            };
            let target = target.clone();
            view.activate_palette(remote_pane, window, cx);
            assert!(view.menu.page.is_none(), "a valid row closes the picker");
            assert_eq!(view.endpoints[view.selected_endpoint].id, "ssh:box");
            // The remote host has no connection yet, so navigation waits for it.
            assert_eq!(view.pending_navigation, Some(target));
        })
    });
}

fn go_to_fixture() -> ClientShellSnapshot {
    let mut snapshot = snapshot();
    let mut tab = snapshot.tabs[0].clone();
    tab.tab_id = "w1:t2".into();
    tab.number = 2;
    tab.label = "logs".into();
    snapshot.tabs.push(tab);
    let mut terminal = snapshot.panes[0].clone();
    terminal.pane_id = "w1:p2".into();
    terminal.tab_id = "w1:t2".into();
    terminal.label = Some("  ".into());
    terminal.foreground_cwd = None;
    terminal.cwd = Some("/repo/logs".into());
    snapshot.panes.push(terminal);
    let mut empty = snapshot.workspaces[0].clone();
    empty.workspace_id = "w2".into();
    empty.number = 2;
    empty.label = "empty".into();
    empty.branch = None;
    snapshot.workspaces.push(empty);
    snapshot
}

#[test]
fn go_to_lists_every_pane_under_its_workspace() {
    let snapshot = go_to_fixture();
    let mut entries = Vec::new();
    go_to_entries(crate::endpoint::LOCAL, None, &snapshot, &mut entries);
    let rows: Vec<_> = entries
        .iter()
        .map(|entry| {
            let Action::Go {
                endpoint,
                boot,
                target,
            } = &entry.action
            else {
                panic!("Go To lists only destinations");
            };
            assert_eq!(endpoint, crate::endpoint::LOCAL);
            assert_eq!(boot, "boot-v1");
            (
                entry.label.as_ref(),
                entry.detail.as_ref(),
                entry.badge.as_ref(),
                target.clone(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            (
                "repo",
                "#1  main  /repo",
                "Workspace",
                NavigationTarget::Workspace("w1".into())
            ),
            (
                "main",
                "repo  #1",
                "Tab",
                NavigationTarget::Tab("w1:t1".into())
            ),
            // The fixture's agent labels its blocked state "waiting".
            (
                "Claude",
                "repo  main  /repo",
                "waiting",
                NavigationTarget::Pane("w1:p1".into())
            ),
            (
                "logs",
                "repo  #2",
                "Tab",
                NavigationTarget::Tab("w1:t2".into())
            ),
            (
                "Terminal",
                "repo  logs  /repo/logs",
                "Terminal",
                NavigationTarget::Pane("w1:p2".into())
            ),
            (
                "empty",
                "#2",
                "Workspace",
                NavigationTarget::Workspace("w2".into())
            ),
        ]
    );
}

/// An integration's state label names the agent's status in Go To, as in
/// the sidebar; a label for another status leaves the daemon's word.
#[test]
fn go_to_badges_use_the_agents_state_labels() {
    let badge = |labels: &[(&str, &str)]| {
        let mut snapshot = go_to_fixture();
        snapshot.agents[0].state_labels = labels
            .iter()
            .map(|(state, label)| ((*state).into(), (*label).into()))
            .collect();
        let mut entries = Vec::new();
        go_to_entries(crate::endpoint::LOCAL, None, &snapshot, &mut entries);
        entries
            .iter()
            .find(|entry| {
                matches!(
                    &entry.action,
                    Action::Go { target: NavigationTarget::Pane(pane), .. } if pane == "w1:p1"
                )
            })
            .map(|entry| entry.badge.to_string())
    };
    assert_eq!(
        badge(&[("blocked", "needs you"), ("working", "busy")]).as_deref(),
        Some("needs you")
    );
    assert_eq!(badge(&[("working", "busy")]).as_deref(), Some("blocked"));
}

#[test]
fn go_to_names_remote_hosts_and_hides_a_lone_default_tab() {
    let snapshot = snapshot();
    let mut entries = Vec::new();
    go_to_entries("ssh:box", Some("Box"), &snapshot, &mut entries);
    let details: Vec<_> = entries.iter().map(|entry| entry.detail.as_ref()).collect();
    assert_eq!(details, ["Box  #1  main  /repo", "Box  repo  /repo"]);
    assert!(entries.iter().all(|entry| matches!(
        &entry.action,
        Action::Go { endpoint, .. } if endpoint == "ssh:box"
    )));
    let mut matching = entries
        .iter()
        .filter(|entry| {
            matches_query(
                &format!("{} {} {}", entry.label, entry.detail, entry.badge),
                "box claude",
            )
        })
        .map(|entry| entry.label.as_ref());
    assert_eq!(matching.next(), Some("Claude"));
    assert_eq!(matching.next(), None);
}

#[test]
fn go_to_rows_indent_only_beneath_a_visible_workspace_or_tab() {
    let snapshot = go_to_fixture();
    let mut entries = Vec::new();
    go_to_entries(crate::endpoint::LOCAL, None, &snapshot, &mut entries);
    let depths = |candidates: &[usize]| {
        search::rank(
            &entries,
            candidates.iter().copied(),
            &search::Query::parse(""),
            &mut search::matcher(),
        )
        .iter()
        .map(|hit| hit.depth)
        .collect::<Vec<_>>()
    };
    // Workspace, tab, agent, tab, terminal, workspace.
    assert_eq!(depths(&[0, 1, 2, 3, 4, 5]), [0, 1, 2, 1, 2, 0]);
    // A search that matches a pane but not its tab leaves it beneath the
    // workspace, and one matching neither leaves it flush.
    assert_eq!(depths(&[0, 2, 5]), [0, 0, 0]);
    assert_eq!(depths(&[2, 3, 4]), [0, 0, 1]);
}

#[test]
fn go_to_destinations_are_revalidated_against_the_current_snapshot() {
    let snapshot = go_to_fixture();
    for target in [
        NavigationTarget::Workspace("w2"),
        NavigationTarget::Tab("w1:t2"),
        NavigationTarget::Pane("w1:p2"),
    ] {
        assert!(destination_exists(&snapshot, "boot-v1", target.clone()).is_ok());
        assert!(matches!(
            destination_exists(&snapshot, "boot-v2", target.clone()),
            Err(Error::PaletteSessionChanged)
        ));
        assert!(matches!(
            destination_exists(&snapshot, "", target),
            Err(Error::PaletteSessionChanged)
        ));
    }
    assert!(matches!(
        destination_exists(&snapshot, "boot-v1", NavigationTarget::Workspace("gone")),
        Err(Error::PaletteWorkspaceRemoved)
    ));
    assert!(matches!(
        destination_exists(&snapshot, "boot-v1", NavigationTarget::Tab("gone")),
        Err(Error::PaletteTabRemoved)
    ));
    assert!(matches!(
        destination_exists(&snapshot, "boot-v1", NavigationTarget::Pane("gone")),
        Err(Error::PaletteDestinationRemoved)
    ));
}

#[test]
fn filtering_matches_all_unicode_tokens_in_any_order() {
    assert!(matches_query("CAF\u{c9} branch 42", " 42\tCAF\u{e9} "));
    assert!(matches_query("\u{391}\u{392} workspace", "\u{3b1}\u{3b2}"));
    assert!(matches_query("anything", " \n "));
    assert!(!matches_query("CAF\u{c9} branch 42", "caf\u{e9} missing"));
}

#[test]
fn invocation_uses_captured_ids_not_current_focus() {
    let mut snapshot = snapshot();
    snapshot.commands = vec![ClientShellCommand {
        command_id: "build".into(),
        action: ClientShellCommandAction::Shell,
        description: None,
        binding_label: String::new(),
        binding_labels: Vec::new(),
    }];
    let target = Target::capture(&snapshot);
    snapshot.focused_workspace_id = None;
    snapshot.focused_tab_id = None;
    snapshot.focused_pane_id = None;
    assert_eq!(
        target
            .invocation(&snapshot, "build", ClientShellCommandAction::Shell)
            .unwrap(),
        json!({
            "command_id": "build", "workspace_id": target.workspace,
            "tab_id": target.tab, "pane_id": target.pane,
        })
    );
    let empty_target = Target::capture(&snapshot);
    assert_eq!(
        empty_target
            .invocation(&snapshot, "build", ClientShellCommandAction::Shell)
            .unwrap(),
        json!({"command_id": "build"})
    );
}

#[test]
fn invocation_rejects_stale_boot_command_action_and_membership() {
    let mut original = snapshot();
    original.commands = vec![ClientShellCommand {
        command_id: "build".into(),
        action: ClientShellCommandAction::Shell,
        description: None,
        binding_label: String::new(),
        binding_labels: Vec::new(),
    }];
    let target = Target::capture(&original);
    for change in 0..7 {
        let mut snapshot = original.clone();
        match change {
            0 => snapshot.boot_id.push_str("-new"),
            1 => snapshot.commands.clear(),
            2 => snapshot.commands[0].action = ClientShellCommandAction::Pane,
            3 => snapshot.workspaces.clear(),
            4 => snapshot.tabs.clear(),
            5 => snapshot.panes.clear(),
            _ => {
                for pane in &mut snapshot.panes {
                    pane.tab_id = "foreign".into();
                }
            }
        }
        assert!(
            target
                .invocation(&snapshot, "build", ClientShellCommandAction::Shell)
                .is_err()
        );
    }
    original.commands[0].action = ClientShellCommandAction::Unknown;
    assert!(
        target
            .invocation(&original, "build", ClientShellCommandAction::Unknown)
            .is_err()
    );
}

#[test]
fn workspace_selection_rejects_removed_id_and_restarted_daemon() {
    let mut snapshot = snapshot();
    let target = Target::capture(&snapshot);
    let id = snapshot.workspaces[0].workspace_id.clone();
    assert!(target.workspace_exists(&snapshot, &id).is_ok());
    assert!(target.workspace_exists(&snapshot, "missing").is_err());
    snapshot.boot_id.push_str("-new");
    assert!(target.workspace_exists(&snapshot, &id).is_err());
}
