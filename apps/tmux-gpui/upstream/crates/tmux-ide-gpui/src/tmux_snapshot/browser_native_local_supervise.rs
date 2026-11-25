//! Card #878: the terminal loop and its catalog actor are restarted when the
//! loop ends while its window is open. The window keeps one `Bridge` for its
//! whole life; each restart runs a new actor and a new loop behind the same
//! mailbox and command channel. Only the window closing ends them for good.
use super::*;
use std::panic::{AssertUnwindSafe, catch_unwind};

/// The waits before each restart. A loop that ends once more after the last
/// one is given up on, and the window says so.
const BACKOFF: [Duration; 5] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
/// A run at least this long was healthy: the next end starts the waits over.
const SETTLED: Duration = Duration::from_secs(30);
/// How long a restart waits for the old actor to end.
const ACTOR_END: Duration = Duration::from_secs(2);
const PANICKED: &str = "it panicked";
/// The restart waits and what counts as a healthy run.
#[derive(Clone, Copy)]
pub(super) struct Policy {
    pub backoff: &'static [Duration],
    pub settled: Duration,
}
pub(super) const POLICY: Policy = Policy {
    backoff: &BACKOFF,
    settled: SETTLED,
};
const NOT_STARTED: &str = "its catalog could not start";

/// One catalog actor and what the terminal loop needs of it.
pub(super) struct Generation {
    pub events: mpsc::Receiver<Incoming>,
    pub output: Box<dyn FnMut(Command) -> Result<(), Error> + Send>,
    /// Disconnected once the actor has ended.
    pub done: mpsc::Receiver<()>,
}

/// Starts the loop under a supervisor. `start` gives each generation's actor:
/// `None` for the first, then what the window was last shown. `finish` runs
/// once, when the window is gone or the supervisor gives up.
pub(super) fn supervise(
    kitty: crate::tmux_snapshot::kitty_graphics::Store,
    start: impl FnMut(Option<&Seen>) -> Result<Generation, Error> + Send + 'static,
    finish: impl FnOnce() + Send + 'static,
) -> Bridge {
    supervise_with(POLICY, kitty, start, finish)
}
pub(super) fn supervise_with(
    policy: Policy,
    kitty: crate::tmux_snapshot::kitty_graphics::Store,
    mut start: impl FnMut(Option<&Seen>) -> Result<Generation, Error> + Send + 'static,
    finish: impl FnOnce() + Send + 'static,
) -> Bridge {
    let mailbox = Arc::new(MailboxSlot::default());
    let incoming = mailbox.clone();
    let (commands, receiver) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut seen = Seen::default();
        let mut restarted = false;
        let mut short = 0;
        let gave_up = loop {
            let began = Instant::now();
            let (reason, done) = match start(restarted.then_some(&seen)) {
                Ok(Generation {
                    events,
                    output,
                    done,
                }) => {
                    let run = Run {
                        kitty: kitty.clone(),
                        events,
                        commands: &receiver,
                        mailbox: &incoming,
                        hold_frames: true,
                        seen: &mut seen,
                    };
                    match catch_unwind(AssertUnwindSafe(|| run_events(run, output))) {
                        Ok(Ended { reason, mut state }) => {
                            if reason != WINDOW {
                                // Input off and the stream gone until the new loop is up.
                                state.status = reconnect::RECONNECTING.into();
                                send_state(&incoming, &state);
                            }
                            (reason, Some(done))
                        }
                        Err(_) => {
                            eprintln!("tmux-preview: terminal loop ended: {PANICKED}");
                            (PANICKED, Some(done))
                        }
                    }
                }
                Err(error) => {
                    eprintln!("tmux-preview: terminal loop not restarted: {error}");
                    (NOT_STARTED, None)
                }
            };
            if let Some(done) = done {
                // Its channels are closed: it ends on its next turn.
                let _ = done.recv_timeout(ACTOR_END);
            }
            if reason == WINDOW {
                break None;
            }
            if began.elapsed() >= policy.settled {
                short = 0;
            }
            let Some(wait) = policy.backoff.get(short) else {
                break Some(reason);
            };
            short += 1;
            eprintln!(
                "tmux-preview: restarting the terminal loop in {} ms ({short} of {})",
                wait.as_millis(),
                policy.backoff.len()
            );
            std::thread::sleep(*wait);
            restarted = true;
        };
        finish();
        if let Some(reason) = gave_up {
            eprintln!("tmux-preview: terminal loop not restarted again: {reason}");
            incoming.stop(reason);
        }
        if let Ok(mut slot) = incoming.lock() {
            *slot = Some(None);
        }
    });
    Bridge::new(mailbox, commands, true)
}
