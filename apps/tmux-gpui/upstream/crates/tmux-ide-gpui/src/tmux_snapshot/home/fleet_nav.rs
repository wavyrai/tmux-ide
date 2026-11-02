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

#[cfg(test)]
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
}
