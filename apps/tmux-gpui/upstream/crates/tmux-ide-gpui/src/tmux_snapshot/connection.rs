//! Quiet reconnect (r1, r2, r5): the app reconnects by itself and says nothing
//! until a drop has lasted long enough to matter, or until only the user can
//! fix it. Connection state shows in one slot in the middle of the sidebar
//! footer, between its two glass capsules:
//!
//! - under 2 s (1 s at startup): nothing changes on screen;
//! - to 8 s: a spinner in the slot, no words;
//! - past 8 s: "Reconnecting…", and pane titles step down to the muted ink;
//! - past 60 s on a session stream: "Offline since 10:42", a button that
//!   retries now, the only manual retry.
//!
//! A key refused while the stream is down shows "Not sent…" in its pane at once
//! and moves the slot straight to its words. Keys are never queued or replayed.
//! The thresholds read [`Watch`]'s clock, which tests replace.
use super::{SnapshotView, agent_indicator::FRAMES, browser};
use gpui::{prelude::*, *};
use std::{
    rc::Rc,
    time::{Duration, Instant, SystemTime},
};

pub(super) const SPINNER_AFTER: Duration = Duration::from_secs(2);
pub(super) const STARTUP_SPINNER_AFTER: Duration = Duration::from_secs(1);
pub(super) const WORDS_AFTER: Duration = Duration::from_secs(8);
pub(super) const OFFLINE_AFTER: Duration = Duration::from_secs(60);
pub(super) const RECONNECTING: &str = "Reconnecting…";
/// The words before the app has ever had a connection (#357 review, item 3).
pub(super) const CONNECTING: &str = "Connecting…";
pub(super) const NOT_SENT: &str = "Not sent. The connection is back in a moment. Type again then.";

/// What is being waited for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    /// The first catalog after launch.
    Startup,
    /// Home's catalog.
    Home,
    /// A session window's terminal stream.
    Session,
}

/// What the slot shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Stage {
    Quiet,
    Spinner,
    Words,
    Offline,
}

/// The stage `elapsed` into a wait. A refused key skips to the words.
pub(super) fn stage(kind: Kind, elapsed: Duration, refused: bool) -> Stage {
    let spinner = if kind == Kind::Startup {
        STARTUP_SPINNER_AFTER
    } else {
        SPINNER_AFTER
    };
    let by_time = if kind == Kind::Session && elapsed >= OFFLINE_AFTER {
        Stage::Offline
    } else if elapsed >= WORDS_AFTER {
        Stage::Words
    } else if elapsed >= spinner {
        Stage::Spinner
    } else {
        Stage::Quiet
    };
    if refused {
        by_time.max(Stage::Words)
    } else {
        by_time
    }
}

/// Whether the slot's spinner turns: only with the shared overlay attached, and
/// never under Reduce Motion, which shows one still frame instead.
pub(super) fn animates(overlay: bool, reduce_motion: bool) -> bool {
    overlay && !reduce_motion
}

/// "10:42" in local time.
fn clock_time(at: SystemTime) -> String {
    chrono::DateTime::<chrono::Local>::from(at)
        .format("%H:%M")
        .to_string()
}

pub(super) type Clock = Rc<dyn Fn() -> (Instant, SystemTime)>;

/// When the current wait began, by the clock the thresholds read.
pub(super) struct Watch {
    since: Option<(Kind, Instant, SystemTime)>,
    /// A connection existed: a live Home or a session was shown.
    connected_once: bool,
    pub(super) clock: Clock,
    _wake: Option<Task<()>>,
}
impl Default for Watch {
    fn default() -> Self {
        Self {
            since: None,
            connected_once: false,
            clock: Rc::new(|| (Instant::now(), SystemTime::now())),
            _wake: None,
        }
    }
}

/// The wait a publication shows, if any.
pub(super) fn waiting(state: &browser::State, connected: bool) -> Option<Kind> {
    if !connected {
        // The bridge is gone: only reopening helps, and that is loud elsewhere.
        return None;
    }
    if state.reconnect_attempt.is_some() {
        return Some(if state.surface == browser::Surface::Home {
            Kind::Home
        } else {
            Kind::Session
        });
    }
    (state.home_phase == browser::HomePhase::Loading && state.local_setup.is_none())
        .then_some(Kind::Startup)
}

impl SnapshotView {
    /// Starts or ends the wait from the latest publication, and wakes the view
    /// at each threshold so the slot changes without a new publication.
    pub(super) fn observe_connection(&mut self, cx: &mut Context<Self>) {
        let kind = waiting(&self.browser_state, self.browser_commands.is_some());
        let watch = &mut self.connection;
        watch.connected_once |= kind.is_none()
            && self.browser_commands.is_some()
            && (self.browser_state.home_phase == browser::HomePhase::Live
                || self.browser_state.surface == browser::Surface::Workspace);
        match (kind, watch.since) {
            (None, _) => {
                watch.since = None;
                watch._wake = None;
            }
            // Startup turning into a reconnect keeps its start: the wait goes on.
            (Some(kind), Some((_, at, wall))) => watch.since = Some((kind, at, wall)),
            (Some(kind), None) => {
                let (now, wall) = (watch.clock)();
                watch.since = Some((kind, now, wall));
                watch._wake = Some(cx.spawn(async move |this, cx| {
                    for after in [
                        STARTUP_SPINNER_AFTER,
                        SPINNER_AFTER,
                        WORDS_AFTER,
                        OFFLINE_AFTER,
                    ] {
                        let wait = (now + after).saturating_duration_since(Instant::now());
                        cx.background_executor().timer(wait).await;
                        if this.update(cx, |_, cx| cx.notify()).is_err() {
                            return;
                        }
                    }
                }));
            }
        }
    }

    /// A key typed while the stream is down was refused (#702: never queued).
    fn key_refused(&self) -> bool {
        self.input_interrupted && self.browser_state.reconnect_attempt.is_some()
    }

    /// The slot's stage now, by the watch's clock.
    pub(super) fn connection_stage(&self) -> Stage {
        let Some((kind, since, _)) = self.connection.since else {
            return Stage::Quiet;
        };
        let (now, _) = (self.connection.clock)();
        stage(
            kind,
            now.saturating_duration_since(since),
            self.key_refused(),
        )
    }

    /// The slot's words: "Connecting…" until a connection has existed.
    pub(super) fn connection_words(&self) -> &'static str {
        match self.connection.since {
            Some((Kind::Startup, _, _)) if !self.connection.connected_once => CONNECTING,
            _ => RECONNECTING,
        }
    }

    /// Pane titles step down to the muted ink once the words show.
    pub(super) fn connection_mutes_titles(&self) -> bool {
        self.connection_stage() >= Stage::Words
    }

    /// The slot between the footer's capsules. It always takes the same room,
    /// so nothing beside it moves when it fills.
    pub(super) fn connection_slot(&self, cx: &mut Context<Self>) -> AnyElement {
        let stage = self.connection_stage();
        let palette = super::design::palette(&self.theme());
        let muted = palette.text_muted;
        let slot = div()
            .id("connection-slot")
            .debug_selector(|| "tmux-connection-slot".into())
            .flex_1()
            .min_w_0()
            .h(px(bezel_theme::ControlSize::Regular.height()))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(4.))
            .text_size(px(bezel_theme::TextStyle::Caption.size()))
            .text_color(muted)
            .children(super::design::ink_probe(|| "connection-slot".into()));
        // What fills the slot fades in over Bezel's quick fade (#761); the
        // slot's own box never changes.
        let fill = div().flex().items_center().gap(px(4.)).min_w_0();
        let content = match stage {
            Stage::Quiet => return slot.into_any_element(),
            Stage::Spinner => fill.child(self.connection_spinner(cx)),
            Stage::Words => fill
                .child(self.connection_spinner(cx))
                .child(div().truncate().child(self.connection_words())),
            Stage::Offline => {
                let since = self
                    .connection
                    .since
                    .map_or_else(String::new, |(_, _, wall)| clock_time(wall));
                let request = self.browser_state.request;
                let hover = palette.element_hover;
                fill.child(
                    div()
                        .id("connection-retry")
                        .debug_selector(|| "tmux-connection-retry".into())
                        .px_2()
                        .rounded_full()
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .truncate()
                        .aria_label("Offline. Retry now")
                        .child(format!("Offline since {since}"))
                        .on_click(cx.listener(move |view, _, _, cx| {
                            cx.stop_propagation();
                            view.retry_reconnect(request);
                        })),
                )
            }
        };
        slot.when(stage == Stage::Spinner, |slot| {
            slot.aria_label(self.connection_words())
        })
        .child(bezel_motion::fade_quick(
            SharedString::from(format!("connection-slot-{stage:?}")),
            content,
        ))
        .into_any_element()
    }

    /// The spinner's glyph box: the shared overlay paints its frames, or, under
    /// Reduce Motion, one still frame.
    fn connection_spinner(&self, cx: &App) -> AnyElement {
        let slots = self.agent_animation.clone();
        let moving = animates(slots.attached(), cx.reduce_motion());
        div()
            .relative()
            .w(px(12.))
            .flex_none()
            .child(
                div()
                    .when(moving, |glyph| glyph.text_color(transparent_black()))
                    .child(FRAMES[if moving { slots.frame() } else { 0 }]),
            )
            .when(moving, |glyph| {
                glyph.child(
                    canvas(
                        |_, _, _| (),
                        move |bounds, _, window, _| slots.reserve(bounds, window),
                    )
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
                )
            })
            .into_any_element()
    }

    /// With the sidebar hidden, the same slot floats at the window's bottom left
    /// on a glass capsule, but only while it has something to show.
    pub(super) fn floating_connection_slot(
        &self,
        sidebar_shown: bool,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if sidebar_shown || self.connection_stage() == Stage::Quiet {
            return None;
        }
        use bezel_ui::surface::Surfaced as _;
        let bezel = bezel_theme::Theme::of(cx).clone();
        Some(
            div()
                .debug_selector(|| "tmux-connection-float".into())
                .absolute()
                .left(px(bezel_theme::Theme::SPACE * 2.))
                .bottom(px(bezel_theme::Theme::SPACE * 2.))
                .w(px(180.))
                .px_1()
                .rounded_full()
                .child(self.connection_slot(cx))
                .surface(
                    &bezel,
                    bezel_theme::SurfaceStyle::Glass(bezel_theme::Glass::Regular),
                )
                .into_any_element(),
        )
    }

    /// "Not sent…" in the pane the key was typed in, on glass, from the first
    /// refused key until the stream is back.
    pub(super) fn not_sent_toast(&self, width: f32, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.key_refused() {
            return None;
        }
        // Over the selected pane's card, or over the whole terminal without cards.
        let rect = self.card_layout(width).and_then(|cards| {
            let selected = self.browser_state.selected_pane.as_ref()?;
            let region = cards.regions.iter().find(|r| &r.id == selected)?;
            Some(cards.content(region))
        });
        use bezel_ui::surface::Surfaced as _;
        let bezel = bezel_theme::Theme::of(cx).clone();
        let ink = toast_ink(&bezel);
        let area = match rect {
            Some(rect) => div()
                .left(rect.origin.x)
                .top(rect.origin.y)
                .w(rect.size.width)
                .h(rect.size.height),
            None => div().inset_0(),
        };
        Some(
            area.absolute()
                .flex()
                .items_end()
                .justify_center()
                .pb(px(bezel_theme::Theme::SPACE * 3.))
                .child(
                    div()
                        .debug_selector(|| "tmux-not-sent".into())
                        .mx(px(16.))
                        .px_3()
                        .py_2()
                        .rounded_full()
                        .text_color(ink)
                        .text_size(px(bezel_theme::TextStyle::Callout.size()))
                        .children(super::design::ink_probe(|| "not-sent".into()))
                        .child(NOT_SENT)
                        .surface(
                            &bezel,
                            bezel_theme::SurfaceStyle::Glass(bezel_theme::Glass::Regular),
                        ),
                )
                .into_any_element(),
        )
    }
}

/// The toast's text: Bezel's text ink, opaque, moved just far enough to read
/// 4.5:1 on the glass over a white desktop and over a black one.
pub(super) fn toast_ink(bezel: &bezel_theme::Theme) -> Hsla {
    let pack = |c: Hsla| u32::from(Rgba::from(c)) >> 8;
    let plates: Vec<u32> = [0xffffff, 0x000000]
        .into_iter()
        .map(|desktop| pack(glass_over(bezel, desktop)))
        .collect();
    let text = bezel_theme::flatten(bezel.text, glass_over(bezel, 0xffffff));
    rgb(crate::contrast::ink(pack(text), &plates, 4.5)).into()
}

/// What Regular glass shows over a flat desktop of `desktop`, by its transfer
/// line: `gain * backdrop + tint`.
pub(super) fn glass_over(bezel: &bezel_theme::Theme, desktop: u32) -> Hsla {
    let spec = bezel_theme::SurfaceStyle::Glass(bezel_theme::Glass::Regular).spec(bezel);
    let (tint, back) = (Rgba::from(spec.tint), rgb(desktop));
    let channel = |b: f32, t: f32| (spec.gain * b + t * tint.a).clamp(0., 1.);
    Rgba {
        r: channel(back.r, tint.r),
        g: channel(back.g, tint.g),
        b: channel(back.b, tint.b),
        a: 1.,
    }
    .into()
}

#[cfg(test)]
#[path = "connection_tests.rs"]
mod tests;
