use super::*;
use browser::fleet::{Fleet, Group, Phase, ServerPhase, Session};
fn row(label: String, detail: Option<String>, depth: u8, target: Option<Target>) -> Row {
    Row {
        label,
        pane_count: detail,
        selected: false,
        target,
        depth,
        machine: None,
        agent: None,
        icon: None,
        favorite: None,
        summary: None,
        attention: 0,
    }
}
fn session_row(_state: &browser::State, g: &Group, s: &Session) -> Row {
    let server = s
        .server_id
        .as_ref()
        .and_then(|id| g.servers.iter().find(|x| &x.id == id))
        .and_then(|s| {
            s.generation
                .as_ref()
                .map(|generation| (s.id.clone(), generation.clone()))
        });
    let target = if g.state == Phase::Ready && !g.conflict {
        s.selection
            .as_ref()
            .zip(s.session_id.as_ref())
            .map(|(selection, session)| Target::FleetSession {
                machine: g.id.clone(),
                id: s.id.clone(),
                session: session.clone(),
                server,
                selection: selection.clone(),
            })
    } else {
        None
    };
    let mut r = row(
        s.name.clone(),
        Some(format!(
            "{} {}{}",
            s.pane_count,
            if s.pane_count == 1 { "pane" } else { "panes" },
            if target.is_none() {
                " · Unavailable"
            } else {
                ""
            }
        )),
        u8::from(g.servers.len() > 1),
        target,
    );
    r.icon = Some("icons/terminal.svg");
    r.selected = s.active;
    r.favorite = Some((s.favorite_action.clone(), s.favorite));
    r
}
pub(super) fn rows(state: &browser::State, fleet: &Fleet) -> Vec<Row> {
    let mut out = Vec::new();
    for g in &fleet.groups {
        let target = fleet.preferences.as_ref().and_then(|p| {
            g.collapse_action
                .as_ref()
                .filter(|a| fleet.preference_action(p.revision, a, !g.collapsed))
                .map(|action| Target::Collapse {
                    machine: g.id.clone(),
                    revision: p.revision,
                    action: action.clone(),
                    enabled: !g.collapsed,
                })
        });
        let mut machine = row(
            g.label.clone(),
            if g.conflict {
                Some("Identity conflict".into())
            } else if g.state != Phase::Ready {
                Some(g.state.label().into())
            } else {
                None
            },
            0,
            target,
        );
        machine.machine = Some(g.id.clone());
        machine.icon = Some(if g.collapsed {
            "icons/chevron-right.svg"
        } else {
            "icons/chevron-down.svg"
        });
        out.push(machine);
        let visible = |s: &&Session| !g.collapsed || s.favorite || s.active;
        for server in &g.servers {
            let mut children: Vec<_> = g
                .sessions
                .iter()
                .filter(|s| s.server_id.as_ref() == Some(&server.id))
                .filter(visible)
                .collect();
            children.sort_by(|a, b| {
                b.favorite
                    .cmp(&a.favorite)
                    .then_with(|| a.name.cmp(&b.name))
                    .then_with(|| a.id.cmp(&b.id))
            });
            if g.collapsed && children.is_empty() {
                continue;
            }
            let target =
                if g.state == Phase::Ready && !g.conflict && server.state == ServerPhase::Online {
                    server
                        .selection
                        .as_ref()
                        .zip(server.generation.as_ref())
                        .map(|(selection, generation)| Target::FleetServer {
                            machine: g.id.clone(),
                            id: server.id.clone(),
                            generation: generation.clone(),
                            selection: selection.clone(),
                        })
                } else {
                    None
                };
            let label = if g.servers.iter().filter(|s| s.label == server.label).count() > 1 {
                format!(
                    "{} · {}",
                    server.label,
                    server
                        .id
                        .chars()
                        .rev()
                        .take(6)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                )
            } else {
                server.label.clone()
            };
            let mut r = row(
                label,
                Some(
                    if server.state == ServerPhase::Offline {
                        "Offline"
                    } else if children.is_empty() {
                        "No sessions"
                    } else {
                        "Server"
                    }
                    .into(),
                ),
                1,
                target,
            );
            r.icon = Some("icons/sessions.svg");
            // A populated single default server adds no useful navigation hierarchy.
            if g.servers.len() != 1 || children.is_empty() || server.state == ServerPhase::Offline {
                out.push(r);
            }
            out.extend(children.into_iter().map(|s| session_row(state, g, s)));
        }
        let other: Vec<_> = g
            .sessions
            .iter()
            .filter(|s| {
                s.server_id
                    .as_ref()
                    .is_none_or(|id| !g.servers.iter().any(|server| &server.id == id))
            })
            .filter(visible)
            .collect();
        if !other.is_empty() {
            out.push(row("Other sessions".into(), None, 1, None));
            out.extend(other.into_iter().map(|s| session_row(state, g, s)));
        }
        if g.omitted_sessions > 0 || g.omitted_servers > 0 {
            out.push(row(
                format!(
                    "{} sessions · {} servers omitted",
                    g.omitted_sessions, g.omitted_servers
                ),
                None,
                1,
                None,
            ));
        }
    }
    // The current catalog has its own exact Session route. Only deduplicate it
    // against a uniquely acknowledged active machine/server scope, never a bare
    // live ID that could also occur on another machine.
    let active: Vec<_> = fleet
        .groups
        .iter()
        .flat_map(|g| g.sessions.iter().filter(|s| s.active).map(move |s| (g, s)))
        .collect();
    let orphan: Vec<_> = state
        .sessions
        .iter()
        .filter(|catalog| {
            active.len() != 1
                || active[0].1.server_id.is_none()
                || !active[0].0.sessions.iter().any(|s| {
                    s.server_id == active[0].1.server_id
                        && s.session_id.as_ref() == Some(&catalog.id)
                })
        })
        .collect();
    if !orphan.is_empty() {
        out.push(row("Current session catalog".into(), None, 0, None));
        out.extend(orphan.into_iter().map(|s| Row {
            label: s.label.clone(),
            pane_count: s.pane_count_label(),
            selected: active.is_empty() && state.selected_session.as_ref() == Some(&s.id),
            target: Some(Target::Session(s.id.clone())),
            depth: 1,
            icon: Some("icons/terminal.svg"),
            favorite: None,
            summary: None,
            attention: 0,
            machine: None,
            agent: None,
        }));
    }
    if fleet.omitted_groups > 0 {
        out.push(row(
            format!("{} machines omitted", fleet.omitted_groups),
            None,
            0,
            None,
        ));
    }
    activity::integrate(state, out)
}
