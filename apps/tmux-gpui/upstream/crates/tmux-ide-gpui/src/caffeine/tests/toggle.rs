use super::*;

#[gpui::test]
fn holds_then_releases_on_one_worker_thread(cx: &mut gpui::TestAppContext) {
    let (log, reports) = (Log::default(), Reports::default());
    assert_eq!(cup_of(cx), Cup::Off);

    cx.update(|cx| toggle_with(cx, holder(&log), reports.sink()));
    assert_eq!(cup_of(cx), Cup::Pending);
    cx.run_until_parked();
    assert_eq!(cup_of(cx), Cup::On);

    // The worker already exists, so this start must never run.
    cx.update(|cx| {
        toggle_with(
            cx,
            || -> keepawake::Result<Held> { unreachable!() },
            reports.sink(),
        )
    });
    assert_eq!(cup_of(cx), Cup::Pending);
    cx.run_until_parked();
    assert_eq!(cup_of(cx), Cup::Off);

    let entries = log.entries();
    let commands: Vec<_> = entries.iter().map(|(command, _)| *command).collect();
    assert_eq!(commands, [Command::Hold, Command::Release]);
    // Windows restores the execution state only on the thread that set it.
    assert_eq!(entries[0].1, entries[1].1);
    assert_ne!(entries[0].1, std::thread::current().id());
    assert!(reports.take().is_empty());
}

#[gpui::test]
fn a_failed_hold_stays_off_and_keeps_its_source(cx: &mut gpui::TestAppContext) {
    let reports = Reports::default();
    let failing = || -> keepawake::Result<Held> {
        Err(keepawake::BuilderError::ValidationError("no power".into()).into())
    };
    cx.update(|cx| toggle_with(cx, failing, reports.sink()));
    cx.run_until_parked();

    assert_eq!(cup_of(cx), Cup::Off);
    let errors = reports.take();
    let [Error::Caffeine(source)] = errors.as_slice() else {
        panic!("expected one Caffeine error, got {errors:?}");
    };
    assert!(matches!(
        source,
        keepawake::Error::Builder(keepawake::BuilderError::ValidationError(reason)) if reason == "no power"
    ));
    assert!(std::error::Error::source(&errors[0]).is_some());

    // The worker survives a failed hold; the next click tries again on it.
    cx.update(|cx| {
        toggle_with(
            cx,
            || -> keepawake::Result<Held> { unreachable!() },
            reports.sink(),
        )
    });
    cx.run_until_parked();
    assert_eq!(cup_of(cx), Cup::Off);
    assert_eq!(reports.take().len(), 1);
}

#[gpui::test]
fn clicks_while_pending_are_ignored(cx: &mut gpui::TestAppContext) {
    let (log, reports) = (Log::default(), Reports::default());
    cx.update(|cx| {
        toggle_with(cx, holder(&log), reports.sink());
        toggle_with(cx, holder(&log), reports.sink());
    });
    cx.run_until_parked();

    assert_eq!(cup_of(cx), Cup::On);
    assert_eq!(log.entries().len(), 1);

    cx.update(|cx| {
        toggle_with(cx, holder(&log), reports.sink());
        toggle_with(cx, holder(&log), reports.sink());
    });
    cx.run_until_parked();

    assert_eq!(cup_of(cx), Cup::Off);
    let commands: Vec<_> = log.entries().iter().map(|(command, _)| *command).collect();
    assert_eq!(commands, [Command::Hold, Command::Release]);
    assert!(reports.take().is_empty());
}

/// keepawake's Linux release unwraps a D-Bus reply, so a release can panic.
struct PanicsOnRelease;

impl Drop for PanicsOnRelease {
    fn drop(&mut self) {
        panic!("release failed");
    }
}

#[gpui::test]
fn a_worker_that_dies_releasing_reads_off_and_is_replaced(cx: &mut gpui::TestAppContext) {
    let (log, reports) = (Log::default(), Reports::default());
    cx.update(|cx| toggle_with(cx, || Ok(PanicsOnRelease), reports.sink()));
    cx.run_until_parked();
    assert_eq!(cup_of(cx), Cup::On);

    cx.update(|cx| toggle_with(cx, holder(&log), reports.sink()));
    cx.run_until_parked();
    assert_eq!(cup_of(cx), Cup::Off);
    assert!(matches!(
        reports.take().as_slice(),
        [Error::CaffeineWorkerStopped]
    ));

    // A fresh worker takes the next click.
    cx.update(|cx| toggle_with(cx, holder(&log), reports.sink()));
    cx.run_until_parked();
    assert_eq!(cup_of(cx), Cup::On);
    assert_eq!(log.entries().len(), 1);
    cx.update(|cx| toggle_with(cx, holder(&log), reports.sink()));
    cx.run_until_parked();
    assert!(reports.take().is_empty());
}
