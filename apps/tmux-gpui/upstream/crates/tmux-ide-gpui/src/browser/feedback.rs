//! Notes the user sent that no terminal took, on a page or on the agent's
//! changes: kept for the agent to fetch with `browser feedback`. A batch goes one way only. When its agent is
//! waiting in `browser feedback --wait`, the batch is handed there; otherwise
//! it is pasted into the agent's pane, and only a pane that no longer exists
//! leaves it here. Only the Unix control socket fetches or waits, so the
//! methods for it exist only where that socket does.
use gpui::Global;
use std::collections::VecDeque;

/// Batches kept at once; the oldest goes first.
const MAX_KEPT: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Batch {
    /// The Herdr pane of the agent the notes are for.
    pub pane_id: String,
    pub text: String,
}

#[derive(Default)]
pub(crate) struct Feedback {
    kept: VecDeque<Batch>,
    /// Panes whose agents are waiting in `browser feedback --wait`.
    waiting: Vec<String>,
}

impl Global for Feedback {}

impl Feedback {
    #[cfg(any(unix, test))]
    pub(crate) fn waiting(&self) -> &[String] {
        &self.waiting
    }

    pub(crate) fn is_waiting(&self, pane_id: &str) -> bool {
        self.waiting.iter().any(|pane| pane == pane_id)
    }

    /// Records which panes are waiting.
    #[cfg(any(unix, test))]
    pub(crate) fn set_waiting(&mut self, panes: Vec<String>) {
        self.waiting = panes;
    }

    pub(crate) fn keep(&mut self, batch: Batch) {
        if self.kept.len() >= MAX_KEPT {
            self.kept.pop_front();
        }
        self.kept.push_back(batch);
    }

    /// Everything kept for `pane_id`, oldest first, joined into one text.
    #[cfg(any(unix, test))]
    pub(crate) fn take(&mut self, pane_id: &str) -> Option<String> {
        let (taken, kept): (Vec<_>, Vec<_>) = self
            .kept
            .drain(..)
            .partition(|batch| batch.pane_id == pane_id);
        self.kept = kept.into();
        (!taken.is_empty()).then(|| {
            taken
                .into_iter()
                .map(|batch| batch.text)
                .collect::<Vec<_>>()
                .join("\n")
        })
    }

    #[cfg(any(unix, test))]
    pub(crate) fn has(&self, pane_id: &str) -> bool {
        self.kept.iter().any(|batch| batch.pane_id == pane_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(pane: &str, text: &str) -> Batch {
        Batch {
            pane_id: pane.into(),
            text: text.into(),
        }
    }

    #[test]
    fn batches_are_taken_once_per_pane_and_bounded() {
        let mut feedback = Feedback::default();
        assert!(feedback.take("p1").is_none());
        feedback.keep(batch("p1", "one"));
        feedback.keep(batch("p2", "other"));
        feedback.keep(batch("p1", "two"));
        assert!(feedback.has("p1"));
        assert_eq!(feedback.take("p1").as_deref(), Some("one\ntwo"));
        assert!(feedback.take("p1").is_none());
        assert_eq!(feedback.take("p2").as_deref(), Some("other"));
        for index in 0..MAX_KEPT + 2 {
            feedback.keep(batch("p", &index.to_string()));
        }
        assert!(
            feedback
                .take("p")
                .is_some_and(|text| text.starts_with("2\n"))
        );
    }

    #[test]
    fn waiting_panes_are_tracked() {
        let mut feedback = Feedback::default();
        feedback.set_waiting(vec!["p1".into()]);
        assert_eq!(feedback.waiting(), ["p1"]);
        assert!(feedback.is_waiting("p1") && !feedback.is_waiting("p2"));
    }
}
