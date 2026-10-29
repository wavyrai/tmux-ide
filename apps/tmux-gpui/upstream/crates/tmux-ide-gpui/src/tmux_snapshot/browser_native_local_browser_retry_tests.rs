//! Stale marks, the single retry and re-targeting of queued clicks.
use super::*;
fn failed() -> Result<CatalogResult, DaemonError> {
    Err(DaemonError::ServerChanged)
}
fn read(state: BrowserState) -> Result<CatalogResult, DaemonError> {
    Ok(CatalogResult::NativeBrowser(Some(state)))
}
/// Stands in for the real worker's reply; a fresh worker takes any follow-up submission.
fn reply(local: &mut Local, result: Result<CatalogResult, DaemonError>) {
    local.browser_controls.worker = None;
    local.browser_controls_reply(result).unwrap();
}
fn in_flight(local: &mut Local, write: Option<BrowserCommand>) {
    local.browser_controls.pending = Some(("route".into(), 1, "pane-a".into()));
    local.browser_controls.writing = write.map(|command| Write {
        basis: observed(command.revision),
        command,
        retried: false,
    });
}
fn writing(local: &Local) -> Option<(BrowserAction, u64, bool)> {
    local
        .browser_controls
        .writing
        .as_ref()
        .map(|w| (w.command.action, w.command.revision, w.retried))
}
#[test]
fn failed_reads_mark_controls_stale_then_forget_them() {
    let mut local = fixture();
    local
        .state
        .browser_controls
        .insert("pane-a".into(), observed(7));
    for _ in 1..STALE_LIMIT {
        in_flight(&mut local, None);
        reply(&mut local, failed());
        assert!(local.state.browser_controls.get("pane-a") == Some(&observed(7)));
        assert!(local.state.browser_marks.get("pane-a") == Some(&Mark::Stale));
    }
    // A good read clears the mark and the failure count.
    in_flight(&mut local, None);
    reply(&mut local, read(observed(8)));
    assert!(local.state.browser_marks.is_empty());
    for _ in 0..STALE_LIMIT {
        in_flight(&mut local, None);
        reply(&mut local, failed());
    }
    assert!(local.state.browser_controls.is_empty());
    // The daemon saying "no browser" is authoritative.
    local
        .state
        .browser_controls
        .insert("pane-a".into(), observed(9));
    in_flight(&mut local, None);
    reply(&mut local, Ok(CatalogResult::NativeBrowser(None)));
    assert!(local.state.browser_controls.is_empty());
}
#[test]
fn a_failed_click_is_retried_once_against_the_fresh_revision() {
    let mut local = fixture();
    local
        .state
        .browser_controls
        .insert("pane-a".into(), observed(7));
    in_flight(
        &mut local,
        Some(BrowserCommand::new(&observed(7), BrowserAction::Back, None)),
    );
    // The browser bumped its revision for a title change and rejected the click.
    reply(&mut local, failed());
    assert!(
        local.browser_controls.pending.is_some(),
        "a fresh read is in flight"
    );
    assert!(writing(&local).is_none());
    reply(&mut local, read(observed(8)));
    assert!(writing(&local) == Some((BrowserAction::Back, 8, true)));
    // A second rejection is reported, not retried again.
    reply(&mut local, failed());
    assert!(writing(&local).is_none());
    assert!(matches!(
        local.state.browser_marks.get("pane-a"),
        Some(Mark::Rejected(_))
    ));
    assert!(local.state.browser_controls.get("pane-a") == Some(&observed(8)));
}
#[test]
fn a_failed_click_on_a_changed_page_is_reported_not_resent() {
    let mut local = fixture();
    local
        .state
        .browser_controls
        .insert("pane-a".into(), observed(7));
    in_flight(
        &mut local,
        Some(BrowserCommand::new(&observed(7), BrowserAction::Back, None)),
    );
    reply(&mut local, failed());
    let mut navigated = observed(8);
    navigated.url = "https://example.com/elsewhere".into();
    reply(&mut local, read(navigated));
    assert!(writing(&local).is_none());
    assert!(local.browser_controls.pending.is_none());
    assert!(matches!(
        local.state.browser_marks.get("pane-a"),
        Some(Mark::Rejected(_))
    ));
}
#[test]
fn a_click_queued_behind_a_read_is_retargeted_to_the_read() {
    let mut local = fixture();
    local
        .state
        .browser_controls
        .insert("pane-a".into(), observed(7));
    in_flight(&mut local, None);
    let reload = BrowserCommand::new(&observed(7), BrowserAction::Reload, None);
    local
        .browser_controls(1, "pane-a".into(), Some(reload.clone()))
        .unwrap();
    assert!(local.browser_controls.queued.is_some());
    reply(&mut local, read(observed(8)));
    assert!(writing(&local) == Some((BrowserAction::Reload, 8, false)));
    // A click two observations old no longer has a known basis: reported.
    local.browser_controls.pending = None;
    local.browser_controls.writing = None;
    local
        .state
        .browser_controls
        .insert("pane-a".into(), observed(9));
    local
        .browser_controls
        .previous
        .insert("pane-a".into(), observed(8));
    local
        .browser_controls(1, "pane-a".into(), Some(reload))
        .unwrap();
    assert!(writing(&local).is_none());
    assert!(matches!(
        local.state.browser_marks.get("pane-a"),
        Some(Mark::Rejected(_))
    ));
}
#[test]
fn a_rejection_clears_after_a_while_or_on_the_next_click() {
    let mut local = fixture();
    local
        .state
        .browser_controls
        .insert("pane-a".into(), observed(7));
    local.reject_browser("pane-a").unwrap();
    local.browser_controls_tick().unwrap();
    assert!(local.state.browser_marks.contains_key("pane-a"));
    local.browser_controls.rejected.insert(
        "pane-a".into(),
        Instant::now().checked_sub(REJECTED_FOR).unwrap(),
    );
    local.browser_controls_tick().unwrap();
    assert!(local.state.browser_marks.is_empty());
    local.reject_browser("pane-a").unwrap();
    let back = BrowserCommand::new(&observed(7), BrowserAction::Back, None);
    local
        .browser_controls(1, "pane-a".into(), Some(back))
        .unwrap();
    assert!(local.state.browser_marks.is_empty());
    assert!(writing(&local) == Some((BrowserAction::Back, 7, false)));
}
