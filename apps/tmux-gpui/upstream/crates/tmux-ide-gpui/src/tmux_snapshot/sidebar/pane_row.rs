//! A pane row's trailing parts (#746): the agent's state, a … button on hover,
//! and the pane menu on right-click.
use super::*;
use crate::tmux_snapshot::SnapshotView;

impl SnapshotView {
    pub(in crate::tmux_snapshot) fn sidebar_pane_row(
        &self,
        element: Stateful<Div>,
        index: usize,
        pane: &str,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let state = panes::pane_agent(&self.browser_state, pane)
            .and_then(|(agent, unavailable)| self.agent_state(agent, unavailable));
        let more = self.pane_row_more(index, pane, cx);
        let id = pane.to_owned();
        element
            .debug_selector(move || format!("tmux-sidebar-pane:{id}"))
            .children(state)
            .child(more)
            .on_mouse_down(MouseButton::Right, menu(pane.to_owned(), cx))
    }

    /// A pane row's … button: the row's menu on a click, and VoiceOver's
    /// "press" on it (AXPress reaches gpui as a click action).
    pub(in crate::tmux_snapshot) fn pane_row_more(
        &self,
        index: usize,
        pane: &str,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let bezel = crate::tmux_snapshot::design::palette(&self.theme());
        let hover = bezel.element_hover;
        let (_, muted) = crate::tmux_snapshot::design::row_ink(&self.theme());
        use bezel_ui::widgets::Buttons as _;
        div()
            .id(("sidebar-pane-menu", index))
            .debug_selector(move || format!("tmux-sidebar-pane-menu-{index}"))
            .role(Role::Button)
            .aria_label("Pane actions")
            .flex_none()
            .when(!self.sidebar_keyboard.active, |d| {
                d.opacity(0.)
                    .group_hover("session-sidebar-row", |s| s.opacity(1.))
            })
            .child(
                bezel
                    .tinted_icon_button(
                        bezel_ui::icons::Icon::asset("icons/more.svg"),
                        rgb(muted).into(),
                    )
                    .rounded(px(bezel_theme::Theme::control_radius()))
                    // Bezel's square is a 24pt control; this one sits in
                    // a 30pt row beside the 20pt kind tile.
                    .min_h_0()
                    .size(px(20.))
                    .hover(move |s| s.bg(hover)),
            )
            .on_mouse_down(MouseButton::Left, menu(pane.to_owned(), cx))
            .on_a11y_action(accesskit::Action::Click, spoken_menu(pane, cx))
    }
}

/// A screen reader's action that opens pane `pane`'s menu.
fn spoken_menu(
    pane: &str,
    cx: &mut Context<SnapshotView>,
) -> impl FnMut(Option<&accesskit::ActionData>, &mut Window, &mut App) + 'static {
    let view = cx.entity().downgrade();
    let pane = pane.to_owned();
    move |_, window, app| {
        let _ = view.update(app, |view, cx| view.open_pane_menu(&pane, window, cx));
    }
}

fn menu(
    pane: String,
    cx: &mut Context<SnapshotView>,
) -> impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static {
    cx.listener(move |view, _: &MouseDownEvent, window, cx| {
        cx.stop_propagation();
        view.open_pane_menu(&pane, window, cx);
    })
}

impl SnapshotView {
    /// The sidebar's first row (#746): Home, with how many agents need input.
    /// A Tab stop after the rows, like the other sidebar controls.
    pub(in crate::tmux_snapshot) fn sidebar_home_row(
        &self,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = self.theme();
        let bezel = bezel_theme::Theme::of(cx).clone();
        let waiting = waiting_agents(&self.browser_state);
        let row = Row {
            label: "Home".into(),
            icon: Some("icons/tmux-home.svg"),
            attention: waiting,
            target: Some(Target::Home),
            ..Row::default()
        };
        let request = self.browser_request;
        self.sidebar_focus_control(
            render_row(
                usize::MAX,
                &row,
                &theme,
                &bezel,
                bezel_motion::Painter::of(cx),
                false,
            )
            .debug_selector(|| "tmux-sidebar-home".into())
            // The focus ring's border is always there, so focus never moves
            // the rows under Home.
            .border_1()
            .border_color(transparent_black())
            .map(|home| spoken(home, &row, None)),
            4,
            &theme,
        )
        .on_click(cx.listener(move |view, _, window, cx| {
            view.dispatch_application_tab(
                request,
                crate::tmux_snapshot::workspace_chrome::ApplicationTab::Home,
                window,
                cx,
            );
        }))
    }
}

/// Agents across the fleet that wait for the user.
pub(in crate::tmux_snapshot) fn waiting_agents(state: &browser::State) -> usize {
    state
        .workspace_fleet_agents
        .as_ref()
        .filter(|p| p.request == state.request && p.valid())
        .map_or(0, |p| p.roster.rows.iter().filter(|r| r.attention).count())
}

/// What a screen reader says for a row: its label, then what the row holds.
/// A heading is a project; a pane row adds the agent's state when there is
/// one; Home adds how many agents need input.
pub(in crate::tmux_snapshot) fn label(row: &Row, state: Option<&'static str>) -> String {
    let mut out = row.label.clone();
    if let Some(aside) = &row.aside {
        out.push_str(&format!(", {aside}"));
    }
    match row.kind {
        Kind::Heading => out.push_str(", project"),
        Kind::Window => out.push_str(", window"),
        Kind::Item => {}
    }
    if let Some(state) = state {
        out.push_str(&format!(", {state}"));
    }
    if row.attention > 0 && row.kind != Kind::Heading {
        out.push_str(&format!(
            ", {}",
            crate::plural::count(row.attention as u64, "needs input", "need input")
        ));
    }
    out
}

/// A row as a screen reader meets it: a button when it goes somewhere (with
/// whether it is the selected one), a heading or a label when it doesn't, and
/// its spoken [`label`].
pub(in crate::tmux_snapshot) fn spoken(
    element: Stateful<Div>,
    row: &Row,
    state: Option<&'static str>,
) -> Stateful<Div> {
    element
        .role(match row.kind {
            _ if row.target.is_some() => Role::Button,
            Kind::Heading => Role::Heading,
            Kind::Window | Kind::Item => Role::Label,
        })
        .aria_label(label(row, state))
        .aria_selected(row.selected)
}
