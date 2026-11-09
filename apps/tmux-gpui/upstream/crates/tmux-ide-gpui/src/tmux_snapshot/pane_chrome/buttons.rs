use super::*;
/// The header's buttons, left to right.
pub(super) const BUTTONS: [HeaderIntent; 4] = [
    HeaderIntent::SplitRight,
    HeaderIntent::SplitDown,
    HeaderIntent::Expand,
    HeaderIntent::Close,
];
impl SnapshotView {
    /// A right-click on a pane's title opens that pane's menu, selecting the
    /// pane first if it isn't selected (#746: the header has no menu button).
    pub(super) fn header_menu_listener(
        &self,
        header: &Header,
        cx: &mut Context<Self>,
    ) -> impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static {
        let frame = self.browser_state.frame.clone();
        let regions = self.browser_state.regions.clone();
        let request = self.browser_request;
        let id = header.id.clone();
        cx.listener(move |view, _: &MouseDownEvent, window, cx| {
            cx.stop_propagation();
            if frame
                .as_ref()
                .is_some_and(|frame| current_header(view, request, frame, &regions, &id))
            {
                view.header_controls.intent = HeaderIntent::Menu;
                view.activate_header_menu(&id, window, cx);
            }
        })
    }
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
            HeaderIntent::SplitRight | HeaderIntent::SplitDown => {
                let direction = if matches!(intent, HeaderIntent::SplitRight) {
                    super::super::pane_actions::SplitDirection::Right
                } else {
                    super::super::pane_actions::SplitDirection::Down
                };
                self.dispatch_captured_pane_action(
                    &target,
                    super::super::pane_actions::Action::Split { direction },
                    window,
                    cx,
                );
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
        if slot(intent) == 0. || action_width(header, width) < slot(intent) * SLOT {
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
        let offset = slot(intent) * SLOT;
        let (name, icon, hint, keys) = match intent {
            HeaderIntent::SplitRight => (
                "split-right",
                "icons/split.svg",
                "Split right",
                Some(super::super::kbd::SPLIT_RIGHT),
            ),
            HeaderIntent::SplitDown => (
                "split-down",
                "icons/split-down.svg",
                "Split down",
                Some(super::super::kbd::SPLIT_DOWN),
            ),
            HeaderIntent::Close => ("close", "icons/close.svg", "Close pane…", None),
            HeaderIntent::Expand if restore => (
                "restore",
                "icons/window-restore.svg",
                "Restore pane layout",
                Some(super::super::kbd::ZOOM),
            ),
            HeaderIntent::Expand => (
                "expand",
                "icons/window-maximize.svg",
                "Expand pane to fill workspace",
                Some(super::super::kbd::ZOOM),
            ),
            HeaderIntent::Menu => return None,
        };
        let bezel = super::super::design::palette(&self.theme());
        let ink = header_ink(&self.theme());
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
                .w(px(SLOT))
                .h(self.header_rect(header, width).size.height)
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .occlude()
                .tooltip(move |window, cx| match keys {
                    Some(keys) => {
                        bezel_ui::tooltip::Tooltip::with_keystroke(hint, keys, window, cx)
                    }
                    None => bezel_ui::tooltip::Tooltip::text(hint, window, cx),
                })
                // Bezel's ghost icon button, sized to the cell-aligned header.
                .child({
                    use bezel_ui::widgets::Buttons as _;
                    let side = px(24.).min(self.header_rect(header, width).size.height);
                    let hover = bezel.element_hover;
                    // Quiet at rest: the header's muted ink, which reads on
                    // the hover wash too (#746).
                    bezel
                        .tinted_icon_button(bezel_ui::icons::Icon::asset(icon), ink.muted)
                        .rounded(px(bezel_theme::Theme::control_radius()))
                        .size(side)
                        .hover(move |s| s.bg(hover))
                })
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
