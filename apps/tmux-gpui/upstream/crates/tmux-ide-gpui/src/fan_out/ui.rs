//! The fan-out dialog: write a prompt and pick agents, follow the launch,
//! then compare the lanes and keep one. Closing the dialog never stops a
//! launch or removal: stopping halfway would strand checkouts. A launched
//! fan-out stays on the window so its comparison can be reopened from the
//! workspace menu.

use super::{
    plan::MAX_LANES,
    state::{LaneState, Stage, agent_status, seed},
};
use crate::{
    HerdrWindow,
    icons::AgentIcon,
    menu::Page,
    progress::{self, Progress as Bar},
    teleport::Follow,
    window::Flash,
};
use gpui::{prelude::*, *};
use herdr_client::protocol::ClientShellSnapshot;
use std::time::Instant;

impl HerdrWindow {
    /// The snapshot of the host a fan-out runs on, if it is still connected.
    fn fan_out_snapshot(&self, endpoint_id: &str) -> Option<&ClientShellSnapshot> {
        let (index, endpoint) = self
            .endpoints
            .iter()
            .enumerate()
            .find(|(_, endpoint)| endpoint.id == endpoint_id)?;
        let live = if index == self.selected_endpoint {
            &self.live
        } else {
            &endpoint.live
        };
        live.snapshot
            .as_deref()
            .filter(|_| live.status.is_connected())
    }

    pub(crate) fn poll_fan_out(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open = self.menu.page == Some(Page::FanOut);
        let Some(fan_out) = &mut self.fan_out else {
            return;
        };
        if !open {
            // Nothing was created yet, so there is nothing to come back to.
            if fan_out.composing() {
                self.fan_out = None;
                return;
            }
            fan_out.stop_probe();
        }
        let was_launching = matches!(fan_out.stage, Stage::Launching);
        let (mut changed, kept) = fan_out.poll();
        if open {
            changed |= fan_out.refresh(Instant::now());
        }
        if was_launching && !open && matches!(fan_out.stage, Stage::Compare) {
            let running = fan_out
                .lanes
                .iter()
                .filter(|lane| lane.state == LaneState::Running)
                .count();
            let total = fan_out.lanes.len();
            let text = format!(
                "Fan-out: {running} of {total} agent(s) prompted. Compare them from the workspace menu."
            );
            let flash = if running == total {
                Flash::success(text)
            } else {
                Flash::warning(text)
            };
            self.show_flash(flash, cx);
            return cx.notify();
        }
        if let Some((endpoint, workspace)) = kept {
            self.fan_out = None;
            if open {
                self.dismiss_menu(window, cx);
            }
            self.show_flash(Flash::success("Kept one lane; removed the others"), cx);
            self.teleport_follow = Some(Follow::new(endpoint, workspace));
            return;
        }
        if changed {
            cx.notify();
        }
    }

    pub(crate) fn fan_out_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        window.prevent_default();
        match event.keystroke.key.as_str() {
            "escape" => self.fan_out_back(window, cx),
            "enter" => self.submit_fan_out(cx),
            _ => {}
        }
    }

    /// Escape steps back out of a confirmation before it closes the dialog.
    fn fan_out_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(fan_out) = &mut self.fan_out
            && let Stage::Confirm(_) = fan_out.stage
        {
            fan_out.stage = Stage::Compare;
            fan_out.error = None;
            cx.notify();
            return;
        }
        self.dismiss_menu(window, cx);
    }

    fn submit_fan_out(&mut self, cx: &mut Context<Self>) {
        let prompt = self
            .menu
            .input
            .as_ref()
            .map(|input| input.text.clone())
            .unwrap_or_default();
        // Other hosts are described before the fan-out is borrowed to launch.
        let destinations: Vec<_> = self
            .fan_out
            .as_ref()
            .filter(|fan_out| fan_out.composing())
            .map(|fan_out| fan_out.lane_hosts())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|endpoint| self.dispatch_destination(&endpoint))
            .collect();
        let Some(fan_out) = &mut self.fan_out else {
            return;
        };
        match fan_out.stage {
            Stage::Compose(_) => {
                let destination = |endpoint: &str| {
                    destinations
                        .iter()
                        .find(|found| found.place.endpoint_id == endpoint)
                        .cloned()
                };
                if fan_out.launch(&prompt, seed(), destination) {
                    // The prompt is sent; the comparison takes the keyboard.
                    self.menu.input = None;
                }
            }
            Stage::Confirm(winner) => {
                fan_out.keep(winner);
            }
            _ => return,
        }
        cx.notify();
    }

    fn open_fan_out_lane(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(fan_out) = &self.fan_out else {
            return;
        };
        let Some(checkout) = fan_out.lanes.get(index).and_then(|l| l.checkout.as_ref()) else {
            return;
        };
        let follow = Follow::new(checkout.endpoint_id.clone(), checkout.workspace_id.clone());
        self.dismiss_menu(window, cx);
        self.teleport_follow = Some(follow);
    }

    pub(crate) fn render_fan_out(&self, cx: &mut Context<Self>) -> Div {
        let Some(fan_out) = &self.fan_out else {
            return div();
        };
        let theme = &self.theme;
        let font = &self.config.ui;
        let muted = rgb(theme.muted);
        let danger = crate::menu::danger(theme);
        let line = |text: String| div().min_w_0().child(text);
        let small = |id: &'static str, index: usize| {
            div()
                .id((id, index))
                .debug_selector(move || format!("{id}-{index}"))
                .px(px(8.))
                .py(px(2.))
                .rounded(px(crate::config::corners::CONTROL))
                .border_1()
                .border_color(rgb(theme.active))
                .cursor_pointer()
                .hover(|button| button.bg(rgb(theme.active)))
        };
        let prompt = self
            .menu
            .input
            .as_ref()
            .map(|input| input.text.as_str())
            .unwrap_or_default();
        let mut body = div().flex().flex_col().gap(px(8.)).px(px(16.)).py(px(12.));
        let (primary, armed) = match &fan_out.stage {
            Stage::Compose(installed) => {
                body = body.child(
                    line(format!(
                        "Each agent gets its own new worktree from {}, then the same prompt.",
                        fan_out
                            .origin
                            .base
                            .strip_prefix("refs/heads/")
                            .unwrap_or(&fan_out.origin.base)
                    ))
                    .text_color(muted),
                );
                if self.menu.input.is_some() {
                    body = body.child(self.render_dialog_input(cx));
                }
                match installed {
                    None => {
                        body = body
                            .child(progress::bar(
                                "fan-out-progress",
                                Bar::Busy,
                                crate::menu::accent(theme).into(),
                                rgb(theme.active).into(),
                            ))
                            .child(
                                line("Looking for installed agents...".into()).text_color(muted),
                            );
                    }
                    Some(Err(error)) => {
                        body = body.child(
                            line(error.clone())
                                .debug_selector(|| "fan-out-error".into())
                                .text_color(danger),
                        );
                    }
                    Some(Ok(kinds)) if kinds.is_empty() => {
                        body = body.child(
                            line(format!(
                                "No supported agent is installed on {}.",
                                fan_out.origin.endpoint_label
                            ))
                            .text_color(danger),
                        );
                    }
                    Some(Ok(kinds)) => {
                        body = body.child(line(format!(
                            "Agents · {} of {MAX_LANES}",
                            fan_out.picks.total()
                        )));
                        for (index, kind) in kinds.iter().copied().enumerate() {
                            let count = fan_out.picks.count(kind);
                            body = body.child(
                                div()
                                    .id(("fan-out-agent", index))
                                    .debug_selector(move || format!("fan-out-agent-{index}"))
                                    .px(px(10.))
                                    .py(px(4.))
                                    .rounded(px(crate::config::corners::CONTROL))
                                    .when(count > 0, |row| row.bg(rgb(theme.active)))
                                    .flex()
                                    .items_center()
                                    .gap(px(10.))
                                    .child(
                                        svg()
                                            .path(
                                                AgentIcon::from_identity(Some(kind.name())).path(),
                                            )
                                            .size(px(14.))
                                            .flex_none()
                                            .text_color(rgb(theme.foreground)),
                                    )
                                    .child(div().flex_1().min_w_0().truncate().child(kind.name()))
                                    .when(count > 0, |row| {
                                        row.child(small("fan-out-less", index).child("−").on_click(
                                            cx.listener(move |this, _, _, cx| {
                                                cx.stop_propagation();
                                                if let Some(fan_out) = &mut this.fan_out
                                                    && fan_out.toggle(kind, false)
                                                {
                                                    cx.notify();
                                                }
                                            }),
                                        ))
                                        .child(
                                            div()
                                                .debug_selector(move || {
                                                    format!("fan-out-count-{index}")
                                                })
                                                .min_w(px(16.))
                                                .flex()
                                                .justify_center()
                                                .child(count.to_string()),
                                        )
                                    })
                                    .child(small("fan-out-more", index).child("+").on_click(
                                        cx.listener(move |this, _, _, cx| {
                                            cx.stop_propagation();
                                            if let Some(fan_out) = &mut this.fan_out
                                                && fan_out.toggle(kind, true)
                                            {
                                                cx.notify();
                                            }
                                        }),
                                    )),
                            );
                        }
                    }
                }
                body = body.children(self.render_fan_out_spread(fan_out, cx));
                let lanes = fan_out.picks.total();
                let label = match (lanes, fan_out.host_count()) {
                    (0 | 1, _) => "Start agent".to_owned(),
                    (lanes, 0 | 1) => format!("Start {lanes} agents"),
                    (lanes, hosts) => format!("Start {lanes} agents on {hosts} hosts"),
                };
                (label, fan_out.not_ready(prompt).is_none())
            }
            Stage::Launching | Stage::Compare | Stage::Confirm(_) | Stage::Removing(_) => {
                let comparing = !matches!(fan_out.stage, Stage::Launching);
                body = body.child(
                    line(format!("“{}”", fan_out.prompt))
                        .debug_selector(|| "fan-out-prompt".into())
                        .text_color(muted),
                );
                if !comparing {
                    let settled = fan_out.lanes.iter().filter(|l| l.state.settled()).count();
                    body = body.child(progress::bar(
                        "fan-out-progress",
                        Bar::Working(settled as f32 / fan_out.lanes.len().max(1) as f32),
                        crate::menu::accent(theme).into(),
                        rgb(theme.active).into(),
                    ));
                }
                for (index, lane) in fan_out.lanes.iter().enumerate() {
                    let failed = matches!(lane.state, LaneState::Failed(_));
                    let mut status = match (&lane.state, &lane.checkout) {
                        (LaneState::Running, Some(checkout)) if comparing => agent_status(
                            self.fan_out_snapshot(&checkout.endpoint_id),
                            &checkout.workspace_id,
                        )
                        .to_owned(),
                        (state, _) => state.label().to_owned(),
                    };
                    // A lane elsewhere says where it runs.
                    if let Some(checkout) = lane
                        .checkout
                        .as_ref()
                        .filter(|c| c.endpoint_id != fan_out.origin.endpoint_id)
                    {
                        let host = self
                            .endpoints
                            .iter()
                            .find(|endpoint| endpoint.id == checkout.endpoint_id)
                            .map_or(checkout.endpoint_id.as_str(), |e| e.label.as_str());
                        status = format!("{status} · {host}");
                    }
                    let mut changes = match (&lane.checkout, lane.stats) {
                        (None, _) => None,
                        (Some(_), Some(stats)) => Some(stats.summary()),
                        (Some(_), None) if comparing => Some("Reading changes...".to_owned()),
                        (Some(_), None) => None,
                    };
                    // A host that could not be read says so; any changes
                    // read before stay beside it.
                    let unread = lane.unread.as_ref().filter(|_| lane.checkout.is_some());
                    if let Some(unread) = unread {
                        changes = Some(match lane.stats {
                            Some(stats) => format!("{} · not updated: {unread}", stats.summary()),
                            None => format!("Changes not read: {unread}"),
                        });
                    }
                    let winner = matches!(
                        fan_out.stage,
                        Stage::Confirm(kept) | Stage::Removing(kept) if kept == index
                    );
                    let actionable =
                        lane.checkout.is_some() && matches!(fan_out.stage, Stage::Compare);
                    body = body.child(
                        div()
                            .id(("fan-out-lane", index))
                            .debug_selector(move || format!("fan-out-lane-{index}"))
                            .px(px(10.))
                            .py(px(6.))
                            .rounded(px(crate::config::corners::CONTROL))
                            .when(winner, |row| row.bg(rgb(theme.active)))
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .child(
                                svg()
                                    .path(
                                        AgentIcon::from_identity(Some(lane.lane.kind.name()))
                                            .path(),
                                    )
                                    .size(px(16.))
                                    .flex_none()
                                    .text_color(rgb(theme.foreground)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .truncate()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(lane.lane.branch.clone()),
                                    )
                                    .child(
                                        div()
                                            .truncate()
                                            .debug_selector(move || {
                                                format!("fan-out-status-{index}")
                                            })
                                            .text_color(if failed { danger } else { muted })
                                            .child(status),
                                    )
                                    .when_some(changes, |column, changes| {
                                        column.child(
                                            div()
                                                .truncate()
                                                .debug_selector(move || {
                                                    format!("fan-out-changes-{index}")
                                                })
                                                .when(unread.is_some(), |text| {
                                                    text.text_color(danger)
                                                })
                                                .child(changes),
                                        )
                                    }),
                            )
                            .when(actionable, |row| {
                                row.child(small("fan-out-open", index).child("Open").on_click(
                                    cx.listener(move |this, _, window, cx| {
                                        cx.stop_propagation();
                                        this.open_fan_out_lane(index, window, cx);
                                    }),
                                ))
                                .child(
                                    small("fan-out-keep", index).child("Keep").on_click(
                                        cx.listener(move |this, _, _, cx| {
                                            cx.stop_propagation();
                                            if let Some(fan_out) = &mut this.fan_out {
                                                fan_out.stage = Stage::Confirm(index);
                                                fan_out.error = None;
                                                cx.notify();
                                            }
                                        }),
                                    ),
                                )
                            }),
                    );
                }
                match fan_out.stage {
                    Stage::Launching => {
                        body = body.child(
                            line("Closing this dialog does not stop the launch.".into())
                                .text_color(muted),
                        );
                        ("Starting...".to_owned(), false)
                    }
                    Stage::Compare => {
                        body = body.child(
                            line("Keep the lane you prefer to remove the others.".into())
                                .text_color(muted),
                        );
                        ("Keep...".to_owned(), false)
                    }
                    Stage::Confirm(winner) => {
                        let others = fan_out.doomed(winner).len();
                        body = body.child(
                            line(format!(
                                "Removes the other {others} worktree(s) and their uncommitted changes. Their branches stay, with any commits."
                            ))
                            .debug_selector(|| "fan-out-confirm".into())
                            .text_color(danger),
                        );
                        (format!("Remove {others} other(s)"), true)
                    }
                    _ => {
                        body = body.child(progress::bar(
                            "fan-out-progress",
                            Bar::Busy,
                            crate::menu::accent(theme).into(),
                            rgb(theme.active).into(),
                        ));
                        ("Removing...".to_owned(), false)
                    }
                }
            }
        };
        if let Some(error) = &fan_out.error {
            body = body.child(
                line(error.clone())
                    .debug_selector(|| "fan-out-error".into())
                    .text_color(danger),
            );
        }
        let button = |id: &'static str| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .px(px(12.))
                .py(px(6.))
                .rounded(px(crate::config::corners::CONTROL))
                .border_1()
                .cursor_pointer()
        };
        let dismiss = match fan_out.stage {
            Stage::Compose(_) => "Cancel",
            Stage::Confirm(_) => "Back",
            // Work under way carries on; closing only hides it.
            _ if fan_out.busy() => "Hide",
            _ => "Close",
        };
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(16.))
                    .py(px(12.))
                    .border_b_1()
                    .border_color(rgb(theme.active))
                    .child(
                        svg()
                            .path("icons/fan-out.svg")
                            .size(px(16.))
                            .flex_none()
                            .text_color(muted),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(px(font.size * 1.35))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Fan out prompt"),
                            )
                            .child(div().truncate().text_color(muted).child(format!(
                                "{} on {}",
                                fan_out.origin.repo_label, fan_out.origin.endpoint_label
                            ))),
                    ),
            )
            .child(
                div()
                    .id("fan-out-body")
                    .max_h(px(460.))
                    .overflow_y_scroll()
                    .child(body),
            )
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .px(px(16.))
                    .py(px(12.))
                    .border_t_1()
                    .border_color(rgb(theme.active))
                    .child(
                        button("fan-out-cancel")
                            .border_color(rgb(theme.active))
                            .hover(|button| button.bg(rgb(theme.active)))
                            .child(dismiss)
                            .on_click(cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.fan_out_back(window, cx);
                            })),
                    )
                    .child(
                        button("fan-out-submit")
                            .border_color(if armed {
                                rgb(theme.foreground)
                            } else {
                                rgb(theme.active)
                            })
                            .text_color(if armed { rgb(theme.foreground) } else { muted })
                            .child(primary)
                            .when(!armed, |button| {
                                button.opacity(0.4).cursor(CursorStyle::OperationNotAllowed)
                            })
                            .when(armed, |button| {
                                button.bg(rgb(theme.active)).on_click(cx.listener(
                                    |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.submit_fan_out(cx);
                                    },
                                ))
                            }),
                    ),
            )
    }
}
