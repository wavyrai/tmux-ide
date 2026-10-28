//! The pieces a provider's panel is drawn from, in the window's theme: a
//! limit with its bar and pace, balances, facts, and shares. [`Ui::standard`]
//! lays out a report's shared fields; a provider's own `render` may compose
//! the same pieces around its detail.

use super::model::{Balance, Pace, Report, Section, Severity, Window as Limit, countdown};
use crate::config::Theme;
use gpui::{prelude::*, *};
use std::time::SystemTime;

pub(crate) struct Ui {
    pub theme: Theme,
    pub font_size: f32,
    pub now: SystemTime,
}

impl Ui {
    pub fn small(&self) -> Pixels {
        px(self.font_size * 0.9)
    }

    pub fn muted(&self) -> Rgba {
        rgb(self.theme.muted)
    }

    /// Windows, then balances, then sections, each group ruled off.
    pub fn standard(&self, report: &Report) -> AnyElement {
        let mut body = div()
            .flex()
            .flex_col()
            .children(report.windows.iter().map(|limit| self.limit(limit)));
        let mut drawn = !report.windows.is_empty();
        if !report.balances.is_empty() {
            body = body
                .when(drawn, |body| body.child(self.rule()))
                .child(self.balances(&report.balances));
            drawn = true;
        }
        for section in &report.sections {
            body = body
                .when(drawn, |body| body.child(self.rule()))
                .child(self.section(section));
            drawn = true;
        }
        body.into_any_element()
    }

    pub fn rule(&self) -> Div {
        div().h(px(1.)).my(px(6.)).bg(rgb(self.theme.active))
    }

    pub fn heading(&self, title: impl Into<SharedString>) -> Div {
        div().font_weight(FontWeight::SEMIBOLD).child(title.into())
    }

    /// Padding every block shares, so custom blocks line up with standard ones.
    pub fn block(&self) -> Div {
        div().px(px(8.)).py(px(6.)).flex().flex_col().gap(px(4.))
    }

    /// `Weekly 89% left`, its reset, a bar of what is left with a tick where
    /// an even spend would be, and whether the rest lasts.
    pub fn limit(&self, limit: &Limit) -> AnyElement {
        let pace = limit.pace(self.now);
        self.block()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .gap(px(8.))
                    .child(self.heading(format!("{} {}% left", limit.kind.title(), limit.left())))
                    .children(limit.resets_in(self.now).map(|left| {
                        div()
                            .flex_none()
                            .text_size(self.small())
                            .text_color(self.muted())
                            .child(format!("Resets in {}", countdown(left)))
                    })),
            )
            .child(self.bar(100. - limit.used, limit.used, pace))
            .children(pace.map(|pace| {
                div()
                    .text_size(self.small())
                    .text_color(self.muted())
                    .child(pace.describe(limit.used))
            }))
            .into_any_element()
    }

    /// One row per balance; one with a total gets a bar of what is left.
    pub fn balances(&self, balances: &[Balance]) -> AnyElement {
        self.block()
            .children(balances.iter().map(|balance| {
                let row = div()
                    .flex()
                    .justify_between()
                    .gap(px(8.))
                    .child(div().text_color(self.muted()).child(balance.label.clone()))
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(balance.text()),
                    );
                match balance.total.filter(|total| *total > 0.) {
                    Some(total) => {
                        let left = (balance.amount / total * 100.).clamp(0., 100.) as f32;
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(row)
                            .child(self.bar(left, 100. - left, None))
                            .into_any_element()
                    }
                    None => row.into_any_element(),
                }
            }))
            .into_any_element()
    }

    pub fn facts(&self, title: &str, facts: &[(String, String)]) -> AnyElement {
        self.block()
            .child(self.heading(title.to_owned()))
            .children(facts.iter().map(|(label, value)| {
                div()
                    .flex()
                    .justify_between()
                    .gap(px(8.))
                    .text_size(self.small())
                    .child(div().text_color(self.muted()).child(label.clone()))
                    .child(div().child(value.clone()))
            }))
            .into_any_element()
    }

    pub fn shares(&self, title: &str, shares: &[(String, f32)]) -> AnyElement {
        self.block()
            .child(self.heading(title.to_owned()))
            .children(shares.iter().map(|(label, share)| {
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(self.small())
                    .child(
                        div()
                            .w(px(96.))
                            .flex_none()
                            .truncate()
                            .text_color(self.muted())
                            .child(label.clone()),
                    )
                    .child(div().flex_1().child(self.bar(*share, 0., None)))
                    .child(
                        div()
                            .w(px(36.))
                            .flex_none()
                            .flex()
                            .justify_end()
                            .child(format!("{}%", share.round())),
                    )
            }))
            .into_any_element()
    }

    pub fn section(&self, section: &Section) -> AnyElement {
        match section {
            Section::Limit(limit) => self.limit(limit),
            Section::Facts { title, facts } => self.facts(title, facts),
            Section::Shares { title, shares } => self.shares(title, shares),
        }
    }

    /// A full-width bar filled to `fill` percent, colored by how much of the
    /// limit is `used`, with a tick where an even spend would have left it.
    pub fn bar(&self, fill: f32, used: f32, pace: Option<Pace>) -> Div {
        let theme = &self.theme;
        let color = match Severity::from(used) {
            Severity::Normal => crate::menu::accent(theme),
            Severity::Warning => rgb(theme.ink(theme.palette[3])),
            Severity::Critical => rgb(theme.ink(theme.palette[1])),
        };
        div()
            .relative()
            .h(px(6.))
            .w_full()
            .rounded_full()
            .bg(rgb(theme.active))
            .child(
                div()
                    .h_full()
                    .w(relative(fill.clamp(0., 100.) / 100.))
                    .rounded_full()
                    .bg(color),
            )
            .children(pace.map(|pace| {
                div()
                    .absolute()
                    .top(px(-2.))
                    .h(px(10.))
                    .w(px(2.))
                    .left(relative((100. - pace.expected).clamp(0., 100.) / 100.))
                    .bg(rgb(theme.foreground))
            }))
    }
}
