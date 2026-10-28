#![allow(clippy::unwrap_used)]
use super::*;
#[track_caller]
fn until(bridge: &Bridge, predicate: impl Fn(&State) -> bool) -> State {
    let deadline = Instant::now() + Duration::from_secs(50);
    let mut last = String::new();
    loop {
        if let Some(state) = bridge.mailbox.lock().unwrap().take() {
            let state = state.unwrap_or_else(|| panic!("native browser closed"));
            last = format!(
                "request={} status={} selected={:?} panes={} ready={} frame={} actions={} agents={:?}",
                state.request,
                state.status,
                state.selected_pane,
                state.panes.len(),
                state.input_ready,
                state.frame.is_some(),
                state.pane_actions.is_some(),
                state.home_agents.as_ref().map(|r| (
                    r.revision,
                    r.observed_sessions,
                    r.total_sessions,
                    r.truncated_sessions,
                    r.rows.len()
                ))
            );
            if predicate(&state) {
                return state;
            }
        }
        assert!(
            Instant::now() < deadline,
            "native browser state timed out: {last}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
#[ignore = "requires explicit owned scratch daemon; admits an isolated test session"]
fn native_local_catalog_opens_owned_session_without_helper() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    owned_session_journey(bridge);
    owner.shutdown().unwrap();
}
#[cfg(unix)]
#[test]
#[ignore = "requires the owned OpenSSH and scratch daemon harness"]
fn native_ssh_catalog_opens_owned_session_without_helper() {
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_OWNED_SSH").as_deref(),
        Ok("private-fixture")
    );
    if let Some(record) = std::env::var_os("TMUX_IDE_TEST_LOCAL_RECORD") {
        let profile = std::env::var("TMUX_IDE_TEST_SAVED_PROFILE").unwrap();
        let (bridge, owner) = start(record.into(), Default::default()).unwrap();
        let home = until(&bridge, |s| {
            s.home_phase == HomePhase::Live
                && (std::env::var_os("TMUX_IDE_TEST_CACHED_HISTORY").is_none()
                    || preferences_ready(s))
                && s.machines
                    .as_ref()
                    .is_some_and(|m| m.available && !m.pending)
        });
        let adding = std::env::var("TMUX_IDE_TEST_ADD_MACHINE").as_deref() == Ok("owned-profile");
        let fleet_selection = std::env::var_os("TMUX_IDE_TEST_CACHED_HISTORY").is_some();
        let home = if fleet_selection {
            fleet_server::selected_catalog(&bridge, home)
        } else {
            home
        };
        let remote_request = if fleet_selection {
            let input = std::env::var("TMUX_IDE_TEST_INPUT_SESSION").unwrap();
            let ready = until(&bridge, |s| {
                s.fleet.as_ref().is_some_and(|f| {
                    f.groups.iter().any(|g| {
                        g.id == profile
                            && g.sessions
                                .iter()
                                .any(|session| session.name == input && session.selection.is_some())
                    })
                })
            });
            let ready = fleet_preferences::exercise(&bridge, ready, &profile, &input);
            let ready = fleet_server::exercise(&bridge, ready, &profile, &input);
            let base = ready.request;
            assert!(ready.frame.is_none());
            eprintln!("NATIVE_CATALOG_ADD_READY");
            until(&bridge, |s| {
                s.request == base
                    && s.frame.is_none()
                    && s.fleet.as_ref().is_some_and(|f| {
                        f.groups.iter().any(|g| {
                            g.id == profile
                                && g.sessions.iter().any(|row| {
                                    row.name == "native-push-owned" && row.selection.is_some()
                                })
                        })
                    })
            });
            eprintln!("NATIVE_CATALOG_REMOVE_READY");
            until(&bridge, |s| {
                s.request == base
                    && s.frame.is_none()
                    && s.fleet.as_ref().is_some_and(|f| {
                        f.groups.iter().any(|g| {
                            g.id == profile
                                && g.state == fleet::Phase::Ready
                                && !g.sessions.iter().any(|row| row.name == "native-push-owned")
                        })
                    })
            });
            eprintln!("NATIVE_CATALOG_UPDATES_VERIFIED");
            let ack = std::env::var_os("TMUX_IDE_TEST_BACKGROUND_RETRY_ACK").unwrap();
            eprintln!("NATIVE_BACKGROUND_FLEET_INTERRUPT_READY");
            let deadline = Instant::now() + Duration::from_secs(10);
            while !std::path::Path::new(&ack).exists() {
                assert!(
                    Instant::now() < deadline,
                    "background tunnel interruption not acknowledged"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            until(&bridge, |s| {
                s.request == base
                    && s.home_phase == HomePhase::Live
                    && s.fleet.as_ref().is_some_and(|f| {
                        f.groups
                            .iter()
                            .any(|g| g.id == profile && g.state == fleet::Phase::Disconnected)
                    })
            });
            // The lost background tunnel must recover without a Home command.
            let ready = until(&bridge, |s| {
                s.request == base
                    && preferences_ready(s)
                    && s.fleet.as_ref().is_some_and(|f| {
                        f.groups.iter().any(|g| {
                            g.id == profile
                                && g.sessions.iter().any(|session| {
                                    session.name == input && session.selection.is_some()
                                })
                        })
                    })
            });
            eprintln!("NATIVE_BACKGROUND_FLEET_RETRY_VERIFIED");
            eprintln!("NATIVE_BACKGROUND_FLEET_AUTO_RECOVERY_VERIFIED");
            let selection = ready
                .fleet
                .as_ref()
                .unwrap()
                .groups
                .iter()
                .find(|g| g.id == profile)
                .unwrap()
                .sessions
                .iter()
                .find(|session| session.name == input)
                .unwrap()
                .selection
                .clone()
                .unwrap();
            bridge
                .commands
                .send(Command::FleetSession {
                    request: base + 3,
                    selection,
                })
                .unwrap();
            until(&bridge, |s| {
                s.request == base + 3 && s.frame.is_some() && s.input_ready
            });
            eprintln!("NATIVE_BACKGROUND_FLEET_SELECTION_VERIFIED");
            bridge
                .commands
                .send(Command::Home { request: base + 4 })
                .unwrap();
            base + 4
        } else {
            let command = if adding {
                Command::Machine {
                    request: 1,
                    ssh_target: Some("target".into()),
                }
            } else {
                Command::MachineProfile {
                    request: 1,
                    id: profile.clone(),
                    revision: home.machines.unwrap().revision,
                }
            };
            bridge.commands.send(command).unwrap();
            1
        };
        let remote = until(&bridge, |s| {
            s.request == remote_request
                && s.surface == Surface::Home
                && s.home_phase == HomePhase::Live
                && s.fleet.as_ref().is_some_and(|f| {
                    f.groups.iter().any(|g| {
                        if adding {
                            g.id != "local"
                        } else {
                            g.id == profile
                        }
                    })
                })
        });
        if adding {
            let saved = remote.machines.as_ref().unwrap();
            assert!(saved.available);
            assert_eq!(saved.machines.len(), 1);
            assert_eq!(saved.machines[0].ssh_target, "target");
            assert!(
                remote
                    .fleet
                    .as_ref()
                    .unwrap()
                    .groups
                    .iter()
                    .any(|g| g.id == saved.machines[0].id)
            );
            eprintln!("NATIVE_MACHINE_ADDED");
        }
        owned_session_journey_from(bridge, Some(remote));
        owner.shutdown().unwrap();
    } else {
        let target = herdr_client::tmux_ssh::SshTarget::parse("target").unwrap();
        let (bridge, owner) = start_remote(target, None, None, Default::default()).unwrap();
        owned_session_journey(bridge);
        owner.shutdown().unwrap();
    }
}

fn owned_session_journey(bridge: Bridge) {
    owned_session_journey_from(bridge, None);
}
fn owned_session_journey_from(bridge: Bridge, initial: Option<State>) {
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_ALLOW_MUTATION").unwrap(),
        "owned-scratch-fleet"
    );
    let input_session = std::env::var("TMUX_IDE_TEST_INPUT_SESSION").unwrap();
    let home = initial.unwrap_or_else(|| {
        until(&bridge, |s| {
            s.home_phase == HomePhase::Live
                && s.session_catalog_complete
                && (std::env::var_os("TMUX_IDE_TEST_OWNED_SSH").is_some()
                    || s.machines
                        .as_ref()
                        .is_some_and(|m| m.available && !m.pending))
        })
    });
    let home = exercise_preferences(&bridge, home);
    let epoch = home.request;
    assert!(!home.sessions.is_empty());
    assert!(!home.input_ready);
    let selected = home
        .sessions
        .iter()
        .find(|session| session.label == input_session)
        .unwrap()
        .id
        .clone();
    bridge
        .commands
        .send(Command::Session {
            request: epoch + 1,
            id: selected.clone(),
        })
        .unwrap();
    let live = until(&bridge, |s| {
        s.request == epoch + 1
            && s.frame.is_some()
            && s.input_ready
            && s.split_layout.is_some()
            && s.workspace_agents
                .as_ref()
                .is_some_and(|agents| agents.roster.observed_sessions == 1 && agents.roster.valid())
            && s.panes
                .iter()
                .all(|pane| pane.window_id.is_some() && pane.window_label.is_some())
    });
    if std::env::var("TMUX_IDE_TEST_REVOKE_PROFILE").as_deref() == Ok("owned-profile") {
        let profile = std::env::var("TMUX_IDE_TEST_SAVED_PROFILE").unwrap();
        eprintln!("NATIVE_SSH_INTERRUPT_READY");
        until(&bridge, |s| {
            !s.input_ready
                && s.input_targets.is_empty()
                && s.home_phase == HomePhase::Live
                && s.fleet
                    .as_ref()
                    .is_some_and(|f| f.groups.iter().any(|g| g.id == "local"))
                && s.machines.as_ref().is_some_and(|r| {
                    r.available && r.machines.iter().any(|m| m.id == profile && !m.enabled)
                })
        });
        eprintln!("NATIVE_SAVED_PROFILE_REVOKED");
        eprintln!("NATIVE_SAVED_PROFILE_RETURNED_LOCAL");

        drop(bridge);
        return;
    }
    let live = if std::env::var("TMUX_IDE_TEST_RECONNECT").as_deref() == Ok("owned-tunnel") {
        eprintln!("NATIVE_SSH_INTERRUPT_READY");
        let revoked = std::cell::Cell::new(false);
        let recovered = until(&bridge, |s| {
            if !s.input_ready && s.input_targets.is_empty() {
                revoked.set(true);
            }
            revoked.get()
                && s.request == live.request
                && s.input_ready
                && s.frame.is_some()
                && s.input_targets != live.input_targets
                && s.selected_session == live.selected_session
                && s.selected_pane == live.selected_pane
        });
        eprintln!("NATIVE_SSH_RECONNECTED");
        recovered
    } else {
        live
    };
    assert!(live.surface == Surface::Workspace);
    assert!(
        live.selected_session
            .as_ref()
            .is_some_and(|id| id.starts_with("live-session."))
    );
    assert!(live.selected_pane.is_some());
    assert!(!live.input_targets.is_empty());
    // Only the input session explicitly selected by the owned harness receives input.
    send_input(&bridge, &live, crate::tmux_snapshot::keys::Input::Text("i=0; while [ \"$i\" -lt 120 ]; do printf 'native-history-%s\\n' \"$i\"; i=$((i+1)); done".into()));
    send_input(
        &bridge,
        &live,
        crate::tmux_snapshot::keys::Input::Key("Enter".into()),
    );
    let output = until(&bridge, |s| {
        s.input_ready && contains(s, "native-history-119")
    });
    send_input(
        &bridge,
        &output,
        crate::tmux_snapshot::keys::Input::Scroll(8),
    );
    let historical = until(&bridge, |s| s.history_offset > 0);
    let anchor = first_history_marker(&historical);
    bridge
        .commands
        .send(Command::Home { request: epoch + 2 })
        .unwrap();
    let home = until(&bridge, |s| {
        s.request == epoch + 2 && s.home_phase == HomePhase::Live
    });
    assert!(home.surface == Surface::Home);
    assert!(home.frame.is_none());
    assert!(!home.input_ready);
    assert!(home.input_targets.is_empty());
    let selected = home
        .sessions
        .iter()
        .find(|session| session.label == input_session)
        .unwrap()
        .id
        .clone();
    bridge
        .commands
        .send(Command::Session {
            request: epoch + 3,
            id: selected,
        })
        .unwrap();
    let restored = until(&bridge, |s| s.request == epoch + 3 && s.history_offset > 0);
    assert_eq!(first_history_marker(&restored), anchor);
    bridge
        .commands
        .send(Command::Home { request: epoch + 4 })
        .unwrap();
    let home = until(&bridge, |s| {
        s.request == epoch + 4 && s.home_phase == HomePhase::Live
    });
    let fleet = home.fleet.as_ref().unwrap();
    assert!(fleet.valid());
    let server = fleet.groups[0]
        .servers
        .iter()
        .find(|s| s.selection.is_some())
        .unwrap();
    bridge
        .commands
        .send(Command::FleetServer {
            request: epoch + 5,
            selection: server.selection.clone().unwrap(),
        })
        .unwrap();
    until(&bridge, |s| {
        s.request == epoch + 5
            && s.create_session
                .as_ref()
                .is_some_and(|c| c.phase == CreatePhase::Idle)
    });
    bridge
        .commands
        .send(Command::CreateSession {
            request: epoch + 5,
            name: "Native GUI created session".into(),
        })
        .unwrap();
    let created = until(&bridge, |s| {
        s.request == epoch + 5 && s.frame.is_some() && s.input_ready && s.pane_actions.is_some()
    });
    assert!(
        created
            .sessions
            .iter()
            .any(|s| s.label == "Native GUI created session")
    );
    assert_ne!(created.selected_session, restored.selected_session);
    let action = created.pane_actions.as_ref().unwrap();
    bridge
        .commands
        .send(Command::PaneAction {
            request: epoch + 5,
            id: action.id.clone(),
            token: action.token.clone(),
            action: crate::tmux_snapshot::pane_actions::Action::NewWindow,
        })
        .unwrap();
    let expanded = until(&bridge, |s| {
        s.request == epoch + 5
            && s.frame.is_some()
            && s.input_ready
            && s.selected_pane != created.selected_pane
    });
    assert_eq!(expanded.selected_session, created.selected_session);
    assert_eq!(expanded.panes.len(), created.panes.len() + 1);

    exercise_navigation(
        &bridge,
        epoch + 5,
        restored.selected_session.as_deref().unwrap(),
        created.selected_session.as_deref().unwrap(),
    );
    bridge
        .commands
        .send(Command::Home { request: epoch + 9 })
        .unwrap();
    until(&bridge, |s| {
        s.request == epoch + 9 && s.home_phase == HomePhase::Live
    });
    if std::env::var_os("TMUX_IDE_TEST_LOCAL_RECORD").is_some() {
        bridge
            .commands
            .send(Command::Machine {
                request: epoch + 10,
                ssh_target: None,
            })
            .unwrap();
        until(&bridge, |s| {
            s.request == epoch + 10
                && s.home_phase == HomePhase::Live
                && s.fleet
                    .as_ref()
                    .is_some_and(|f| f.groups.iter().any(|g| g.id == "local"))
        });
        eprintln!("NATIVE_SAVED_PROFILE_RETURNED_LOCAL");
        if std::env::var("TMUX_IDE_TEST_CROSS_MACHINE").as_deref() == Ok("owned-fleet") {
            let home = until(&bridge, |s| {
                s.request == epoch + 10
                    && s.session_history.as_ref().is_some_and(|h| h.back.is_some())
                    && s.machines
                        .as_ref()
                        .is_some_and(|m| m.available && !m.pending)
            });
            let capability = home.session_history.unwrap();
            bridge
                .commands
                .send(Command::SessionHistory {
                    request: epoch + 11,
                    from_request: epoch + 10,
                    revision: capability.revision,
                    action: capability.back.unwrap(),
                })
                .unwrap();
            until(&bridge, |s| {
                s.request == epoch + 11
                    && s.frame.is_some()
                    && s.selected_session == restored.selected_session
                    && s.session_history
                        .as_ref()
                        .is_some_and(|h| h.forward.is_some())
                    && s.fleet
                        .as_ref()
                        .is_some_and(|f| f.groups.iter().any(|g| g.id != "local"))
            });
            bridge
                .commands
                .send(Command::Machine {
                    request: epoch + 12,
                    ssh_target: None,
                })
                .unwrap();
            until(&bridge, |s| {
                s.request == epoch + 12
                    && s.home_phase == HomePhase::Live
                    && s.fleet
                        .as_ref()
                        .is_some_and(|f| f.groups.iter().any(|g| g.id == "local"))
            });
            eprintln!("NATIVE_CROSS_MACHINE_VERIFIED");
            tabs_live(&bridge, epoch + 12);
        }
    }
    drop(bridge);
}
fn send_input(bridge: &Bridge, state: &State, input: crate::tmux_snapshot::keys::Input) {
    let pane = state.selected_pane.as_ref().unwrap();
    let target = state
        .input_targets
        .iter()
        .find(|target| &target.id == pane)
        .unwrap();
    bridge
        .commands
        .send(Command::Input {
            request: state.request,
            id: pane.clone(),
            input_target: Some(target.token.clone()),
            input,
        })
        .unwrap();
}
fn first_history_marker(state: &State) -> String {
    let view = state.frame.as_ref().unwrap().view();
    for y in 0..usize::from(view.height()) {
        let row = view
            .row(y)
            .unwrap()
            .iter()
            .map(|cell| cell.symbol.as_str())
            .collect::<String>();
        if row.contains("native-history-") {
            return row.trim().to_owned();
        }
    }
    panic!("historical frame has no fixture marker");
}
fn contains(state: &State, needle: &str) -> bool {
    state.frame.as_ref().is_some_and(|frame| {
        let view = frame.view();
        (0..usize::from(view.height())).any(|y| {
            view.row(y).is_some_and(|cells| {
                cells
                    .iter()
                    .map(|cell| cell.symbol.as_str())
                    .collect::<String>()
                    .contains(needle)
            })
        })
    })
}
#[test]
fn missing_private_record_is_reported_without_starting_a_daemon() {
    let root = tempfile::tempdir().unwrap();
    let (bridge, _owner) = start(root.path().join("absent.json"), Default::default()).unwrap();
    let state = until(&bridge, |s| s.home_phase == HomePhase::Unavailable);
    assert!(state.sessions.is_empty());
    assert!(state.frame.is_none());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

fn preferences_ready(state: &State) -> bool {
    state
        .fleet
        .as_ref()
        .and_then(|f| f.preferences.as_ref())
        .is_some_and(|p| p.phase == fleet::PreferencePhase::Ready)
}
fn exercise_preferences(bridge: &Bridge, home: State) -> State {
    if std::env::var("TMUX_IDE_TEST_PREFERENCES").as_deref() != Ok("owned-local") {
        return home;
    }
    let request = home.request;
    let home = if preferences_ready(&home) {
        home
    } else {
        until(bridge, |s| s.request == request && preferences_ready(s))
    };
    let fleet = home.fleet.as_ref().unwrap();
    let row = &fleet.groups[0].sessions[0];
    let key = row.id.clone();
    let old_action = row.favorite_action.clone().unwrap();
    let old_revision = fleet.preferences.as_ref().unwrap().revision;
    let favorite = |enabled| Command::FleetPreference {
        request,
        revision: old_revision,
        action: old_action.clone(),
        enabled,
    };
    bridge.commands.send(favorite(true)).unwrap();
    // A queued duplicate must not reverse the acknowledged favorite.
    bridge.commands.send(favorite(false)).unwrap();
    let saved = until(bridge, |s| {
        preferences_ready(s)
            && s.fleet.as_ref().is_some_and(|f| {
                f.groups
                    .iter()
                    .flat_map(|g| &g.sessions)
                    .any(|r| r.id == key && r.favorite)
            })
    });
    // Nor may an old capability be reused after the receipt publishes new tokens.
    bridge.commands.send(favorite(false)).unwrap();
    let fleet = saved.fleet.as_ref().unwrap();
    bridge
        .commands
        .send(Command::FleetPreference {
            request,
            revision: fleet.preferences.as_ref().unwrap().revision,
            action: fleet.groups[0].collapse_action.clone().unwrap(),
            enabled: true,
        })
        .unwrap();
    let collapsed = until(bridge, |s| {
        preferences_ready(s) && s.fleet.as_ref().is_some_and(|f| f.groups[0].collapsed)
    });
    let fleet = collapsed.fleet.as_ref().unwrap();
    assert!(
        fleet.groups[0]
            .sessions
            .iter()
            .any(|s| s.id == key && s.favorite)
    );
    bridge
        .commands
        .send(Command::FleetPreference {
            request,
            revision: fleet.preferences.as_ref().unwrap().revision,
            action: fleet.groups[0].collapse_action.clone().unwrap(),
            enabled: false,
        })
        .unwrap();
    until(bridge, |s| {
        preferences_ready(s) && s.fleet.as_ref().is_some_and(|f| !f.groups[0].collapsed)
    });
    bridge
        .commands
        .send(Command::Refresh {
            request: request + 1,
        })
        .unwrap();
    let refreshed = until(bridge, |s| {
        s.request == request + 1
            && s.home_phase == HomePhase::Live
            && preferences_ready(s)
            && s.fleet.as_ref().is_some_and(|f| {
                !f.groups[0].collapsed
                    && f.groups[0]
                        .sessions
                        .iter()
                        .any(|r| r.id == key && r.favorite)
            })
    });
    eprintln!("NATIVE_PREFERENCES_VERIFIED");
    refreshed
}

fn exercise_navigation(bridge: &Bridge, request: u64, previous: &str, current: &str) {
    let ready = until(bridge, |s| {
        s.request == request && s.session_history.as_ref().is_some_and(|h| h.back.is_some())
    });
    let history = ready.session_history.unwrap();
    let stale = history.back.clone().unwrap();
    bridge
        .commands
        .send(Command::SessionHistory {
            request: request + 1,
            from_request: request,
            revision: history.revision,
            action: stale.clone(),
        })
        .unwrap();
    let back = until(bridge, |s| {
        s.request == request + 1
            && s.frame.is_some()
            && s.history_offset > 0
            && s.selected_session.as_deref() == Some(previous)
            && s.session_history
                .as_ref()
                .is_some_and(|h| h.forward.is_some())
    });
    assert!(back.history_offset > 0);
    assert!(
        !back.input_ready,
        "navigation must not enable typing in restored scrollback"
    );
    let forward = back.session_history.unwrap();
    // A higher request does not revive the previous publication's capability.
    bridge
        .commands
        .send(Command::SessionHistory {
            request: request + 2,
            from_request: request + 1,
            revision: history.revision,
            action: stale,
        })
        .unwrap();
    let rejected = until(bridge, |s| {
        s.session_history_rejected
            .as_ref()
            .is_some_and(|r| r.request == request + 2)
    });
    assert_eq!(rejected.request, request + 1);
    assert_eq!(rejected.selected_session.as_deref(), Some(previous));
    bridge
        .commands
        .send(Command::SessionHistory {
            request: request + 3,
            from_request: request + 1,
            revision: forward.revision,
            action: forward.forward.unwrap(),
        })
        .unwrap();
    until(bridge, |s| {
        s.request == request + 3 && s.input_ready && s.selected_session.as_deref() == Some(current)
    });
    eprintln!("NATIVE_NAVIGATION_VERIFIED");
}

#[path = "browser_native_local_cached_history_tests.rs"]
mod cached;

#[cfg(unix)]
#[path = "browser_native_local_fleet_preferences_live_tests.rs"]
mod fleet_preferences;

#[cfg(unix)]
#[path = "browser_native_local_fleet_server_live_tests.rs"]
mod fleet_server;

fn tabs_live(bridge: &Bridge, request: u64) {
    let home = until(bridge, |s| {
        s.request == request
            && s.machines
                .as_ref()
                .is_some_and(|m| m.available && !m.pending)
            && s.session_tabs.as_ref().is_some_and(|p| {
                p.rows
                    .iter()
                    .any(|r| r.host_label != "Local" && r.available)
            })
    });
    let p = home.session_tabs.unwrap();
    let row = p
        .rows
        .iter()
        .find(|r| r.host_label != "Local" && r.available)
        .unwrap();
    let id = row.id.clone();
    let name = row.label.clone();
    bridge
        .commands
        .send(Command::SessionTab {
            request: request + 1,
            from_request: request,
            revision: p.revision,
            action: row.activate.clone(),
        })
        .unwrap();
    let live = until(bridge, |s| {
        s.request == request + 1
            && (s.input_ready || s.history_offset > 0)
            && s.frame.is_some()
            && s.session_tabs
                .as_ref()
                .is_some_and(|p| p.active.as_ref() == Some(&id))
    });
    if live.history_offset > 0 {
        assert!(
            !live.input_ready,
            "restored scrollback must not enable typing"
        );
    }
    let p = live.session_tabs.unwrap();
    bridge
        .commands
        .send(Command::SessionTab {
            request: request + 2,
            from_request: request + 1,
            revision: p.revision,
            action: p.close_active.unwrap(),
        })
        .unwrap();
    until(bridge, |s| {
        s.request == request + 2
            && s.home_phase == HomePhase::Live
            && s.session_tabs
                .as_ref()
                .is_some_and(|p| !p.rows.iter().any(|r| r.id == id))
            && s.sessions.iter().any(|row| row.label == name)
    });
    eprintln!("NATIVE_SESSION_TABS_VERIFIED");
}

#[path = "browser_native_local_agent_live_tests.rs"]
mod agent_live;

#[path = "browser_native_local_agent_picker_live_tests.rs"]
mod picker_live;
