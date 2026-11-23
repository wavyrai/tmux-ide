#![allow(clippy::unwrap_used)]
//! Card #871: which streams a focus change is sent to. What the loop does
//! when the stream cannot take it is in `browser_native_worker_exit_tests.rs`.
use super::*;

/// Card #871: a stream that is already being re-issued, or that an owner
/// action retired, is not told about focus: its replacement is opened with the
/// window's focus as it is then.
#[test]
fn a_stream_being_replaced_is_not_told_about_focus() {
    for interrupted in [false, true] {
        let (mut active, _state, observed, peer) = super::super::selection_tests::fixture(true);
        while observed.try_recv().is_ok() {}
        active.reissue = !interrupted;
        active.stream_interrupted = interrupted;
        presence(&mut active, false, 2, 1);
        active.reissue = false;
        active.stream_interrupted = false;
        // The stream is still open, and takes the next change.
        presence(&mut active, false, 3, 2);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut told = Vec::new();
        while told.is_empty() {
            assert!(std::time::Instant::now() < deadline, "no focus change sent");
            told.extend(
                observed
                    .try_iter()
                    .filter(|value| value["type"] == "presence"),
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        told.extend(
            observed
                .try_iter()
                .filter(|value| value["type"] == "presence"),
        );
        assert_eq!(told.len(), 1, "interrupted: {interrupted}: {told:?}");
        active.controller.retire();
        peer.join().unwrap();
    }
}
