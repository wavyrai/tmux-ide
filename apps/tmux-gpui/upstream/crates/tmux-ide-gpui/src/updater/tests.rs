use super::*;
use anyhow::Context as _;

#[test]
fn homebrew_work_is_never_cancelled_and_a_relaunch_only_quits() -> Result<()> {
    let mut updater = Updater::default();
    for state in [
        State::Upgrading {
            detail: "==> Downloading".into(),
        },
        State::Restarting,
    ] {
        updater.state = state.clone();
        assert!(state.busy(), "{state:?} occupies the worker");
        assert!(!updater.interruptible(), "{state:?} cannot be interrupted");
        updater.cancel();
        assert_eq!(updater.state, state, "{state:?} survives a cancel request");
        assert!(!updater.cancelled.load(Ordering::Acquire));
    }
    updater.state = State::Downloading {
        received: 0,
        total: 0,
    };
    assert!(updater.interruptible(), "a download still cancels");

    // Homebrew leaves no staged helper to hand over to, so the committed
    // restart is just a quit, and only ever requested once.
    assert!(!updater.commit_restart()?);
    updater.relaunched = true;
    assert!(updater.commit_restart()?);
    assert!(!updater.commit_restart()?);
    Ok(())
}

#[test]
fn only_a_waiting_release_marks_an_update_available() {
    let mut updater = Updater::default();
    for state in [
        State::Disabled(String::new()),
        State::Idle,
        State::Checking,
        State::Current,
        State::Downloading {
            received: 1,
            total: 2,
        },
        State::Installing,
        State::Upgrading {
            detail: String::new(),
        },
        State::Restarting,
        State::Cancelling,
        State::Error(String::new()),
    ] {
        updater.state = state.clone();
        assert!(!updater.update_available(), "{state:?} is not an update");
    }
    for state in [
        State::Available {
            version: "20260920.2".into(),
        },
        State::Ready {
            version: "20260920.2".into(),
        },
        State::Homebrew {
            version: "20260920.2".into(),
        },
        State::Restart {
            version: "20260920.2".into(),
        },
    ] {
        updater.state = state.clone();
        assert!(updater.update_available(), "{state:?} is an update");
    }
}

#[test]
fn scheduled_checks_run_hourly() {
    assert_eq!(CHECK_INTERVAL, Duration::from_secs(60 * 60));
    let updater = Updater::default();
    assert!(updater.next_check > Instant::now());
    assert!(updater.next_check <= Instant::now() + CHECK_INTERVAL);
}

#[test]
fn disabled_and_preview_services_never_queue_work() -> anyhow::Result<()> {
    let mut updater = Updater::default();
    let initial = updater.state.clone();
    updater.check();
    updater.download();
    updater.install();
    updater.cancel();
    assert_eq!(updater.state, initial);
    assert!(!updater.poll());
    assert!(!updater.commit_restart()?);
    Ok(())
}

#[test]
fn single_operation_and_generation_fence_keep_old_progress_out() -> anyhow::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(2);
    let mut updater = Updater::default();
    updater.commands = Some(sender);
    updater.state = State::Idle;
    updater.check();
    updater.check();
    let command = receiver.try_recv().context("receive initial check")?;
    assert!(receiver.try_recv().is_err());
    publish(
        &updater.mailbox,
        command.generation.wrapping_sub(1),
        State::Current,
        None,
    );
    assert!(!updater.poll());
    assert_eq!(updater.state, State::Checking);
    updater.cancel();
    assert!(updater.cancelled.load(Ordering::Acquire));
    publish(
        &updater.mailbox,
        command.generation,
        State::Ready {
            version: "20260920.2".into(),
        },
        None,
    );
    assert!(
        !updater.poll(),
        "cancel fences an already-published completion"
    );
    assert_eq!(updater.state, State::Cancelling);
    let cancellation = receiver.try_recv().context("receive cancellation")?;
    assert!(matches!(cancellation.operation, Operation::Cancel));
    publish(&updater.mailbox, cancellation.generation, State::Idle, None);
    assert!(updater.poll());
    updater.check();
    assert!(!updater.cancelled.load(Ordering::Acquire));
    assert_ne!(
        receiver
            .try_recv()
            .context("receive subsequent check")?
            .generation,
        command.generation
    );
    Ok(())
}

#[test]
fn periodic_checks_cannot_reset_active_cancellation() -> anyhow::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(2);
    let mut updater = Updater::default();
    updater.commands = Some(sender);
    updater.state = State::Idle;
    updater.next_check = Instant::now();
    assert!(updater.poll());
    assert!(matches!(
        receiver
            .try_recv()
            .context("receive periodic check")?
            .operation,
        Operation::Check
    ));
    updater.cancel();
    updater.next_check = Instant::now();
    assert!(!updater.poll());
    assert!(updater.cancelled.load(Ordering::Acquire));
    assert_eq!(updater.state, State::Cancelling);
    assert!(matches!(
        receiver
            .try_recv()
            .context("receive cancellation")?
            .operation,
        Operation::Cancel
    ));
    assert!(receiver.try_recv().is_err());
    Ok(())
}
