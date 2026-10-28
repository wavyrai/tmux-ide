//! The checkpoint list as a timeline: one monospace line per checkpoint on a
//! rail of dots, with its clock time and diff, and a day break wherever the
//! date changes.

use crate::{
    HerdrWindow,
    checkpoint::Checkpoint,
    config::{corners, mix},
    fonts::StyledFont,
};
use chrono::{DateTime, Datelike, Days, TimeZone};
use gpui::{prelude::*, *};

/// The least height of a line; the rail's dot sits on its center line.
const MIN_ROW: f32 = 26.;
const GUTTER: f32 = 20.;
const STROKE: f32 = 2.;

/// Each line's height: the face's own line height plus a little air, so a
/// large terminal font grows the rows instead of spilling into the next.
pub(super) fn row_height(face: &crate::config::FontConfig) -> f32 {
    (face.line_height() + 6.).max(MIN_ROW).ceil()
}

/// `created` (Unix seconds) as a wall-clock time in `zone`.
pub(super) fn clock<Z: TimeZone>(created: i64, zone: &Z) -> String
where
    Z::Offset: std::fmt::Display,
{
    DateTime::from_timestamp(created, 0)
        .map(|at| at.with_timezone(zone).format("%H:%M").to_string())
        .unwrap_or_default()
}

/// The heading for the day `created` falls on, seen from `now`: none for
/// today, "Yesterday, Oct 7", "Mon, Oct 5", or "Oct 5, 2025" in another year.
pub(super) fn day_heading<Z: TimeZone>(created: i64, now: i64, zone: &Z) -> Option<String>
where
    Z::Offset: std::fmt::Display,
{
    let date = DateTime::from_timestamp(created, 0)?
        .with_timezone(zone)
        .date_naive();
    let today = DateTime::from_timestamp(now, 0)?
        .with_timezone(zone)
        .date_naive();
    if date == today {
        return None;
    }
    let format = if today.checked_sub_days(Days::new(1)) == Some(date) {
        "Yesterday, %b %-d"
    } else if date.year() == today.year() {
        "%a, %b %-d"
    } else {
        "%b %-d, %Y"
    };
    Some(date.format(format).to_string())
}

/// The calendar day `created` falls on, to tell where a day break goes.
fn day<Z: TimeZone>(created: i64, zone: &Z) -> Option<chrono::NaiveDate> {
    Some(
        DateTime::from_timestamp(created, 0)?
            .with_timezone(zone)
            .date_naive(),
    )
}

impl HerdrWindow {
    pub(super) fn render_checkpoint_timeline(
        &self,
        list: &[Checkpoint],
        now: i64,
        cx: &mut Context<Self>,
    ) -> Div {
        let Some(view) = &self.checkpoints.view else {
            return div();
        };
        let theme = &self.theme;
        let face = &self.config.terminal;
        let zone = chrono::Local;
        let height = row_height(face);
        let rail = rgb(mix(theme.surface, theme.muted, 60));
        let muted = rgb(theme.muted);
        // A segment of the rail: the half above or below a line's center.
        let segment = |top: Option<f32>| {
            let line = div()
                .absolute()
                .left(px((GUTTER - STROKE) / 2.))
                .w(px(STROKE))
                .bg(rail);
            match top {
                Some(top) => line.top(px(top)).bottom_0(),
                None => line.top_0().h(px(height / 2.)),
            }
        };
        let gutter = || div().relative().flex_none().w(px(GUTTER)).h_full();
        let mut timeline = div()
            .flex()
            .flex_col()
            .text_font(face)
            .text_size(px(face.size))
            .line_height(px(face.line_height()));
        let mut previous = day(now, &zone);
        let last = list.len().saturating_sub(1);
        for (index, checkpoint) in list.iter().enumerate() {
            let date = day(checkpoint.created, &zone);
            if date != previous {
                previous = date;
                if let Some(heading) = day_heading(checkpoint.created, now, &zone) {
                    timeline = timeline.child(
                        div()
                            .debug_selector(move || format!("checkpoint-day-{index}"))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .pl(px(4.))
                            .h(px(height))
                            .child(
                                gutter()
                                    .when(index > 0, |gutter| gutter.child(segment(None)))
                                    .child(segment(Some(height / 2.))),
                            )
                            .child(div().min_w_0().truncate().text_color(muted).child(heading)),
                    );
                }
            }
            let selected = view.selected == Some(index);
            let restorable = view.restorable(checkpoint);
            let changed = checkpoint.diff.files > 0;
            // Changed turns stand out; empty ones, and ones from another
            // branch that cannot be restored here, recede.
            let (size, dot) = if changed && restorable {
                (10., theme.primary())
            } else {
                (6., theme.muted)
            };
            let text = if changed && restorable {
                theme.foreground
            } else {
                theme.muted
            };
            let group = SharedString::from(format!("checkpoint-row-{index}"));
            let id = checkpoint.id.clone();
            let mut row = div()
                .id(("checkpoint", index))
                .debug_selector(move || format!("checkpoint-{index}"))
                .group(group.clone())
                .flex()
                .items_center()
                .gap(px(6.))
                .pl(px(4.))
                .pr(px(8.))
                .h(px(height))
                .rounded(px(corners::SMALL))
                .when(selected, |row| row.bg(rgb(theme.active)))
                .hover(|row| row.bg(rgb(theme.active)))
                .child(
                    gutter()
                        .when(index > 0, |gutter| gutter.child(segment(None)))
                        .when(index < last, |gutter| {
                            gutter.child(segment(Some(height / 2.)))
                        })
                        .child(
                            div()
                                .absolute()
                                .left(px((GUTTER - size) / 2.))
                                .top(px((height - size) / 2.))
                                .size(px(size))
                                .rounded_full()
                                .bg(rgb(dot)),
                        ),
                )
                .child(
                    div()
                        .flex_none()
                        .text_color(muted)
                        .child(clock(checkpoint.created, &zone)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(rgb(text))
                        .child(crate::sidebar::label_text(&checkpoint.label)),
                );
            if changed {
                let diff = checkpoint.diff;
                row = row
                    .child(
                        div()
                            .flex_none()
                            .text_color(rgb(theme.ink(theme.palette[2])))
                            .child(format!("+{}", diff.additions)),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_color(rgb(theme.ink(theme.palette[1])))
                            .child(format!("\u{2212}{}", diff.deletions)),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_color(muted)
                            .child(format!("{}f", diff.files)),
                    );
            }
            // The restore icon shows on the selected or hovered line only, so
            // a long list does not repeat it on every line.
            row = row.child(
                div()
                    .id(("checkpoint-restore", index))
                    .debug_selector(move || format!("checkpoint-restore-{index}"))
                    .flex_none()
                    .size(px(16.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(restorable, |button| {
                        button
                            .cursor_pointer()
                            .when(!selected, |button| {
                                button
                                    .opacity(0.)
                                    .group_hover(group, |button| button.opacity(1.))
                            })
                            .child(
                                svg()
                                    .path("icons/refresh.svg")
                                    .size(px(14.))
                                    .text_color(rgb(theme.foreground)),
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                if let Some(view) = &mut this.checkpoints.view {
                                    view.selected = Some(index);
                                    view.confirming = Some(id.clone());
                                }
                                cx.notify();
                            }))
                    }),
            );
            timeline = timeline.child(row.on_click(cx.listener(move |this, _, _, cx| {
                if let Some(view) = &mut this.checkpoints.view {
                    view.selected = Some(index);
                }
                cx.notify();
            })));
        }
        timeline
    }
}
