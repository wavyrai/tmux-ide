//! A review lives in a tab, beside the workspace's terminals and pages, so it
//! can sit in a group of its own, take the whole window, or close like any
//! tab. The tab, saved with the others, keeps the checkout and, as its
//! `origin`, the pane of the agent its notes go to. The review's state lives
//! in the window: made when the tab is opened or first seen after a restart,
//! and read off the UI thread from the window's tick, never from drawing.
use super::{Agent, Layout, Review, State, agent_in, pick_agent, rows, search};
use crate::{
    HerdrWindow,
    browser::{Location, ReviewCheckout, Slot, Store, Tab, TabId},
    pull_request::Input,
    search_input::{self, SearchInput},
    window::Flash,
};
use gpui::{prelude::*, *};
use std::{
    cell::Cell,
    collections::{BTreeSet, HashMap, HashSet},
};

impl HerdrWindow {
    /// Opens the focused checkout's review tab in the group in use, or
    /// brings back the one already open, and reads its changes again.
    pub(crate) fn open_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(checkout) = self
            .git
            .tracked()
            .and_then(|input| ReviewCheckout::try_from(input).ok())
        else {
            self.show_flash(Flash::warning("No local checkout to review"), cx);
            return;
        };
        // The workspace whose checkout the Git chip tracks, found the same way.
        let workspace = self.live.snapshot.as_deref().and_then(|snapshot| {
            snapshot.focused_workspace_id.clone().or_else(|| {
                snapshot
                    .workspaces
                    .iter()
                    .find(|workspace| workspace.focused)
                    .map(|workspace| workspace.workspace_id.clone())
            })
        });
        let Some(workspace) = workspace else {
            self.show_flash(Flash::warning("Open a workspace first"), cx);
            return;
        };
        let scope = crate::browser::scope(&self.endpoints[self.selected_endpoint]);
        let agent = self.live.snapshot.as_deref().and_then(pick_agent);
        let existing = cx.try_global::<Store>().and_then(|store| {
            store
                .in_workspace(&scope, &workspace)
                .find(|tab| {
                    matches!(&tab.location, Some(Location::Review { checkout: open }) if *open == checkout)
                })
                .map(|tab| tab.id)
        });
        let origin = agent.as_ref().map(|agent| agent.pane_id.clone());
        let opened = existing.or_else(|| {
            Store::update(cx, |store| {
                store.open(
                    scope,
                    &workspace,
                    Some(Location::Review { checkout }),
                    origin,
                )
            })
        });
        let Some(id) = opened else {
            self.show_flash(Flash::warning("Too many tabs are open"), cx);
            return;
        };
        self.dismiss_menu(window, cx);
        self.ensure_review(id, agent, cx);
        self.load_review(id, cx);
        self.show_browser_tab(id, window, cx);
        if let Some(review) = self.reviews.get(&id) {
            window.focus(&review.focus, cx);
        }
    }

    /// Makes `id`'s review from its tab, if the window has none yet; a newly
    /// named `agent` replaces the one the review sends to. Whether it was made.
    fn ensure_review(&mut self, id: TabId, agent: Option<Agent>, cx: &mut Context<Self>) -> bool {
        if let Some(review) = self.reviews.get_mut(&id) {
            if agent.is_some() {
                review.agent = agent;
            }
            return false;
        }
        let Some(Location::Review { checkout }) = cx
            .try_global::<Store>()
            .and_then(|store| store.get(id))
            .and_then(|tab| tab.location.clone())
        else {
            return false;
        };
        let review = self.new_review(id, Input::from(&checkout), agent, cx);
        self.reviews.insert(id, review);
        true
    }

    /// The review holding the keyboard, or one of its fields.
    pub(crate) fn focused_review(&self, window: &Window, cx: &App) -> Option<TabId> {
        self.reviews
            .iter()
            .find(|(_, review)| {
                review.focus.contains_focused(window, cx)
                    || review.files_focus.is_focused(window)
                    || review.search.input.read(cx).focus.is_focused(window)
                    || review.filter.read(cx).focus.is_focused(window)
                    || review.input.read(cx).focus.is_focused(window)
            })
            .map(|(id, _)| *id)
    }

    /// Runs every window tick: review tabs of the focused workspace that
    /// have no state yet, such as ones restored from the last run, get one
    /// and read their changes; the state of closed tabs goes.
    pub(crate) fn poll_reviews(&mut self, cx: &mut Context<Self>) {
        let Some(store) = cx.try_global::<Store>() else {
            self.reviews.clear();
            return;
        };
        self.reviews.retain(|id, _| store.get(*id).is_some());
        let Some((scope, workspace)) = self.browser_key() else {
            return;
        };
        let snapshot = self.live.snapshot.clone();
        let missing: Vec<(TabId, Option<Agent>)> = store
            .in_workspace(&scope, &workspace)
            .filter(|tab| {
                matches!(tab.location, Some(Location::Review { .. }))
                    && !self.reviews.contains_key(&tab.id)
            })
            .map(|tab| {
                let agent = tab
                    .origin
                    .as_deref()
                    .zip(snapshot.as_deref())
                    .and_then(|(pane, snapshot)| agent_in(snapshot, pane));
                (tab.id, agent)
            })
            .collect();
        for (id, agent) in missing {
            if self.ensure_review(id, agent, cx) {
                self.load_review(id, cx);
            }
        }
        self.follow_review_changes(cx);
    }

    /// A review tab, drawn in `slot` where a page would be.
    pub(crate) fn render_review_tab(
        &self,
        slot: Slot,
        tab: &Tab,
        gap: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = tab.id;
        let Some(review) = self.reviews.get(&id) else {
            return div()
                .id(SharedString::from(slot.selector("review-loading")))
                .size_full()
                .pl(px(gap))
                .into_any_element();
        };
        let focus = review.focus.clone();
        div()
            .id(SharedString::from(slot.selector("review-tab")))
            .size_full()
            .min_w_0()
            .pl(px(gap))
            .track_focus(&focus)
            // The review holds the keyboard while used, so typing never
            // reaches a terminal in another group.
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _, window, cx| {
                    if let Some(review) = this.reviews.get(&id)
                        && !review.input.read(cx).focus.is_focused(window)
                    {
                        window.focus(&review.focus, cx);
                    }
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |this, _, _, _| this.release_review_code(id)),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(move |this, _, _, _| this.release_review_code(id)),
            )
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                // Only keys meant for the diff itself; fields keep theirs.
                let Some(review) = this.reviews.get(&id) else {
                    return;
                };
                if review.focus.is_focused(window) && this.review_key(id, event, window, cx) {
                    cx.stop_propagation();
                }
            }))
            // The Edit menu's Copy and Select All, which replay their keys.
            .when(review.selection.is_some_and(|s| !s.is_empty()), |tab| {
                tab.on_action(
                    cx.listener(move |this, _: &crate::actions::Copy, window, cx| {
                        this.review_key(id, &crate::actions::edit_key("c"), window, cx);
                    }),
                )
            })
            .on_action(
                cx.listener(move |this, _: &crate::actions::SelectAll, window, cx| {
                    this.review_key(id, &crate::actions::edit_key("a"), window, cx);
                }),
            )
            .child(self.render_review(id, cx))
            .into_any_element()
    }
}

impl HerdrWindow {
    /// A review of `checkout` for tab `id`, its fields made and followed.
    pub(super) fn new_review(
        &mut self,
        id: TabId,
        checkout: Input,
        agent: Option<Agent>,
        cx: &mut Context<Self>,
    ) -> Review {
        let (ui, theme) = (self.config.ui.clone(), self.theme.clone());
        let field = |placeholder: &'static str, cx: &mut Context<Self>| {
            let (ui, theme) = (ui.clone(), theme.clone());
            cx.new(|cx| {
                let mut input = SearchInput::new(cx);
                input.set_placeholder(placeholder, cx);
                input.set_appearance(ui, theme, cx);
                input
            })
        };
        let input = field("Describe the change\u{2026}", cx);
        let filter = field("Filter files\u{2026}", cx);
        let search = field("Find in changes\u{2026}", cx);
        let subscriptions = vec![
            cx.subscribe(&filter, move |this, _, _: &search_input::Changed, cx| {
                this.review_filter_changed(id, cx);
            }),
            cx.subscribe(&search, move |this, _, _: &search_input::Changed, cx| {
                this.review_query_changed(id, cx);
            }),
        ];
        Review {
            checkout,
            scope: super::Scope::default(),
            layout: Layout::default(),
            ignore_whitespace: false,
            split_ratio: rows::EVEN_SPLIT,
            agent,
            endpoint: self.selected_endpoint,
            state: State::Loading,
            starts: vec![0],
            reading: HashSet::new(),
            batch_out: false,
            wanted: BTreeSet::new(),
            eager: 0,
            cursor: 0,
            expanding: HashSet::new(),
            colours: Default::default(),
            viewed: HashMap::new(),
            folds: HashMap::new(),
            tree: Default::default(),
            closed: HashSet::new(),
            hide_viewed: false,
            shown: Vec::new(),
            picked: None,
            filter,
            filter_text: String::new(),
            files_scroll: UniformListScrollHandle::new(),
            files_focus: cx.focus_handle(),
            revealed: Cell::new(None),
            search: search::Search::new(search),
            draft: None,
            selection: None,
            selecting: false,
            notes: Vec::new(),
            marks: HashMap::new(),
            input,
            scroll: ListState::new(0, ListAlignment::Top, px(super::OVERDRAW)),
            hinted: Default::default(),
            grab: 0.,
            request: 0,
            focus: cx.focus_handle(),
            files_shown: None,
            notes_shown: None,
            width: Default::default(),
            seen: None,
            restore: None,
            _subscriptions: subscriptions,
        }
    }
}
