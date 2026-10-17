use super::*;
use std::rc::Rc;
pub(super) struct Confirmation {
    pub(super) identity: Rc<()>,
    target: crate::tmux_snapshot::pane_actions::Target,
    label: String,
}
impl SnapshotView {
    pub(super) fn begin_pane_close(
        &mut self,
        target: crate::tmux_snapshot::pane_actions::Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.presence.ready()
            || !target.current(&self.browser_state)
            || self.browser_state.request != self.browser_request
            || self.picker.as_ref().is_none_or(|p| {
                p.mode != Mode::Commands || p.request != self.browser_request || p.closing.is_some()
            })
        {
            return;
        }
        let label = self
            .browser_state
            .panes
            .iter()
            .find(|p| Some(&p.id) == self.browser_state.selected_pane.as_ref())
            .map(|p| p.label.clone())
            .unwrap_or_default();
        if let Some(picker) = &mut self.picker {
            picker.closing = Some(Confirmation {
                identity: Rc::new(()),
                target,
                label,
            });
            picker.error = None;
        }
        self.terminal_focus.focus(window, cx);
        cx.notify();
    }
    pub(super) fn confirm_pane_close(
        &mut self,
        identity: &Rc<()>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(picker) = &self.picker else {
            return;
        };
        let Some(confirmation) = &picker.closing else {
            return;
        };
        if picker.mode != Mode::Commands
            || picker.request != self.browser_request
            || !Rc::ptr_eq(identity, &confirmation.identity)
            || self.new_session.is_some()
            || self.pane_actions.is_some()
        {
            return;
        }
        let target = confirmation.target.clone();
        if !self.presence.ready()
            || !target.current(&self.browser_state)
            || self.browser_state.request != self.browser_request
        {
            if let Some(p) = &mut self.picker {
                p.error = Some("Pane changed — cancel and reopen Close pane.");
            }
            cx.notify();
            return;
        }
        if self.dispatch_captured_pane_action(
            &target,
            crate::tmux_snapshot::pane_actions::Action::Close,
            window,
            cx,
        ) {
            self.close_picker(window, cx);
        } else if let Some(p) = &mut self.picker {
            p.error = Some("Action queue unavailable — cancel and reselect the pane.");
            cx.notify();
        }
    }
    fn cancel_pane_close(
        &mut self,
        identity: &Rc<()>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .picker
            .as_ref()
            .and_then(|p| p.closing.as_ref())
            .is_some_and(|c| Rc::ptr_eq(identity, &c.identity))
        {
            self.close_picker(window, cx);
        }
    }
    pub(super) fn pane_close_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(identity) = self
            .picker
            .as_ref()
            .and_then(|p| p.closing.as_ref())
            .map(|c| c.identity.clone())
        else {
            return;
        };
        let key = &event.keystroke;
        if !event.is_held
            && !key.modifiers.platform
            && !key.modifiers.control
            && !key.modifiers.alt
            && !key.modifiers.shift
        {
            match key.key.as_str() {
                "escape" => self.cancel_pane_close(&identity, window, cx),
                "enter" => self.confirm_pane_close(&identity, window, cx),
                _ => {}
            }
        }
        cx.stop_propagation();
        window.prevent_default();
    }
    pub(super) fn pane_close_render(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(picker) = &self.picker else {
            return div().into_any_element();
        };
        let Some(c) = &picker.closing else {
            return div().into_any_element();
        };
        let theme = self.theme();
        let confirm = c.identity.clone();
        let cancel = c.identity.clone();
        div()
            .id("pane-close-confirmation")
            .debug_selector(|| "pane-close-confirmation".into())
            .size_full()
            .flex()
            .flex_col()
            .gap_3()
            .overflow_hidden()
            .child(div().child("Close pane?"))
            .child(div().min_w_0().truncate().child(c.label.clone()))
            .child(
                div().child("This stops the process running in this pane. Other panes stay open."),
            )
            .children(picker.error.map(|message| div().child(message)))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        crate::tmux_snapshot::controls::action_button(
                            "pane-close-confirm",
                            Some("Close pane"),
                            "Close this captured pane",
                            crate::tmux_snapshot::controls::Icon::Trash,
                            crate::tmux_snapshot::controls::ButtonStyle::Destructive,
                            &theme,
                        )
                        .on_click(cx.listener(
                            move |view, _, window, cx| {
                                view.confirm_pane_close(&confirm, window, cx)
                            },
                        )),
                    )
                    .child(
                        crate::tmux_snapshot::controls::button(
                            "pane-close-cancel",
                            Some("Cancel"),
                            "Keep pane running",
                            crate::tmux_snapshot::controls::Icon::Close,
                            &theme,
                        )
                        .on_click(cx.listener(
                            move |view, _, window, cx| view.cancel_pane_close(&cancel, window, cx),
                        )),
                    ),
            )
            .into_any_element()
    }
}
