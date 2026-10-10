use super::*;

#[test]
fn go_to_finds_agents_by_kind_name_and_status_and_tabs_by_label() {
    let snapshot = go_to_fixture();
    let mut entries = Vec::new();
    go_to_entries(crate::endpoint::LOCAL, None, &snapshot, &mut entries);
    let found = |query: &str| {
        search::rank(
            &entries,
            0..entries.len(),
            &search::Query::parse(query),
            &mut search::matcher(),
        )
        .first()
        .map(|hit| entries[hit.index].action.identity())
    };
    let pane = |id: &str| {
        Some(Identity::Go(
            crate::endpoint::LOCAL.into(),
            NavigationTarget::Pane(id.into()),
        ))
    };
    for query in ["claude", "reviewer", "blocked", "waiting", "agent"] {
        assert_eq!(found(query), pane("w1:p1"), "{query}");
    }
    assert_eq!(
        found("logs tab"),
        Some(Identity::Go(
            crate::endpoint::LOCAL.into(),
            NavigationTarget::Tab("w1:t2".into())
        ))
    );
}
