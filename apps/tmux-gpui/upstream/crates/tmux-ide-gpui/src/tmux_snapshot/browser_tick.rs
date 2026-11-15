//! The UI's browser task. It flushes queued UI work and re-renders only when
//! something is due; an idle Home must cost no frames (card #703). It wakes
//! only for a reason (#714): a publication, a nudge from input, a render or
//! an image, a deadline some queued work set, or a 16 ms poll while work
//! waits for room in the command queue.
use super::{SnapshotView, browser, renderer_probe};
use gpui::{AsyncWindowContext, Context, WeakEntity};
use std::time::{Duration, Instant};

/// The poll period while queued work waits for room in the command queue.
const POLL: Duration = Duration::from_millis(16);
/// The shortest wait: even "at once" yields to the main thread first.
const MIN_WAIT: Duration = Duration::from_millis(1);
/// The poll period while images are missing or arriving: they are reported
/// missing after seconds, not frames.
const IMAGE_POLL: Duration = Duration::from_millis(250);

/// The browser task's link to the window: what nudges it.
#[derive(Default)]
pub(super) struct IdleTick {
    mailbox: Option<browser::Mailbox>,
    /// Times the UI task woke, by timer or otherwise.
    #[cfg(test)]
    wakes: u32,
    /// Tests turn the render's nudge off to see the input listeners' alone.
    #[cfg(test)]
    quiet_renders: bool,
    /// A deadline tests set, as queued work would; cleared once it fires.
    #[cfg(test)]
    deadline: Option<Instant>,
}
impl IdleTick {
    /// A render's nudge: a render is activity, and queued work may follow it.
    pub(super) fn render_nudge(&self) {
        #[cfg(test)]
        if self.quiet_renders {
            return;
        }
        self.nudge();
    }
    /// Wakes the UI task to flush what the activity queued.
    pub(super) fn nudge(&self) {
        if let Some(mailbox) = &self.mailbox {
            mailbox.nudge();
        }
    }
}

/// When the browser task next has to run without being woken.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Next {
    /// Nothing is queued: only a publication or a nudge wakes it.
    Idle,
    /// Queued work flushes once its deadline passes.
    At(Instant),
}

/// The browser window's UI loop. It runs once per publication (at once,
/// #710) and per nudge, and otherwise only when queued work set a deadline.
pub(super) async fn run_browser(
    entity: WeakEntity<SnapshotView>,
    mailbox: browser::Mailbox,
    cx: &mut AsyncWindowContext,
) {
    let attached = entity.update(cx, |view, _| view.attach_idle_tick(mailbox.clone()));
    if attached.is_err() {
        return;
    }
    loop {
        // Waiting before deciding, so a nudge during the decision still wakes us.
        mailbox.set_idle(true);
        let now = cx.background_executor().now();
        let next = next_run(&mailbox, now, || {
            entity
                .update(cx, |view, _| view.tick_next(now))
                .unwrap_or(Next::Idle)
        });
        match next {
            Next::Idle => mailbox.published().await,
            Next::At(at) => {
                // Never a zero timer: gpui completes it without yielding.
                let wait = at.saturating_duration_since(now).max(MIN_WAIT);
                let timer = cx.background_executor().timer(wait);
                browser::tick_or_publication(timer, &mailbox).await;
            }
        }
        mailbox.set_idle(false);
        // This pass serves the activity that woke it.
        mailbox.take_activity();
        if entity
            .update(cx, |view, cx| {
                #[cfg(test)]
                {
                    view.idle_tick.wakes += 1;
                }
                view.browser_tick(cx)
            })
            .is_err()
        {
            break;
        }
        let update = mailbox.try_lock().ok().and_then(|mut slot| slot.take());
        if let Some(state) = update {
            let done = state.is_none();
            if entity
                .update_in(cx, |view, window, cx| {
                    view.apply_browser_state(state, cx);
                    view.finish_session_open(window, cx);
                    view.finish_header_actions(window, cx);
                })
                .is_err()
                || done
            {
                break;
            }
        }
    }
}

/// When the UI task next runs. A nudge that landed while it was busy (after
/// its last wake, before `set_idle`) left only its activity flag: it runs
/// again at once for it.
fn next_run(mailbox: &browser::MailboxSlot, now: Instant, queued: impl FnOnce() -> Next) -> Next {
    if mailbox.has_activity() {
        Next::At(now)
    } else {
        queued()
    }
}

impl SnapshotView {
    /// Gives the view, its images and its accessibility watcher the UI task's
    /// mailbox to nudge.
    fn attach_idle_tick(&mut self, mailbox: browser::Mailbox) {
        let images = mailbox.clone();
        self.graphics.store.on_change(move || images.nudge());
        let settings = mailbox.clone();
        self.chrome.on_change(move || settings.nudge());
        self.idle_tick.mailbox = Some(mailbox);
    }

    /// When the browser task must next run unwoken: the earliest deadline of
    /// the queued work, a poll while work waits for room, or never.
    pub(super) fn tick_next(&self, now: Instant) -> Next {
        let poll = renderer_probe::runtime::enabled()
            || (self.browser_commands.is_some() && self.presence.unflushed())
            || self.resize_gesture.busy()
            || self.pending_input.is_some()
            || self.attention.closing()
            || self.palette.closing()
            || self.graphics.store.changed_or_inflating();
        let deadlines = [
            poll.then_some(now + POLL),
            self.fit_settle.due_at(),
            self.palette.due_at(),
            self.graphics.store.waiting().then_some(now + IMAGE_POLL),
            #[cfg(test)]
            self.idle_tick.deadline,
        ];
        // A deadline already passed is work this pass did not finish (a fit
        // waits for its render): poll for it rather than run again at once,
        // which would keep the main thread from rendering (review r1).
        deadlines
            .into_iter()
            .flatten()
            .min()
            .map_or(Next::Idle, |at| Next::At(at.max(now + POLL)))
    }

    pub(super) fn browser_tick(&mut self, cx: &mut Context<Self>) {
        #[cfg(test)]
        {
            let now = cx.background_executor().now();
            if self.idle_tick.deadline.is_some_and(|at| at <= now) {
                self.idle_tick.deadline = None;
            }
        }
        if let Some(sender) = &self.browser_commands {
            self.presence.flush(sender);
        }
        self.flush_resize_gesture(cx);
        self.flush_pending_input(cx);
        renderer_probe::runtime::tick();
        if !self.terminal_input_ready() || self.selection.is_some() || self.divider.is_some() {
            self.fit_settle.clear();
        } else if self.fit_settle.due(super::geometry::fit_now()) {
            cx.notify();
        }
        self.flush_attention();
        self.flush_palette(cx);
        self.flush_kitty_graphics(cx);
        self.tick_agent_indicators(cx);
        if self.chrome.take_policy_change() {
            cx.notify();
        }
    }
}

#[cfg(test)]
#[path = "browser_tick_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "browser_tick_idle_tests.rs"]
mod idle_tests;

#[cfg(test)]
#[path = "browser_tick_reconnect_tests.rs"]
mod reconnect_tests;
