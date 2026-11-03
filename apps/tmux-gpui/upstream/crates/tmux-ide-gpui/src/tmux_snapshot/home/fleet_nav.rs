//! Home's left list: All sessions, Favourites, then one entry per machine.
//! The entry picks what the session table shows. The choice lives in Home's
//! controls for the window's life, and falls back to All sessions when its
//! machine leaves the fleet.
use super::browser::fleet::{Fleet, Group, Session};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum View {
    #[default]
    All,
    Favourites,
    /// A machine, by its fleet group id.
    Machine(String),
}

impl View {
    /// Whether the table shows `group`'s header row.
    pub(super) fn shows_group(&self, group: &Group) -> bool {
        match self {
            Self::All => true,
            Self::Favourites => group.sessions.iter().any(|s| s.favorite),
            Self::Machine(id) => &group.id == id,
        }
    }

    /// Whether the table shows `session` under `group`. All sessions keeps the
    /// machine's collapse preference; a machine of its own shows everything.
    pub(super) fn shows_session(&self, group: &Group, session: &Session) -> bool {
        match self {
            Self::All => group.shows(session),
            Self::Favourites => session.favorite,
            Self::Machine(id) => &group.id == id,
        }
    }

    /// The selector a list entry renders under.
    pub(super) fn selector(&self, index: usize) -> String {
        match self {
            Self::All => "home-nav-all".into(),
            Self::Favourites => "home-nav-favourites".into(),
            Self::Machine(_) => format!("home-nav-machine-{}", index.saturating_sub(2)),
        }
    }
}

/// The list's entries in order.
pub(super) fn entries(fleet: Option<&Fleet>) -> Vec<View> {
    let mut entries = vec![View::All, View::Favourites];
    if let Some(fleet) = fleet {
        entries.extend(fleet.groups.iter().map(|g| View::Machine(g.id.clone())));
    }
    entries
}

/// `view`, or All sessions when its machine is gone.
pub(super) fn reconcile(view: &View, fleet: Option<&Fleet>) -> View {
    if entries(fleet).contains(view) {
        view.clone()
    } else {
        View::All
    }
}

/// The entry a navigation key moves to, or `None` for any other key.
pub(super) fn step(view: &View, fleet: Option<&Fleet>, key: &str) -> Option<View> {
    let entries = entries(fleet);
    let current = entries.iter().position(|e| e == view).unwrap_or(0);
    let last = entries.len() - 1;
    let index = match key {
        "up" | "[" => current.saturating_sub(1),
        "down" | "]" => (current + 1).min(last),
        "home" => 0,
        "end" => last,
        _ => return None,
    };
    Some(entries[index].clone())
}

/// Session count shown beside an entry.
pub(super) fn count(view: &View, fleet: Option<&Fleet>) -> usize {
    fleet.map_or(0, |fleet| {
        fleet
            .groups
            .iter()
            .filter(|g| view.shows_group(g))
            .map(|g| match view {
                // All counts every session, collapsed or not.
                View::All | View::Machine(_) => g.sessions.len(),
                View::Favourites => g.sessions.iter().filter(|s| s.favorite).count(),
            })
            .sum()
    })
}

/// A table row's identity: its machine's group id and the session's id. It
/// survives a republished fleet; indices would not.
pub(in crate::tmux_snapshot) type RowKey = (String, String);

/// The table's session rows in paint order, as (group index, session index):
/// per machine, each server's sessions, then sessions on no listed server.
/// The live session ids the table narrows to while the needs-input pill is
/// on (#705); `None` shows every row the view does.
pub(in crate::tmux_snapshot) type Only<'a> = Option<&'a std::collections::HashSet<String>>;

/// Whether the table shows `session` under `group`, for `view` and `only`.
pub(super) fn shows(view: &View, only: Only, group: &Group, session: &Session) -> bool {
    view.shows_session(group, session)
        && only.is_none_or(|only| {
            session
                .session_id
                .as_ref()
                .is_some_and(|id| only.contains(id))
        })
}

pub(super) fn table_rows(view: &View, only: Only, fleet: Option<&Fleet>) -> Vec<(usize, usize)> {
    let Some(fleet) = fleet else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for (index, group) in fleet.groups.iter().enumerate() {
        if !view.shows_group(group) {
            continue;
        }
        for server in &group.servers {
            rows.extend(group.sessions.iter().enumerate().filter_map(|(row, s)| {
                (s.server_id.as_ref() == Some(&server.id) && shows(view, only, group, s))
                    .then_some((index, row))
            }));
        }
        rows.extend(group.sessions.iter().enumerate().filter_map(|(row, s)| {
            (shows(view, only, group, s)
                && s.server_id
                    .as_ref()
                    .is_none_or(|id| !group.servers.iter().any(|server| &server.id == id)))
            .then_some((index, row))
        }));
    }
    rows
}

/// The key of the row at (group, session) in `fleet`.
pub(super) fn row_key(fleet: &Fleet, (group, row): (usize, usize)) -> RowKey {
    let group = &fleet.groups[group];
    (group.id.clone(), group.sessions[row].id.clone())
}

/// The table cursor after `key`: `cursor` if it is still shown, else the first
/// row; `None` when the table is empty or the key is not a table key.
pub(super) fn step_row(
    view: &View,
    only: Only,
    fleet: Option<&Fleet>,
    cursor: Option<&RowKey>,
    key: &str,
) -> Option<RowKey> {
    let fleet_ref = fleet?;
    let rows = table_rows(view, only, fleet);
    let keys: Vec<RowKey> = rows.iter().map(|&r| row_key(fleet_ref, r)).collect();
    let last = keys.len().checked_sub(1)?;
    let current = cursor.and_then(|c| keys.iter().position(|k| k == c));
    let index = match (key, current) {
        ("up", Some(i)) => i.saturating_sub(1),
        ("down", Some(i)) => (i + 1).min(last),
        ("home", _) => 0,
        ("end", _) => last,
        ("up" | "down" | "", None) => 0,
        ("", Some(i)) => i,
        _ => return None,
    };
    Some(keys[index].clone())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn fleet(ids: &[&str]) -> Fleet {
        let groups: Vec<serde_json::Value> = ids
            .iter()
            .map(|id| {
                serde_json::json!({
                    "id": id, "label": id, "state": "ready", "conflict": false,
                    "omittedSessions": 0,
                    "sessions": [
                        {"id": format!("{id}-a"), "name": "a", "paneCount": 1, "favorite": true},
                        {"id": format!("{id}-b"), "name": "b", "paneCount": 2}
                    ]
                })
            })
            .collect();
        serde_json::from_value(serde_json::json!({"groups": groups, "omittedGroups": 0})).unwrap()
    }

    #[test]
    fn entries_are_filters_then_machines_in_fleet_order() {
        let fleet = fleet(&["local", "spark"]);
        assert_eq!(
            entries(Some(&fleet)),
            vec![
                View::All,
                View::Favourites,
                View::Machine("local".into()),
                View::Machine("spark".into())
            ]
        );
        assert_eq!(entries(None), vec![View::All, View::Favourites]);
    }

    #[test]
    fn keys_walk_the_list_and_stop_at_its_ends() {
        let fleet = fleet(&["local", "spark"]);
        let f = Some(&fleet);
        let spark = View::Machine("spark".into());
        assert_eq!(step(&View::All, f, "down"), Some(View::Favourites));
        assert_eq!(step(&View::All, f, "]"), Some(View::Favourites));
        assert_eq!(step(&View::All, f, "up"), Some(View::All));
        assert_eq!(step(&View::All, f, "end"), Some(spark.clone()));
        assert_eq!(step(&spark, f, "down"), Some(spark.clone()));
        assert_eq!(step(&spark, f, "["), Some(View::Machine("local".into())));
        assert_eq!(step(&spark, f, "home"), Some(View::All));
        assert_eq!(step(&spark, f, "x"), None);
    }

    #[test]
    fn a_selected_machine_that_leaves_falls_back_to_all_sessions() {
        let before = fleet(&["local", "spark"]);
        let after = fleet(&["local"]);
        let spark = View::Machine("spark".into());
        assert_eq!(reconcile(&spark, Some(&before)), spark);
        assert_eq!(reconcile(&spark, Some(&after)), View::All);
        assert_eq!(reconcile(&spark, None), View::All);
        assert_eq!(reconcile(&View::Favourites, None), View::Favourites);
    }

    #[test]
    fn views_filter_groups_sessions_and_counts() {
        let fleet = fleet(&["local", "spark"]);
        let (local, spark) = (&fleet.groups[0], &fleet.groups[1]);
        let machine = View::Machine("spark".into());
        assert!(!machine.shows_group(local) && machine.shows_group(spark));
        assert!(machine.shows_session(spark, &spark.sessions[1]));
        assert!(View::Favourites.shows_session(spark, &spark.sessions[0]));
        assert!(!View::Favourites.shows_session(spark, &spark.sessions[1]));
        assert_eq!(count(&View::All, Some(&fleet)), 4);
        assert_eq!(count(&View::Favourites, Some(&fleet)), 2);
        assert_eq!(count(&machine, Some(&fleet)), 2);
    }

    #[test]
    fn the_table_cursor_walks_shown_rows_and_restarts_when_its_row_leaves() {
        let fleet = fleet(&["local", "spark"]);
        let f = Some(&fleet);
        let key = |g: &str, s: &str| (g.to_owned(), format!("{g}-{s}"));
        // All sessions: every machine's rows, in paint order.
        assert_eq!(
            table_rows(&View::All, None, f),
            vec![(0, 0), (0, 1), (1, 0), (1, 1)]
        );
        assert_eq!(
            step_row(&View::All, None, f, None, "down"),
            Some(key("local", "a"))
        );
        let c = key("local", "b");
        assert_eq!(
            step_row(&View::All, None, f, Some(&c), "down"),
            Some(key("spark", "a"))
        );
        assert_eq!(
            step_row(&View::All, None, f, Some(&c), "up"),
            Some(key("local", "a"))
        );
        assert_eq!(
            step_row(&View::All, None, f, Some(&c), "end"),
            Some(key("spark", "b"))
        );
        assert_eq!(
            step_row(&View::All, None, f, Some(&key("spark", "b")), "down"),
            Some(key("spark", "b"))
        );
        assert_eq!(step_row(&View::All, None, f, Some(&c), "x"), None);
        // A cursor its view no longer shows restarts at the first row.
        let spark = View::Machine("spark".into());
        assert_eq!(
            step_row(&spark, None, f, Some(&c), ""),
            Some(key("spark", "a"))
        );
        assert_eq!(
            step_row(&View::Favourites, None, f, Some(&key("spark", "b")), ""),
            Some(key("local", "a"))
        );
        assert_eq!(step_row(&View::All, None, None, None, "down"), None);
    }

    #[test]
    fn table_rows_follow_servers_then_loose_sessions_and_keep_the_views_filter() {
        let fleet: Fleet = serde_json::from_value(serde_json::json!({
            "omittedGroups": 0,
            "groups": [{
                "id": "spark", "label": "spark", "state": "ready", "conflict": false,
                "omittedSessions": 0,
                "servers": [
                    {"id": "b", "label": "b", "state": "online"},
                    {"id": "a", "label": "a", "state": "online"}
                ],
                "sessions": [
                    {"id": "loose", "name": "loose", "paneCount": 1, "favorite": true},
                    {"id": "on-a", "name": "on-a", "paneCount": 1, "serverId": "a"},
                    {"id": "on-b", "name": "on-b", "paneCount": 1, "serverId": "b", "favorite": true},
                    {"id": "on-gone", "name": "on-gone", "paneCount": 1, "serverId": "gone"}
                ]
            }]
        }))
        .unwrap();
        let f = Some(&fleet);
        // Server b's rows, then a's, then sessions on no listed server,
        // whether they name no server or one the fleet does not list.
        assert_eq!(
            table_rows(&View::All, None, f),
            vec![(0, 2), (0, 1), (0, 0), (0, 3)]
        );
        // Favourites drops the plain session under its server too.
        assert_eq!(table_rows(&View::Favourites, None, f), vec![(0, 2), (0, 0)]);
    }

    #[test]
    fn a_waiting_filter_narrows_the_rows_and_the_cursor() {
        // The fixture's sessions carry no live id; give two of them one.
        let mut fleet = fleet(&["local", "spark"]);
        fleet.groups[0].sessions[1].session_id = Some("live-1".into());
        fleet.groups[1].sessions[0].session_id = Some("live-2".into());
        let f = Some(&fleet);
        let only: std::collections::HashSet<String> =
            ["live-1".to_owned(), "live-2".to_owned()].into();
        assert_eq!(table_rows(&View::All, Some(&only), f), vec![(0, 1), (1, 0)]);
        assert_eq!(table_rows(&View::All, None, f).len(), 4);
        let first = step_row(&View::All, Some(&only), f, None, "");
        assert_eq!(first, Some(("local".into(), "local-b".into())));
        assert_eq!(
            step_row(&View::All, Some(&only), f, first.as_ref(), "down"),
            Some(("spark".into(), "spark-a".into()))
        );
    }
}
