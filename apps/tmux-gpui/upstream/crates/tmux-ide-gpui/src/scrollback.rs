//! The connection's mailbox for scrollback answers: find, copy-mode motions,
//! selection reads, and the editor hand-off. It is kept apart from the modal
//! dialog slot so none of these overwrites or steals a dialog's response, and
//! it is replaced with the connection, so an answer can never reach a newer
//! one. Each feature keeps at most one request here at a time, so the slots
//! below are bounded by the number of features, not by user input.

use crate::terminal_painter::{Highlight, Tint};
use herdr_client::{
    ClientEvent,
    protocol::PaneSurfacePane,
    scrollback::{ScrollbackResponse, TextRange, decode_response},
};
use std::collections::VecDeque;

/// More requests than any combination of features keeps outstanding.
const MAX_REQUESTS: usize = 8;

type Answer = herdr_client::Result<ScrollbackResponse>;

#[derive(Default)]
pub(crate) struct Inbox {
    pending: VecDeque<String>,
    answers: VecDeque<(String, Answer)>,
    /// Requests whose owner went away. Their answers are swallowed instead of
    /// reaching the window's status line as unexplained daemon errors.
    discarded: VecDeque<String>,
}

impl Inbox {
    /// Claims the events that answer a registered request and passes on the
    /// rest. Runs on the event reader, under the same lock `send` takes.
    pub(crate) fn apply(&mut self, event: ClientEvent) -> Option<ClientEvent> {
        if matches!(event, ClientEvent::Disconnected { .. }) {
            for request in std::mem::take(&mut self.pending) {
                self.answer(request, Err(herdr_client::Error::Disconnected));
            }
            self.discarded.clear();
            return Some(event);
        }
        let request = match &event {
            ClientEvent::Response { request_id, .. } => request_id,
            ClientEvent::CommandRejected {
                request_id: Some(request_id),
                ..
            } => request_id,
            _ => return Some(event),
        };
        if let Some(index) = self.discarded.iter().position(|id| id == request) {
            self.discarded.remove(index);
            return None;
        }
        let Some(index) = self.pending.iter().position(|id| id == request) else {
            return Some(event);
        };
        let Some(request) = self.pending.remove(index) else {
            return Some(event);
        };
        let answer = match event {
            ClientEvent::Response { response, .. } => decode_response(&response),
            ClientEvent::CommandRejected { reason, .. } => Err(reason),
            _ => return None,
        };
        self.answer(request, answer);
        None
    }

    fn answer(&mut self, request: String, answer: Answer) {
        if self.answers.len() == MAX_REQUESTS {
            self.answers.pop_front();
        }
        self.answers.push_back((request, answer));
    }

    /// Registers the request `send` queues while holding the mailbox, so even
    /// an immediate rejection finds it pending.
    pub(crate) fn send(
        &mut self,
        send: impl FnOnce() -> herdr_client::Result<String>,
    ) -> herdr_client::Result<String> {
        if self.pending.len() >= MAX_REQUESTS {
            return Err(herdr_client::Error::Full);
        }
        let request = send()?;
        self.pending.push_back(request.clone());
        Ok(request)
    }

    /// The answer to `request`, once; `None` while it is outstanding.
    pub(crate) fn take(&mut self, request: &str) -> Option<Answer> {
        let index = self.answers.iter().position(|(id, _)| id == request)?;
        self.answers.remove(index).map(|(_, answer)| answer)
    }

    /// Gives up on `request`: an answer already here is dropped, and one
    /// still on its way is swallowed when it comes.
    pub(crate) fn discard(&mut self, request: &str) {
        if self.take(request).is_some() {
            return;
        }
        if let Some(index) = self.pending.iter().position(|id| id == request)
            && let Some(request) = self.pending.remove(index)
        {
            if self.discarded.len() == MAX_REQUESTS {
                self.discarded.pop_front();
            }
            self.discarded.push_back(request);
        }
    }
}

/// The scroll offset that centers `range` in `pane`, or `None` when it is
/// already in view or the pane cannot scroll (an alternate screen has no
/// history to move through).
pub(crate) fn reveal_offset(pane: &PaneSurfacePane, range: TextRange) -> Option<u64> {
    let scroll = pane.scroll?;
    let top = viewport_top(pane);
    let height = u32::from(pane.inner_rect.height);
    if range.start.row >= top && range.end.row < top.saturating_add(height) {
        return None;
    }
    let wanted_top = u64::from(range.start.row.saturating_sub(height / 2));
    Some(
        scroll
            .max_offset_from_bottom
            .saturating_sub(wanted_top)
            .min(scroll.max_offset_from_bottom),
    )
}

/// The absolute row painted at the top of `pane`.
pub(crate) fn viewport_top(pane: &PaneSurfacePane) -> u32 {
    pane.scroll.map_or(0, |scroll| {
        u32::try_from(
            scroll
                .max_offset_from_bottom
                .saturating_sub(scroll.offset_from_bottom),
        )
        .unwrap_or(u32::MAX)
    })
}

/// Appends the cells of `range` that `pane` shows, tinted, in the surface
/// frame's grid. Rows map through the pane's current scroll position, so a
/// range keeps its place as the pane scrolls; the rows between its ends run
/// the pane's full width, as a terminal selection does.
pub(crate) fn push_range(
    pane: &PaneSurfacePane,
    range: TextRange,
    tint: Tint,
    highlights: &mut Vec<Highlight>,
) {
    let inner = pane.inner_rect;
    let top = viewport_top(pane);
    let bottom = top.saturating_add(u32::from(inner.height));
    if range.end.row < top || range.start.row >= bottom || range.end < range.start {
        return;
    }
    for row in range.start.row.max(top)..=range.end.row.min(bottom.saturating_sub(1)) {
        let start = if row == range.start.row {
            range.start.col
        } else {
            0
        };
        let end = if row == range.end.row {
            range.end.col.saturating_add(1)
        } else {
            inner.width
        }
        .min(inner.width);
        let Ok(offset) = u16::try_from(row - top) else {
            continue;
        };
        if start >= end {
            continue;
        }
        highlights.push(Highlight {
            row: inner.y.saturating_add(offset),
            columns: inner.x.saturating_add(start)..inner.x.saturating_add(end),
            tint,
        });
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(id: &str) -> ClientEvent {
        ClientEvent::Response {
            request_id: id.into(),
            response: json!({"id": id, "result": {"type": "ok"}}),
        }
    }

    #[test]
    fn answers_are_claimed_by_request_and_taken_once() {
        let mut inbox = Inbox::default();
        inbox.send(|| Ok("a".into())).unwrap();
        inbox.send(|| Ok("b".into())).unwrap();
        assert!(inbox.apply(response("other")).is_some(), "not ours");
        assert!(inbox.apply(response("b")).is_none());
        assert!(inbox.take("a").is_none(), "still outstanding");
        assert_eq!(inbox.take("b").unwrap().unwrap(), ScrollbackResponse::Ok {});
        assert!(inbox.take("b").is_none(), "an answer moves out once");
        let rejected = ClientEvent::CommandRejected {
            request_id: Some("a".into()),
            reason: herdr_client::Error::Full,
        };
        assert!(inbox.apply(rejected).is_none());
        assert!(matches!(
            inbox.take("a"),
            Some(Err(herdr_client::Error::Full))
        ));
        assert!(inbox.apply(response("a")).is_some(), "no longer pending");
    }

    #[test]
    fn a_disconnect_fails_everything_outstanding() {
        let mut inbox = Inbox::default();
        inbox.send(|| Ok("a".into())).unwrap();
        inbox.send(|| Ok("b".into())).unwrap();
        let disconnect = ClientEvent::Disconnected {
            reason: "gone".into(),
            ssh: None,
        };
        assert!(
            inbox.apply(disconnect).is_some(),
            "the window still sees it"
        );
        for id in ["a", "b"] {
            assert!(matches!(
                inbox.take(id),
                Some(Err(herdr_client::Error::Disconnected))
            ));
        }
    }

    #[test]
    fn discarded_requests_are_swallowed_and_registration_is_bounded() {
        let mut inbox = Inbox::default();
        inbox.send(|| Ok("a".into())).unwrap();
        inbox.discard("a");
        assert!(inbox.apply(response("a")).is_none(), "swallowed");
        assert!(inbox.take("a").is_none());
        assert!(inbox.apply(response("a")).is_some(), "only once");

        assert!(
            inbox
                .send(|| Err(herdr_client::Error::Disconnected))
                .is_err()
        );
        for index in 0..MAX_REQUESTS {
            inbox.send(|| Ok(format!("r{index}"))).unwrap();
        }
        assert!(matches!(
            inbox.send(|| Ok("over".into())),
            Err(herdr_client::Error::Full)
        ));
    }
}
