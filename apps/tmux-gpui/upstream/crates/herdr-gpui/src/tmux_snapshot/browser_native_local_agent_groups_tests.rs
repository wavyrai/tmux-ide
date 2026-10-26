#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn grouping_uses_machine_server_generation_source_and_id_never_labels() {
    let mut gate = super::super::super::tests::ready();
    let row = gate.publication().rows.remove(0);
    let mut rows = Vec::new();
    let mut memberships = BTreeMap::new();
    let team = |generation: &str, source: u8| {
        Some(("server".into(), generation.into(), source, "team-id".into()))
    };
    for (index, (machine, team)) in [
        ("one", None),
        ("two", team("a", 0)),
        ("one", team("a", 0)),
        ("one", team("b", 0)),
        ("one", team("a", 1)),
        ("one", team("a", 0)),
        ("two", None),
        ("two", team("a", 0)),
    ]
    .into_iter()
    .enumerate()
    {
        let mut row = row.clone();
        row.key = index.to_string();
        row.machine_label = Some("Same label".into());
        row.team_name = Some("Same name".into());
        memberships.insert(row.key.clone(), (machine.into(), team));
        rows.push(row);
    }
    let grouped = grouped(rows, &memberships);
    assert_eq!(
        grouped.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
        ["2", "5", "3", "4", "0", "1", "7", "6"]
    );
}
