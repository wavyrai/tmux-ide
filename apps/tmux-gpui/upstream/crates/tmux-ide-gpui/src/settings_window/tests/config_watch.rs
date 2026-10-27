use super::*;
use persistence::{ConfigWatch, Sample};

fn state(local: u64) -> Sample {
    [Ok(local), Ok(0)]
}

/// Two equal samples make a change stable; returns the second decision.
fn settle(watch: &mut ConfigWatch, sample: Sample, revision: u64) -> bool {
    assert!(!watch.observe(sample, None, revision, false));
    watch.observe(sample, None, revision, false)
}

#[test]
fn own_save_is_not_reloaded_but_a_later_edit_is() {
    let mut watch = ConfigWatch::default();
    assert!(settle(&mut watch, state(1), 0), "first sample loads");
    assert!(
        !watch.observe(state(1), None, 1, false),
        "that reload completed"
    );
    // A save then wrote and reloaded state 2.
    assert!(!watch.observe(state(2), Some(state(2)), 2, false));
    assert!(!settle(&mut watch, state(2), 2), "the save's own write");
    assert!(settle(&mut watch, state(3), 2), "an edit after the save");
}

#[test]
fn a_save_right_after_a_watcher_reload_still_suppresses_its_echo() {
    let mut watch = ConfigWatch::default();
    assert!(settle(&mut watch, state(1), 0));
    // The watcher reload (revision 1) and a save (revision 2) both finished
    // before this tick: the older reload must not displace the save's sample.
    assert!(!watch.observe(state(2), Some(state(2)), 2, false));
    assert!(!watch.observe(state(2), None, 2, false));
    assert!(!watch.observe(state(2), None, 2, false));
}

#[test]
fn busy_window_defers_an_external_edit_without_losing_it() {
    let mut watch = ConfigWatch::default();
    assert!(settle(&mut watch, state(1), 0));
    assert!(!watch.observe(state(1), None, 1, false));
    assert!(!watch.observe(state(4), None, 1, true));
    assert!(!watch.observe(state(4), None, 1, true));
    assert!(watch.observe(state(4), None, 1, false));
}
