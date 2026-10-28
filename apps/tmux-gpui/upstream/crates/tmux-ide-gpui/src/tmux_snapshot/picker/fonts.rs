//! Uses the existing searchable native picker, with no daemon commands.
use super::{Row, Target};
use crate::tmux_snapshot::terminal_font::{Choice, Settings};
pub(super) fn rows(settings: &Settings, query: &str) -> Vec<Row> {
    let query = query.to_lowercase();
    let mut rows = vec![
        Row {
            target: Target::Font(Choice::Size(1)),
            label: "Increase terminal size (+1)".into(),
        },
        Row {
            target: Target::Font(Choice::Size(-1)),
            label: "Decrease terminal size (−1)".into(),
        },
    ];
    rows.retain(|row| matches(&row.label, &query));
    rows.extend(
        settings
            .names
            .iter()
            .filter(|name| matches(name, &query))
            .take(256 - rows.len())
            .map(|name| Row {
                target: Target::Font(Choice::Family(name.clone())),
                label: name.clone(),
            }),
    );
    rows
}
fn matches(label: &str, query: &str) -> bool {
    let label = label.to_lowercase();
    query.split_whitespace().all(|term| label.contains(term))
}
