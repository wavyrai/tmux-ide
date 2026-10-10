//! The status bar's usage segments: per agent, a meter for the window closest
//! to its limit and the tightest windows' shares used with their time to
//! reset, or in compact mode the tightest share alone. A click opens that
//! agent's panel, so the bar stays one quiet line; picking a tab there brings
//! that agent to the front of the bar.

use super::{
    Reading,
    model::{Severity, Window as Limit},
    panel::PANEL_GAP,
};
use crate::{config::status_bar::Detail, window::HerdrWindow};
use gpui::{prelude::*, *};
use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, SystemTime},
};

const METER_WIDTH: f32 = 40.;
/// Windows a detailed segment names at most; the panel lists the rest. A
/// service with many model quotas would otherwise crowd out the whole bar.
pub(super) const BAR_WINDOWS: usize = 2;

impl HerdrWindow {
    /// The provider chosen in the panel, then those closest to a limit, at
    /// most [`super::HEADLINE`]; nothing when usage is hidden or no provider
    /// on the host has numbers yet.
    pub(crate) fn render_usage(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let entry = self.usage.current();
        let shown = entry
            .map(|entry| entry.headline(super::HEADLINE, self.usage.chosen()))
            .unwrap_or_default();
        // A host that could not be read at all says so, but only while
        // there is nothing older to show.
        let host_error = entry
            .and_then(|entry| entry.error.clone())
            .filter(|_| shown.is_empty());
        if !self.config.usage.show || (shown.is_empty() && host_error.is_none()) {
            return None;
        }
        let busy = self.usage.busy();
        let now = SystemTime::now();
        let theme = &self.theme;
        let mut row = div()
            .id("usage")
            .debug_selector(|| "usage".into())
            .flex()
            .flex_shrink_1()
            .min_w_0()
            .overflow_hidden()
            .items_center()
            .gap(px(4.));
        for reading in &shown {
            row = row.child(self.usage_segment(reading, now, cx));
        }
        if let Some(error) = host_error {
            let (foreground, surface) = (theme.foreground, theme.surface);
            let error = SharedString::from(error);
            row = row.child(
                div()
                    .id("usage-host-error")
                    .debug_selector(|| "usage-host-error".into())
                    .min_w_0()
                    .truncate()
                    .text_color(rgb(theme.muted))
                    .child("Usage unavailable")
                    .tooltip(move |_, cx| {
                        let text = error.clone();
                        cx.new(|_| Hint {
                            text,
                            foreground,
                            surface,
                        })
                        .into()
                    }),
            );
        }
        let refresh = svg()
            .path("icons/refresh.svg")
            .size(px(11.))
            .text_color(rgb(theme.muted));
        // The segments clip when crowded; refresh stays in reach beside them.
        Some(
            div()
                .flex()
                .flex_shrink_1()
                .min_w_0()
                .items_center()
                .gap(px(4.))
                .child(row)
                .child(
                    div()
                        .id("usage-refresh")
                        .debug_selector(|| "usage-refresh".into())
                        .size(px(18.))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(crate::config::corners::CONTROL))
                        .cursor_pointer()
                        .hover(|s| s.bg(rgb(theme.active)))
                        .child(if busy {
                            refresh
                                .with_animation(
                                    "usage-refreshing",
                                    Animation::new(Duration::from_secs(1)).repeat(),
                                    |icon, delta| {
                                        icon.with_transformation(Transformation::rotate(
                                            percentage(delta),
                                        ))
                                    },
                                )
                                .into_any_element()
                        } else {
                            refresh.into_any_element()
                        })
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.usage.refresh(std::time::Instant::now());
                            cx.notify();
                        })),
                ),
        )
    }

    fn usage_segment(
        &self,
        reading: &Reading,
        now: SystemTime,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = &self.theme;
        let provider = reading.provider;
        let key = provider.id();
        let bounds = Rc::new(Cell::new(Bounds::<Pixels>::default()));
        let painted = bounds.clone();
        let open = self.menu.page == Some(crate::menu::Page::Usage(provider));
        let mut segment = div()
            .id(SharedString::from(format!("usage-{key}")))
            .debug_selector(move || format!("usage-{key}"))
            .relative()
            .flex()
            // Whole segments: a crowded bar clips the last ones rather than
            // truncating every label mid-word.
            .flex_none()
            .items_center()
            .gap(px(6.))
            .px(px(6.))
            .rounded(px(crate::config::corners::CONTROL))
            .cursor_pointer()
            .hover(|s| s.bg(rgb(theme.active)))
            .when(open, |segment| segment.bg(rgb(theme.active)))
            .child(
                svg()
                    .path(provider.icon())
                    .size(px(12.))
                    .flex_none()
                    .text_color(rgb(theme.foreground)),
            )
            .child(
                canvas(|_, _, _| (), move |area, _, _, _| painted.set(area))
                    .absolute()
                    .inset_0()
                    .size_full(),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                // Anchored to the segment, not the pointer, so the panel keeps
                // the same gap above the bar wherever the click landed.
                let origin = bounds.get().origin;
                this.open_usage(
                    provider,
                    point(origin.x, origin.y - px(PANEL_GAP)),
                    window,
                    cx,
                );
            }));
        let Some(report) = &reading.report else {
            // Waiting on Keychain access: the lock says why there are no
            // numbers, and the click opens the panel that asks.
            return segment.when(reading.access.is_some(), |segment| {
                segment.child(
                    svg()
                        .path("icons/lock.svg")
                        .size(px(11.))
                        .flex_none()
                        .text_color(rgb(theme.muted)),
                )
            });
        };
        let mut labels = div()
            .flex()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .gap(px(4.));
        match self.config.status_bar.usage {
            Detail::Compact => {
                if let Some(tightest) = report.tightest() {
                    labels = labels.child(
                        div()
                            .text_color(rgb(color(tightest.used.into(), theme, theme.foreground)))
                            .child(format!("{}%", tightest.percent())),
                    );
                }
            }
            Detail::Detailed => {
                if let Some(tightest) = report.tightest() {
                    segment = segment.child(meter(tightest, theme));
                }
                for (index, window) in bar_windows(&report.windows).enumerate() {
                    if index > 0 {
                        labels = labels.child(div().text_color(rgb(theme.muted)).child("·"));
                    }
                    labels = labels.child(
                        div()
                            .text_color(rgb(color(window.used.into(), theme, theme.foreground)))
                            .child(window.label(now)),
                    );
                }
            }
        }
        // A service that meters money or credits rather than a window shows
        // what is left or spent.
        if report.windows.is_empty()
            && let Some(balance) = report.balances.first()
        {
            labels = labels.child(balance.amount_text());
        }
        segment
            .child(labels)
            // The numbers are the last good ones; the panel says why.
            .when(reading.error.is_some(), |segment| {
                segment.child(
                    div()
                        .flex_none()
                        .text_color(rgb(theme.ink(theme.palette[3])))
                        .child("!"),
                )
            })
    }
}

/// The [`BAR_WINDOWS`] windows closest to their limits, in report order so
/// the session window keeps its place before the weekly one.
pub(super) fn bar_windows(windows: &[Limit]) -> impl Iterator<Item = &Limit> {
    let mut tightest: Vec<usize> = (0..windows.len()).collect();
    // Stable, so equally used windows keep report order.
    tightest.sort_by(|&a, &b| windows[b].used.total_cmp(&windows[a].used));
    tightest.truncate(BAR_WINDOWS);
    tightest.sort_unstable();
    tightest.into_iter().map(|index| &windows[index])
}

fn color(severity: Severity, theme: &crate::config::Theme, normal: u32) -> u32 {
    match severity {
        Severity::Normal => normal,
        Severity::Warning => theme.ink(theme.palette[3]),
        Severity::Critical => theme.ink(theme.palette[1]),
    }
}

fn meter(window: &Limit, theme: &crate::config::Theme) -> impl IntoElement {
    div()
        .w(px(METER_WIDTH))
        .h(px(5.))
        .flex_none()
        .rounded_full()
        .overflow_hidden()
        .bg(rgb(theme.active))
        .child(
            div()
                .h_full()
                .w(px(METER_WIDTH * window.used / 100.))
                .rounded_full()
                .bg(rgb(color(window.used.into(), theme, theme.muted))),
        )
}

pub(super) fn ago(elapsed: Duration) -> String {
    match elapsed.as_secs() {
        0..60 => "less than a minute".into(),
        seconds => super::model::countdown(Duration::from_secs(seconds - seconds % 60)),
    }
}

/// A small tooltip in the status bar's colors.
pub(crate) struct Hint {
    pub(crate) text: SharedString,
    pub(crate) foreground: u32,
    pub(crate) surface: u32,
}

impl Render for Hint {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(8.))
            .py(px(4.))
            .rounded(px(crate::config::corners::CONTROL))
            .shadow_md()
            .text_size(px(12.))
            .text_color(rgb(self.foreground))
            .bg(rgb(self.surface))
            .child(self.text.clone())
    }
}
