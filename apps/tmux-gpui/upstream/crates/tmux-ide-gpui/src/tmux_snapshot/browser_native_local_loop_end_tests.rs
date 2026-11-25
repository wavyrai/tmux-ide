#![allow(clippy::unwrap_used)]
//! Card #878: the terminal loop is restarted when it ends while its window is
//! open. The first four tests end the real loop (`run_events`, under the
//! supervisor `start_source` uses) through each exit that remained on main
//! 542eb82ef, with a window built from the window tests' fixture. On main each
//! left the window with dead terminals ("Connection lost. Reopen Tmux IDE to
//! reconnect.") until the app was restarted.
use super::supervise::{Generation, POLICY, Policy, supervise_with};
use super::*;
use crate::tmux_snapshot::{SnapshotView, browser_ui::Selection, fit_test_support::fixture_view};
use gpui::{Entity, TestAppContext, VisualTestContext};
use herdr_client::tmux_handoff::{Event, Handoff};
use serde_json::json;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const WAIT: Duration = Duration::from_secs(5);
const LOST: &str = "Connection lost. Reopen Tmux IDE to reconnect.";
const QUICK: Policy = Policy {
    backoff: &[
        Duration::from_millis(40),
        Duration::from_millis(80),
        Duration::from_millis(160),
    ],
    settled: Duration::from_secs(60),
};

/// One scripted catalog actor, as the test holds it.
struct Catalog {
    events: mpsc::SyncSender<Incoming>,
    /// Every command the loop passed to this catalog.
    out: mpsc::Receiver<Command>,
    /// Ends the actor (dropped).
    finished: mpsc::Sender<()>,
    /// What the supervisor started it with.
    seen: Option<Seen>,
    started: Instant,
}
/// How the next catalog's command sink behaves.
type Sink = Box<dyn FnMut(&Command) -> Result<(), Error> + Send>;
struct Supervised {
    bridge: Bridge,
    catalogs: mpsc::Receiver<Catalog>,
    finished: Arc<AtomicUsize>,
}
/// The supervisor with scripted catalogs. `sinks` gives each catalog's
/// command sink in turn, wrapped so the test also sees what it is sent;
/// after the last one, catalogs take every command.
fn supervised(policy: Policy, mut sinks: Vec<Sink>) -> Supervised {
    sinks.reverse();
    let (started, catalogs) = mpsc::channel();
    let finished = Arc::new(AtomicUsize::new(0));
    let counted = finished.clone();
    let bridge = supervise_with(
        policy,
        Default::default(),
        move |seen: Option<&Seen>| {
            let (events, receiver) = mpsc::sync_channel(8);
            let (forward, out) = mpsc::channel();
            let (finished, done) = mpsc::channel();
            let mut sink = sinks.pop().unwrap_or_else(|| Box::new(|_| Ok(())));
            started
                .send(Catalog {
                    events,
                    out,
                    finished,
                    seen: seen.cloned(),
                    started: Instant::now(),
                })
                .unwrap();
            Ok(Generation {
                events: receiver,
                output: Box::new(move |command: Command| {
                    let result = sink(&command);
                    let _ = forward.send(command);
                    result
                }),
                done,
            })
        },
        move || {
            counted.fetch_add(1, Ordering::SeqCst);
        },
    );
    Supervised {
        bridge,
        catalogs,
        finished,
    }
}
impl Supervised {
    fn next_catalog(&self) -> Catalog {
        match self.catalogs.recv_timeout(WAIT) {
            Ok(catalog) => catalog,
            Err(_) => panic!("no catalog was started"),
        }
    }
}
/// What the window shows at request 7: session-a, on pane-a.
fn shown() -> State {
    State {
        request: 7,
        surface: Surface::Workspace,
        sessions: vec![pane("session-a")],
        panes: vec![pane("pane-a"), pane("pane-b")],
        selected_session: Some("session-a".into()),
        selected_pane: Some("pane-a".into()),
        status: "Terminal ready".into(),
        ..State::default()
    }
}
fn pane(id: &str) -> Choice {
    Choice {
        id: id.into(),
        label: "Pane".into(),
        pane_count: None,
        window_id: Some("window-a".into()),
        browser_icon: None,
        display_name_source: None,
        window_label: None,
        largest_window: None,
    }
}
/// The window as it is with a terminal open at request 7.
fn window(
    cx: &mut TestAppContext,
    sender: mpsc::SyncSender<Command>,
) -> (Entity<SnapshotView>, &mut VisualTestContext) {
    cx.add_window_view(|window, cx| {
        let mut state = shown();
        state.input_ready = true;
        fixture_view(window, cx, sender, 7, state)
    })
}
/// The next publication the window takes; `None` when the loop ended for good.
fn publication(mailbox: &Mailbox) -> Option<State> {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if let Some(next) = mailbox.lock().unwrap().take() {
            return next;
        }
        thread::sleep(Duration::from_millis(2));
    }
    panic!("nothing was published");
}
/// Publications until one matches; panics when the loop ends for good.
fn until(mailbox: &Mailbox, what: &str, wanted: impl Fn(&State) -> bool) -> State {
    loop {
        let state = publication(mailbox).unwrap_or_else(|| panic!("the loop ended before: {what}"));
        if wanted(&state) {
            return state;
        }
    }
}
fn apply(view: &Entity<SnapshotView>, cx: &mut VisualTestContext, state: State) {
    cx.update(|_, cx| view.update(cx, |view, cx| view.apply_browser_state(Some(state), cx)));
}
/// The first catalog shows the window's session; returns it.
fn first_catalog(supervised: &Supervised) -> Catalog {
    let catalog = supervised.next_catalog();
    assert!(catalog.seen.is_none(), "the first catalog is not resumed");
    catalog
        .events
        .send(Incoming::Catalog(Box::new(shown())))
        .unwrap();
    until(
        &supervised.bridge.mailbox,
        "the catalog is shown",
        |state| state.request == 7,
    );
    catalog
}
/// After the loop ended: the window is told it is reconnecting, a new
/// catalog starts where the window was, the window takes the new loop's
/// publications, and its next selection reaches the new catalog.
fn restarted(
    view: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    supervised: &Supervised,
    presence: (bool, u64),
) {
    let mailbox = &supervised.bridge.mailbox;
    let reconnecting = until(mailbox, "the window is told", |state| {
        state.status == reconnect::RECONNECTING
    });
    assert_eq!(reconnecting.request, 7);
    assert!(!reconnecting.input_ready);
    assert!(reconnecting.frame.is_none());
    apply(view, cx, reconnecting);
    let next = supervised.next_catalog();
    assert_eq!(
        next.seen,
        Some(Seen {
            request: 7,
            presence,
            session: Some("session-a".into()),
            pane: Some("pane-a".into()),
        })
    );
    let mut ready = shown();
    ready.status = "Terminal ready again".into();
    next.events
        .send(Incoming::Catalog(Box::new(ready)))
        .unwrap();
    let again = until(mailbox, "the new loop publishes", |state| {
        state.status == "Terminal ready again"
    });
    apply(view, cx, again);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert!(
                view.browser_commands.is_some(),
                "the window dropped its sender"
            );
            assert_eq!(view.browser_state.status, "Terminal ready again");
            assert_eq!(view.browser_state.request, 7);
            view.select(Selection::Pane("pane-b".into()), window, cx);
        });
    });
    let deadline = Instant::now() + WAIT;
    loop {
        match next.out.recv_timeout(Duration::from_millis(20)) {
            Ok(Command::Pane { request: 8, id }) if id == "pane-b" => break,
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("the new loop ended"),
        }
        assert!(Instant::now() < deadline, "the selection never reached it");
    }
    assert_eq!(supervised.finished.load(Ordering::SeqCst), 0);
    drop(next.finished);
}

/// Exit `REFUSED`: the catalog takes no command for 2 s (its queue of 32 is
/// full and it drains nothing), so `watch::Commands::send` fails.
#[gpui::test]
fn a_catalog_that_stalls_for_two_seconds_is_restarted(cx: &mut TestAppContext) {
    let (sender, stuck) = mpsc::sync_channel(1);
    sender.try_send(Command::Refresh { request: 0 }).unwrap();
    let commands = watch::Commands::new(sender, thread::current());
    let stalled: Sink = Box::new(move |_| commands.send(Command::Refresh { request: 0 }));
    let supervised = supervised(QUICK, vec![stalled]);
    let first = first_catalog(&supervised);
    // The window's first focus change goes to the catalog, which never takes it.
    let (view, cx) = window(cx, supervised.bridge.commands.clone());
    // The window told the loop its focus (revision 1) when it opened.
    restarted(&view, cx, &supervised, (true, 1));
    drop((first, stuck));
}

/// Exit `CLOSED`: the catalog actor ended (it returned or unwound), which
/// drops its event sender.
#[gpui::test]
fn a_catalog_that_goes_away_is_restarted(cx: &mut TestAppContext) {
    let supervised = supervised(QUICK, Vec::new());
    let first = first_catalog(&supervised);
    let (view, cx) = window(cx, supervised.bridge.commands.clone());
    // The window leaves; the catalog hears of it before it goes.
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.presence.set_active(false);
            view.presence.flush(view.browser_commands.as_ref().unwrap());
        })
    });
    let deadline = Instant::now() + WAIT;
    while !matches!(
        first.out.recv_timeout(Duration::from_millis(20)),
        Ok(Command::Presence { active: false, .. })
    ) {
        assert!(Instant::now() < deadline, "the focus change never arrived");
    }
    let Catalog {
        events, finished, ..
    } = first;
    let actor = thread::spawn(move || {
        let _held = (events, finished);
        panic!("a fault in the catalog actor");
    });
    assert!(actor.join().is_err());
    restarted(&view, cx, &supervised, (false, 2));
}

fn capability() -> Box<Handoff> {
    let now = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    Box::new(Handoff::parse(&serde_json::to_vec(&json!({"descriptor":{"protocolVersion":2,"webSocketUrl":"ws://127.0.0.1:9/v2/terminal/pane-streams/redeem","subprotocol":herdr_client::tmux_stream::SUBPROTOCOL,"redemptionTicket":format!("ps2_{}","a".repeat(43)),"daemonInstanceId":"e01ce8ee-74d8-40d0-9a59-a096050a6ade","requestId":"b987f903-e864-43dd-8591-8d0a464ca6e8","expiresAt":now + 60_000,"panes":["pane-a"],"effectiveViewerMode":"interactive"},"origin":"http://127.0.0.1:4000","hostClientId":"native.test","workspaceName":"workspace","selectedPane":"pane-a"})).unwrap()).unwrap())
}

/// Exit `STALE`: an open older than the catalog's request.
#[gpui::test]
fn an_open_older_than_its_catalog_is_restarted(cx: &mut TestAppContext) {
    let supervised = supervised(QUICK, Vec::new());
    let first = first_catalog(&supervised);
    let (view, cx) = window(cx, supervised.bridge.commands.clone());
    first
        .events
        .send(Incoming::Handoff(Event::Open {
            version: 1,
            id: "b987f903-e864-43dd-8591-8d0a464ca6e8".into(),
            request: 6,
            live_session_id: "session-a".into(),
            capability: capability(),
        }))
        .unwrap();
    // The window told the loop its focus (revision 1) when it opened.
    restarted(&view, cx, &supervised, (true, 1));
    drop(first);
}

/// Was exit `WINDOW` with the window open: while the loop waits on its
/// catalog (under the 2 s limit), the window's queue of 32 fills, and a
/// selection that cannot be queued dropped the window's only sender. Now the
/// window keeps its sender and the loop runs on.
#[gpui::test]
fn a_full_window_queue_keeps_the_sender_and_the_loop(cx: &mut TestAppContext) {
    let (gate, opened) = mpsc::channel::<()>();
    let mut held = true;
    let waiting: Sink = Box::new(move |_| {
        if std::mem::take(&mut held) {
            let _ = opened.recv_timeout(WAIT);
        }
        Ok(())
    });
    let supervised = supervised(QUICK, vec![waiting]);
    let first = first_catalog(&supervised);
    let (view, cx) = window(cx, supervised.bridge.commands);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let sender = view.browser_commands.clone().unwrap();
            thread::sleep(Duration::from_millis(100));
            let mut sent = 0;
            while sender.try_send(Command::Refresh { request: 0 }).is_ok() {
                sent += 1;
                assert!(sent <= 64, "the loop is not held");
            }
            drop(sender);
            view.select(Selection::Pane("pane-b".into()), window, cx);
            assert!(
                view.browser_commands.is_some(),
                "the window dropped its sender"
            );
            assert_ne!(view.browser_state.status, LOST);
            assert_eq!(view.browser_request, 7, "an unsent selection moved on");
        });
    });
    drop(gate);
    // Once the loop has drained the queue, the same selection goes through.
    let deadline = Instant::now() + WAIT;
    'sent: loop {
        let request = cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.select(Selection::Pane("pane-b".into()), window, cx);
                view.browser_request
            })
        });
        while let Ok(command) = first.out.recv_timeout(Duration::from_millis(50)) {
            if matches!(command, Command::Pane { request: 8, ref id } if id == "pane-b") {
                break 'sent;
            }
        }
        assert_eq!(request, 7, "a selection was sent and lost");
        assert!(Instant::now() < deadline, "the selection never reached it");
    }
    assert!(
        supervised
            .catalogs
            .recv_timeout(Duration::from_millis(200))
            .is_err(),
        "the loop was restarted"
    );
}

/// A loop that keeps ending is restarted after each wait of the backoff, in
/// order, and then given up on: the window gets the existing message with the
/// reason.
#[gpui::test]
fn a_loop_that_keeps_ending_backs_off_and_then_gives_up(cx: &mut TestAppContext) {
    let supervised = supervised(QUICK, Vec::new());
    let mut starts = Vec::new();
    for _ in 0..=QUICK.backoff.len() {
        let catalog = supervised.next_catalog();
        starts.push(catalog.started);
        drop(catalog);
    }
    for (pair, wait) in starts.windows(2).zip(QUICK.backoff) {
        assert!(pair[1] - pair[0] >= *wait, "restarted before {wait:?}");
    }
    let mailbox = supervised.bridge.mailbox.clone();
    loop {
        if publication(&mailbox).is_none() {
            break;
        }
    }
    assert_eq!(mailbox.stopped(), Some(CLOSED));
    assert_eq!(supervised.finished.load(Ordering::SeqCst), 1);
    assert!(
        supervised
            .catalogs
            .recv_timeout(Duration::from_millis(300))
            .is_err(),
        "restarted after giving up"
    );
    let (view, cx) = window(cx, supervised.bridge.commands);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.apply_browser_state(None, cx);
            view.connection_stopped(mailbox.stopped());
            assert_eq!(
                view.browser_state.status,
                format!("{LOST} The terminal stopped: its catalog closed.")
            );
            assert!(view.browser_commands.is_none());
        })
    });
}

/// A run that stayed up for the healthy time starts the waits over.
#[test]
fn a_run_that_settled_starts_the_waits_over() {
    const ONCE: Policy = Policy {
        backoff: &[Duration::from_millis(30)],
        settled: Duration::from_millis(300),
    };
    let supervised = supervised(ONCE, Vec::new());
    drop(supervised.next_catalog());
    // Restarted once; this run is healthy, so it may be restarted again.
    let second = supervised.next_catalog();
    thread::sleep(Duration::from_millis(400));
    drop(second);
    // A short run now: the one wait is used up, and the loop is given up on.
    drop(supervised.next_catalog());
    let mailbox = &supervised.bridge.mailbox;
    while publication(mailbox).is_some() {}
    assert_eq!(mailbox.stopped(), Some(CLOSED));
}

/// The waits and the healthy time the app uses.
#[test]
fn the_app_backs_off_from_250_ms_to_4_s_and_settles_after_30_s() {
    let backoff: Vec<u128> = POLICY.backoff.iter().map(Duration::as_millis).collect();
    assert_eq!(backoff, [250, 500, 1000, 2000, 4000]);
    assert_eq!(POLICY.settled, Duration::from_secs(30));
}

/// Closing the window ends the loop and its catalog, with no restart.
#[test]
fn closing_the_window_ends_everything_without_a_restart() {
    let supervised = supervised(QUICK, Vec::new());
    let first = first_catalog(&supervised);
    let Supervised {
        bridge,
        catalogs,
        finished,
    } = supervised;
    let Bridge {
        mailbox, commands, ..
    } = bridge;
    drop(commands);
    assert!(publication(&mailbox).is_none());
    assert_eq!(mailbox.stopped(), None);
    assert_eq!(finished.load(Ordering::SeqCst), 1);
    assert!(
        catalogs.recv_timeout(Duration::from_millis(300)).is_err(),
        "a catalog was started after the window closed"
    );
    // The catalog's command sink went with the loop: the actor ends.
    assert!(matches!(
        first.out.recv_timeout(WAIT),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}

/// A panic inside the loop is an exit the supervisor restarts.
#[test]
fn a_panic_in_the_loop_is_restarted() {
    let panicking: Sink = Box::new(|command| {
        if matches!(command, Command::Refresh { request: 66 }) {
            panic!("a fault in the terminal loop");
        }
        Ok(())
    });
    let supervised = supervised(QUICK, vec![panicking]);
    let first = first_catalog(&supervised);
    // The window leaves, and the catalog publishes once more: what the run
    // saw is kept as it goes, since a panic returns nothing.
    supervised
        .bridge
        .commands
        .send(Command::Presence {
            active: false,
            revision: 5,
        })
        .unwrap();
    let mut later = shown();
    later.status = "Later".into();
    first
        .events
        .send(Incoming::Catalog(Box::new(later)))
        .unwrap();
    until(&supervised.bridge.mailbox, "the later state", |state| {
        state.status == "Later"
    });
    supervised
        .bridge
        .commands
        .send(Command::Refresh { request: 66 })
        .unwrap();
    let next = supervised.next_catalog();
    let seen = next.seen.unwrap();
    assert_eq!((seen.request, seen.presence), (7, (false, 5)));
}

/// The focus a window gave one run carries over more than one restart.
#[test]
fn the_focus_carries_over_more_than_one_restart() {
    let supervised = supervised(QUICK, Vec::new());
    let first = first_catalog(&supervised);
    supervised
        .bridge
        .commands
        .send(Command::Presence {
            active: false,
            revision: 4,
        })
        .unwrap();
    let deadline = Instant::now() + WAIT;
    while !matches!(
        first.out.recv_timeout(Duration::from_millis(20)),
        Ok(Command::Presence { active: false, .. })
    ) {
        assert!(Instant::now() < deadline, "the focus change never arrived");
    }
    drop(first);
    let second = supervised.next_catalog();
    assert_eq!(
        second.seen.as_ref().map(|seen| seen.presence),
        Some((false, 4))
    );
    second
        .events
        .send(Incoming::Catalog(Box::new(shown())))
        .unwrap();
    until(
        &supervised.bridge.mailbox,
        "the second run publishes",
        |state| state.status == "Terminal ready",
    );
    drop(second);
    let third = supervised.next_catalog();
    assert_eq!(third.seen.map(|seen| seen.presence), Some((false, 4)));
}

/// The app's own generation: a real catalog actor starts where the window
/// was, and ends with its channels without shutting the owner down.
#[test]
fn a_new_generation_starts_where_the_window_was() {
    let record = PathBuf::from("/nonexistent-native-catalog-test/daemon.json");
    let owner = NativeOwner::new(CatalogSource::Local(record.clone()));
    let seen = Seen {
        request: 7,
        presence: (false, 3),
        session: Some("live-session.aaaaaaaaaaaaaaaaaaaa".into()),
        pane: Some("%2".into()),
    };
    let Generation {
        events,
        output,
        done,
    } = generation(
        &owner,
        CatalogSource::Local(record.clone()),
        Some(record),
        "local".into(),
        "Local".into(),
        Some(&seen),
    )
    .unwrap();
    let Ok(Incoming::Catalog(state)) = events.recv_timeout(WAIT) else {
        panic!("the catalog published nothing");
    };
    assert_eq!(state.request, 7);
    assert_eq!(state.presence_revision, 3);
    assert_eq!(state.surface, Surface::Workspace);
    assert_eq!(state.selected_session, seen.session);
    assert_eq!(state.status, reconnect::RECONNECTING);
    assert!(
        matches!(done.try_recv(), Err(mpsc::TryRecvError::Empty)),
        "the actor is still running"
    );
    drop((events, output));
    assert!(matches!(
        done.recv_timeout(WAIT),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
    assert!(
        owner.observation_source().is_ok(),
        "the actor shut the owner"
    );
}
