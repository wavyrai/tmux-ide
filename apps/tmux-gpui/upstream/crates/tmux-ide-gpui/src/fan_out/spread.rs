//! The fan-out dialog's host section: spreading lanes over the best hosts,
//! and choosing one lane's host from every host, best first.

use super::state::FanOut;
use crate::{HerdrWindow, icons::AgentIcon, toggles::checkbox};
use gpui::{prelude::*, *};

impl HerdrWindow {
    /// The spread switch and, while spreading, each lane with its host.
    /// Nothing when the origin is the only host lanes could run on.
    pub(super) fn render_fan_out_spread(
        &self,
        fan_out: &FanOut,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        if !fan_out.can_spread() {
            return None;
        }
        let theme = &self.theme;
        let size = self.config.ui.size;
        let hint = fan_out
            .hosts
            .suggestion()
            .map(|best| format!("{} has the most room", best.label));
        let switch = div()
            .id("fan-out-spread")
            .debug_selector(|| "fan-out-spread".into())
            .flex()
            .items_center()
            .gap(px(8.))
            .cursor_pointer()
            .on_click(cx.listener(|this, _, _, cx| {
                cx.stop_propagation();
                if let Some(fan_out) = &mut this.fan_out
                    && fan_out.toggle_spread()
                {
                    cx.notify();
                }
            }))
            .child(checkbox(theme, size, fan_out.spread))
            .child(div().flex_1().min_w_0().child("Spread agents across hosts"))
            .children(hint.map(|hint| {
                div()
                    .flex_none()
                    .text_color(rgb(theme.subtext()))
                    .child(hint)
            }));
        let mut section = div().flex().flex_col().gap(px(4.)).child(switch);
        if !fan_out.spread {
            return Some(section);
        }
        for (lane, (kind, host)) in fan_out.picks.kinds().zip(fan_out.lane_hosts()).enumerate() {
            let (chip, list) = self.render_lane_host(&fan_out.hosts, lane, &host, cx);
            section = section
                .child(
                    div()
                        .debug_selector(move || format!("fan-out-lane-host-{lane}"))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .px(px(10.))
                        .py(px(3.))
                        .rounded(px(crate::config::corners::CONTROL))
                        .bg(rgb(theme.surface))
                        .child(
                            svg()
                                .path(AgentIcon::from_identity(Some(kind.name())).path())
                                .size(px(14.))
                                .flex_none()
                                .text_color(rgb(theme.foreground)),
                        )
                        .child(div().flex_1().min_w_0().truncate().child(kind.name()))
                        .child(chip),
                )
                .children(list);
        }
        Some(section)
    }
}
