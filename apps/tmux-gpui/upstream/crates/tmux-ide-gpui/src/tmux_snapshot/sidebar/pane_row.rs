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
        let bezel = crate::tmux_snapshot::design::palette(&self.theme());
        let hover = bezel.element_hover;
        let (_, muted) = crate::tmux_snapshot::design::row_ink(&self.theme());
        let more = {
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
        };
        let id = pane.to_owned();
        element
            .debug_selector(move || format!("tmux-sidebar-pane:{id}"))
            .children(state)
            .child(more)
            .on_mouse_down(MouseButton::Right, menu(pane.to_owned(), cx))
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
