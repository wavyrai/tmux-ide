use super::*;
use browser::fleet::{Fleet, Group, Phase, ServerPhase, Session};
fn row(label: String, detail: Option<String>, depth: u8, target: Option<Target>) -> Row {
    Row {
        label,
        pane_count: detail,
        target,
        depth,
        ..Row::default()
    }
}
/// A session's heading (#746): the project's name and favicon, with its
/// machine beside it when the fleet has more than one. An unavailable
/// session keeps its heading and says so.
fn session_row(fleet: &Fleet, g: &Group, s: &Session) -> Row {
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
    let unavailable = target.is_none().then(|| "Unavailable".to_owned());
    let mut r = row(s.name.clone(), None, 0, target);
    r.kind = Kind::Heading;
    r.favicon = s.favicon.clone();
    r.aside = match (fleet.groups.len() > 1, unavailable) {
        (true, Some(why)) => Some(format!("{} · {why}", g.label)),
        (true, None) => Some(g.label.clone()),
        (false, why) => why,
    };
    r.selected = s.active;
    r.favorite = Some((s.favorite_action.clone(), s.favorite));
    r
}
/// Whether fleet session `s` is the session open in the workspace.
fn open(state: &browser::State, s: &Session) -> bool {
    s.active
        && state.surface == browser::Surface::Workspace
        && s.session_id.is_some()
        && s.session_id == state.selected_session
}
/// Sessions grouped by project (#746): each session is a heading, and the open
/// one lists its panes. Machines, servers and their actions stay on Home.
pub(super) fn rows(state: &browser::State, fleet: &Fleet) -> Vec<Row> {
    let mut out = Vec::new();
    for g in &fleet.groups {
        if g.conflict || g.state != Phase::Ready {
            let mut machine = row(g.label.clone(), None, 0, None);
            machine.kind = Kind::Heading;
            machine.aside = Some(if g.conflict {
                "Identity conflict".into()
            } else {
                g.state.label().into()
            });
            machine.machine = Some(g.id.clone());
            out.push(machine);
        }
        let mut sessions: Vec<_> = g.sessions.iter().collect();
        sessions.sort_by(|a, b| {
            b.favorite
                .cmp(&a.favorite)
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.id.cmp(&b.id))
        });
        for s in sessions {
            out.push(session_row(fleet, g, s));
            if open(state, s) {
                out.extend(panes::rows(state, 0));
            }
        }
        let offline = g
            .servers
            .iter()
            .filter(|server| server.state == ServerPhase::Offline)
            .count();
        if offline > 0 {
            out.push(row(
                format!(
                    "{} offline",
                    crate::plural::count(offline as u64, "server", "servers")
                ),
                None,
                0,
                None,
            ));
        }
        if g.omitted_sessions > 0 || g.omitted_servers > 0 {
            out.push(row(
                format!(
                    "{} · {} omitted",
                    crate::plural::count(g.omitted_sessions, "session", "sessions"),
                    crate::plural::count(g.omitted_servers, "server", "servers")
                ),
                None,
                0,
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
        for s in orphan {
            let open = active.is_empty() && state.selected_session.as_ref() == Some(&s.id);
            out.push(Row {
                label: s.label.clone(),
                selected: open,
                target: Some(Target::Session(s.id.clone())),
                kind: Kind::Heading,
                ..Row::default()
            });
            if open && state.surface == browser::Surface::Workspace {
                out.extend(panes::rows(state, 0));
            }
        }
    }
    if fleet.omitted_groups > 0 {
        out.push(row(
            format!(
                "{} omitted",
                crate::plural::count(fleet.omitted_groups, "machine", "machines")
            ),
            None,
            0,
            None,
        ));
    }
    activity::integrate(state, out)
}
