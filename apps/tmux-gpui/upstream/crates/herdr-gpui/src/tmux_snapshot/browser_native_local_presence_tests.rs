use super::*;

#[test]
fn home_presence_acknowledges_focus_without_an_open_terminal() {
    let (mut local, events) = fixture();
    for (active, revision) in [(true, 1), (false, 2), (true, 3)] {
        local
            .command(Command::Presence { active, revision })
            .unwrap();
        let publication = events.try_iter().find_map(|event| match event {
            Incoming::Catalog(state) if state.presence_revision == revision => Some(state),
            _ => None,
        });
        assert!(
            publication.is_some(),
            "Home must acknowledge focus revision {revision}"
        );
        assert!(local.active.is_none());
    }
    local.publish().unwrap();
    assert!(matches!(events.try_recv().unwrap(), Incoming::Catalog(s) if s.presence_revision == 3));
    local
        .command(Command::Presence {
            active: false,
            revision: 1,
        })
        .unwrap();
    assert!(events.try_recv().is_err());
    assert!(local.foreground);
}
