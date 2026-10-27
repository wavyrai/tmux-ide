use super::*;
impl SnapshotView {
    pub(super) fn perform_header_intent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let intent = self.header_controls.intent;
        self.header_controls = Default::default();
        let Some(target) = super::super::pane_actions::Target::capture(&self.browser_state) else {
            return;
        };
        match intent {
            HeaderIntent::Menu => self.open_header_actions(window, cx),
            HeaderIntent::Close => {
                self.close_header_pane(target, window, cx);
            }
            HeaderIntent::Expand => {
                let desired = if self
                    .browser_state
                    .pane_actions
                    .as_ref()
                    .is_some_and(|a| a.zoomed)
                {
                    super::super::pane_actions::Zoom::Unzoomed
                } else {
                    super::super::pane_actions::Zoom::Zoomed
                };
                self.dispatch_captured_pane_action(
                    &target,
                    super::super::pane_actions::Action::Zoom { desired },
                    window,
                    cx,
                );
            }
        }
    }
    pub(super) fn header_button(
        &self,
        header: &Header,
        width: f32,
        intent: HeaderIntent,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if action_width(header, width) == 0. {
            return None;
        }
        let frame = self.browser_state.frame.clone()?;
        let regions = self.browser_state.regions.clone();
        let request = self.browser_request;
        let id = header.id.clone();
        let restore = self
            .browser_state
            .pane_actions
            .as_ref()
            .is_some_and(|a| a.zoomed);
        let (name, icon, hint, offset) = match intent {
            HeaderIntent::Close => ("close", "icons/close.svg", "Close pane…", 28.),
            HeaderIntent::Expand if restore => (
                "restore",
                "icons/window-restore.svg",
                "Restore pane layout",
                56.,
            ),
            HeaderIntent::Expand => (
                "expand",
                "icons/window-maximize.svg",
                "Expand pane to fill workspace",
                56.,
            ),
            HeaderIntent::Menu => return None,
        };
        let theme = self.theme();
        Some(
            div()
                .id(SharedString::from(format!("pane-{name}:{id}")))
                .role(Role::Button)
                .aria_label(hint)
                .debug_selector({
                    let id = id.clone();
                    move || format!("pane-{name}:{id}")
                })
                .absolute()
                .left(px(
                    f32::from(self.header_rect(header, width).right()) - offset
                ))
                .top(self.header_rect(header, width).origin.y)
                .w(px(28.))
                .h(self.header_rect(header, width).size.height)
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(crate::config::corners::CONTROL))
                .hover(move |s| s.bg(rgb(theme.muted).opacity(0.12)))
                .cursor_pointer()
                .occlude()
                .tooltip(move |window, cx| {
                    if matches!(intent, HeaderIntent::Expand) {
                        bezel_ui::tooltip::Tooltip::with_keystroke(
                            hint,
                            super::super::kbd::ZOOM,
                            window,
                            cx,
                        )
                    } else {
                        bezel_ui::tooltip::Tooltip::text(hint, window, cx)
                    }
                })
                .child(
                    svg()
                        .path(icon)
                        .size(px(14.).min(px(self.terminal_height())))
                        .text_color(rgb(theme.muted)),
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |view, _, window, cx| {
                    cx.stop_propagation();
                    if current_header(view, request, &frame, &regions, &id) {
                        view.header_controls.intent = intent;
                        view.activate_header_menu(&id, window, cx);
                    }
                }))
                .into_any_element(),
        )
    }
}
