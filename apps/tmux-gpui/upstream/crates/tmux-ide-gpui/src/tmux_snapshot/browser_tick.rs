//! The UI's 16 ms browser tick. It flushes queued work and re-renders only when
//! something is due; an idle Home must cost no frames (card #703). An idle
//! window arms no tick at all (#714): the tick runs for a grace period after
//! any activity, and for as long as queued work is waiting.
use super::{SnapshotView, browser, renderer_probe};
use gpui::{AsyncWindowContext, Context, WeakEntity};
use std::time::{Duration, Instant};

/// How long the tick keeps running after the last publication, input, render
/// or finished image. Work queued by that activity is flushed within it.
pub(super) const GRACE: Duration = Duration::from_secs(1);

/// The tick's link to the window's UI task.
#[derive(Default)]
pub(super) struct IdleTick {
    mailbox: Option<browser::Mailbox>,
    grace_until: Option<Instant>,
    /// Times the UI task woke, by tick or otherwise.
    #[cfg(test)]
    wakes: u32,
}
impl IdleTick {
    /// Wakes the UI task if it is idle and restarts the grace period.
    pub(super) fn nudge(&self) {
        if let Some(mailbox) = &self.mailbox {
            mailbox.nudge();
        }
    }
}

/// The browser window's UI loop. It wakes for the 16 ms tick (queued UI work)
/// or at once when a publication lands (#710), then applies the latest state.
/// With nothing queued and no recent activity it arms no tick, and waits for a
/// publication or a nudge only.
pub(super) async fn run_browser(
    entity: WeakEntity<SnapshotView>,
    mailbox: browser::Mailbox,
    cx: &mut AsyncWindowContext,
) {
    let attached = entity.update(cx, |view, cx| view.attach_idle_tick(mailbox.clone(), cx));
    if attached.is_err() {
        return;
    }
    loop {
        // Idle before deciding, so a nudge during the decision still wakes us.
        mailbox.set_idle(true);
        let now = cx.background_executor().now();
        let tick = entity
            .update(cx, |view, _| view.tick_wanted(now))
            .unwrap_or(false);
        if tick {
            mailbox.set_idle(false);
            let tick = cx.background_executor().timer(Duration::from_millis(16));
            browser::tick_or_publication(tick, &mailbox).await;
        } else {
            mailbox.published().await;
            mailbox.set_idle(false);
        }
        let active = mailbox.take_activity();
        let now = cx.background_executor().now();
        if entity
            .update(cx, |view, cx| {
                if active {
                    view.idle_tick.grace_until = Some(now + GRACE);
                }
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

impl SnapshotView {
    /// Gives the view, its images and its accessibility watcher the UI task's
    /// mailbox to nudge, and starts the first grace period.
    fn attach_idle_tick(&mut self, mailbox: browser::Mailbox, cx: &mut Context<Self>) {
        let images = mailbox.clone();
        self.graphics.store.on_change(move || images.nudge());
        let settings = mailbox.clone();
        self.chrome.on_change(move || settings.nudge());
        self.idle_tick.mailbox = Some(mailbox);
        self.idle_tick.grace_until = Some(cx.background_executor().now() + GRACE);
    }

    /// Whether the UI task should arm its 16 ms tick: within the grace period
    /// after activity, or while queued work waits for a flush.
    pub(super) fn tick_wanted(&self, now: Instant) -> bool {
        self.idle_tick.grace_until.is_some_and(|until| now < until) || self.tick_work_queued()
    }

    /// Work only a later tick flushes, which no publication or input may wake.
    fn tick_work_queued(&self) -> bool {
        renderer_probe::runtime::enabled()
            || (self.browser_commands.is_some() && self.presence.unflushed())
            || self.resize_gesture.busy()
            || self.pending_input.is_some()
            || self.fit_settle.pending()
            || self.attention.closing()
            || self.palette.queued()
            || self.graphics.store.pending()
    }

    pub(super) fn browser_tick(&mut self, cx: &mut Context<Self>) {
        if let Some(sender) = &self.browser_commands {
            self.presence.flush(sender);
        }
        self.flush_resize_gesture(cx);
        self.flush_pending_input(cx);
        renderer_probe::runtime::tick();
        if !self.terminal_input_ready() || self.selection.is_some() || self.divider.is_some() {
            self.fit_settle.clear();
        } else if self.fit_settle.due(Instant::now()) {
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
