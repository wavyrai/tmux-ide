//! Home's agents (#705, Option A): each agent shows on its session's row in
//! the table, so Home itself keeps only a pill for the agents that need input
//! and one quiet line while agents are still being found or can't be.
use super::*;
use crate::tmux_snapshot::browser::home_agents::Phase;
use bezel_ui::widgets::status_dot;
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn home_agent_select(
        &mut self,
        request: u64,
        revision: u64,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_commands.is_some()
            && self.presence.ready()
            && self.browser_state.surface == browser::Surface::Home
            && self.browser_request == request
            && self.browser_state.request == request
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none()
            && self
                .browser_state
                .home_agents
                .as_ref()
                .is_some_and(|r| r.revision == revision && r.available(key))
        {
            self.select(
                Selection::Agent {
                    from_request: request,
                    roster_revision: revision,
                    key: key.into(),
                },
                window,
                cx,
            );
        }
    }
    /// "N need input" by the search field, only while an agent waits. A
    /// click narrows the table to the waiting sessions and a second click,
    /// or any left-list entry, shows them all again (#705).
    pub(super) fn home_agent_pill(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let roster = self.browser_state.home_agents.as_ref()?;
        let count = roster.rows.iter().filter(|row| row.attention).count();
        if count == 0 {
            return None;
        }
        let bezel = self.home_palette();
        let on = self.home_filter.as_ref().is_some_and(|c| c.waiting_only);
        let tone: Hsla = rgb(super::super::agent_indicator::attention_ink(&self.theme())).into();
        let canvas: Hsla = rgb(self.canvas()).into();
        let request = self.browser_request;
        Some(
            div()
                .id("home-agents-attention")
                .debug_selector(move || {
                    format!("home-agents-attention-{}", if on { "on" } else { "off" })
                })
                .role(Role::Button)
                .aria_label(crate::plural::count(
                    count,
                    "agent needs input",
                    "agents need input",
                ))
                .aria_toggled(if on { Toggled::True } else { Toggled::False })
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.))
                .h(px(bezel_theme::Theme::BUTTON_HEIGHT))
                .px(px(SPACE))
                .rounded_full()
                .cursor_pointer()
                .bg(bezel_theme::flatten(
                    tone.opacity(if on { 0.28 } else { 0.14 }),
                    canvas,
                ))
                .child(status_dot(tone))
                .child(
                    div()
                        .text_style(TextStyle::Callout)
                        .text_color(bezel.text)
                        .children(design::ink_probe(|| "home-agents-attention".into()))
                        .child(crate::plural::count(count, "needs input", "need input")),
                )
                .when(on, |pill| {
                    pill.child(
                        bezel_ui::icons::icon(bezel_ui::icons::Icon::asset("icons/x.svg"))
                            .size(px(12.))
                            .flex_none()
                            .text_color(bezel.text),
                    )
                })
                .on_click(cx.listener(move |view, _, _, cx| {
                    cx.stop_propagation();
                    if view.home_action_current(request)
                        && let Some(controls) = &mut view.home_filter
                    {
                        controls.waiting_only = !controls.waiting_only;
                        cx.notify();
                    }
                }))
                .into_any_element(),
        )
    }

    /// One quiet line under the table while agents are being found, can't be
    /// observed, or are only partly loaded: what is happening, the daemon's
    /// note, and Retry or Load more. Nothing once every agent is live.
    pub(super) fn home_agent_status(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let roster = self.browser_state.home_agents.as_ref()?;
        let bezel = self.home_palette();
        let recovery = self.browser_state.home_agent_recovery.is_some()
            || self.home_filter.as_ref().is_some_and(|c| c.recovery_error);
        let message = match roster.phase {
            Phase::Live if roster.note.is_none() && !recovery => return None,
            Phase::Loading => "Discovering agents…".to_owned(),
            Phase::Unavailable => "Agent observations unavailable".to_owned(),
            Phase::Live | Phase::Partial => crate::tmux_snapshot::roster_counts::home(roster),
        };
        Some(
            div()
                .debug_selector(|| "home-agents-status".into())
                .w_full()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(SPACE))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(SPACE))
                        .text_style(TextStyle::Callout)
                        .text_color(bezel.text_muted)
                        .when(roster.phase == Phase::Loading, |line| {
                            line.child(div().debug_selector(|| "home-agents-loader".into()).child(
                                bezel_ui::loaders::pulse_loader(
                                    "home-agents-loader",
                                    &bezel,
                                    4.,
                                    bezel_motion::Painter::of(cx),
                                    cx,
                                ),
                            ))
                        })
                        .child(
                            div()
                                .children(design::ink_probe(|| "home-agent-counts".into()))
                                .child(message),
                        )
                        .children(
                            roster
                                .note
                                .clone()
                                .map(|note| div().min_w_0().truncate().child(format!("· {note}"))),
                        ),
                )
                .child(self.home_recovery_controls(cx))
                .into_any_element(),
        )
    }
}
