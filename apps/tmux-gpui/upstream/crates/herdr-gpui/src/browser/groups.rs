//! Editor groups: a workspace's view split into side-by-side groups, each
//! listing the same tabs and showing one of them, as an editor's groups do.
//!
//! Each group that shows a terminal has a client connection of its own, and
//! the daemon keeps a focused tab per client, so groups show different Herdr
//! tabs side by side. A tab is still live in just one group at a time: the
//! daemon sizes a tab for one client, and a native page is placed only once.
//! Of the groups that picked the same tab, the one used last shows it and
//! the others stand in for it until they are used again.
use super::TabId;
use serde::{Deserialize, Serialize};

/// Neither group beside a divider may be dragged narrower than this share
/// of the row.
const MIN_SHARE: f32 = 0.08;
/// A saved layout with more groups than this is not restored.
const MAX_SAVED_GROUPS: usize = 32;
/// Nor one whose group removed more tabs from its strip than this.
const MAX_SAVED_HIDDEN: usize = 512;
const MAX_TAB_ID_BYTES: usize = 256;

/// Names a group within a window. Unique across the window's workspaces, so
/// state keyed by group, such as an address field, is never shared.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct GroupId(u64);

/// Hands out group IDs for one window.
#[derive(Debug, Default)]
pub(crate) struct GroupIds(u64);

impl GroupIds {
    pub(crate) fn next(&mut self) -> GroupId {
        self.0 += 1;
        GroupId(self.0)
    }
}

/// A group and where it sits, which names its debug selectors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Slot {
    pub(crate) id: GroupId,
    pub(crate) index: usize,
}

impl Slot {
    /// The first group keeps the unsplit names, so a window that never
    /// splits reads as it always has.
    pub(crate) fn selector(self, name: &str) -> String {
        match self.index {
            0 => name.to_owned(),
            index => format!("g{index}-{name}"),
        }
    }
}

/// The tab a group picked.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub(crate) enum Pick {
    Herdr(String),
    Page(TabId),
}

/// What a group draws.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Shown {
    /// The daemon's focused tab.
    Terminal,
    Page(TabId),
    /// A tab live in another group, or a Herdr tab the daemon does not
    /// focus: using the group brings it here.
    Elsewhere(Pick),
    /// Nothing to show yet.
    Empty,
}

#[derive(Clone, Debug, PartialEq)]
struct Group {
    id: GroupId,
    /// `None` follows the daemon's focused tab. Only a lone group follows:
    /// beside another, following would move it whenever the other focuses
    /// a tab of its own.
    pick: Option<Pick>,
    /// When the group was last used; the latest one holds a shared tab.
    used: u64,
    /// The group's share of the row's width.
    share: f32,
    /// Tabs closed in this group: gone from its strip, still open in Herdr
    /// and in every other group.
    hidden: Vec<Pick>,
}

/// One workspace's groups, left to right.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Layout {
    groups: Vec<Group>,
    active: GroupId,
    clock: u64,
}

/// A layout as saved across restarts: each group's tab and width, left to
/// right, and the group in use. Group IDs are the window's own and are
/// handed out anew on restore.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct SavedLayout {
    groups: Vec<SavedGroup>,
    active: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct SavedGroup {
    pick: Option<Pick>,
    share: f32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    hidden: Vec<Pick>,
}

fn valid_pick(pick: &Pick) -> bool {
    match pick {
        Pick::Herdr(tab) => !tab.is_empty() && tab.len() <= MAX_TAB_ID_BYTES,
        Pick::Page(_) => true,
    }
}

impl SavedLayout {
    /// Whether a saved layout is one the app could have written: bounded,
    /// with widths that are positive and finite, and names of sane length.
    pub(crate) fn valid(&self) -> bool {
        !self.groups.is_empty()
            && self.groups.len() <= MAX_SAVED_GROUPS
            && self.active < self.groups.len()
            && self.groups.iter().all(|group| {
                group.share.is_finite()
                    && group.share > 0.
                    && group.pick.as_ref().is_none_or(valid_pick)
                    && group.hidden.len() <= MAX_SAVED_HIDDEN
                    && group.hidden.iter().all(valid_pick)
            })
    }
}

impl Layout {
    /// The layout to save, or `None` for one group following the terminal,
    /// which is what a workspace shows without one.
    pub(crate) fn saved(&self) -> Option<SavedLayout> {
        if self.groups.len() == 1
            && self.groups[0].pick.is_none()
            && self.groups[0].hidden.is_empty()
        {
            return None;
        }
        Some(SavedLayout {
            groups: self
                .groups
                .iter()
                .map(|group| SavedGroup {
                    pick: group.pick.clone(),
                    share: group.share,
                    hidden: group.hidden.clone(),
                })
                .collect(),
            active: self
                .groups
                .iter()
                .position(|group| group.id == self.active)
                .unwrap_or(0),
        })
    }

    /// A layout rebuilt from `saved`, with IDs from `ids`. Widths are
    /// scaled to fill the row, and the group in use is the latest used, so
    /// it holds any tab it shares.
    pub(crate) fn restore(saved: &SavedLayout, ids: &mut GroupIds) -> Self {
        let total: f32 = saved.groups.iter().map(|group| group.share).sum();
        let groups: Vec<Group> = saved
            .groups
            .iter()
            .enumerate()
            .map(|(index, group)| Group {
                id: ids.next(),
                pick: group.pick.clone(),
                used: if index == saved.active { 1 } else { 0 },
                share: group.share / total,
                hidden: group.hidden.clone(),
            })
            .collect();
        let active = groups[saved.active.min(groups.len() - 1)].id;
        Self {
            groups,
            active,
            clock: 1,
        }
    }

    /// One group following the terminal, as an unsplit window shows.
    pub(crate) fn new(id: GroupId) -> Self {
        Self {
            groups: vec![Group {
                id,
                pick: None,
                used: 0,
                share: 1.,
                hidden: Vec::new(),
            }],
            active: id,
            clock: 0,
        }
    }

    pub(crate) fn slots(&self) -> impl Iterator<Item = Slot> + '_ {
        self.groups.iter().enumerate().map(|(index, group)| Slot {
            id: group.id,
            index,
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.groups.len()
    }

    pub(crate) fn active(&self) -> GroupId {
        self.active
    }

    fn group(&self, id: GroupId) -> Option<&Group> {
        self.groups.iter().find(|group| group.id == id)
    }

    fn group_mut(&mut self, id: GroupId) -> Option<&mut Group> {
        self.groups.iter_mut().find(|group| group.id == id)
    }

    pub(crate) fn share(&self, id: GroupId) -> f32 {
        self.group(id).map_or(0., |group| group.share)
    }

    /// The tab `id` picked, reading a group that follows the terminal as
    /// the daemon's `focused` tab.
    pub(crate) fn pick(&self, id: GroupId, focused: Option<&str>) -> Option<Pick> {
        let group = self.group(id)?;
        group
            .pick
            .clone()
            .or_else(|| focused.map(|tab| Pick::Herdr(tab.to_owned())))
    }

    /// What `id` draws, where `focused` names the tab each group's own
    /// connection focuses.
    pub(crate) fn shown(&self, id: GroupId, focused: impl Fn(GroupId) -> Option<String>) -> Shown {
        let Some(pick) = self.pick(id, focused(id).as_deref()) else {
            // Following a terminal the daemon has not focused: the terminal
            // area still shows, as it does before a workspace connects.
            let follower = self
                .groups
                .iter()
                .filter(|group| group.pick.is_none())
                .max_by_key(|group| group.used)
                .map(|group| group.id);
            return if follower == Some(id) {
                Shown::Terminal
            } else {
                Shown::Empty
            };
        };
        let live = match &pick {
            Pick::Herdr(tab) if focused(id).as_deref() != Some(tab.as_str()) => false,
            _ => self.holder(&pick, &focused) == Some(id),
        };
        match (live, pick) {
            (true, Pick::Herdr(_)) => Shown::Terminal,
            (true, Pick::Page(page)) => Shown::Page(page),
            (false, pick) => Shown::Elsewhere(pick),
        }
    }

    /// The group a tab is live in: the latest used of those that picked it.
    pub(crate) fn holder(
        &self,
        pick: &Pick,
        focused: &impl Fn(GroupId) -> Option<String>,
    ) -> Option<GroupId> {
        self.groups
            .iter()
            .filter(|group| {
                self.pick(group.id, focused(group.id).as_deref()).as_ref() == Some(pick)
            })
            .max_by_key(|group| group.used)
            .map(|group| group.id)
    }

    /// The Herdr tab each group picked, for the groups that hold it: the
    /// ones that need a terminal connection. A group following the terminal
    /// is left out; it shows whatever the window's own connection focuses.
    pub(crate) fn terminal_holders(&self) -> Vec<(GroupId, String)> {
        let mut holders: Vec<(GroupId, String, u64)> = Vec::new();
        for group in &self.groups {
            let Some(Pick::Herdr(tab)) = &group.pick else {
                continue;
            };
            match holders.iter_mut().find(|(_, held, _)| held == tab) {
                Some(holder) if holder.2 < group.used => {
                    *holder = (group.id, tab.clone(), group.used)
                }
                Some(_) => {}
                None => holders.push((group.id, tab.clone(), group.used)),
            }
        }
        holders
            .into_iter()
            .map(|(group, tab, _)| (group, tab))
            .collect()
    }

    /// Makes `id` the group in use. Returns whether anything changed.
    pub(crate) fn activate(&mut self, id: GroupId) -> bool {
        let clock = self.clock;
        let active = self.active;
        let Some(group) = self.group_mut(id) else {
            return false;
        };
        if active == id && group.used == clock {
            return false;
        }
        group.used = clock + 1;
        self.clock = clock + 1;
        self.active = id;
        true
    }

    /// Picks `pick` in `id` and uses the group. A tab picked here is back
    /// in the group's strip.
    pub(crate) fn choose(&mut self, id: GroupId, pick: Pick) {
        if let Some(group) = self.group_mut(id) {
            group.hidden.retain(|hidden| *hidden != pick);
            group.pick = Some(pick);
            self.activate(id);
        }
    }

    /// Whether `id`'s strip lists `pick`. A tab closed in every group is
    /// still listed in `fallback`, the group in use, so no open tab is ever
    /// out of reach.
    pub(crate) fn lists(&self, id: GroupId, pick: &Pick, fallback: GroupId) -> bool {
        let hidden_in = |group: &Group| group.hidden.contains(pick);
        let Some(group) = self.group(id) else {
            return false;
        };
        !hidden_in(group) || (id == fallback && self.groups.iter().all(hidden_in))
    }

    /// Closes `picks` in `id`: gone from its strip, open everywhere else.
    pub(crate) fn hide(&mut self, id: GroupId, picks: impl IntoIterator<Item = Pick>) {
        let Some(group) = self.group_mut(id) else {
            return;
        };
        for pick in picks {
            if !group.hidden.contains(&pick) {
                group.hidden.push(pick);
            }
        }
    }

    /// Drops closed-in-group marks for tabs that are gone for good.
    pub(crate) fn forget_hidden(&mut self, mut open: impl FnMut(&Pick) -> bool) {
        for group in &mut self.groups {
            group.hidden.retain(&mut open);
        }
    }

    /// Splits `id`: a new group to its right picks the same tab, takes half
    /// its width, and becomes the group in use, so the tab moves with it.
    /// A group that followed the terminal keeps `focused`.
    pub(crate) fn split(&mut self, id: GroupId, new: GroupId, focused: Option<&str>) -> bool {
        let Some(index) = self.groups.iter().position(|group| group.id == id) else {
            return false;
        };
        for group in &mut self.groups {
            if group.pick.is_none() {
                group.pick = focused.map(|tab| Pick::Herdr(tab.to_owned()));
            }
        }
        let source = &mut self.groups[index];
        source.share /= 2.;
        // The new group lists what its source lists, as an editor's split
        // opens with the same tabs.
        let group = Group {
            id: new,
            pick: source.pick.clone(),
            used: 0,
            share: source.share,
            hidden: source.hidden.clone(),
        };
        self.groups.insert(index + 1, group);
        self.activate(new);
        true
    }

    /// Where closing `id` would leave it: its place, its share, and the
    /// group its room goes to. `None` for the last group, which never closes.
    pub(crate) fn fold_target(&self, id: GroupId) -> Option<(usize, f32, GroupId)> {
        if self.groups.len() < 2 {
            return None;
        }
        let index = self.groups.iter().position(|group| group.id == id)?;
        let into = if index == 0 { 1 } else { index - 1 };
        Some((index, self.groups[index].share, self.groups[into].id))
    }

    /// Closes `id`, giving its width to the group on its left, or its right
    /// when it was first. The last group never closes.
    pub(crate) fn close(&mut self, id: GroupId) -> bool {
        if self.groups.len() < 2 {
            return false;
        }
        let Some(index) = self.groups.iter().position(|group| group.id == id) else {
            return false;
        };
        let closed = self.groups.remove(index);
        let neighbour = index.saturating_sub(1);
        self.groups[neighbour].share += closed.share;
        if self.active == id {
            let next = self.groups[neighbour].id;
            self.activate(next);
        }
        true
    }

    /// Moves the divider after the `divider`th group to `offset` into a row
    /// `width` wide. Returns whether it moved.
    pub(crate) fn drag(&mut self, divider: usize, offset: f32, width: f32) -> bool {
        if divider + 1 >= self.groups.len() || width.is_nan() || width <= 0. || !offset.is_finite()
        {
            return false;
        }
        let start: f32 = self.groups[..divider].iter().map(|group| group.share).sum();
        let pair = self.groups[divider].share + self.groups[divider + 1].share;
        if pair < 2. * MIN_SHARE {
            return false;
        }
        let left = (offset / width - start).clamp(MIN_SHARE, pair - MIN_SHARE);
        if left == self.groups[divider].share {
            return false;
        }
        self.groups[divider].share = left;
        self.groups[divider + 1].share = pair - left;
        true
    }

    /// Follows the daemon moving the focus of `group`'s connection to `new`,
    /// from a shortcut, an agent, or a closed tab. A group following the
    /// terminal already shows it.
    pub(crate) fn focus_moved(&mut self, group: GroupId, new: &str) {
        if let Some(group) = self.group_mut(group)
            && group.pick.is_some()
        {
            group.pick = Some(Pick::Herdr(new.to_owned()));
        }
    }

    /// Replaces `closed` wherever it was picked, with `with` or, for `None`,
    /// with the terminal: following it when alone, else the `focused` tab.
    /// Returns whether any group had picked it.
    pub(crate) fn replace(
        &mut self,
        closed: &Pick,
        with: Option<Pick>,
        focused: Option<&str>,
    ) -> bool {
        let with = with.or_else(|| {
            (self.groups.len() > 1)
                .then(|| focused.map(|tab| Pick::Herdr(tab.to_owned())))
                .flatten()
        });
        let mut changed = false;
        for group in &mut self.groups {
            if group.pick.as_ref() == Some(closed) {
                group.pick = with.clone();
                changed = true;
            }
        }
        changed
    }

    /// Every tab some group picked.
    pub(crate) fn picks(&self) -> impl Iterator<Item = &Pick> + '_ {
        self.groups.iter().filter_map(|group| group.pick.as_ref())
    }
}

#[cfg(test)]
mod tests;
