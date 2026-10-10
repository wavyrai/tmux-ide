//! The titlebar's Git actions popup: commit, push, and pull request creation
//! for the focused local checkout, plus review, comment, and merge for its
//! open pull request.
use super::{Page, accent, danger};
use crate::{
    HerdrWindow,
    dialog_input::DialogInput,
    git::{Action, Status},
    pull_request::State as PrState,
};
use gpui::{prelude::*, *};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Row {
    Commit,
    Push,
    PullRequest,
    Review,
    Comment,
    Merge,
}

impl Row {
    pub(super) fn icon(self) -> &'static str {
        match self {
            Self::Commit => "icons/pencil.svg",
            Self::Push => "icons/chevron-up.svg",
            Self::PullRequest => "icons/git-branch.svg",
            Self::Review => "icons/pulse.svg",
            Self::Comment => "icons/plus.svg",
            Self::Merge => "icons/arrow-right.svg",
        }
    }
}

/// Stats as the titlebar and the popup header both show them.
pub(super) fn summary(status: Option<Status>) -> String {
    let Some(status) = status else {
        return "Checking working tree...".into();
    };
    if !status.dirty() {
        return "No uncommitted changes".into();
    }
    let mut parts = vec![format!("+{} -{}", status.additions, status.deletions)];
    if status.untracked > 0 {
        parts.push(format!(
            "{} untracked {}",
            status.untracked,
            if status.untracked == 1 {
                "entry"
            } else {
                "entries"
            }
        ));
    }
    parts.join(", ")
}

impl HerdrWindow {
    /// Follow the focused checkout and drain worker results. Called from the
    /// window's poll task, never from a render or input path.
    pub(crate) fn update_git(&mut self) -> bool {
        let now = std::time::Instant::now();
        let mut changed = self.git.track(self.git_input(), self.active, now);
        self.git
            .track_listed(self.listed_git_inputs(), self.active, now);
        changed |= self.git.poll(now);
        changed |= self.update_pr_actions(now);
        changed
    }

    /// Every listed local checkout, so the sidebar can mark the ones holding
    /// uncommitted work. Empty when the endpoint is not the owned local daemon.
    fn listed_git_inputs(&self) -> Vec<crate::pull_request::Input> {
        if !self.local_git_endpoint() {
            return Vec::new();
        }
        self.live
            .snapshot
            .iter()
            .flat_map(|snapshot| snapshot.workspaces.iter())
            .filter_map(|workspace| {
                crate::pull_request::repository_input(
                    workspace.worktree.as_ref(),
                    workspace.branch.as_deref(),
                )
                .ok()
            })
            .collect()
    }

    /// Local, owned daemon sockets only: the same trust boundary the PR lookup
    /// uses, because both run Git against the user's own checkouts.
    fn local_git_endpoint(&self) -> bool {
        self.selected_endpoint == 0
            && self.live.local_daemon_peer
            && self.live.status.is_connected()
    }

    /// The checkout the chrome acts on: the focused workspace's, when it is one
    /// this client may run Git in.
    pub(super) fn git_input(&self) -> Option<crate::pull_request::Input> {
        if !self.local_git_endpoint() {
            return None;
        }
        let snapshot = self.live.snapshot.as_ref()?;
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|workspace| {
                Some(workspace.workspace_id.as_str()) == snapshot.focused_workspace_id.as_deref()
            })
            .or_else(|| {
                snapshot
                    .workspaces
                    .iter()
                    .find(|workspace| workspace.focused)
            })?;
        crate::pull_request::repository_input(
            workspace.worktree.as_ref(),
            workspace.branch.as_deref(),
        )
        .ok()
    }

    pub(crate) fn open_git_menu(
        &mut self,
        anchor: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.menu.page.is_some() {
            self.dismiss_menu(window, cx);
            return;
        }
        if self.git.tracked().is_none() {
            return;
        }
        self.menu.reset();
        self.menu.anchor = anchor;
        self.menu.page = Some(Page::Git);
        if self.menu.github.connected()
            && let Some(input) = self.git_input()
        {
            self.sync_pr_scope();
            self.menu.pr_cache.refresh(input, std::time::Instant::now());
        }
        self.discard_composition(cx);
        window.focus(&self.menu.focus, cx);
        cx.notify();
    }

    /// The pull request already prefetched for the focused branch, in whatever
    /// lifecycle it is in. Reading the cache never schedules work.
    pub(crate) fn git_pull_request(&self) -> Option<&crate::pull_request::PullRequest> {
        let input = self.git.tracked()?;
        self.menu
            .github
            .connected()
            .then(|| {
                self.menu
                    .pr_cache
                    .peek(input.repo_key.as_deref()?, &input.branch)
            })
            .flatten()
    }

    /// A GitHub lookup for the focused branch is in flight or about to be.
    fn git_pull_request_loading(&self) -> bool {
        self.menu.github.connected()
            && self
                .git
                .tracked()
                .is_some_and(|input| self.menu.pr_cache.loading(input, std::time::Instant::now()))
    }

    /// Only an open pull request can be opened; a merged or closed one leaves
    /// creating the next one as the action.
    pub(super) fn git_open_pull_request(&self) -> Option<&crate::pull_request::PullRequest> {
        self.git_pull_request()
            .filter(|pr| pr.state == PrState::Open)
    }

    pub(super) fn git_rows(&self) -> Vec<(Row, String)> {
        if self.git.tracked().is_none() {
            return Vec::new();
        }
        let mut rows = vec![
            (Row::Commit, "Commit...".into()),
            (Row::Push, "Push".into()),
            match self.git_open_pull_request() {
                Some(pr) => (
                    Row::PullRequest,
                    format!("Open pull request #{}", pr.number),
                ),
                None => (Row::PullRequest, "Create pull request".into()),
            },
        ];
        // Acting on a pull request needs its identity, which only an open,
        // fully reported one carries.
        if let Some(pr) = self.git_open_pull_request()
            && self.pr_actions.target().is_some()
        {
            rows.push((Row::Review, "Checks and comments".into()));
            rows.push((Row::Comment, "Comment...".into()));
            // GitHub refuses to merge a draft; the repository may allow nothing.
            if !pr.is_draft && !pr.merge_methods.is_empty() {
                rows.push((Row::Merge, "Merge...".into()));
            }
        }
        rows
    }

    pub(super) fn activate_git_row(
        &mut self,
        row: Row,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // One explicit operation at a time, Git or GitHub.
        if self.git.running().is_some() || self.pr_actions.running().is_some() {
            return;
        }
        match row {
            Row::Commit => {
                self.menu.page = Some(Page::GitCommit);
                self.menu.input = Some(DialogInput::default());
            }
            Row::Push => self.start_git(Action::Push),
            Row::PullRequest => {
                if let Some(url) = self.git_open_pull_request().map(|pr| pr.url.clone()) {
                    cx.open_url(&url);
                    self.dismiss_menu(window, cx);
                    return;
                }
                self.start_git(Action::CreatePullRequest);
            }
            Row::Review => self.open_pr_review(),
            Row::Comment => self.open_pr_comment(),
            Row::Merge => self.open_pr_merge(),
        }
        cx.notify();
    }

    fn start_git(&mut self, action: Action) {
        let token = self
            .menu
            .github
            .profile
            .as_ref()
            .map(|profile| profile.token.clone());
        if let Err(error) = self.git.start(action, token) {
            self.menu.error = Some(error.to_string());
        } else {
            self.menu.error = None;
        }
    }

    pub(super) fn submit_git_commit(&mut self, cx: &mut Context<Self>) {
        if self
            .menu
            .input
            .as_ref()
            .is_some_and(|input| input.marked.is_some())
        {
            return;
        }
        let message = self
            .menu
            .input
            .as_ref()
            .map(|input| input.text.trim().to_owned())
            .unwrap_or_default();
        self.start_git(Action::Commit(message));
        if self.menu.error.is_none() {
            self.menu.input = None;
            self.menu.page = Some(Page::Git);
        }
        cx.notify();
    }

    pub(super) fn git_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let rows = self.git_rows();
        match event.keystroke.key.as_str() {
            "escape" => self.dismiss_menu(window, cx),
            "up" | "down" if !rows.is_empty() => {
                let selected = self
                    .menu
                    .git_selected
                    .and_then(|selected| rows.iter().position(|(row, _)| *row == selected));
                let index = match (selected, event.keystroke.key.as_str()) {
                    (None, "up") => rows.len() - 1,
                    (None, _) => 0,
                    (Some(index), "up") => (index + rows.len() - 1) % rows.len(),
                    (Some(index), _) => (index + 1) % rows.len(),
                };
                self.menu.git_selected = Some(rows[index].0);
                cx.notify();
            }
            "enter" => {
                if let Some(row) = self
                    .menu
                    .git_selected
                    .filter(|row| rows.iter().any(|(candidate, _)| candidate == row))
                {
                    self.activate_git_row(row, window, cx);
                }
            }
            _ => {}
        }
    }

    fn render_git_summary(&self) -> Div {
        let theme = &self.theme;
        let row = div()
            .debug_selector(|| "git-menu-summary".into())
            .px(px(8.))
            .pb(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .text_color(rgb(theme.muted));
        let Some(status) = self.git.status().filter(|status| status.dirty()) else {
            return row.child(summary(self.git.status()));
        };
        row.child(
            div()
                .flex_1()
                .min_w_0()
                .child("Not yet committed")
                .when(status.untracked > 0, |label| {
                    label.child(format!(" ({} untracked)", status.untracked))
                }),
        )
        .child(
            div()
                .flex()
                .flex_none()
                .gap(px(6.))
                .child(
                    div()
                        .debug_selector(|| "git-menu-uncommitted-additions".into())
                        .text_color(rgb(theme.ink(theme.palette[2])))
                        .child(format!("+{}", crate::sidebar::compact(status.additions))),
                )
                .child(
                    div()
                        .debug_selector(|| "git-menu-uncommitted-deletions".into())
                        .text_color(rgb(theme.ink(theme.palette[1])))
                        .child(format!("-{}", crate::sidebar::compact(status.deletions))),
                ),
        )
    }

    pub(super) fn render_git_menu(&self, cx: &mut Context<Self>) -> Div {
        let theme = &self.theme;
        let font = &self.config.ui;
        let mut panel = div().flex().flex_col();
        if let Some(input) = self.git.tracked() {
            panel = panel.child(
                div()
                    .debug_selector(|| "git-menu-branch".into())
                    .px(px(8.))
                    .pt(px(4.))
                    .pb(px(8.))
                    .text_color(rgb(theme.muted))
                    .truncate()
                    .child(input.branch.clone()),
            );
        }
        if let Some(pr) = self.git_pull_request() {
            let url = pr.url.clone();
            panel = panel.child(
                div()
                    .id("git-menu-pr-title")
                    .debug_selector(|| "git-menu-pr-title".into())
                    .px(px(8.))
                    .py(px(6.))
                    .mb(px(4.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .font_weight(FontWeight::SEMIBOLD)
                    .cursor_pointer()
                    .hover(|link| link.bg(rgb(theme.active)))
                    .child(pr.title.clone())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        cx.open_url(&url);
                        this.dismiss_menu(window, cx);
                    })),
            );
            panel = panel.child(
                div()
                    .debug_selector(|| "git-menu-pr".into())
                    .px(px(8.))
                    .pb(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_color(rgb(pr.color(theme)))
                            .child(format!("#{}", pr.number)),
                    )
                    .child(
                        div()
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(crate::config::corners::CONTROL))
                            .bg(rgb(theme.active))
                            .text_color(rgb(pr.color(theme)))
                            .child(pr.lifecycle()),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .debug_selector(|| "git-menu-pr-counts".into())
                            .flex()
                            .child(
                                div()
                                    .text_color(rgb(theme.ink(theme.palette[2])))
                                    .child(format!("+{}", crate::sidebar::compact(pr.additions))),
                            )
                            .gap(px(6.))
                            .child(
                                div()
                                    .text_color(rgb(theme.ink(theme.palette[1])))
                                    .child(format!("-{}", crate::sidebar::compact(pr.deletions))),
                            ),
                    ),
            );
            panel = panel.child(self.render_git_summary());
            if pr.state == PrState::Open {
                panel = panel.child(
                    div()
                        .debug_selector(|| "git-menu-pr-readiness".into())
                        .px(px(8.))
                        .pb(px(8.))
                        .child(if pr.is_draft {
                            "Draft — not ready for review"
                        } else {
                            "Ready for review"
                        }),
                );
            }
            for (selector, heading, label) in [
                ("git-menu-pr-review", "Review", pr.review().to_owned()),
                ("git-menu-pr-merge", "Merge", pr.merge_status().to_owned()),
                ("git-menu-pr-checks", "Checks", pr.checks_summary.clone()),
            ] {
                panel = panel.child(
                    div()
                        .debug_selector(move || selector.into())
                        .px(px(8.))
                        .pb(px(6.))
                        .flex()
                        .gap(px(10.))
                        .child(
                            div()
                                .w(px(48.))
                                .flex_none()
                                .text_color(rgb(theme.muted))
                                .child(heading),
                        )
                        .child(div().flex_1().min_w_0().child(label)),
                );
            }
        } else {
            if self.git_pull_request_loading() {
                panel = panel.child(
                    div()
                        .debug_selector(|| "git-menu-pr-loading".into())
                        .px(px(8.))
                        .pb(px(10.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .text_color(rgb(theme.muted))
                        .child(
                            svg()
                                .path("icons/refresh.svg")
                                .size(px(12.))
                                .flex_none()
                                .text_color(rgb(theme.muted))
                                .with_animation(
                                    "git-menu-pr-loading",
                                    Animation::new(std::time::Duration::from_secs(1)).repeat(),
                                    |icon, delta| {
                                        icon.with_transformation(Transformation::rotate(
                                            percentage(delta),
                                        ))
                                    },
                                ),
                        )
                        .child("Loading pull request..."),
                );
            }
            panel = panel.child(self.render_git_summary());
        }
        panel = panel.child(
            div()
                .mt(px(4.))
                .mb(px(4.))
                .border_t_1()
                .border_color(rgb(theme.active)),
        );
        let running = self.git.running().is_some() || self.pr_actions.running().is_some();
        for (row, label) in self.git_rows() {
            let selected = self.menu.git_selected == Some(row);
            panel = panel.child(
                div()
                    .id(SharedString::from(label.clone()))
                    .debug_selector({
                        let label = label.clone();
                        move || format!("git-menu-{label}")
                    })
                    .min_h(px(font.line_height() + 12.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .when(!running, |item| item.cursor_pointer())
                    .when(running, |item| item.text_color(rgb(theme.muted)))
                    .when(selected && !running, |item| item.bg(rgb(theme.active)))
                    .on_hover(cx.listener(move |this, hovered, _, cx| {
                        if *hovered {
                            this.menu.git_selected = Some(row);
                        } else if this.menu.git_selected == Some(row) {
                            this.menu.git_selected = None;
                        }
                        cx.notify();
                    }))
                    .child(
                        svg()
                            .path(row.icon())
                            .size(px(14.))
                            .flex_none()
                            .text_color(rgb(theme.muted)),
                    )
                    .child(label)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.activate_git_row(row, window, cx);
                    })),
            );
        }
        if let Some(action) = self.git.running() {
            panel = panel.child(
                div()
                    .debug_selector(|| "git-menu-running".into())
                    .p(px(8.))
                    .text_color(rgb(theme.ink(theme.palette[3])))
                    .child(action.running_label()),
            );
        }
        if let Some(outcome) = self.git.outcome() {
            panel = panel.child(
                div()
                    .debug_selector(|| "git-menu-outcome".into())
                    .p(px(8.))
                    .child(outcome.message.clone()),
            );
            if let Some(url) = outcome.url.clone() {
                panel = panel.child(
                    div()
                        .id("git-menu-open")
                        .debug_selector(|| "git-menu-open".into())
                        .px(px(8.))
                        .pb(px(8.))
                        .cursor_pointer()
                        .text_color(accent(theme))
                        .child("Open in browser")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            cx.open_url(&url);
                            this.dismiss_menu(window, cx);
                        })),
                );
            }
        }
        panel = self.render_pr_action_status(panel, cx);
        for error in self
            .git
            .error()
            .into_iter()
            .chain(self.menu.error.as_deref())
        {
            panel = panel.child(
                div()
                    .debug_selector(|| "git-menu-error".into())
                    .p(px(8.))
                    .text_color(rgb(theme.ink(theme.palette[1])))
                    .child(error.to_owned()),
            );
        }
        panel
    }

    /// The commit dialog wears the workspace dialogs' chrome: a titled header
    /// naming the branch, the body, then right-aligned actions. Its primary
    /// action stays unarmed until there is a message to commit.
    pub(super) fn render_git_commit(&self, cx: &mut Context<Self>) -> Div {
        let theme = &self.theme;
        let font = &self.config.ui;
        let armed = self
            .menu
            .input
            .as_ref()
            .is_some_and(|input| !input.text.trim().is_empty());
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .px(px(16.))
            .py(px(12.))
            .child(
                div()
                    .text_color(rgb(theme.subtext()))
                    .child("Stages every change in the checkout, then commits."),
            )
            .child(
                div()
                    .debug_selector(|| "git-commit-summary".into())
                    .rounded(px(crate::config::corners::CONTROL))
                    .bg(rgb(theme.active))
                    .px(px(10.))
                    .py(px(6.))
                    .child(summary(self.git.status())),
            );
        if self.menu.input.is_some() {
            body = body.child(self.render_dialog_input(cx));
        }
        if let Some(error) = &self.menu.error {
            body = body.child(
                div()
                    .debug_selector(|| "git-commit-error".into())
                    .rounded(px(crate::config::corners::CONTROL))
                    .bg(rgb(theme.active))
                    .px(px(10.))
                    .py(px(6.))
                    .text_color(danger(theme))
                    .child(error.clone()),
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
                            .path(Row::Commit.icon())
                            .size(px(16.))
                            .flex_none()
                            .text_color(rgb(theme.muted)),
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
                                    .child("Commit"),
                            )
                            .when_some(self.git.tracked(), |header, input| {
                                header.child(
                                    div()
                                        .truncate()
                                        .text_color(rgb(theme.muted))
                                        .child(input.branch.clone()),
                                )
                            }),
                    ),
            )
            .child(body)
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .px(px(16.))
                    .py(px(12.))
                    .border_t_1()
                    .border_color(rgb(theme.active))
                    .child(
                        button("git-commit-cancel")
                            .border_color(rgb(theme.active))
                            .hover(|button| button.bg(rgb(theme.active)))
                            .child("Cancel")
                            .on_click(cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.dismiss_menu(window, cx);
                            })),
                    )
                    .child(
                        button("git-commit-submit")
                            .border_color(rgb(if armed {
                                theme.foreground
                            } else {
                                theme.active
                            }))
                            .when(armed, |button| button.bg(rgb(theme.active)))
                            .text_color(rgb(if armed { theme.foreground } else { theme.muted }))
                            .hover(|button| button.bg(rgb(theme.active)))
                            .child("Commit")
                            .on_click(cx.listener(|this, _, _, cx| {
                                cx.stop_propagation();
                                this.submit_git_commit(cx);
                            })),
                    ),
            )
    }
}

#[cfg(test)]
mod tests;
