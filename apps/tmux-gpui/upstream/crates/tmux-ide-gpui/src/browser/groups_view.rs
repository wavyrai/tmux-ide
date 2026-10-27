//! The window's editor groups: which group shows which tab, using and
//! splitting groups, and following the daemon's focus. The rules for what a
//! group draws live in [`super::groups`]; this applies them to the focused
//! workspace and carries out what they imply, such as focusing the Herdr tab
//! a group asks for.
use super::tab_appear::{Leaving, Listed};
use super::tab_scroll::Thumb;
use super::{
    Location, Scope, Tab, TabId,
    groups::{GroupId, Layout, Pick, Shown, Slot},
    view::store,
};
use crate::{HerdrWindow, NavigationTarget, search_input::SearchInput};
use gpui::{prelude::*, *};
use std::{collections::hash_map::Entry, time::Instant};

impl HerdrWindow {
    /// The daemon's focused tab, when it belongs to the focused workspace.
    pub(crate) fn focused_herdr_tab(&self) -> Option<&str> {
        let snapshot = self.live.snapshot.as_ref()?;
        let tab = snapshot.focused_tab_id.as_deref()?;
        snapshot
            .tabs
            .iter()
            .any(|candidate| {
                candidate.tab_id == tab
                    && Some(&candidate.workspace_id) == snapshot.focused_workspace_id.as_ref()
            })
            .then_some(tab)
    }

    fn layout(&self) -> Option<&Layout> {
        self.browser.layouts.get(&self.browser_key()?)
    }

    /// `key`'s groups, made on first use from the layout saved for it, if
    /// any, or else as one group following the terminal.
    fn layout_for(&mut self, key: (Scope, String)) -> &mut Layout {
        let browser = &mut self.browser;
        match browser.layouts.entry(key) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let layout = match browser.saved.remove(entry.key()) {
                    Some(saved) => {
                        browser.restored = Some(entry.key().clone());
                        Layout::restore(&saved, &mut browser.group_ids)
                    }
                    None => Layout::new(browser.group_ids.next()),
                };
                entry.insert(layout)
            }
        }
    }

    /// Saves each of this window's layouts that changed, for the next start.
    pub(crate) fn save_group_layouts(&mut self, cx: &mut Context<Self>) {
        for (key, layout) in &self.browser.layouts {
            super::Layouts::record(cx, key, layout.saved());
        }
    }

    /// The focused workspace's groups, creating its first one. Render calls
    /// this before drawing so every group it draws has an ID.
    pub(crate) fn ensure_layout(&mut self) -> Option<&mut Layout> {
        let key = self.browser_key()?;
        Some(self.layout_for(key))
    }

    /// The focused workspace's groups, left to right. Without a workspace
    /// the window still draws one group, for the terminal area.
    pub(crate) fn group_slots(&self) -> Vec<Slot> {
        match self.layout() {
            Some(layout) => layout.slots().collect(),
            None => vec![Slot {
                id: self.browser.fallback_group,
                index: 0,
            }],
        }
    }

    pub(crate) fn is_split(&self) -> bool {
        self.layout().is_some_and(|layout| layout.len() > 1)
    }

    pub(crate) fn active_group(&self) -> Option<GroupId> {
        self.layout().map(Layout::active)
    }

    /// The share of the row `group` takes as drawn now: its settled share,
    /// bent while a group beside it opens or folds.
    pub(crate) fn group_share(&self, group: GroupId) -> f32 {
        let Some(layout) = self.layout() else {
            return 1.;
        };
        self.browser.group_motion.share(
            group,
            layout.share(group),
            |other| layout.share(other),
            Instant::now(),
        )
    }

    /// How far `group` has opened from its split, or `None` once open.
    pub(crate) fn group_opened(&self, group: GroupId) -> Option<f32> {
        self.browser.group_motion.opened(group, Instant::now())
    }

    /// The closed groups still folding away.
    pub(crate) fn folding_groups(&self) -> Vec<super::Fold> {
        self.browser.group_motion.folding(Instant::now())
    }

    /// Whether a group is still opening or folding, so the window draws
    /// another frame.
    pub(crate) fn groups_moving(&mut self) -> bool {
        self.browser.group_motion.animating(Instant::now())
    }

    /// The tab `group` picked, the focused one when it follows the terminal.
    pub(crate) fn group_pick(&self, group: GroupId) -> Option<Pick> {
        self.layout()?.pick(group, self.focused_herdr_tab())
    }

    /// Records what `group`'s strip draws; see
    /// [`super::tab_appear::TabAppear::observe`].
    pub(crate) fn observe_strip(&mut self, group: GroupId, tabs: Vec<Listed>, now: Instant) {
        self.browser.appear.observe(group, tabs, now);
    }

    /// The tabs shrinking out of `group`'s strip.
    pub(crate) fn leaving_tabs(&self, group: GroupId) -> Vec<Leaving> {
        self.browser.appear.leaving(group).to_vec()
    }

    /// Forgets the strips of groups that closed, so their tabs never shrink
    /// out of a strip no longer drawn.
    pub(crate) fn forget_gone_strips(&mut self) {
        let layouts = &self.browser.layouts;
        let live = |group| {
            layouts
                .values()
                .any(|layout| layout.slots().any(|slot| slot.id == group))
        };
        self.browser.appear.retain(live);
        // The group drawn before any workspace has a layout keeps its strip.
        let fallback = self.browser.fallback_group;
        self.browser
            .tab_scroll
            .retain(|group| group == fallback || live(group));
    }

    /// What tracks `group`'s strip's sideways scroll.
    pub(crate) fn strip_scroll(&mut self, group: GroupId) -> ScrollHandle {
        self.browser.tab_scroll.handle(group)
    }

    /// Brings `group`'s chosen tab, at `index` in its strip, into view when
    /// the choice changes or while the tab grows in. Whether the strip needs
    /// another frame to do it.
    pub(crate) fn reveal_tab(&mut self, group: GroupId, pick: &Pick, index: usize) -> bool {
        let growing = self
            .browser
            .appear
            .growth(group, pick, Instant::now())
            .is_some();
        self.browser.tab_scroll.reveal(group, pick, index, growing)
    }

    /// The thumb `group`'s strip draws, when its tabs outgrow it.
    pub(crate) fn strip_thumb(&self, group: GroupId) -> Option<Thumb> {
        self.browser.tab_scroll.thumb(group)
    }

    /// Takes hold of `group`'s strip thumb with the pointer at `x`.
    pub(crate) fn grab_strip_thumb(&mut self, group: GroupId, x: Pixels) {
        self.browser.tab_scroll.grab(group, x);
    }

    /// Drags `group`'s strip thumb to the pointer at `x`; whether it moved.
    pub(crate) fn drag_strip_thumb(&mut self, group: GroupId, x: Pixels) -> bool {
        self.browser.tab_scroll.drag(group, x)
    }

    /// The focused workspace's browser tabs and the labels their strips
    /// show, in strip order.
    pub(crate) fn browser_tab_labels(&self, cx: &App) -> Vec<(Pick, SharedString)> {
        let (Some((scope, workspace)), Some(store)) = (self.browser_key(), store(cx)) else {
            return Vec::new();
        };
        store
            .in_workspace(&scope, &workspace)
            .map(|tab| (Pick::Page(tab.id), super::view::tab_label(&tab.title)))
            .collect()
    }

    /// Whether a tab is still growing or shrinking, so the window draws
    /// another frame.
    pub(crate) fn tabs_growing(&self) -> bool {
        self.browser.appear.animating()
    }

    /// Narrows and fades `tab` while it grows into the strip; a whole tab
    /// is left as it is.
    pub(crate) fn grow_tab<E: Styled>(&self, tab: E, group: GroupId, pick: &Pick) -> E {
        /// Wider than any label a strip shows, so the last frame of growth
        /// does not visibly clamp a long one.
        const GROWN: f32 = 480.;
        match self.browser.appear.growth(group, pick, Instant::now()) {
            Some(k) => tab
                .min_w(px(crate::TAB_WIDTH * k))
                .max_w(px(GROWN * k))
                .overflow_hidden()
                .opacity(k),
            None => tab,
        }
    }

    /// Whether `group`'s strip lists `pick`; see [`Layout::lists`].
    pub(crate) fn group_lists(&self, group: GroupId, pick: &Pick) -> bool {
        let Some(layout) = self.layout() else {
            return true;
        };
        layout.lists(group, pick, self.primary_group().unwrap_or(group))
    }

    /// The tabs `group`'s strip lists, in strip order: Herdr tabs first,
    /// then browser tabs.
    pub(crate) fn group_tabs(&self, group: GroupId, cx: &App) -> Vec<Pick> {
        let herdr = self.live.snapshot.as_ref().map(|snapshot| {
            snapshot
                .tabs
                .iter()
                .filter(|tab| Some(&tab.workspace_id) == snapshot.focused_workspace_id.as_ref())
                .map(|tab| Pick::Herdr(tab.tab_id.clone()))
                .collect::<Vec<_>>()
        });
        herdr
            .unwrap_or_default()
            .into_iter()
            .chain(self.browser_tab_ids(cx).into_iter().map(Pick::Page))
            .filter(|pick| self.group_lists(group, pick))
            .collect()
    }

    /// Closes `picks` in `group` alone, as an editor closes tabs in one of
    /// its groups: they stay open in Herdr, in the browser, and in every
    /// other group. A group closing the tab it shows moves to the tab after
    /// it in its strip, or before it; a group left with none closes.
    pub(crate) fn close_in_group(
        &mut self,
        group: GroupId,
        picks: Vec<Pick>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let before = self.group_tabs(group, cx);
        let current = self.group_pick(group);
        let Some(layout) = self.ensure_layout() else {
            return;
        };
        layout.hide(group, picks.iter().cloned());
        let after = self.group_tabs(group, cx);
        if after.is_empty() {
            self.close_group(group, window, cx);
            return;
        }
        if current
            .as_ref()
            .is_some_and(|current| picks.contains(current))
        {
            let position = current
                .and_then(|current| before.iter().position(|pick| *pick == current))
                .unwrap_or(0);
            let next = before[position..]
                .iter()
                .chain(before[..position].iter().rev())
                .find(|pick| after.contains(pick))
                .cloned();
            match next {
                Some(Pick::Herdr(tab)) => self.choose_herdr_tab(group, &tab, window, cx),
                Some(Pick::Page(id)) => self.show_browser_tab_in(Some(group), id, window, cx),
                None => {}
            }
        }
        cx.notify();
    }

    /// What `group` draws. A page another window closed reads as nothing
    /// until the next tick forgets it.
    pub(crate) fn group_shown(&self, group: GroupId, cx: &App) -> Shown {
        let Some(layout) = self.layout() else {
            return Shown::Terminal;
        };
        let focused = |group| self.group_focused_tab(group);
        let shown = layout.shown(group, focused);
        match &shown {
            Shown::Page(id) | Shown::Elsewhere(Pick::Page(id))
                if store(cx).is_none_or(|store| store.get(*id).is_none()) =>
            {
                Shown::Empty
            }
            // The window's connection is on its way to the tab its group
            // picked and no other group shows it: the terminal keeps its
            // frame until the daemon focuses the tab, rather than flashing
            // a stand-in for one round trip.
            Shown::Elsewhere(pick @ Pick::Herdr(tab))
                if Some(group) == self.primary_group()
                    && layout.holder(pick, &focused) == Some(group)
                    && !self.parked_focuses(tab) =>
            {
                Shown::Terminal
            }
            _ => shown,
        }
    }

    /// The group `pick` is live in, if any.
    #[cfg(any(target_os = "macos", windows))]
    pub(crate) fn group_showing(&self, pick: &Pick, cx: &App) -> Option<GroupId> {
        self.group_slots()
            .into_iter()
            .map(|slot| slot.id)
            .find(|group| match (self.group_shown(*group, cx), pick) {
                (Shown::Terminal, Pick::Herdr(_)) => self.group_pick(*group).as_ref() == Some(pick),
                (Shown::Page(id), Pick::Page(page)) => id == *page,
                _ => false,
            })
    }

    /// The pages live in some group, which the window presents.
    #[cfg(any(target_os = "macos", windows))]
    pub(crate) fn live_pages(&self, cx: &App) -> Vec<TabId> {
        self.group_slots()
            .into_iter()
            .filter_map(|slot| match self.group_shown(slot.id, cx) {
                Shown::Page(id) => Some(id),
                _ => None,
            })
            .collect()
    }

    /// Settles which group holds the window's connection, then, when that
    /// is `group`, focuses the Herdr tab it picked if the connection shows
    /// another, and hands it the keyboard. A group with a parked connection
    /// steers that one to its tab instead.
    fn bring_group_tab(&mut self, group: GroupId, window: &mut Window, cx: &mut Context<Self>) {
        self.reconcile_group_terminals(cx);
        if self.primary_group() != Some(group) {
            return;
        }
        let focused = self.focused_herdr_tab().map(str::to_owned);
        if let Some(Pick::Herdr(tab)) = self.group_pick(group)
            && focused.as_deref() != Some(tab.as_str())
        {
            self.navigate(NavigationTarget::Tab(&tab), cx);
        }
        if matches!(self.group_pick(group), Some(Pick::Herdr(_)) | None) {
            window.focus(&self.focus, cx);
        }
    }

    /// Makes `group` the one in use, which brings it the tab it picked.
    pub(crate) fn activate_group(
        &mut self,
        group: GroupId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(layout) = self.ensure_layout() else {
            return;
        };
        if !layout.activate(group) {
            return;
        }
        self.bring_group_tab(group, window, cx);
        cx.notify();
    }

    /// Shows Herdr tab `tab` in `group`.
    pub(crate) fn choose_herdr_tab(
        &mut self,
        group: GroupId,
        tab: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(layout) = self.ensure_layout() else {
            return;
        };
        layout.choose(group, Pick::Herdr(tab.to_owned()));
        self.bring_group_tab(group, window, cx);
        cx.notify();
    }

    /// The next Herdr tab the daemon focuses goes to `group`: its "+" asked
    /// for it.
    pub(crate) fn expect_new_tab_in(&mut self, group: GroupId) {
        self.browser.new_tab_group = self.browser_key().map(|key| (key, group));
    }

    #[cfg(test)]
    pub(crate) fn expected_new_tab_group(&self) -> Option<GroupId> {
        self.browser.new_tab_group.as_ref().map(|(_, group)| *group)
    }

    /// Follows the window's connection moving its focus, from a shortcut, an
    /// agent, a closed tab, or a group's "+". The group holding the
    /// connection shows the new tab, unless a "+" asked for it in another
    /// group, which then takes the connection; the group that had it gets a
    /// parked one for its own tab. Arriving in another workspace moves its
    /// group only off a Herdr tab: one showing a page keeps it.
    pub(crate) fn terminal_focus_moved(
        &mut self,
        new: &str,
        arrived: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(key) = self.browser_key() else {
            return;
        };
        // Restore a saved layout before reading its groups.
        self.layout_for(key.clone());
        let asked = self
            .browser
            .new_tab_group
            .take_if(|(asked, _)| *asked == key)
            .map(|(_, group)| group);
        let primary = self.primary_group();
        let on_page =
            primary.is_some_and(|group| matches!(self.group_pick(group), Some(Pick::Page(_))));
        // A restored layout keeps its tabs; the group in use is taken back
        // to its own instead.
        let restoring = self.browser.restored.as_ref() == Some(&key);
        if arrived && (on_page || restoring) {
            return;
        }
        let layout = self.layout_for(key);
        match (asked, primary) {
            (Some(group), _) => {
                layout.choose(group, Pick::Herdr(new.to_owned()));
                self.set_primary_group(group);
            }
            (None, Some(primary)) => layout.focus_moved(primary, new),
            (None, None) => {}
        }
        self.reconcile_group_terminals(cx);
        cx.notify();
    }

    /// Lets groups that picked a Herdr tab the daemon closed follow the
    /// terminal instead.
    pub(crate) fn forget_closed_herdr_tabs(&mut self, cx: &mut Context<Self>) {
        let (Some(key), Some(snapshot)) = (self.browser_key(), self.live.snapshot.clone()) else {
            return;
        };
        let focused = self.focused_herdr_tab().map(str::to_owned);
        let Some(layout) = self.browser.layouts.get_mut(&key) else {
            return;
        };
        let closed: Vec<Pick> = layout
            .picks()
            .filter(|pick| {
                matches!(pick, Pick::Herdr(tab) if !snapshot.tabs.iter().any(|candidate| {
                    &candidate.tab_id == tab && candidate.workspace_id == key.1
                }))
            })
            .cloned()
            .collect();
        for pick in &closed {
            layout.replace(pick, None, focused.as_deref());
        }
        // Closed-in-group marks for tabs the daemon closed go with them.
        layout.forget_hidden(|pick| match pick {
            Pick::Herdr(tab) => snapshot
                .tabs
                .iter()
                .any(|candidate| &candidate.tab_id == tab && candidate.workspace_id == key.1),
            Pick::Page(id) => store(cx).is_some_and(|store| store.get(*id).is_some()),
        });
        if !closed.is_empty() {
            cx.notify();
        }
    }

    /// Shows a browser tab in the group in use.
    pub(crate) fn show_browser_tab(
        &mut self,
        id: TabId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.show_browser_tab_in(None, id, window, cx);
    }

    /// Shows a browser tab in `group`, or in the group in use of the tab's
    /// workspace.
    pub(crate) fn show_browser_tab_in(
        &mut self,
        group: Option<GroupId>,
        id: TabId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tab) = store(cx).and_then(|store| store.get(id)).cloned() else {
            return;
        };
        let layout = self.layout_for((tab.scope.clone(), tab.workspace_id.clone()));
        let group = group.unwrap_or(layout.active());
        layout.choose(group, Pick::Page(id));
        #[cfg(any(target_os = "macos", windows))]
        if let Err(error) = self.browser.pages.ensure(&tab, window, cx) {
            tracing::warn!(%error, "Cannot create a browser page");
            self.browser.failed = Some((id, error.to_string().into()));
        }
        self.sync_address(group, Some(&tab), true, window, cx);
        if tab.location.is_none() {
            let focus = self.group_address(group, cx).read(cx).focus.clone();
            window.focus(&focus, cx);
        }
        cx.notify();
    }

    /// Opens a blank browser tab in `group`.
    pub(crate) fn open_browser_tab_in(
        &mut self,
        group: GroupId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(layout) = self.ensure_layout() {
            layout.activate(group);
        }
        self.open_browser_tab(None, window, cx);
    }

    /// Closes a browser tab. Groups that picked it move to the browser tab
    /// after it, or before it, or else follow the terminal.
    pub(crate) fn close_browser_tab(
        &mut self,
        id: TabId,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tab) = store(cx).and_then(|store| store.get(id)).cloned() else {
            return;
        };
        let order: Vec<TabId> = store(cx)
            .map(|store| {
                store
                    .in_workspace(&tab.scope, &tab.workspace_id)
                    .map(|tab| tab.id)
                    .collect()
            })
            .unwrap_or_default();
        let position = order.iter().position(|tab| *tab == id).unwrap_or(0);
        let next = order
            .get(position + 1)
            .or_else(|| position.checked_sub(1).and_then(|before| order.get(before)))
            .copied();
        let key = (tab.scope.clone(), tab.workspace_id.clone());
        let focused = (self.browser_key().as_ref() == Some(&key))
            .then(|| self.focused_herdr_tab().map(str::to_owned))
            .flatten();
        if let Some(layout) = self.browser.layouts.get_mut(&key) {
            layout.replace(&Pick::Page(id), next.map(Pick::Page), focused.as_deref());
        }
        crate::browser::Store::update(cx, |store| store.close(id));
        self.forget_browser_tabs(|tab| tab == id);
        cx.notify();
    }

    /// Splits `group`: a new group to its right shows the same tab.
    pub(crate) fn split_group(
        &mut self,
        group: GroupId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let new = self.browser.group_ids.next();
        let focused = self.focused_herdr_tab().map(str::to_owned);
        let Some(layout) = self.ensure_layout() else {
            return;
        };
        if !layout.split(group, new, focused.as_deref()) {
            return;
        }
        self.browser.group_motion.open(new, group, Instant::now());
        // The new group shows the tab the window's connection shows, so it
        // takes that connection, and the group it split from connects anew
        // only once it picks a tab of its own.
        self.bring_group_tab(new, window, cx);
        self.sync_addresses(true, window, cx);
        cx.notify();
    }

    /// Splits the group in use.
    pub(crate) fn split_active_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(group) = self.ensure_layout().map(|layout| layout.active()) {
            self.split_group(group, window, cx);
        }
    }

    /// Closes `group`; its tabs stay in every other group's strip.
    pub(crate) fn close_group(
        &mut self,
        group: GroupId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(layout) = self.ensure_layout() else {
            return;
        };
        let target = layout.fold_target(group);
        if !layout.close(group) {
            return;
        }
        let active = layout.active();
        if let Some((index, share, into)) = target {
            self.browser
                .group_motion
                .fold(group, index, share, into, Instant::now());
        }
        self.browser.addresses.remove(&group);
        self.forget_group_terminal(group);
        self.bring_group_tab(active, window, cx);
        self.sync_addresses(true, window, cx);
        cx.notify();
    }

    /// Moves the divider after the `divider`th group; see [`Layout::drag`].
    pub(crate) fn drag_divider(&mut self, divider: usize, offset: f32, width: f32) -> bool {
        self.ensure_layout()
            .is_some_and(|layout| layout.drag(divider, offset, width))
    }

    /// `group`'s address field, made the first time it shows a page.
    pub(crate) fn group_address(&mut self, group: GroupId, cx: &mut App) -> Entity<SearchInput> {
        self.browser
            .addresses
            .entry(group)
            .or_insert_with(|| {
                let input = cx.new(|cx| {
                    let mut input = SearchInput::new(cx);
                    input.set_placeholder("Enter an address", cx);
                    input
                });
                (input, None)
            })
            .0
            .clone()
    }

    /// Shows each live page's address in its group's field, unless someone
    /// is typing there.
    pub(crate) fn sync_addresses(&mut self, force: bool, window: &Window, cx: &mut Context<Self>) {
        for slot in self.group_slots() {
            if let Shown::Page(id) = self.group_shown(slot.id, cx) {
                let tab = store(cx).and_then(|store| store.get(id)).cloned();
                self.sync_address(slot.id, tab.as_ref(), force, window, cx);
            }
        }
    }

    pub(crate) fn sync_address(
        &mut self,
        group: GroupId,
        tab: Option<&Tab>,
        force: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let input = self.group_address(group, cx);
        let id = tab.map(|tab| tab.id);
        let text = tab
            .and_then(|tab| tab.location.as_ref())
            .map(Location::display)
            .unwrap_or_default();
        let shown = self.browser.addresses.get(&group).and_then(|(_, tab)| *tab);
        let field = input.read(cx);
        if !force
            && (field.focus.is_focused(window) || (shown == id && field.text() == text.as_str()))
        {
            return;
        }
        if let Some((_, tab)) = self.browser.addresses.get_mut(&group) {
            *tab = id;
        }
        input.update(cx, |input, cx| input.set_text_selected(&text, cx));
    }
}
