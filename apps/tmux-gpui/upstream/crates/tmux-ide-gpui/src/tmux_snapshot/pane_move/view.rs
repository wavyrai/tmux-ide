//! The drag in the window: the press on a header, the pointer while the
//! button is held, the layers that show it, the result and Cmd-Z.
use super::*;
use crate::tmux_snapshot::{browser_ui::Selection, design, pane_actions::Target};

impl SnapshotView {
    /// What rules a drag out: at the press, and on every draw while one
    /// runs. Once dragging, the source's own selection briefly takes the
    /// pane action capability and input away, so those two count only at
    /// the press.
    fn pane_move_facts(&self, dragging: bool) -> Facts {
        let s = &self.browser_state;
        Facts {
            zoomed: s.pane_actions.as_ref().is_some_and(|a| a.zoomed),
            held: s.retained_preview
                || s.frame.is_none()
                || !self.presence.ready()
                || (!dragging && !s.input_ready),
            reconnecting: s.reconnect_attempt.is_some(),
            dialog: self.picker.is_some()
                || self.pane_actions.is_some()
                || self.new_session.is_some()
                || self.browser_address.is_some(),
            pending: (!dragging && Target::capture(s).is_none())
                || self.divider.is_some()
                || self.resize_gesture.busy(),
            cards: self
                .card_layout(self.input_cell_width.unwrap_or(8.))
                .is_some(),
        }
    }

    /// Each pane's card as drawn, in the terminal canvas's coordinates.
    fn pane_move_cards(&self) -> Vec<(String, Bounds<Pixels>)> {
        let width = self.input_cell_width.unwrap_or(8.);
        let (Some(layout), Some((canvas, _))) = (self.card_layout(width), self.input_geometry)
        else {
            return Vec::new();
        };
        layout
            .regions
            .iter()
            .map(|r| (r.id.clone(), layout.card_in(r, canvas.size)))
            .collect()
    }

    #[cfg(test)]
    pub(in crate::tmux_snapshot) fn pane_move_cards_for_test(
        &self,
    ) -> Vec<(String, Bounds<Pixels>)> {
        self.pane_move_cards()
    }
    fn pane_move_local(&self, at: Point<Pixels>) -> Option<Point<Pixels>> {
        Some(at - self.input_geometry?.0.origin)
    }

    /// The pane whose swap zone holds the window point `at`, with the input
    /// token it is published with now.
    fn pane_move_target(&self, at: Point<Pixels>) -> Option<Pick> {
        let at = self.pane_move_local(at)?;
        let id = self
            .pane_move_cards()
            .into_iter()
            .find(|(_, card)| in_centre(*card, at))
            .map(|(id, _)| id)?;
        let token = self
            .browser_state
            .input_targets
            .iter()
            .find(|t| t.id == id)?
            .token
            .clone();
        Some(Pick { id, token })
    }

    /// A left press on a pane's header title. The buttons stop their own
    /// presses, so they never get here.
    pub(in crate::tmux_snapshot) fn pane_move_press(
        &mut self,
        id: &str,
        event: &MouseDownEvent,
        cx: &mut Context<Self>,
    ) {
        if event.button != MouseButton::Left
            || event.modifiers != Modifiers::default()
            || event.click_count > 1
        {
            return;
        }
        let facts = self.pane_move_facts(false);
        let pressed = self.pointer.moving.press(
            id,
            event.position,
            self.browser_request,
            self.browser_state.selected_session.clone(),
            &self.browser_state.regions,
            facts,
        );
        if pressed.is_ok() {
            cx.notify();
        }
    }

    fn pane_move_pointer(
        &mut self,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target = self.pane_move_target(at);
        let started = self
            .pointer
            .moving
            .moved(at, target, &self.browser_state.regions);
        if started {
            // The swap is sent from the selected pane, so the source is
            // selected as a click would; it is by the time of the drop.
            let source = self
                .pointer
                .moving
                .gesture
                .as_ref()
                .map(|g| g.source.clone());
            if let Some(source) = source
                && self.browser_state.selected_pane.as_ref() != Some(&source)
            {
                let before = self.browser_state.selected_pane.clone();
                self.select(Selection::Pane(source), window, cx);
                // The selection is a new request on the same session; the
                // drag goes on under it.
                if let Some(gesture) = self.pointer.moving.gesture.as_mut() {
                    gesture.restore = before;
                    gesture.request = self.browser_request;
                }
            }
            self.clear_selection(cx);
        }
        cx.notify();
    }

    fn pane_move_release(
        &mut self,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pane_move_pointer(at, window, cx);
        let now = cx.background_executor().now();
        match self
            .pointer
            .moving
            .release(&self.browser_state.regions, now)
        {
            Release::Click => {}
            Release::Cancel => {}
            Release::Stale => {
                self.pane_move_toast("The layout changed. Drop the pane again.", false, cx);
            }
            Release::Swap { source, target } => {
                if let Some(spent) = self.pane_move_send(&source, &target, window, cx) {
                    self.pointer.moving.sent(spent);
                    self.pane_move_wake(cx);
                } else {
                    self.pointer.moving.fail(now);
                    let text = format!(
                        "Couldn't swap {} and {}. Try again.",
                        label(&self.browser_state, &source),
                        label(&self.browser_state, &target.id)
                    );
                    self.pane_move_toast(text, false, cx);
                }
            }
        }
        cx.notify();
    }

    /// Sends the swap from the selected pane `source` to `target` as the
    /// preview showed it. Returns the pane action capability it spent.
    fn pane_move_send(
        &mut self,
        source: &str,
        target: &Pick,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<String> {
        let state = &self.browser_state;
        let spent = state
            .pane_actions
            .as_ref()
            .filter(|a| a.id == source)?
            .token
            .clone();
        let captured = Target::capture(state)?;
        self.dispatch_captured_pane_action(
            &captured,
            pane_actions::Action::Swap {
                target: target.id.clone(),
                target_token: target.token.clone(),
            },
            window,
            cx,
        )
        .then_some(spent)
    }

    /// Redraws when a pending swap may have to give up.
    fn pane_move_wake(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(SETTLE).await;
            let _ = view.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }

    fn pane_move_toast(
        &mut self,
        text: impl Into<SharedString>,
        undo: bool,
        cx: &mut Context<Self>,
    ) {
        let serial = self.pointer.moving.show(text, undo);
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(TOAST).await;
            let _ = view.update(cx, |view, cx| {
                if view
                    .pointer
                    .moving
                    .toast
                    .as_ref()
                    .is_some_and(|t| t.serial == serial)
                {
                    view.pointer.moving.toast = None;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// While dragging, terminal input is off and Esc cancels. Otherwise
    /// Cmd-Z swaps the last swap back while the layout is unchanged since;
    /// any other key, and Cmd-Z with nothing to undo, goes on as before.
    pub(in crate::tmux_snapshot) fn pane_move_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.pointer.moving.dragging() {
            if event.keystroke.key == "escape" {
                self.pointer.moving.cancel(cx.background_executor().now());
                cx.notify();
            }
            cx.stop_propagation();
            return true;
        }
        let key = &event.keystroke;
        if key.key != "z"
            || !key.modifiers.platform
            || key.modifiers.shift
            || key.modifiers.alt
            || key.modifiers.control
            || self.pointer.moving.gesture.is_some()
        {
            return false;
        }
        let state = &self.browser_state;
        let Some(selected) = state.selected_pane.clone() else {
            return false;
        };
        let Some(target) = self
            .pointer
            .moving
            .undo
            .as_ref()
            .and_then(|u| u.reverse(self.browser_request, &state.regions, &selected))
            .and_then(|id| {
                let token = state
                    .input_targets
                    .iter()
                    .find(|t| t.id == id)?
                    .token
                    .clone();
                Some(Pick { id, token })
            })
        else {
            return false;
        };
        let Some(spent) = self.pane_move_send(&selected, &target, window, cx) else {
            return false;
        };
        let now = cx.background_executor().now();
        self.pointer.moving.undo = None;
        self.pointer.moving.gesture = Some(Gesture {
            request: self.browser_request,
            session: self.browser_state.selected_session.clone(),
            source: selected,
            origin: point(px(0.), px(0.)),
            pointer: point(px(0.), px(0.)),
            phase: Phase::Pending {
                target,
                before: self.browser_state.regions.clone(),
                since: now,
                sent: Some(spent),
            },
            seen: self.browser_state.regions.clone(),
            undoing: true,
            restore: None,
        });
        self.pane_move_wake(cx);
        cx.stop_propagation();
        cx.notify();
        true
    }

    /// Reads the published state each draw: a drag from another session
    /// ends; so does one the window can no longer take (a reconnect, a held
    /// frame, focus lost, a dialog, a divider drag, zoom); a pane that went
    /// away ends it; a pending swap settles. A drag that ends without a swap
    /// selects the pane that was selected before it.
    fn pane_move_observe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let now = cx.background_executor().now();
        let ruled_out = self.pane_move_facts(true).refusal().is_some();
        let moving = &mut self.pointer.moving;
        if moving.gesture.as_ref().is_some_and(|g| {
            g.request != self.browser_request || g.session != self.browser_state.selected_session
        }) {
            moving.gesture = None;
        }
        if ruled_out {
            moving.cancel(now);
        }
        if moving.relayout(&self.browser_state.regions, now) {
            self.pane_move_toast("A pane closed, so the drag was cancelled.", false, cx);
        }
        let pending = self
            .pointer
            .moving
            .gesture
            .as_ref()
            .and_then(|g| match &g.phase {
                Phase::Pending { target, .. } => Some((g.source.clone(), target.id.clone())),
                _ => None,
            });
        if let Some((a, b)) = pending {
            let (a, b) = (
                label(&self.browser_state, &a),
                label(&self.browser_state, &b),
            );
            let actions = self
                .browser_state
                .pane_actions
                .as_ref()
                .map(|a| a.token.clone());
            match self.pointer.moving.settle(
                &self.browser_state.regions,
                actions.as_deref(),
                &self.browser_state.status,
                now,
            ) {
                Settle::Swapped => self.pane_move_toast(format!("Swapped {a} and {b}"), true, cx),
                Settle::Failed => {
                    self.pane_move_toast(format!("Couldn't swap {a} and {b}"), false, cx)
                }
                Settle::Waiting => {}
            }
        }
        if let Some(before) = self.pointer.moving.take_restore()
            && self.browser_state.panes.iter().any(|p| p.id == before)
            && self.browser_state.selected_pane.as_ref() != Some(&before)
        {
            self.select(Selection::Pane(before), window, cx);
        }
        if self
            .pointer
            .moving
            .returning(now, cx.reduce_motion())
            .is_some()
            && self.pointer.moving.gesture.is_some()
        {
            window.request_animation_frame();
        }
    }

    /// The drag's layers over the terminal canvas, and while the button is
    /// held, the listeners that follow the pointer anywhere in the window.
    pub(in crate::tmux_snapshot) fn pane_move_layers(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        self.pane_move_observe(window, cx);
        let palette = design::palette(&self.theme());
        let mut layers = Vec::new();
        let now = cx.background_executor().now();
        let reduced = cx.reduce_motion();
        if let Some(gesture) = self.pointer.moving.gesture.clone().filter(|g| !g.undoing) {
            if matches!(gesture.phase, Phase::Pressed | Phase::Dragging { .. }) {
                layers.push(listeners(cx.entity().downgrade()));
            }
            let cards = self.pane_move_cards();
            let card = |id: &str| cards.iter().find(|(c, _)| c == id).map(|(_, b)| *b);
            let source = label(&self.browser_state, &gesture.source);
            let target = match &gesture.phase {
                Phase::Dragging { target } => target.as_ref().map(|t| t.id.clone()),
                Phase::Pending { target, .. } => Some(target.id.clone()),
                _ => None,
            };
            let shown = !matches!(gesture.phase, Phase::Pressed);
            if shown && let Some(bounds) = card(&gesture.source) {
                let note = target
                    .as_ref()
                    .map(|t| format!("{} moves here", label(&self.browser_state, t)));
                layers.push(source_wash(bounds, note, &palette));
            }
            if let Some(target) = &target
                && let Some(bounds) = card(target)
            {
                let name = label(&self.browser_state, target);
                layers.push(preview(bounds, target, &source, &name, &palette));
            }
            let carried = match &gesture.phase {
                Phase::Dragging { target } => Some((gesture.pointer, target.is_some())),
                Phase::Returning { from, since } => {
                    let t = progress(
                        &bezel_motion::LAYOUT,
                        now.saturating_duration_since(*since),
                        reduced,
                    );
                    let home = gesture.origin;
                    Some((
                        point(
                            from.x + (home.x - from.x) * t,
                            from.y + (home.y - from.y) * t,
                        ),
                        false,
                    ))
                }
                _ => None,
            };
            if let Some((at, over)) = carried {
                layers.push(carried_card(at, &source, over, &palette));
            }
        }
        if let Some(toast) = &self.pointer.moving.toast {
            layers.push(toast_card(toast, &palette));
        }
        layers
    }
}

/// Window-wide listeners while the button is held: the pointer may leave
/// the header, the canvas or the window.
fn listeners(view: WeakEntity<SnapshotView>) -> AnyElement {
    canvas(
        |_, _, _| {},
        move |_, _, window, _| {
            let moved = view.clone();
            window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, cx| {
                if phase != DispatchPhase::Capture {
                    return;
                }
                let _ = moved.update(cx, |view, cx| {
                    if e.pressed_button == Some(MouseButton::Left) {
                        view.pane_move_pointer(e.position, window, cx);
                    } else {
                        // The button came up where we couldn't see it.
                        view.pointer.moving.cancel(cx.background_executor().now());
                        cx.notify();
                    }
                });
            });
            let released = view.clone();
            window.on_mouse_event(move |e: &MouseUpEvent, phase, window, cx| {
                if phase != DispatchPhase::Capture || e.button != MouseButton::Left {
                    return;
                }
                let _ = released.update(cx, |view, cx| {
                    let dragging = view.pointer.moving.dragging();
                    view.pane_move_release(e.position, window, cx);
                    if dragging {
                        // A drop never clicks the header it lands on.
                        cx.stop_propagation();
                    }
                });
            });
        },
    )
    .absolute()
    .size_0()
    .into_any_element()
}

fn placed(bounds: Bounds<Pixels>) -> Div {
    div()
        .absolute()
        .left(bounds.origin.x)
        .top(bounds.origin.y)
        .w(bounds.size.width)
        .h(bounds.size.height)
        .rounded(px(bezel_theme::Theme::panel_radius()))
}

fn chip(text: String, palette: &bezel_theme::Theme) -> AnyElement {
    bezel_ui::drag::ghost_label(text, palette).into_any_element()
}

/// The source in place: faded, with a dashed outline.
fn source_wash(
    bounds: Bounds<Pixels>,
    note: Option<String>,
    palette: &bezel_theme::Theme,
) -> AnyElement {
    placed(bounds)
        .debug_selector(|| "pane-move-source".into())
        .border_1()
        .border_dashed()
        .border_color(palette.text_muted)
        .bg(Hsla {
            a: 0.55,
            ..palette.terminal_bg
        })
        .flex()
        .items_center()
        .justify_center()
        .children(note.map(|note| chip(note, palette)))
        .into_any_element()
}

/// Where the source would go. Translucent: the target's content stays
/// readable under it (PM, against the mockup's opaque card).
fn preview(
    bounds: Bounds<Pixels>,
    target: &str,
    source: &str,
    name: &str,
    palette: &bezel_theme::Theme,
) -> AnyElement {
    bezel_motion::fade_quick(
        SharedString::from(format!("pane-move-preview:{target}")),
        placed(bounds)
            .id(SharedString::from(format!("pane-move-preview:{target}")))
            .debug_selector(|| "pane-move-preview".into())
            .role(Role::Group)
            .aria_label(format!("Swap with {name}"))
            .border_2()
            .border_color(palette.accent)
            .bg(palette.drop_target)
            .flex()
            .items_center()
            .justify_center()
            .child(chip(format!("{source} goes here"), palette)),
    )
    .into_any_element()
}

/// The card under the pointer: the pane's icon and title, never a live
/// terminal.
fn carried_card(
    at: Point<Pixels>,
    title: &str,
    over: bool,
    palette: &bezel_theme::Theme,
) -> AnyElement {
    use bezel_ui::drag::Carried as _;
    let card = div()
        .debug_selector(|| "pane-move-carried".into())
        .flex()
        .items_center()
        .gap_2()
        .px_2()
        .py_1()
        .rounded(px(bezel_theme::Theme::control_radius()))
        .text_color(palette.text)
        .child(
            bezel_ui::icons::icon(bezel_ui::icons::Icon::asset("icons/terminal.svg"))
                .size(px(bezel_ui::widgets::ICON_GLYPH))
                .text_color(palette.text_muted),
        )
        .child(title.to_owned())
        .when(over, |card| {
            card.child(div().text_color(palette.text_muted).child("Swap"))
        })
        .ghost(palette);
    deferred(
        anchored()
            .position_mode(AnchoredPositionMode::Window)
            .position(at + point(px(12.), px(14.)))
            .child(bezel_motion::fade_quick(
                "pane-move-carried",
                div().child(card),
            )),
    )
    .with_priority(3)
    .into_any_element()
}

fn toast_card(toast: &Toast, palette: &bezel_theme::Theme) -> AnyElement {
    use bezel_ui::drag::Carried as _;
    let text = toast.text.clone();
    div()
        .absolute()
        .bottom(px(16.))
        .left_0()
        .right_0()
        .flex()
        .justify_center()
        .child(bezel_motion::fade_quick(
            SharedString::from(format!("pane-move-toast:{}", toast.serial)),
            div().child(
                div()
                    .id("pane-move-toast")
                    .debug_selector(|| "pane-move-toast".into())
                    .role(Role::Status)
                    .aria_label(text.clone())
                    .flex()
                    .items_center()
                    .gap_3()
                    .px_3()
                    .py_2()
                    .rounded(px(bezel_theme::Theme::control_radius()))
                    .text_color(palette.text)
                    .child(text)
                    .when(toast.undo, |t| {
                        t.child(div().text_color(palette.text_muted).child("Undo ⌘Z"))
                    })
                    .ghost(palette),
            ),
        ))
        .into_any_element()
}
