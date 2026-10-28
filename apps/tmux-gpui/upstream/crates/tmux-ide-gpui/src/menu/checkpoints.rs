//! The checkpoints dialog of a workspace row: the checkout's snapshots, newest
//! first, each with what its turn changed, and a restore behind a
//! confirmation that says what restoring replaces.

use super::Page;
use crate::{
    HerdrWindow,
    checkpoint::{Checkout, Listing, age, host_for},
};
use gpui::{prelude::*, *};
use herdr_client::protocol::AgentStatus;

impl HerdrWindow {
    /// The checkout the menu's workspace shows, when checkpoints can reach it.
    pub(super) fn checkpoint_checkout(&self) -> Option<Checkout> {
        let target = self.menu.target.as_ref()?;
        let endpoint = self.endpoints.get(self.selected_endpoint)?;
        let host = host_for(&endpoint.connection.target, &self.live)?;
        Checkout::new(
            host,
            &target.worktree.as_ref()?.key,
            target.branch.as_deref(),
        )
    }

    pub(super) fn open_checkpoints(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(checkout), Some(target)) = (self.checkpoint_checkout(), &self.menu.target) else {
            return;
        };
        let workspace = target.id.clone();
        self.checkpoints
            .open(checkout, target.label.clone(), workspace);
        self.menu.page = Some(Page::Checkpoints);
        self.menu.error = None;
        window.focus(&self.menu.focus, cx);
        cx.notify();
    }

    /// Closing the dialog forgets its list; a restore it started still runs.
    pub(crate) fn close_stale_checkpoints(&mut self) {
        if self.menu.page != Some(Page::Checkpoints) && self.checkpoints.view.is_some() {
            self.checkpoints.close();
        }
    }

    /// Whether an agent in the dialog's workspace is mid-turn, and so may
    /// keep changing the files a restore puts back.
    fn checkpoint_agent_working(&self) -> bool {
        let Some(view) = &self.checkpoints.view else {
            return false;
        };
        self.live.snapshot.as_ref().is_some_and(|snapshot| {
            snapshot.agents.iter().any(|agent| {
                agent.workspace_id == view.workspace_id
                    && matches!(
                        agent.agent_status,
                        AgentStatus::Working | AgentStatus::Blocked
                    )
            })
        })
    }

    pub(crate) fn checkpoints_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        window.prevent_default();
        let Some(view) = &mut self.checkpoints.view else {
            self.dismiss_menu(window, cx);
            return;
        };
        let count = match &view.listing {
            Listing::Ready(list) => list.len(),
            _ => 0,
        };
        match event.keystroke.key.as_str() {
            "escape" if view.confirming.is_some() && !view.restoring => view.confirming = None,
            "escape" => self.dismiss_menu(window, cx),
            "up" | "down" if view.confirming.is_none() && count > 0 => {
                let up = event.keystroke.key == "up";
                view.selected = Some(match view.selected {
                    None if up => count - 1,
                    None => 0,
                    Some(index) if up => (index + count - 1) % count,
                    Some(index) => (index + 1) % count,
                });
            }
            "enter" if view.confirming.is_some() => self.checkpoints.restore(),
            "enter" => {
                if let Some(checkpoint) = view
                    .selected_checkpoint()
                    .filter(|checkpoint| view.restorable(checkpoint))
                {
                    view.confirming = Some(checkpoint.id.clone());
                }
            }
            _ => return,
        }
        cx.notify();
    }

    pub(crate) fn render_checkpoints(&self, cx: &mut Context<Self>) -> Div {
        let Some(view) = &self.checkpoints.view else {
            return div();
        };
        let theme = &self.theme;
        let font = &self.config.ui;
        let muted = rgb(theme.muted);
        let danger = crate::menu::danger(theme);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| {
                i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
            });
        let line = |text: String| div().min_w_0().child(text);
        let mut body = div().flex().flex_col().gap(px(6.)).px(px(16.)).py(px(12.));
        let confirming = view.confirming_checkpoint();
        if let Some(checkpoint) = confirming {
            body = body
                .child(
                    line(format!(
                        "Restore \u{201c}{}\u{201d} from {}?",
                        checkpoint.label,
                        age(checkpoint.created, now)
                    ))
                    .font_weight(FontWeight::SEMIBOLD),
                )
                .child(line(format!(
                    "Files in this checkout go back to how they were then, and {} moves back to the commit it was on. Files created since are removed; ignored files are left alone.",
                    view.checkout.branch
                )))
                .child(
                    line("The current state is saved as a checkpoint first, so this can be undone.".into())
                        .text_color(muted),
                );
            if self.checkpoint_agent_working() {
                body = body.child(
                    line(
                        "An agent in this workspace is still working and may keep changing files."
                            .into(),
                    )
                    .debug_selector(|| "checkpoints-agent-working".into())
                    .text_color(danger),
                );
            }
        } else {
            match &view.listing {
                Listing::Loading => {
                    body = body.child(line("Loading checkpoints...".into()).text_color(muted));
                }
                Listing::Failed(error) => {
                    body = body.child(
                        line(error.clone())
                            .debug_selector(|| "checkpoints-error".into())
                            .text_color(danger),
                    );
                }
                Listing::Ready(list) if list.is_empty() => {
                    body = body.child(
                        line(if self.config.agent_checkpoints {
                            "No checkpoints yet. One is taken each time an agent here starts or finishes a turn.".into()
                        } else {
                            "No checkpoints. Checkpoint agent turns is off in Settings > General.".into()
                        })
                        .text_color(muted),
                    );
                }
                Listing::Ready(list) => {
                    body = body.child(self.render_checkpoint_timeline(list, now, cx));
                }
            }
        }
        if let Some(error) = &view.error {
            body = body.child(
                line(error.clone())
                    .debug_selector(|| "checkpoints-restore-error".into())
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
        let mut footer = div()
            .flex()
            .justify_end()
            .gap(px(8.))
            .px(px(16.))
            .py(px(12.))
            .border_t_1()
            .border_color(rgb(theme.active))
            .child(
                button("checkpoints-cancel")
                    .border_color(rgb(theme.active))
                    .hover(|button| button.bg(rgb(theme.active)))
                    .child(if confirming.is_some() {
                        "Cancel"
                    } else {
                        "Close"
                    })
                    .on_click(cx.listener(|this, _, window, cx| {
                        cx.stop_propagation();
                        match &mut this.checkpoints.view {
                            Some(view) if view.confirming.is_some() && !view.restoring => {
                                view.confirming = None;
                                cx.notify();
                            }
                            _ => this.dismiss_menu(window, cx),
                        }
                    })),
            );
        if confirming.is_some() {
            let armed = !view.restoring;
            footer = footer.child(
                button("checkpoints-restore")
                    .border_color(danger)
                    .text_color(danger)
                    .child(if armed { "Restore" } else { "Restoring..." })
                    .when(!armed, |button| {
                        button.opacity(0.4).cursor(CursorStyle::OperationNotAllowed)
                    })
                    .when(armed, |button| {
                        button
                            .hover(|button| button.bg(rgb(theme.active)))
                            .on_click(cx.listener(|this, _, _, cx| {
                                cx.stop_propagation();
                                this.checkpoints.restore();
                                cx.notify();
                            }))
                    }),
            );
        }
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
                            .path("icons/refresh.svg")
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
                                    .child("Checkpoints"),
                            )
                            .child(
                                div().truncate().text_color(muted).child(format!(
                                    "{} \u{b7} {}",
                                    view.title, view.checkout.branch
                                )),
                            ),
                    ),
            )
            .child(
                div()
                    .id("checkpoints-body")
                    .max_h(px(420.))
                    .overflow_y_scroll()
                    .child(body),
            )
            .child(footer)
    }
}

#[cfg(test)]
mod tests;
mod timeline;
