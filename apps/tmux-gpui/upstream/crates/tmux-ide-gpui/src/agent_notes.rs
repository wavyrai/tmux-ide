//! Delivering notes the user wrote to the agent they are about, whether they
//! annotate a page the agent showed or review the changes it made. A batch
//! goes one way only: to the agent when it waits in `browser feedback
//! --wait`, otherwise pasted into its pane once it is idle, and kept for
//! `browser feedback` when its pane is gone or must not be typed into.
use crate::{
    HerdrWindow, browser::Feedback, connection::ConnectionBridge, terminal::InputTarget,
    window::Flash,
};
use gpui::{ClipboardItem, Context};
use herdr_client::protocol::{
    AgentStatus, ClientKeyCode, ClientKeyKind, ClientPaneInputEvent, ClientShellAgent,
    ClientShellSnapshot,
};
use std::time::{Duration, Instant};

/// How long a batch waits for a busy agent before it is pasted anyway, or,
/// when the agent is asking a question, kept for `browser feedback`.
const HOLD: Duration = Duration::from_secs(120);
/// Lets the agent's input take the paste before Enter submits it.
const SUBMIT_DELAY: Duration = Duration::from_millis(150);

/// Notes on the way to an agent's pane, waiting for it to be idle.
struct Delivery {
    pane_id: String,
    boot_id: String,
    text: String,
    until: Instant,
}

/// The window's notes still waiting for their agents.
#[derive(Default)]
pub(crate) struct Deliveries(Vec<Delivery>);

impl Deliveries {
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }
}

/// The agent in `pane_id`, if Herdr sees one there.
pub(crate) fn agent<'a>(
    snapshot: &'a ClientShellSnapshot,
    pane_id: &str,
) -> Option<&'a ClientShellAgent> {
    snapshot
        .agents
        .iter()
        .find(|agent| agent.pane_id == pane_id)
}

fn enter() -> ClientPaneInputEvent {
    ClientPaneInputEvent::Key {
        code: ClientKeyCode::Enter,
        modifiers: 0,
        kind: ClientKeyKind::Press,
        repeat_count: 1,
        shifted_codepoint: None,
        generated_text: None,
        tracks_release: false,
        physical_key_id: None,
        windows_record: None,
    }
}

impl HerdrWindow {
    /// Sends `text` to the agent in `pane_id`. `here` says whether this
    /// window shows the daemon that pane belongs to; only then can it be
    /// typed into. `None` copies the notes, since no agent asked for them.
    pub(crate) fn deliver_notes(
        &mut self,
        pane_id: Option<String>,
        here: bool,
        text: String,
        cx: &mut Context<Self>,
    ) {
        let Some(pane_id) = pane_id else {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
            self.show_flash(
                Flash::success("No agent to send to, so the notes were copied"),
                cx,
            );
            return;
        };
        let waiting = cx
            .try_global::<Feedback>()
            .is_some_and(|feedback| feedback.is_waiting(&pane_id));
        let snapshot = self.live.snapshot.clone();
        let shown = snapshot.as_deref().filter(|snapshot| {
            here && snapshot
                .panes
                .iter()
                .any(|candidate| candidate.pane_id == pane_id)
        });
        let flash = if waiting {
            cx.default_global::<Feedback>()
                .keep(crate::browser::Batch { pane_id, text });
            Flash::success("Notes sent to the waiting agent")
        } else if let Some((snapshot, found)) =
            shown.and_then(|snapshot| Some((snapshot, agent(snapshot, &pane_id)?)))
        {
            let busy = matches!(
                found.agent_status,
                AgentStatus::Working | AgentStatus::Blocked
            );
            self.deliveries.0.push(Delivery {
                pane_id,
                boot_id: snapshot.boot_id.clone(),
                text,
                until: Instant::now() + HOLD,
            });
            if busy {
                Flash::success("Notes will go to the agent once it is idle")
            } else {
                Flash::success("Notes sent to the agent")
            }
        } else if shown.is_some() {
            // A shell, not an agent: Enter there would run the notes.
            cx.default_global::<Feedback>()
                .keep(crate::browser::Batch { pane_id, text });
            Flash::warning("No agent runs in that pane; notes kept for `browser feedback`")
        } else {
            cx.default_global::<Feedback>()
                .keep(crate::browser::Batch { pane_id, text });
            Flash::warning("The agent's pane is not here; notes kept for `browser feedback`")
        };
        self.show_flash(flash, cx);
    }

    /// Pastes held notes into agents that became idle. Runs every tick.
    pub(crate) fn poll_deliveries(&mut self, cx: &mut Context<Self>) {
        if self.deliveries.0.is_empty() {
            return;
        }
        let now = Instant::now();
        let deliveries = std::mem::take(&mut self.deliveries.0);
        for delivery in deliveries {
            let waiting = cx
                .try_global::<Feedback>()
                .is_some_and(|feedback| feedback.is_waiting(&delivery.pane_id));
            let snapshot = self.live.snapshot.clone();
            let present = snapshot.as_deref().filter(|snapshot| {
                snapshot.boot_id == delivery.boot_id
                    && snapshot
                        .panes
                        .iter()
                        .any(|pane| pane.pane_id == delivery.pane_id)
            });
            let status = present
                .and_then(|snapshot| agent(snapshot, &delivery.pane_id))
                .map(|agent| agent.agent_status);
            let busy = matches!(status, Some(AgentStatus::Working | AgentStatus::Blocked));
            if present.is_some() && !waiting && busy && now < delivery.until {
                self.deliveries.0.push(delivery);
                continue;
            }
            // Only a running agent's prompt is typed into. A pane whose agent
            // exited is a shell, where Enter would run the pasted text, quotes
            // included; an agent asking the user something must not have its
            // answer typed by a paste. Both fetch the notes instead.
            let typable = matches!(
                status,
                Some(AgentStatus::Idle | AgentStatus::Done | AgentStatus::Working)
            );
            if waiting || present.is_none() || !typable {
                cx.default_global::<Feedback>().keep(crate::browser::Batch {
                    pane_id: delivery.pane_id,
                    text: delivery.text,
                });
                if !waiting {
                    self.show_flash(
                        Flash::warning("The agent is not ready; notes kept for `browser feedback`"),
                        cx,
                    );
                }
                continue;
            }
            self.paste_into_pane(delivery, cx);
        }
    }

    fn paste_into_pane(&mut self, delivery: Delivery, cx: &mut Context<Self>) {
        let target = InputTarget::Pane(delivery.pane_id.clone());
        let pasted = self.endpoints[self.selected_endpoint]
            .connection
            .handle
            .as_ref()
            .ok_or(crate::Error::NotConnected)
            .and_then(|handle| {
                ConnectionBridge::send_input(
                    handle,
                    &delivery.boot_id,
                    &target,
                    ClientPaneInputEvent::Paste(delivery.text.clone()),
                )
                .map_err(crate::Error::from)
            });
        if let Err(error) = pasted {
            tracing::warn!(%error, "Could not paste notes into the agent's pane");
            cx.default_global::<Feedback>().keep(crate::browser::Batch {
                pane_id: delivery.pane_id,
                text: delivery.text,
            });
            self.show_flash(
                Flash::warning("Could not reach the agent; notes kept for `browser feedback`"),
                cx,
            );
            return;
        }
        let timer = cx.background_executor().clone();
        let boot_id = delivery.boot_id;
        cx.spawn(async move |this, cx| {
            timer.timer(SUBMIT_DELAY).await;
            this.update(cx, |this, _| {
                let handle = this.endpoints[this.selected_endpoint]
                    .connection
                    .handle
                    .as_ref();
                if let Some(handle) = handle
                    && let Err(error) =
                        ConnectionBridge::send_input(handle, &boot_id, &target, enter())
                {
                    tracing::warn!(%error, "Could not submit notes in the agent's pane");
                }
            })
            .ok();
        })
        .detach();
    }
}
