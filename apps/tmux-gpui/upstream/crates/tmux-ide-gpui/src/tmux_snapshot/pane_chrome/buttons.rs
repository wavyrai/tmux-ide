use super::*;
/// The header's buttons, left to right.
pub(super) const BUTTONS: [HeaderIntent; 4] = [
    HeaderIntent::SplitRight,
    HeaderIntent::SplitDown,
    HeaderIntent::Expand,
    HeaderIntent::Close,
];
/// What a pane title tells a screen reader about the pane's actions.
pub(super) const TITLE_HINT: &str =
    "Pane actions: right-click or Control-click the title, or press F5 for every pane action";
/// A header button as a screen reader meets it: its hint and its shortcut.
pub(super) fn button_a11y(
    button: Stateful<Div>,
    hint: &'static str,
    keys: Option<&'static str>,
) -> Stateful<Div> {
    button
        .role(Role::Button)
        .aria_label(hint)
        .when_some(keys, |button, keys| button.aria_keyshortcuts(keys))
}
/// A header button's name, icon, tooltip and shortcut; the tooltip shows
/// the shortcut beside the hint.
pub(super) fn face(
    intent: HeaderIntent,
    restore: bool,
) -> Option<(
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
)> {
    Some(match intent {
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
            "icons/zoom.svg",
            "Expand pane to fill workspace",
            Some(super::super::kbd::ZOOM),
        ),
        HeaderIntent::Menu => return None,
    })
}
impl SnapshotView {
    /// Opens pane `id`'s menu from outside its header buttons: a right-click
    /// (or Control-click, which macOS sends as one) on its title or its
    /// sidebar row, the row's … button, or Shift-F10 on the focused row.
    /// Selects the pane first if it isn't.
    pub(in crate::tmux_snapshot) fn open_pane_menu(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_state.surface != super::super::browser::Surface::Workspace
            || !self.browser_state.panes.iter().any(|p| p.id == id)
            || self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
        {
            return;
        }
        self.header_controls.intent = HeaderIntent::Menu;
        self.activate_header_menu(id, window, cx);
    }
    /// A pane title as a screen reader meets it (#746): a button named after
    /// the pane, which selects it. Its menu is a right-click (or
    /// Control-click); without a pointer, F5 lists every pane action.
    pub(super) fn pane_title_a11y(&self, element: Stateful<Div>, header: &Header) -> Stateful<Div> {
        element
            .role(Role::Button)
            .aria_label(label(&self.browser_state, &header.id))
            .aria_description(TITLE_HINT)
    }
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
        let offset = slot(intent) * SLOT + ACTS_PAD;
        let (name, icon, hint, keys) = face(intent, restore)?;
        let bezel = super::super::design::palette(&self.theme());
        let ink = header_ink(&self.theme());
        // #746 v3: quiet at rest, the icon tier on an unfocused card and
        // muted on the focused one; the text ink under the hover wash.
        let focused = self.browser_state.selected_pane.as_deref() == Some(&header.id);
        let rest = if focused { ink.muted } else { ink.icon };
        let pressed = matches!(intent, HeaderIntent::Close) && self.pane_close_open_for(&id);
        Some(
            div()
                .id(SharedString::from(format!("pane-{name}:{id}")))
                .map(|button| button_a11y(button, hint, keys))
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
                .tooltip(move |_, cx| {
                    super::super::glass_ink::tooltip(hint, keys.map(Into::into), cx)
                })
                // A 22 pt ghost button with a 12 pt glyph, sized to the
                // cell-aligned header.
                .child({
                    let side = px(22.).min(self.header_rect(header, width).size.height);
                    let hover = bezel.element_hover;
                    let text = ink.text;
                    div()
                        .group("pane-header-button")
                        .size(side)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .text_color(rest)
                        // Pressed while its close card is open (c1).
                        .when(pressed, |b| b.bg(bezel.element_active))
                        .hover(move |s| s.bg(hover))
                        .children(super::super::design::ink_probe({
                            let id = id.clone();
                            move || format!("pane-{name}-icon:{id}")
                        }))
                        .child(
                            bezel_ui::icons::icon(bezel_ui::icons::Icon::asset(icon))
                                .size(px(12.))
                                .text_color(rest)
                                .group_hover("pane-header-button", move |s| s.text_color(text)),
                        )
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
impl SnapshotView {
    /// `pane`'s close button in window coordinates: the last 28 pt slot at
    /// its header's right end, the 24 pt button centred in it.
    pub(in crate::tmux_snapshot) fn close_button_bounds(
        &self,
        pane: &str,
    ) -> Option<Bounds<Pixels>> {
        let (canvas, _) = self.input_geometry?;
        let width = self.input_cell_width?;
        let header = self
            .presentation_headers()
            .into_iter()
            .find(|h| h.id == pane)?;
        let rect = self.header_rect(&header, width);
        let side = px(22.).min(rect.size.height);
        let right = canvas.origin.x + rect.right() - px(ACTS_PAD) - (px(SLOT) - side) / 2.;
        let top = canvas.origin.y + rect.top() + (rect.size.height - side) / 2.;
        Some(Bounds::new(point(right - side, top), size(side, side)))
    }
}
