//! A host picker's state: the candidates as last gathered, their ranking,
//! and the host chosen. The ranking follows the samples only until they
//! settle, so the tiles do not reshuffle under the pointer.

use super::{Candidate, rank, spread};
use std::time::{Duration, Instant};

/// Hosts shown as tiles; the rest are listed behind the "Other" field.
pub(crate) const BEST: usize = 3;
/// How long the ranking may follow the samples before it settles anyway.
/// CPU needs two samples a couple of seconds apart.
const SETTLE: Duration = Duration::from_secs(5);

/// Which host list a click or an open list belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Slot {
    /// The new worktree or workspace dialog's own host.
    Dialog,
    /// One fan-out lane's host.
    Lane(usize),
}

#[derive(Debug, Clone)]
pub(crate) struct Picker {
    candidates: Vec<Candidate>,
    /// Endpoint IDs, best first.
    order: Vec<String>,
    settled: bool,
    /// The candidates as they stood when the ranking settled. Lanes are
    /// spread by these, so they do not hop between hosts with every sample.
    frozen: Vec<Candidate>,
    opened: Instant,
    /// The dialog's choice, an endpoint ID. Starts on the current host.
    chosen: String,
    /// The host list open below a field or lane, if any.
    open: Option<Slot>,
}

impl Picker {
    pub(crate) fn new(current: &str, now: Instant) -> Self {
        Self {
            candidates: Vec::new(),
            order: Vec::new(),
            settled: false,
            frozen: Vec::new(),
            opened: now,
            chosen: current.to_owned(),
            open: None,
        }
    }

    /// Take freshly gathered candidates. Returns whether anything shown changed.
    pub(crate) fn update(&mut self, candidates: Vec<Candidate>, now: Instant) -> bool {
        if candidates == self.candidates && self.settled {
            return false;
        }
        let before = (self.order.clone(), self.chosen.clone());
        let changed = candidates != self.candidates;
        self.candidates = candidates;
        if self.settled {
            // New hosts join at the end; gone ones leave.
            let ids: Vec<&str> = self
                .candidates
                .iter()
                .map(|c| c.endpoint_id.as_str())
                .collect();
            self.order.retain(|id| ids.contains(&id.as_str()));
            for id in ids {
                if !self.order.iter().any(|known| known == id) {
                    self.order.push(id.to_owned());
                }
            }
        } else {
            self.order = rank(&self.candidates)
                .into_iter()
                .map(|index| self.candidates[index].endpoint_id.clone())
                .collect();
            self.settled = self.candidates.iter().all(Candidate::sampled)
                || now.duration_since(self.opened) >= SETTLE;
            if self.settled {
                self.frozen.clone_from(&self.candidates);
            }
        }
        if self.chosen().is_none_or(|chosen| !chosen.online)
            && let Some(current) = self.current()
        {
            self.chosen = current.endpoint_id.clone();
        }
        changed || before != (self.order.clone(), self.chosen.clone())
    }

    fn get(&self, endpoint_id: &str) -> Option<&Candidate> {
        self.candidates
            .iter()
            .find(|candidate| candidate.endpoint_id == endpoint_id)
    }

    /// Every candidate, best first.
    pub(crate) fn ranked(&self) -> impl Iterator<Item = &Candidate> {
        self.order.iter().filter_map(|id| self.get(id))
    }

    /// The tiles: the best online hosts.
    pub(crate) fn best(&self) -> impl Iterator<Item = &Candidate> {
        self.ranked().filter(|c| c.online).take(BEST)
    }

    /// Every host that is not a tile, offline ones last.
    pub(crate) fn rest(&self) -> impl Iterator<Item = &Candidate> {
        let best: Vec<&str> = self.best().map(|c| c.endpoint_id.as_str()).collect();
        self.ranked()
            .filter(move |c| !best.contains(&c.endpoint_id.as_str()))
    }

    pub(crate) fn is_best(&self, endpoint_id: &str) -> bool {
        self.best().any(|c| c.endpoint_id == endpoint_id)
    }

    /// The best-ranked host, if it is not the current one.
    pub(crate) fn suggestion(&self) -> Option<&Candidate> {
        self.ranked()
            .next()
            .filter(|best| best.online && !best.current)
    }

    pub(crate) fn current(&self) -> Option<&Candidate> {
        self.candidates.iter().find(|c| c.current)
    }

    /// Whether there is any other host to choose: one alone is no choice.
    pub(crate) fn offers_choice(&self) -> bool {
        self.candidates.iter().filter(|c| c.online).count() > 1
    }

    pub(crate) fn chosen(&self) -> Option<&Candidate> {
        self.get(&self.chosen)
    }

    /// The chosen host when it is not the current one.
    pub(crate) fn dispatched(&self) -> Option<&Candidate> {
        self.chosen().filter(|chosen| !chosen.current)
    }

    /// Choose `endpoint_id`, if it is online. Closes any open list.
    pub(crate) fn choose(&mut self, endpoint_id: &str) -> bool {
        self.open = None;
        if !self.get(endpoint_id).is_some_and(|c| c.online) || self.chosen == endpoint_id {
            return false;
        }
        endpoint_id.clone_into(&mut self.chosen);
        true
    }

    /// The online host for `endpoint_id`, for a lane's assignment.
    pub(crate) fn online(&self, endpoint_id: &str) -> Option<&Candidate> {
        self.get(endpoint_id).filter(|c| c.online)
    }

    pub(crate) fn open(&self) -> Option<Slot> {
        self.open
    }

    /// Open `slot`'s list, or close it when it is the one open.
    pub(crate) fn toggle(&mut self, slot: Slot) {
        self.open = (self.open != Some(slot)).then_some(slot);
    }

    pub(crate) fn close(&mut self) -> bool {
        self.open.take().is_some()
    }

    /// A host for each of `lanes` new agents, by endpoint ID: each goes to
    /// the online host with the most room left. Scores are the settled
    /// ones; whether a host is online is current.
    pub(crate) fn spread(&self, lanes: usize) -> Vec<String> {
        let source = if self.settled {
            &self.frozen
        } else {
            &self.candidates
        };
        let candidates: Vec<Candidate> = source
            .iter()
            .map(|candidate| Candidate {
                online: self.online(&candidate.endpoint_id).is_some(),
                ..candidate.clone()
            })
            .collect();
        spread(&candidates, &rank(&candidates), lanes)
            .into_iter()
            .map(|index| candidates[index].endpoint_id.clone())
            .collect()
    }
}
