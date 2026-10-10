//! The menu behind a group's "…" button: tabs other than a terminal to open
//! in the group (a blank browser tab, the focused checkout's review, the
//! focused workspace's listening ports), closing tabs in the group, and
//! splitting it. A terminal tab comes from the group's "+". Closing here only
//! ever takes tabs out of this group's strip, as an editor's group menu does:
//! the tabs stay open in Herdr, in the browser, and in every other group.
//! Only a tab's own close, unsplit, reaches Herdr, through its confirmation.
use crate::{
    HerdrWindow,
    browser::{GroupId, Pick},
    controls::Command,
    listening_ports::Link,
    menu::Page,
};
use gpui::{prelude::*, *};

/// The most a port's process name takes in its row. Names run to 32
/// characters, and the address beside it is what tells ports apart.
const PROCESS_WIDTH: f32 = 64.;

/// How large a row's icon draws, and the room a row without one keeps so
/// labels line up.
const ICON_SIZE: f32 = 14.;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Action {
    NewBrowserTab,
    /// The review tab of the checkout the Git chip tracks.
    Review,
    /// One of the focused workspace's listening ports and where it opens.
    Port {
        number: u16,
        process: String,
        link: Link,
    },
    Close,
    CloseOthers,
    /// Closes the group, and with it every tab in it.
    CloseAll,
    Split,
}

impl Action {
    /// The row's text, which for a port is where its page opens.
    fn label(&self) -> SharedString {
        match self {
            Self::NewBrowserTab => "New Browser Tab".into(),
            Self::Review => "Review Changes".into(),
            Self::Port { link, .. } => link.label().into(),
            Self::Close => "Close".into(),
            Self::CloseOthers => "Close Others".into(),
            Self::CloseAll => "Close All".into(),
            Self::Split => "Split Right".into(),
        }
    }

    fn icon(&self) -> Option<&'static str> {
        match self {
            Self::NewBrowserTab => Some("icons/globe.svg"),
            Self::Review => Some("icons/diff-unified.svg"),
            Self::Port { .. } => Some("icons/arrow-right.svg"),
            Self::Split => Some("icons/split.svg"),
            Self::Close | Self::CloseOthers | Self::CloseAll => None,
        }
    }

    /// Stable for tests: `Port5173` rather than the port's whole value.
    fn selector(&self) -> String {
        match self {
            Self::Port { number, .. } => format!("group-menu-Port{number}"),
            action => format!("group-menu-{action:?}"),
        }
    }

    /// Which run of rows this one belongs to; a rule separates runs.
    fn section(&self) -> u8 {
        match self {
            Self::NewBrowserTab | Self::Review => 0,
            Self::Port { .. } => 1,
            Self::Close | Self::CloseOthers | Self::CloseAll => 2,
            Self::Split => 3,
        }
    }
}

pub(crate) struct GroupMenu {
    group: GroupId,
    selected: Option<usize>,
    /// The panel's own scroll, so a row the keyboard selects past a long
    /// list of ports scrolls into view.
    scroll: ScrollHandle,
}

/// The panel child that draws `actions[index]`: the "Listening" heading
/// before the first port is a child of its own.
fn child_index(actions: &[Action], index: usize) -> usize {
    let heading = actions
        .iter()
        .take(index + 1)
        .any(|action| matches!(action, Action::Port { .. }));
    index + usize::from(heading)
}

impl HerdrWindow {
    /// The rows worth offering for `group`. Review needs a checkout; ports
    /// come from the last scan, so they follow the status bar's. Closing
    /// belongs to a split: a lone group has nowhere else to keep its tabs.
    fn group_actions(&self, group: GroupId, cx: &App) -> Vec<Action> {
        let mut actions = vec![Action::NewBrowserTab];
        if self.git.tracked().is_some() {
            actions.push(Action::Review);
        }
        if let Some((_, _, listed)) = self.focused_listening_ports() {
            actions.extend(listed.ports.iter().filter_map(|port| {
                Some(Action::Port {
                    number: port.number,
                    process: port.process.clone(),
                    link: port.link(listed.origin)?,
                })
            }));
        }
        if self.is_split() {
            let pick = self.group_pick(group);
            if pick.is_some() {
                actions.push(Action::Close);
            }
            if self
                .group_tabs(group, cx)
                .iter()
                .any(|tab| Some(tab) != pick.as_ref())
            {
                actions.push(Action::CloseOthers);
            }
            actions.push(Action::CloseAll);
        }
        actions.push(Action::Split);
        actions
    }

    pub(crate) fn open_group_menu(
        &mut self,
        group: GroupId,
        anchor: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.open_menu(window, cx) {
            return;
        }
        self.menu.anchor = anchor;
        self.menu.page = Some(Page::Group);
        self.menu.group = Some(GroupMenu {
            group,
            selected: None,
            scroll: ScrollHandle::new(),
        });
    }

    fn activate_group_menu(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        let Some(group) = self.menu.group.as_ref().map(|menu| menu.group) else {
            return;
        };
        self.dismiss_menu(window, cx);
        self.activate_group(group, window, cx);
        match action {
            Action::NewBrowserTab => self.open_browser_tab_in(group, window, cx),
            Action::Review => self.open_review(window, cx),
            Action::Port { link, .. } => {
                let Some((endpoint, workspace)) = self
                    .focused_listening_ports()
                    .map(|(endpoint, workspace, _)| (endpoint.to_owned(), workspace.to_owned()))
                else {
                    return;
                };
                self.open_port_link(&endpoint, &workspace, &link, window, cx);
            }
            Action::Close => {
                if let Some(pick) = self.group_pick(group) {
                    self.close_in_group(group, vec![pick], window, cx);
                }
            }
            Action::CloseOthers => {
                let keep = self.group_pick(group);
                let others: Vec<Pick> = self
                    .group_tabs(group, cx)
                    .into_iter()
                    .filter(|tab| Some(tab) != keep.as_ref())
                    .collect();
                self.close_in_group(group, others, window, cx);
            }
            Action::CloseAll => self.close_group(group, window, cx),
            Action::Split => self.split_group(group, window, cx),
        }
    }

    /// Closes the tab `group` shows, for Close Tab: a page at once, a Herdr
    /// tab through its confirmation.
    pub(crate) fn close_group_tab(
        &mut self,
        group: GroupId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match self.group_pick(group) {
            Some(Pick::Herdr(tab)) => self.open_tab_close(&tab, window, cx),
            Some(Pick::Page(id)) => self.close_browser_tab(id, window, cx),
            None => {}
        }
    }

    pub(crate) fn group_menu_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(group) = self.menu.group.as_ref().map(|menu| menu.group) else {
            return;
        };
        let actions = self.group_actions(group, cx);
        let Some(menu) = &mut self.menu.group else {
            return;
        };
        let key = event.keystroke.key.as_str();
        cx.stop_propagation();
        window.prevent_default();
        let count = actions.len();
        match key {
            "escape" => self.dismiss_menu(window, cx),
            "up" | "down" => {
                let selected = match (menu.selected, key) {
                    (None, "up") => count - 1,
                    (None, _) => 0,
                    (Some(i), "up") => (i + count - 1) % count,
                    (Some(i), _) => (i + 1) % count,
                };
                menu.selected = Some(selected);
                menu.scroll.scroll_to_item(child_index(&actions, selected));
                cx.notify();
            }
            "enter" => {
                if let Some(action) = menu.selected.and_then(|index| actions.get(index)).cloned() {
                    self.activate_group_menu(action, window, cx);
                }
            }
            _ => {}
        }
    }

    /// Fills the menu's `panel` with its rows. They are the panel's own
    /// children, which the panel's scroll handle addresses by index.
    pub(crate) fn render_group_menu(
        &self,
        panel: Stateful<Div>,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let Some(menu) = &self.menu.group else {
            return panel;
        };
        let theme = &self.theme;
        let mut panel = panel.track_scroll(&menu.scroll).flex().flex_col();
        let mut section = None;
        for (index, action) in self.group_actions(menu.group, cx).into_iter().enumerate() {
            let starts_section = section.is_some_and(|last| last != action.section());
            let first_port = matches!(action, Action::Port { .. }) && section != Some(1);
            section = Some(action.section());
            if first_port {
                panel = panel.child(
                    div()
                        .flex_none()
                        .when(starts_section, |heading| {
                            heading
                                .mt(px(4.))
                                .border_t_1()
                                .border_color(rgb(theme.active))
                        })
                        .pt(px(6.))
                        .pb(px(2.))
                        .px(px(8.))
                        .text_xs()
                        .text_color(rgb(theme.muted))
                        .child("Listening"),
                );
            }
            let detail: SharedString = match &action {
                Action::NewBrowserTab => self
                    .keymap()
                    .primary(Command::NewBrowserTab)
                    .to_owned()
                    .into(),
                Action::Port { process, .. } => process.clone().into(),
                _ => "".into(),
            };
            let selector = action.selector();
            let (label, process) = (format!("{selector}-label"), format!("{selector}-detail"));
            let capped = matches!(action, Action::Port { .. });
            panel = panel.child(
                div()
                    .id(("group-menu-action", index))
                    .flex_none()
                    .debug_selector(move || selector.clone())
                    .when(starts_section && !first_port, |row| {
                        row.mt(px(4.)).border_t_1().border_color(rgb(theme.active))
                    })
                    .min_h(px(self.config.ui.line_height() + 12.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .cursor_pointer()
                    .when(menu.selected == Some(index), |row| {
                        row.bg(rgb(theme.active))
                    })
                    .hover(|row| row.bg(rgb(theme.active)))
                    .child(match action.icon() {
                        Some(icon) => svg()
                            .path(icon)
                            .size(px(ICON_SIZE))
                            .flex_none()
                            .text_color(rgb(theme.muted))
                            .into_any_element(),
                        None => div().size(px(ICON_SIZE)).flex_none().into_any_element(),
                    })
                    .child(
                        div()
                            .debug_selector(move || label.clone())
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(action.label()),
                    )
                    .when(!detail.is_empty(), |line| {
                        line.child(
                            div()
                                .debug_selector(move || process.clone())
                                .flex_none()
                                .when(capped, |detail| detail.max_w(px(PROCESS_WIDTH)).truncate())
                                .text_color(rgb(theme.muted))
                                .child(detail),
                        )
                    })
                    .on_hover(cx.listener(move |this, hovered, _, cx| {
                        if *hovered && let Some(menu) = &mut this.menu.group {
                            menu.selected = Some(index);
                            cx.notify();
                        }
                    }))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.activate_group_menu(action.clone(), window, cx)
                    })),
            );
        }
        panel
    }
}

#[cfg(test)]
mod tests;
