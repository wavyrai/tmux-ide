use super::*;

#[test]
fn only_a_repository_s_recent_picks_count() {
    let mut history = History::default();
    for _ in 0..6 {
        history.record("herdr-gpui", "ssh:old");
    }
    for _ in 0..3 {
        history.record("herdr-gpui", "ssh:beelink");
    }
    history.record("other", "ssh:beelink");
    assert_eq!(history.picks("herdr-gpui", "ssh:beelink"), 3);
    // Eight recent picks count: three to beelink, five of the six old ones.
    assert_eq!(history.picks("herdr-gpui", "ssh:old"), 5);
    assert_eq!(history.picks("other", "ssh:beelink"), 1);
    assert_eq!(history.picks("unknown", "ssh:beelink"), 0);
}

#[test]
fn oversized_or_empty_names_are_not_recorded() {
    let mut history = History::default();
    history.record("", "local");
    history.record("repo", "");
    history.record(&"r".repeat(600), "local");
    assert_eq!(history.picks("", "local"), 0);
    assert_eq!(history.picks(&"r".repeat(600), "local"), 0);
}

#[test]
fn the_history_survives_a_restart_and_rejects_a_damaged_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dispatch-history.json");
    let mut history = History::at(Some(path.clone()));
    history.record("repo", "ssh:beelink");
    history.finish();
    let restored = History::at(Some(path.clone()));
    assert_eq!(restored.picks("repo", "ssh:beelink"), 1);
    std::fs::write(&path, br#"{"picks":[{"repo":"","endpoint":"x"}]}"#).unwrap();
    assert_eq!(History::at(Some(path)).picks("", "x"), 0);
}
