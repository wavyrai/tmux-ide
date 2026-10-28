use super::*;

#[test]
fn output_request_waits_for_final_paint_and_records_output_kind() {
    let receipt = run("output", || {
        let request = admit(Input::Text("!".into()), &state("READY", 0));
        assert!(
            matches!(request, Input::Text(t) if t == format!("PROBE-BURST:{}\n", "a".repeat(32)))
        );
        let partial = state(&format!("PROBE-BURST:{}:16383", "a".repeat(32)), 0);
        after_paint(&partial, partial.frame.as_ref().unwrap(), 80, 1, true);
        RUNTIME.with_borrow(|r| assert!(r.as_ref().unwrap().ledger.pending()));
        let complete = state(&format!("PROBE-OUTPUT:{}", "a".repeat(32)), 0);
        after_paint(&complete, complete.frame.as_ref().unwrap(), 80, 1, true);
    });
    assert_eq!(receipt["kind"], "output");
    assert_eq!(receipt["status"], "completed");
}

#[test]
fn old_paint_cannot_complete_after_navigation_identity_changes() {
    for changed_pane in [true, false] {
        let receipt = run("output", || {
            let _ = admit(Input::Text("!".into()), &state("READY", 0));
            let mut stale = state(&format!("PROBE-OUTPUT:{}", "a".repeat(32)), 0);
            if changed_pane {
                stale.selected_pane = Some("%2".into());
            } else {
                stale.request += 1;
            }
            after_paint(&stale, stale.frame.as_ref().unwrap(), 80, 1, true);
        });
        assert_eq!(receipt["status"], "failed");
        assert_eq!(receipt["reason"], "scope-changed");
    }
}

#[test]
fn inconsistent_selection_is_not_a_valid_probe_scope() {
    for changed_pane in [true, false] {
        let mut stale = state("READY", 0);
        if changed_pane {
            stale.selected_pane = Some("%2".into());
        } else {
            stale.request += 1;
        }
        assert!(scope(&stale).is_none());
    }
}
