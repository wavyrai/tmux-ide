use super::{Identity, Reveal};

#[test]
fn interrupted_measurement_retry_does_not_block_later_selection() {
    let first = Identity::Session("first".into());
    let next = Identity::Session("next".into());
    let mut reveal = Reveal::default();
    assert!(reveal.prepare(&first, true, false));
    // One retry has been requested while the list has no measured bounds.
    reveal.retry_scheduled = true;
    assert!(reveal.prepare(&first, false, false));
    assert!(
        reveal.retry_scheduled,
        "unchanged unmeasured state must not request an animation loop"
    );
    assert!(!reveal.prepare(&first, false, true));
    assert!(
        !reveal.retry_scheduled,
        "keyboard ownership retires the abandoned retry"
    );
    assert!(reveal.prepare(&next, true, false));
    assert!(
        !reveal.retry_scheduled,
        "new selection gets its own one-shot retry"
    );
    reveal.retry_scheduled = true;
    assert!(reveal.prepare(&Identity::Session("third".into()), false, false));
    assert!(
        !reveal.retry_scheduled,
        "changed identity resets budget even with unchanged topology"
    );
}
