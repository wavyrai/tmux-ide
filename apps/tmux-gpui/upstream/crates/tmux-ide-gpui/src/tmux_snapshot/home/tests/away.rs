//! r4: a remote machine that stops answering is retried until the user
//! disconnects it. It reads as before for 8 s, then "Reconnecting…", then
//! "Unreachable since…"; its last known rows stay, muted and tagged "away";
//! needs-input stays at full strength, and this Mac is untouched.
use super::*;
use crate::tmux_snapshot::connection::{Away, Clock, away};
use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant, SystemTime},
};

#[test]
fn an_away_machine_reads_on_the_owner_approved_steps() {
    let since = SystemTime::UNIX_EPOCH;
    assert_eq!(away(Duration::from_millis(7_999), since), Away::Quiet);
    assert_eq!(away(Duration::from_secs(8), since), Away::Reconnecting);
    assert!(matches!(
        away(Duration::from_secs(60), since),
        Away::Unreachable(_)
    ));
    assert!(
        away(Duration::from_secs(61), since)
            .label()
            .ends_with("· trying again every minute")
    );
    assert_eq!(Away::Reconnecting.label(), "Reconnecting…");
}

fn fleet_with_spark_away(at: Instant) -> browser::fleet::Fleet {
    let mut fleet: browser::fleet::Fleet = serde_json::from_value(serde_json::json!({
        "groups": [
            {"id": "local", "label": "local", "state": "ready", "conflict": false,
             "omittedSessions": 0, "sessions": [
                {"id": "local-web", "name": "web", "paneCount": 1, "sessionId": "live-local-web"}]},
            {"id": "spark", "label": "spark", "state": "disconnected", "conflict": false,
             "omittedSessions": 0, "retry": "22222222-2222-4222-8222-222222222222",
             "disconnect": "33333333-3333-4333-8333-333333333333", "sessions": [
                {"id": "spark-api", "name": "api", "paneCount": 2, "sessionId": "live-spark-api"}]}
        ],
        "omittedGroups": 0,
        "preferences": {"revision": 1, "phase": "ready", "error": null}
    }))
    .unwrap();
    fleet.groups[1].away = Some((at, SystemTime::UNIX_EPOCH + Duration::from_secs(36_120)));
    fleet
}

fn clock(start: Instant) -> (Clock, Rc<Cell<Duration>>) {
    let offset = Rc::new(Cell::new(Duration::ZERO));
    let read = offset.clone();
    (
        Rc::new(move || (start + read.get(), SystemTime::now())),
        offset,
    )
}

#[gpui::test]
fn the_header_steps_and_the_rows_stay_muted_and_tagged(cx: &mut TestAppContext) {
    let start = Instant::now();
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(fleet_with_spark_away(start));
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    let (clock, at) = clock(start);
    view.update(cx, |view, _| view.connection.clock = clock);
    cx.simulate_resize(size(px(1200.), px(900.)));
    let status = |cx: &mut VisualTestContext| {
        view.read_with(cx, |view, _| {
            let fleet = view.browser_state.fleet.as_ref().unwrap();
            view.machine_away(&fleet.groups[1])
        })
    };
    // Under 8 s: as before; no Retry while it retries by itself.
    at.set(Duration::from_secs(3));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(status(cx), Some(Away::Quiet));
    assert!(cx.debug_bounds("fleet-retry-1").is_none());
    assert!(cx.debug_bounds("fleet-session-away-1-0").is_none());
    // 8 s: "Reconnecting…", the rows muted and tagged.
    at.set(Duration::from_secs(9));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(status(cx), Some(Away::Reconnecting));
    assert!(cx.debug_bounds("fleet-machine-status-1").is_some());
    assert!(cx.debug_bounds("fleet-session-away-1-0").is_some());
    // This Mac's rows are untouched, and the footer slot stays quiet.
    assert!(cx.debug_bounds("fleet-session-away-0-0").is_none());
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.connection_stage(),
            crate::tmux_snapshot::connection::Stage::Quiet
        );
    });
    // A minute: unreachable since, with Disconnect and no Retry.
    at.set(Duration::from_secs(61));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(matches!(status(cx), Some(Away::Unreachable(_))));
    assert!(cx.debug_bounds("fleet-disconnect-1").is_some());
    assert!(cx.debug_bounds("fleet-retry-1").is_none());
}
