use super::needs_submission;
#[test]
fn a_retired_last_canvas_is_republished_without_unbounded_replacement() {
    assert!(
        !needs_submission(true, Some(1)),
        "keep the displayed canvas"
    );
    assert!(
        needs_submission(true, Some(0)),
        "recover when resize retired all backing"
    );
    assert!(
        !needs_submission(true, Some(1)),
        "do not duplicate the recovered canvas"
    );
    assert!(
        needs_submission(false, Some(1)),
        "allow a changed canvas to replace it"
    );
    assert!(
        !needs_submission(false, Some(2)),
        "bound retained submissions"
    );
    assert!(
        !needs_submission(false, None),
        "never submit to a missing receiver"
    );
}
