//! Copies made by programs in a machine's panes (OSC 52, bridge v1).
//!
//! The daemon reports a copy; the app decides. Owner decision (17 Nov 2026):
//! the pasteboard is written silently only when the pane is the focused pane
//! of the key window and the user typed into it in the last 2 seconds;
//! otherwise the pane's header offers "Copy N KB from <machine>?". Every
//! silent write shows in that header for 1.5 s. Nothing here reads the
//! pasteboard: a remote machine can never see what is on it.
use super::{SnapshotView, browser, browser::NativeOwner};
use gpui::{prelude::*, *};
use herdr_client::tmux_daemon::{
    BridgeEnd, BridgeEvent, RemoteBridgeWorker,
    remote_clipboard::{self, Delivery, Focus, InputLedger},
};
use std::time::{Duration, Instant};

/// How long a silent copy says so in its pane's header.
pub(super) const COPIED_FOR: Duration = Duration::from_millis(1500);
/// How long a refused copy says so.
const REFUSED_FOR: Duration = Duration::from_secs(4);
/// A lane that failed tries again after 2 s, doubling up to a minute.
const RETRY_FIRST: Duration = Duration::from_secs(2);
const RETRY_CAP: Duration = Duration::from_secs(60);
/// A daemon without the bridge is asked again only this rarely.
const UNSUPPORTED_RECHECK: Duration = Duration::from_secs(600);
/// How much of a copied text the header shows.
const PREVIEW_CHARS: usize = 40;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Offer {
    pub pane: String,
    pub text: String,
    pub machine: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Note {
    pub pane: String,
    pub text: String,
    pub until: Instant,
}

struct Lane {
    key: String,
    worker: RemoteBridgeWorker,
}

#[derive(Default)]
pub(super) struct RemoteCopy {
    owner: Option<NativeOwner>,
    lane: Option<Lane>,
    /// The machine whose lane ended, when it may start again, and how often
    /// it failed in a row.
    retry: Option<(String, Instant, u32)>,
    inputs: InputLedger,
    offer: Option<Offer>,
    note: Option<Note>,
}

/// What the window knows when a copy arrives.
pub(super) struct Context<'a> {
    pub focus: Focus<'a>,
    pub shown: &'a dyn Fn(&str) -> bool,
    pub machine: &'a str,
}

impl RemoteCopy {
    pub(super) fn new(owner: Option<NativeOwner>) -> Self {
        Self {
            owner,
            ..Self::default()
        }
    }
    /// The user sent input to `pane`.
    pub(super) fn note_input(&mut self, pane: &str, now: Instant) {
        self.inputs.note(pane, now);
    }
    /// A copy from a pane. Returns the text to put on the pasteboard now,
    /// when the copy is plainly the user's doing; otherwise the pane offers it.
    pub(super) fn receive(
        &mut self,
        event: BridgeEvent,
        context: &Context<'_>,
        now: Instant,
    ) -> Option<String> {
        if !(context.shown)(event.pane_id()) {
            return None;
        }
        match event {
            BridgeEvent::Clipboard { pane_id, text, .. } => {
                let last = self.inputs.last(&pane_id);
                match remote_clipboard::delivery(context.focus, &pane_id, last, now) {
                    Delivery::Silent => {
                        if self
                            .offer
                            .as_ref()
                            .is_some_and(|offer| offer.pane == pane_id)
                        {
                            self.offer = None;
                        }
                        self.note = Some(Note {
                            text: format!("Copied from {}: {}", context.machine, preview(&text)),
                            pane: pane_id,
                            until: now + COPIED_FOR,
                        });
                        Some(text)
                    }
                    Delivery::Ask => {
                        // The newest copy replaces an older offer.
                        self.offer = Some(Offer {
                            pane: pane_id,
                            text,
                            machine: context.machine.to_owned(),
                        });
                        None
                    }
                }
            }
            BridgeEvent::TooLarge { pane_id, bytes, .. } => {
                self.note = Some(Note {
                    text: format!(
                        "Copy from {} too large ({})",
                        context.machine,
                        megabytes(bytes)
                    ),
                    pane: pane_id,
                    until: now + REFUSED_FOR,
                });
                None
            }
        }
    }
    /// The user clicked the offer on `pane`: its text, once.
    pub(super) fn accept(&mut self, pane: &str) -> Option<String> {
        if self.offer.as_ref().is_some_and(|offer| offer.pane == pane) {
            self.offer.take().map(|offer| offer.text)
        } else {
            None
        }
    }
    pub(super) fn dismiss(&mut self, pane: &str) {
        if self.offer.as_ref().is_some_and(|offer| offer.pane == pane) {
            self.offer = None;
        }
    }
    pub(super) fn offer(&self, pane: &str) -> Option<&Offer> {
        self.offer.as_ref().filter(|offer| offer.pane == pane)
    }
    pub(super) fn note(&self, pane: &str, now: Instant) -> Option<&str> {
        self.note
            .as_ref()
            .filter(|note| note.pane == pane && now < note.until)
            .map(|note| note.text.as_str())
    }
    /// Clears a note whose time is up; true when one was.
    pub(super) fn expire(&mut self, now: Instant) -> bool {
        let expired = self.note.as_ref().is_some_and(|note| now >= note.until);
        if expired {
            self.note = None;
        }
        expired
    }
    /// When the UI task must run to clear a note.
    pub(super) fn due_at(&self) -> Option<Instant> {
        let lane_retry = self
            .lane
            .is_none()
            .then_some(self.retry.as_ref().map(|(_, at, _)| *at))
            .flatten();
        [self.note.as_ref().map(|note| note.until), lane_retry]
            .into_iter()
            .flatten()
            .min()
    }
    /// Panes the window no longer shows lose their offer.
    pub(super) fn retain(&mut self, shown: impl Fn(&str) -> bool) {
        if self.offer.as_ref().is_some_and(|offer| !shown(&offer.pane)) {
            self.offer = None;
        }
        if self.note.as_ref().is_some_and(|note| !shown(&note.pane)) {
            self.note = None;
        }
    }
    /// Keeps one lane to the machine the window shows, while it shows one.
    fn sync(&mut self, wanted: bool, now: Instant, wake: impl Fn() + Send + 'static) {
        let source = wanted
            .then(|| self.owner.as_ref()?.observation_source().ok())
            .flatten();
        let key = source
            .as_ref()
            .map(herdr_client::tmux_daemon::CatalogSource::machine_key);
        if self
            .lane
            .as_ref()
            .is_some_and(|lane| Some(&lane.key) != key.as_ref())
        {
            self.lane = None;
        }
        if (self.retry.as_ref()).is_some_and(|(machine, _, _)| Some(machine) != key.as_ref()) {
            self.retry = None;
        }
        let (Some(source), Some(key)) = (source, key) else {
            return;
        };
        if self.lane.is_some() || self.retry.as_ref().is_some_and(|(_, at, _)| now < *at) {
            return;
        }
        if let Ok(worker) = RemoteBridgeWorker::spawn(source, wake) {
            self.lane = Some(Lane { key, worker });
        }
    }
    fn take_events(&mut self, now: Instant) -> Vec<BridgeEvent> {
        let Some(lane) = &self.lane else {
            return Vec::new();
        };
        let events = lane.worker.take_events();
        // A lane that came up starts its failure count over.
        if lane.worker.live() {
            self.retry = None;
        }
        if let Some(end) = lane.worker.take_end() {
            let failures = match &self.retry {
                Some((key, _, failures)) if *key == lane.key => failures.saturating_add(1),
                _ => 0,
            };
            let wait = match end {
                BridgeEnd::Unsupported => UNSUPPORTED_RECHECK,
                BridgeEnd::Failed(_) => RETRY_FIRST
                    .saturating_mul(1u32.checked_shl(failures).unwrap_or(u32::MAX))
                    .min(RETRY_CAP),
            };
            self.retry = Some((lane.key.clone(), now + wait, failures));
            self.lane = None;
        }
        events
    }
}

/// The first characters of a copy, with control characters made visible.
pub(super) fn preview(text: &str) -> String {
    let mut shown: String = text
        .chars()
        .take(PREVIEW_CHARS)
        .map(|c| if c.is_control() { '·' } else { c })
        .collect();
    if text.chars().nth(PREVIEW_CHARS).is_some() {
        shown.push('…');
    }
    shown
}

/// "2 bytes", "3 KB", "1.5 MB": a copy's size as the offer names it.
pub(super) fn size_label(bytes: u64) -> String {
    const KIB: u64 = 1024;
    if bytes < KIB {
        format!("{bytes} {}", if bytes == 1 { "byte" } else { "bytes" })
    } else if bytes < KIB * KIB {
        format!("{} KB", bytes.div_ceil(KIB))
    } else {
        megabytes(bytes)
    }
}

fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024. * 1024.))
}

impl SnapshotView {
    /// Runs on the UI task: keeps the lane, and applies the copies it got.
    pub(super) fn tick_remote_copy(&mut self, cx: &mut gpui::Context<Self>) {
        let now = cx.background_executor().now();
        let wanted = self.browsing && self.browser_state.surface == browser::Surface::Workspace;
        let wake = self.idle_tick.waker();
        self.remote_copy.sync(wanted, now, move || {
            if let Some(wake) = &wake {
                wake.nudge();
            }
        });
        let events = self.remote_copy.take_events(now);
        let panes: Vec<String> = if wanted {
            self.browser_state
                .panes
                .iter()
                .map(|p| p.id.clone())
                .collect()
        } else {
            Vec::new()
        };
        let shown = |pane: &str| panes.iter().any(|id| id == pane);
        let mut changed = !events.is_empty();
        let machine = if self.browser_state.machine_label.trim().is_empty() {
            "this machine".to_owned()
        } else {
            self.browser_state.machine_label.clone()
        };
        let context = Context {
            focus: Focus {
                window_active: self.presence.active(),
                selected_pane: self.browser_state.selected_pane.as_deref(),
            },
            shown: &shown,
            machine: &machine,
        };
        let mut writes = Vec::new();
        for event in events {
            if let Some(text) = self.remote_copy.receive(event, &context, now) {
                writes.push(text);
            }
        }
        // Only the newest copy matters on the pasteboard.
        if let Some(text) = writes.pop() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
        self.remote_copy.retain(shown);
        changed |= self.remote_copy.expire(now);
        if changed {
            cx.notify();
        }
    }

    /// The header content for `pane` while it offers a copy or says one
    /// happened; `None` leaves the title.
    pub(super) fn remote_copy_header(
        &self,
        pane: &str,
        cx: &mut gpui::Context<Self>,
    ) -> Option<AnyElement> {
        let theme = self.theme();
        let palette = super::design::palette(&theme);
        let ink = super::pane_chrome::header_ink(&theme);
        if let Some(offer) = self.remote_copy.offer(pane) {
            use bezel_ui::widgets::Buttons as _;
            let label = format!(
                "Copy {} from {}?",
                size_label(offer.text.len() as u64),
                offer.machine
            );
            let (accept, dismiss) = (pane.to_owned(), pane.to_owned());
            let hover = palette.element_hover;
            return Some(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .flex_1()
                    .min_w_0()
                    .child(
                        palette
                            .ghost("remote-copy-accept")
                            .role(Role::Button)
                            .aria_label(label.clone())
                            .debug_selector({
                                let pane = pane.to_owned();
                                move || format!("remote-copy-accept:{pane}")
                            })
                            .min_w_0()
                            .px(px(bezel_theme::Theme::SPACE / 2.))
                            .text_color(ink.text)
                            .hover(move |s| s.bg(hover))
                            .child(div().min_w_0().truncate().child(label))
                            .on_click(cx.listener(move |view, _, _, cx| {
                                cx.stop_propagation();
                                if let Some(text) = view.remote_copy.accept(&accept) {
                                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        palette
                            .ghost("remote-copy-dismiss")
                            .role(Role::Button)
                            .aria_label("Dismiss copy")
                            .debug_selector({
                                let pane = pane.to_owned();
                                move || format!("remote-copy-dismiss:{pane}")
                            })
                            .px(px(bezel_theme::Theme::SPACE / 2.))
                            .text_color(ink.muted)
                            .hover(move |s| s.bg(hover))
                            .child("×")
                            .on_click(cx.listener(move |view, _, _, cx| {
                                cx.stop_propagation();
                                view.remote_copy.dismiss(&dismiss);
                                cx.notify();
                            })),
                    )
                    .into_any_element(),
            );
        }
        let now = cx.background_executor().now();
        let note = self.remote_copy.note(pane, now)?;
        Some(
            div()
                .min_w_0()
                .flex_1()
                .truncate()
                .text_color(ink.muted)
                .debug_selector({
                    let pane = pane.to_owned();
                    move || format!("remote-copy-note:{pane}")
                })
                .child(note.to_owned())
                .into_any_element(),
        )
    }
}

#[cfg(test)]
#[path = "remote_copy_tests.rs"]
mod tests;
