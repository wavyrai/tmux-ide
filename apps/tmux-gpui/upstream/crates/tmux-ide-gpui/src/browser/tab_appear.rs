//! Tabs grow into a strip when they open and shrink out of it when they
//! close, so the eye follows where one landed or where one went. Each group's
//! strip is tracked on its own, so a tab closed in one group shrinks out of
//! that strip alone. The tabs a strip already has when the window first draws
//! it simply appear.
use super::{GroupId, Pick};
use crate::motion::{self, ENTER, LEAVE};
use gpui::SharedString;
use std::{collections::HashMap, time::Instant};

/// A tab on its way out of a strip, drawn where it stood as it shrinks.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Leaving {
    pub(crate) pick: Pick,
    pub(crate) label: SharedString,
    /// Its place in the strip when it closed.
    pub(crate) index: usize,
    /// Its width when it closed.
    pub(crate) width: f32,
    since: Instant,
}

impl Leaving {
    /// How much of it is left at `now`, from 1 to 0.
    pub(crate) fn left(&self, now: Instant) -> f32 {
        motion::progress(self.since, now, LEAVE).map_or(0., |k| 1. - k)
    }
}

/// A tab a strip draws: what it is, what it says, and how wide it is.
pub(crate) struct Listed {
    pub(crate) pick: Pick,
    pub(crate) label: SharedString,
    pub(crate) width: f32,
}

#[derive(Default)]
struct Strip {
    tabs: Vec<Listed>,
    growing: HashMap<Pick, Instant>,
    leaving: Vec<Leaving>,
}

#[derive(Default)]
pub(crate) struct TabAppear {
    strips: HashMap<GroupId, Strip>,
    /// Set by `hold`: motions that start from then on start held too.
    #[cfg(test)]
    held: bool,
}

impl TabAppear {
    /// Records the tabs `group`'s strip draws at `now`. The first time a
    /// strip is seen its tabs are taken as they are; after that, a new tab
    /// grows in and a missing one shrinks out where it stood.
    pub(crate) fn observe(&mut self, group: GroupId, tabs: Vec<Listed>, now: Instant) {
        #[cfg(test)]
        let start = if self.held { held_start() } else { now };
        #[cfg(not(test))]
        let start = now;
        let Some(strip) = self.strips.get_mut(&group) else {
            self.strips.insert(
                group,
                Strip {
                    tabs,
                    ..Default::default()
                },
            );
            return;
        };
        for tab in &tabs {
            if !strip.tabs.iter().any(|old| old.pick == tab.pick) {
                strip.growing.insert(tab.pick.clone(), start);
                // A tab that comes back is no longer leaving.
                strip.leaving.retain(|leaving| leaving.pick != tab.pick);
            }
        }
        for (index, old) in strip.tabs.iter().enumerate() {
            if !tabs.iter().any(|tab| tab.pick == old.pick) {
                strip.leaving.push(Leaving {
                    pick: old.pick.clone(),
                    label: old.label.clone(),
                    index,
                    width: old.width,
                    since: start,
                });
            }
        }
        strip.tabs = tabs;
        strip
            .growing
            .retain(|_, since| motion::progress(*since, now, ENTER).is_some());
        strip
            .leaving
            .retain(|leaving| motion::progress(leaving.since, now, LEAVE).is_some());
    }

    /// How far `tab` has grown into `group`'s strip at `now`, or `None`
    /// once it is whole.
    pub(crate) fn growth(&self, group: GroupId, tab: &Pick, now: Instant) -> Option<f32> {
        let since = self.strips.get(&group)?.growing.get(tab)?;
        motion::progress(*since, now, ENTER)
    }

    /// The tabs shrinking out of `group`'s strip.
    pub(crate) fn leaving(&self, group: GroupId) -> &[Leaving] {
        self.strips
            .get(&group)
            .map_or(&[], |strip| strip.leaving.as_slice())
    }

    /// Whether a tab is still growing or shrinking, so the window draws
    /// another frame.
    pub(crate) fn animating(&self) -> bool {
        self.strips
            .values()
            .any(|strip| !strip.growing.is_empty() || !strip.leaving.is_empty())
    }

    /// Forgets the strips of groups that are gone.
    pub(crate) fn retain(&mut self, mut live: impl FnMut(GroupId) -> bool) {
        self.strips.retain(|group, _| live(*group));
    }

    /// Holds every moving tab where it started, and every one that starts
    /// later, for tests whose frames are too slow to catch one mid-way.
    /// Holding a motion only once it has begun would race the frame that
    /// begins it: on a slow machine that frame can outlast the motion.
    #[cfg(test)]
    pub(crate) fn hold(&mut self) {
        self.held = true;
        let later = held_start();
        for strip in self.strips.values_mut() {
            for since in strip.growing.values_mut() {
                *since = later;
            }
            for leaving in &mut strip.leaving {
                leaving.since = later;
            }
        }
    }
}

/// When a held motion starts: far enough ahead that it never moves.
#[cfg(test)]
fn held_start() -> Instant {
    Instant::now() + std::time::Duration::from_secs(3600)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::GroupIds;

    fn herdr(id: &str) -> Pick {
        Pick::Herdr(id.into())
    }

    fn listed(ids: &[&str]) -> Vec<Listed> {
        ids.iter()
            .map(|id| Listed {
                pick: herdr(id),
                label: SharedString::from(id.to_string()),
                width: 120.,
            })
            .collect()
    }

    #[test]
    fn tabs_grow_in_and_shrink_out_of_their_own_strip() {
        let mut appear = TabAppear::default();
        let mut ids = GroupIds::default();
        let (left, right) = (ids.next(), ids.next());
        let start = Instant::now();
        // A strip's tabs when first seen simply appear.
        appear.observe(left, listed(&["t1", "t2"]), start);
        appear.observe(right, listed(&["t1", "t2"]), start);
        assert!(!appear.animating());

        // A new one grows in, eased out, and ends whole.
        appear.observe(left, listed(&["t1", "t2", "t3"]), start);
        assert!(appear.animating());
        assert_eq!(appear.growth(left, &herdr("t3"), start), Some(0.));
        assert!(appear.growth(right, &herdr("t3"), start).is_none());
        assert_eq!(appear.growth(left, &herdr("t3"), start + ENTER), None);

        // A closed one shrinks out where it stood, in that strip only.
        appear.observe(right, listed(&["t2"]), start);
        let leaving = appear.leaving(right);
        assert_eq!(leaving.len(), 1);
        assert_eq!(
            (leaving[0].pick.clone(), leaving[0].index),
            (herdr("t1"), 0)
        );
        assert_eq!(leaving[0].left(start), 1.);
        assert_eq!(leaving[0].left(start + LEAVE), 0.);
        assert!(appear.leaving(left).is_empty());
        appear.observe(right, listed(&["t2"]), start + LEAVE);
        assert!(appear.leaving(right).is_empty());

        // A tab that comes back while leaving grows in instead.
        appear.observe(left, listed(&["t2", "t3"]), start + ENTER);
        appear.observe(left, listed(&["t1", "t2", "t3"]), start + ENTER);
        assert!(appear.leaving(left).is_empty());
        assert!(appear.growth(left, &herdr("t1"), start + ENTER).is_some());

        // A gone group's strip is forgotten: its next sight grows nothing.
        appear.retain(|group| group == left);
        appear.observe(right, listed(&["t9"]), start + ENTER);
        assert!(appear.leaving(right).is_empty());
        assert!(appear.growth(right, &herdr("t9"), start + ENTER).is_none());
    }
}
