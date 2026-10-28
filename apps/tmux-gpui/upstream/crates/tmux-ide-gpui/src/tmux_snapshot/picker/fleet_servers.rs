use super::{Row, Target, browser};
pub(super) fn rows(state: &browser::State, query: &str) -> Vec<Row> {
    state.fleet.as_ref().map_or_else(Vec::new, |fleet| {
        fleet
            .groups
            .iter()
            .flat_map(|group| {
                group.servers.iter().map(move |server| Row {
                    target: Target::FleetServer(server.selection.clone()),
                    label: format!(
                        "{} · {} · {}",
                        group.label,
                        server.label,
                        if server.selection.is_some() {
                            "Select server"
                        } else {
                            "Unavailable"
                        }
                    ),
                })
            })
            .filter(|row| {
                query
                    .split_whitespace()
                    .all(|term| row.label.to_lowercase().contains(term))
            })
            .collect()
    })
}
