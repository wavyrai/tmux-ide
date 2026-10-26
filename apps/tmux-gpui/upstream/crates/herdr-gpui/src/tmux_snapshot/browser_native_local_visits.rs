//! Accepted live attachments only. Persisted keys are display/history data,
//! never authority to open a terminal. Queue entries retain their local owner.
use super::*;
use std::collections::VecDeque;
pub(in super::super) struct Visits<Owner = LocalOwnerStamp> {
    accepted: Option<(String, String)>,
    queued: bool,
    pending: VecDeque<(Owner, String)>,
}
impl<Owner> Default for Visits<Owner> {
    fn default() -> Self {
        Self {
            accepted: None,
            queued: false,
            pending: VecDeque::new(),
        }
    }
}
impl<Owner: Clone + PartialEq> Visits<Owner> {
    pub(in super::super) fn active_key(&self) -> Option<&str> {
        self.accepted.as_ref().map(|(_, key)| key.as_str())
    }
    pub(in super::super) fn detach(&mut self) {
        self.accepted = None;
        self.queued = false;
    }
    fn accept(&mut self, route: String, key: String) {
        if self.accepted.as_ref() == Some(&(route.clone(), key.clone())) {
            return;
        }
        self.accepted = Some((route, key));
        self.queued = false;
    }
    fn enqueue(&mut self, owner: Option<&Owner>) {
        if self.queued {
            return;
        }
        let (Some((_, key)), Some(owner)) = (&self.accepted, owner) else {
            return;
        };
        // Overflow is not retried on later frames. Keep work bounded like the
        // helper; normal navigation retires or drains it before reaching this.
        self.queued = true;
        if self.pending.len() < 64 {
            self.pending.push_back((owner.clone(), key.clone()));
        }
    }
    fn next(&mut self, owner: &Owner) -> Option<(Owner, String)> {
        let (captured, key) = self.pending.pop_front()?;
        if &captured != owner {
            self.pending.clear();
            return None;
        }
        Some((captured, key))
    }
    pub(super) fn retire(&mut self) {
        self.pending.clear();
        // A failed/invalidated write must not be replayed by the same attachment.
        self.queued = true;
    }
}
impl Gate {
    pub(super) fn enqueue_visit(&mut self) {
        if matches!(
            self.phase,
            fleet::PreferencePhase::Ready | fleet::PreferencePhase::Saving
        ) {
            self.visits.enqueue(self.owner.as_ref());
        }
    }
    pub(super) fn next_visit(&mut self) -> Option<(LocalOwnerStamp, FleetPreferenceChange)> {
        if self.phase != fleet::PreferencePhase::Ready {
            return None;
        }
        self.enqueue_visit();
        let (owner, key) = self.visits.next(self.owner.as_ref()?)?;
        self.begin(true);
        Some((owner, FleetPreferenceChange::Visit { key }))
    }
}
impl Local {
    pub(in super::super) fn accept_visit(&mut self) -> Result<(), Error> {
        let (Some(identity), Some(route)) = (&self.catalog_identity, &self.active) else {
            return Ok(());
        };
        let key = identity.session_key(
            &self.machine_id,
            &route.target.scope,
            &route.target.live,
            false,
        )?;
        self.navigation.accept(route.request, &key);
        self.navigation.remember(&key, &self.machine_id);
        self.preferences.visits.accept(route.id.clone(), key);
        self.preferences.enqueue_visit();
        self.accept_tab();
        self.publish()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queue_is_ordered_bounded_and_owner_replacement_discards_it() {
        let mut visits = Visits::<u8>::default();
        for i in 0..65 {
            visits.accept(format!("route-{i}"), format!("key-{i}"));
            visits.enqueue(Some(&1));
        }
        assert_eq!(visits.pending.len(), 64);
        assert_eq!(visits.next(&1), Some((1, "key-0".into())));
        assert!(visits.next(&2).is_none());
        assert!(visits.pending.is_empty());
        visits.enqueue(Some(&2));
        assert!(visits.pending.is_empty());
    }
    #[test]
    fn loading_waits_for_ack_and_detaching_preserves_already_accepted_queue() {
        let mut visits = Visits::<u8>::default();
        visits.accept("a".into(), "A".into());
        visits.enqueue(None);
        assert!(visits.pending.is_empty());
        visits.enqueue(Some(&1));
        visits.accept("a".into(), "A".into());
        visits.enqueue(Some(&1));
        assert_eq!(visits.pending.len(), 1);
        visits.detach();
        visits.accept("b".into(), "B".into());
        visits.enqueue(Some(&1));
        assert_eq!(visits.next(&1), Some((1, "A".into())));
        assert_eq!(visits.next(&1), Some((1, "B".into())));
        assert!(visits.next(&1).is_none());
        visits.retire();
        visits.enqueue(Some(&1));
        assert!(visits.pending.is_empty());
    }
    #[test]
    fn attachment_is_deduplicated_and_retirement_never_replays_it() {
        let mut visits = Visits::<u8>::default();
        visits.accept("route".into(), "session".into());
        visits.enqueue(None);
        assert!(!visits.queued);
        visits.retire();
        visits.accept("route".into(), "session".into());
        assert!(visits.queued);
        visits.detach();
        visits.accept("new-route".into(), "session".into());
        assert!(!visits.queued);
    }
}
