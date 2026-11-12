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
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
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

/// A state only the user can fix (r3), as the worker publishes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Act {
    DaemonUpdate,
    Record,
    Credentials,
    Platform,
    Unreadable,
    /// A session window's recovery stopped.
    GaveUp,
    /// The daemon was updated past what this app speaks.
    AppUpdate,
    /// Over SSH, a different daemon answered for the machine.
    SshIdentity,
}
/// The one card Home shows for it, and the slot's short label.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Card {
    pub slot: &'static str,
    pub title: String,
    pub detail: String,
    /// The one thing that can fix it here; `None` when nothing in the app can
    /// (an app too old for the daemon), and only Copy details shows.
    pub action: Option<&'static str>,
    /// A remote machine's retry token, when the action is to retry it.
    pub retry: Option<String>,
}
pub(super) const KEEP_RUNNING: &str = "Your sessions keep running.";
pub(super) const UPDATE_NEEDED: &str = "Update needed";
pub(super) const SETUP_NEEDED: &str = "Set up needed";
pub(super) const COULDNT_RECONNECT: &str = "Couldn't reconnect";
pub(super) const CREDENTIALS_DETAIL: &str = "The background service refused this app's credentials. Refresh reads them again; if it still refuses, run tmux-ide doctor in Terminal.";

/// The words a user should never have to read (onboarding A0): the
/// implementation's names for the background service, the command-line tool
/// and the machine list, and a function key.
#[cfg(test)]
pub(in crate::tmux_snapshot) fn jargon(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    let words: Vec<&str> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    ["daemon", "fleet", "catalog"]
        .into_iter()
        .find(|w| lower.contains(w))
        .or_else(|| words.contains(&"CLI").then_some("CLI"))
        .or_else(|| {
            words
                .iter()
                .any(|w| w.eq_ignore_ascii_case("F5"))
                .then_some("F5")
        })
}

/// The card for `state`, if anything needs the user: this Mac's daemon or
/// recovery first, then local setup, then the first remote machine.
pub(super) fn card(state: &browser::State, connected: bool) -> Option<Card> {
    use browser::local_setup::Phase as P;
    let card = |slot, title: &str, detail: &str, action: &'static str| Card {
        slot,
        title: title.into(),
        detail: detail.into(),
        action: Some(action),
        retry: None,
    };
    if let Some(act) = state.act {
        let detail = crate::notifications::safe_text(&state.status, 240);
        return Some(match act {
            Act::DaemonUpdate => card(
                UPDATE_NEEDED,
                "Tmux IDE needs an update",
                &detail,
                "Refresh",
            ),
            Act::Record => card(
                SETUP_NEEDED,
                "The background service's details can't be read",
                &detail,
                "Refresh",
            ),
            // Refresh reads the daemon's record and its credentials again,
            // which is what fixes a rotated token; the text says so.
            Act::Credentials => card(
                SETUP_NEEDED,
                "The background service refused this app",
                CREDENTIALS_DETAIL,
                "Refresh",
            ),
            Act::Platform => card(
                SETUP_NEEDED,
                "This Mac can't verify the background service",
                &detail,
                "Refresh",
            ),
            Act::Unreadable => card(
                SETUP_NEEDED,
                "The background service's answer can't be read",
                &detail,
                "Refresh",
            ),
            Act::GaveUp => card(
                COULDNT_RECONNECT,
                COULDNT_RECONNECT,
                &detail,
                "Refresh sessions",
            ),
            Act::SshIdentity => card(
                SETUP_NEEDED,
                "A different machine answered",
                &detail,
                "Refresh sessions",
            ),
            // Nothing in the app fixes an app that is too old: no button.
            Act::AppUpdate => Card {
                action: None,
                ..card(UPDATE_NEEDED, "This app needs an update", &detail, "")
            },
        });
    }
    if connected && let Some(setup) = &state.local_setup {
        let slot = if setup.phase == P::Unsupported {
            UPDATE_NEEDED
        } else {
            SETUP_NEEDED
        };
        let title = match setup.phase {
            P::Running => return None,
            P::Available => "Set up Tmux IDE",
            P::Missing => "The command-line tool is missing",
            P::Unsupported => "The command-line tool doesn't match the app",
            P::Unrecognized => "The command-line tool wasn't recognized",
            P::Failed | P::StoppedWaiting => "Setup didn't finish",
        };
        return Some(card(
            slot,
            title,
            setup.phase.guidance(),
            setup.phase.label(),
        ));
    }
    let group = state
        .fleet
        .as_ref()?
        .groups
        .iter()
        .find(|g| g.needs_user())?;
    Some(Card {
        slot: if group.needs_update() {
            UPDATE_NEEDED
        } else {
            SETUP_NEEDED
        },
        title: format!("{} needs you", group.label),
        detail: group.connection_hint().unwrap_or_default().into(),
        action: Some("Retry connection"),
        retry: group.retry.clone(),
    })
}

/// How an unreachable remote machine reads (r4): unchanged for 8 s, then
/// reconnecting, then unreachable since a time, retried every minute.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Away {
    Quiet,
    Reconnecting,
    Unreachable(String),
}
impl Away {
    pub(super) fn label(&self) -> String {
        match self {
            Self::Quiet => String::new(),
            Self::Reconnecting => RECONNECTING.into(),
            Self::Unreachable(since) => {
                format!("Unreachable since {since} · trying again every minute")
            }
        }
    }
}
pub(super) fn away(elapsed: Duration, since: SystemTime) -> Away {
    if elapsed >= OFFLINE_AFTER {
        Away::Unreachable(clock_time(since))
    } else if elapsed >= WORDS_AFTER {
        Away::Reconnecting
    } else {
        Away::Quiet
    }
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
    _away_wake: Option<Task<()>>,
    /// Agent marks have shown "last known" for this drop (#362): they keep
    /// it until the agent lane's re-read clears the flag, even once the link
    /// is back and the connection's words are gone.
    pub(super) agents_marked: std::cell::Cell<bool>,
}
impl Default for Watch {
    fn default() -> Self {
        Self {
            since: None,
            connected_once: false,
            clock: Rc::new(|| (Instant::now(), SystemTime::now())),
            _wake: None,
            _away_wake: None,
            agents_marked: std::cell::Cell::new(false),
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
        self.wake_for_away_machines(cx);
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

    /// Repaints at the 8 s and 60 s marks of each away machine.
    fn wake_for_away_machines(&mut self, cx: &mut Context<Self>) {
        let marks: Vec<Instant> = self
            .browser_state
            .fleet
            .iter()
            .flat_map(|f| f.groups.iter())
            .filter_map(|g| g.away.map(|(at, _)| at))
            .flat_map(|at| [at + WORDS_AFTER, at + OFFLINE_AFTER])
            .filter(|mark| *mark > Instant::now())
            .collect();
        self.connection._away_wake = (!marks.is_empty()).then(|| {
            cx.spawn(async move |this, cx| {
                let mut marks = marks;
                marks.sort();
                for mark in marks {
                    let wait = mark.saturating_duration_since(Instant::now());
                    cx.background_executor().timer(wait).await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        return;
                    }
                }
            })
        });
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

    /// A remote machine's state while it is retried, by the watch's clock.
    pub(super) fn machine_away(&self, group: &browser::fleet::Group) -> Option<Away> {
        let (since, wall) = group.away?;
        let (now, _) = (self.connection.clock)();
        Some(away(now.saturating_duration_since(since), wall))
    }

    /// The away state of the machine that lists `session`, if it is away.
    pub(super) fn session_away(&self, session: &browser::fleet::Session) -> Option<Away> {
        let fleet = self.browser_state.fleet.as_ref()?;
        let group = fleet
            .groups
            .iter()
            .find(|g| g.sessions.iter().any(|s| std::ptr::eq(s, session)))?;
        self.machine_away(group).filter(|a| *a != Away::Quiet)
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
        let act = card(&self.browser_state, self.browser_commands.is_some());
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
        if let Some(act) = act {
            // What only the user can fix shows at once, whatever the clock says.
            return slot
                .child(
                    fill.debug_selector(|| "tmux-connection-act".into())
                        .child(div().size(px(6.)).rounded_full().bg(palette.warning))
                        .child(div().truncate().child(act.slot)),
                )
                .into_any_element();
        }
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

    /// Home's one card for what only the user can fix (r3): a title, that the
    /// sessions keep running, the action, and Copy details.
    pub(super) fn act_card(&self, card: Card, cx: &mut Context<Self>) -> AnyElement {
        use super::controls::{ButtonStyle, Icon, action_button_on};
        let bezel = self.home_palette();
        let request = self.browser_request;
        let retry = card.retry.clone();
        let details = format!("{}\n{}", card.title, card.detail);
        let action = card.action.map(|label| {
            action_button_on(
                "home-act-action",
                Some(label),
                label,
                Icon::Refresh,
                ButtonStyle::Secondary,
                &bezel,
            )
            .debug_selector(|| "home-act-action".into())
            .on_click(cx.listener(move |view, _, window, cx| {
                cx.stop_propagation();
                match &retry {
                    Some(token) => {
                        view.retry_fleet_machine(request, token, window, cx);
                    }
                    None => view.home_refresh(request, window, cx),
                }
            }))
        });
        let copy = action_button_on(
            "home-act-copy",
            Some("Copy details"),
            "Copy details",
            Icon::Copy,
            ButtonStyle::Quiet,
            &bezel,
        )
        .debug_selector(|| "home-act-copy".into())
        .on_click(cx.listener(move |_, _, _, cx| {
            cx.stop_propagation();
            cx.write_to_clipboard(ClipboardItem::new_string(details.clone()));
        }));
        div()
            .debug_selector(|| "home-act-card".into())
            .w_full()
            .p(px(bezel_theme::Theme::SPACE * 2.))
            .flex()
            .flex_col()
            .gap(px(bezel_theme::Theme::SPACE))
            .rounded(px(bezel_theme::Theme::control_radius() * 2.))
            // The warning strip's wash, so its inked text reads 4.5:1 on it.
            .bg(rgb(super::home::strip_plate(bezel.warning, self.canvas())))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(bezel.warning_muted)
                    .child(div().size(px(6.)).rounded_full().bg(bezel.warning))
                    .children(super::design::ink_probe(|| "home-act-title".into()))
                    .child(card.title),
            )
            .child(
                div()
                    .text_color(bezel.warning_muted)
                    .children(super::design::ink_probe(|| "home-act-detail".into()))
                    .child(format!("{} {KEEP_RUNNING}", card.detail)),
            )
            .child(
                div()
                    .flex()
                    .gap(px(bezel_theme::Theme::SPACE))
                    .children(action)
                    .child(copy),
            )
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
        if sidebar_shown
            || (self.connection_stage() == Stage::Quiet
                && card(&self.browser_state, self.browser_commands.is_some()).is_none())
        {
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
