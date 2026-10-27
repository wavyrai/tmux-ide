use super::*;
use crate::tmux_snapshot::pane_actions::{Action as PaneAction, Harness, Target as PaneTarget};
use std::rc::Rc;
pub(super) struct Form {
    pub(super) identity: Rc<()>,
    target: PaneTarget,
    pub(super) name: Entity<SearchInput>,
    harness: Harness,
}
impl SnapshotView {
    pub(super) fn begin_new_agent(
        &mut self,
        target: PaneTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.presence.ready()
            || !target.current(&self.browser_state)
            || self.browser_state.request != self.browser_request
            || self.picker.as_ref().is_none_or(|p| {
                p.mode != Mode::Commands
                    || p.request != self.browser_request
                    || p.closing.is_some()
                    || p.agent.is_some()
            })
        {
            return;
        }
        let theme = self.theme();
        let name = cx.new(|cx| {
            let mut input = SearchInput::new(cx).with_max_bytes(320);
            input.set_placeholder("Agent name", cx);
            input.set_appearance(crate::config::Config::default().ui, theme, cx);
            input
        });
        name.read(cx).focus.clone().focus(window, cx);
        if let Some(p) = &mut self.picker {
            p.agent = Some(Form {
                identity: Rc::new(()),
                target,
                name,
                harness: Harness::Claude,
            });
            p.error = None;
        }
        cx.notify();
    }
    fn agent_identity_current(&self, identity: &Rc<()>) -> bool {
        self.picker.as_ref().is_some_and(|p| {
            p.mode == Mode::Commands
                && p.request == self.browser_request
                && p.agent
                    .as_ref()
                    .is_some_and(|f| Rc::ptr_eq(identity, &f.identity))
        })
    }
    pub(super) fn submit_new_agent(
        &mut self,
        identity: &Rc<()>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.agent_identity_current(identity)
            || self.new_session.is_some()
            || self.pane_actions.is_some()
        {
            return;
        }
        let Some(form) = self.picker.as_ref().and_then(|p| p.agent.as_ref()) else {
            return;
        };
        if form.name.read(cx).is_composing() {
            return;
        }
        let target = form.target.clone();
        let harness = form.harness;
        let name = form.name.read(cx).text().trim().to_owned();
        let error = if !self.presence.ready()
            || self.browser_state.request != self.browser_request
            || !target.current(&self.browser_state)
        {
            Some("Pane changed — cancel and reopen New agent.")
        } else if name.is_empty()
            || name.encode_utf16().count() > 80
            || name.chars().any(char::is_control)
        {
            Some("Enter an agent name of 1–80 characters.")
        } else {
            None
        };
        if let Some(error) = error {
            if let Some(p) = &mut self.picker {
                p.error = Some(error);
            }
            cx.notify();
            return;
        }
        if self.dispatch_captured_pane_action(
            &target,
            PaneAction::NewAgent { name, harness },
            window,
            cx,
        ) {
            self.close_picker(window, cx);
        } else {
            if let Some(p) = &mut self.picker {
                p.error = Some("Action queue unavailable — cancel and reselect the pane.");
            }
            cx.notify();
        }
    }
    fn set_agent_harness(&mut self, identity: &Rc<()>, harness: Harness, cx: &mut Context<Self>) {
        if !self.agent_identity_current(identity) {
            return;
        }
        if let Some(form) = self.picker.as_mut().and_then(|p| p.agent.as_mut()) {
            if form.name.read(cx).is_composing() {
                return;
            }
            form.harness = harness;
        }
        cx.notify();
    }
    fn cancel_new_agent(&mut self, identity: &Rc<()>, window: &mut Window, cx: &mut Context<Self>) {
        if self.agent_identity_current(identity) {
            self.close_picker(window, cx);
        }
    }
    pub(super) fn new_agent_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(form) = self.picker.as_ref().and_then(|p| p.agent.as_ref()) else {
            return;
        };
        if form.name.read(cx).is_composing() {
            return;
        }
        let identity = form.identity.clone();
        let next = match form.harness {
            Harness::Claude => Harness::Codex,
            Harness::Codex => Harness::Claude,
        };
        let key = &event.keystroke;
        if event.is_held || key.modifiers.platform || key.modifiers.control || key.modifiers.alt {
            return;
        }
        match key.key.as_str() {
            "escape" => self.cancel_new_agent(&identity, window, cx),
            "enter" => self.submit_new_agent(&identity, window, cx),
            "tab" => self.set_agent_harness(&identity, next, cx),
            _ => return,
        }
        cx.stop_propagation();
        window.prevent_default();
    }
    pub(super) fn new_agent_render(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(p) = &self.picker else {
            return div().into_any_element();
        };
        let Some(f) = &p.agent else {
            return div().into_any_element();
        };
        let theme = self.theme();
        let submit = f.identity.clone();
        let cancel = f.identity.clone();
        let mut choices = div().flex().gap_2();
        for (h, label, selected) in [
            (
                Harness::Claude,
                "Claude",
                matches!(f.harness, Harness::Claude),
            ),
            (Harness::Codex, "Codex", matches!(f.harness, Harness::Codex)),
        ] {
            let identity = f.identity.clone();
            choices = choices.child(
                crate::tmux_snapshot::controls::button(
                    if selected {
                        "agent-harness-selected"
                    } else {
                        "agent-harness-other"
                    },
                    Some(label),
                    "Choose agent harness",
                    crate::tmux_snapshot::controls::Icon::Terminal,
                    &theme,
                )
                .map(|b| if selected { b.bg(rgb(theme.active)) } else { b })
                .on_click(
                    cx.listener(move |view, _, _, cx| view.set_agent_harness(&identity, h, cx)),
                ),
            );
        }
        div()
            .id("new-agent-form")
            .debug_selector(|| "new-agent-form".into())
            .size_full()
            .overflow_hidden()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().child("New agent"))
            .child(div().child("Create a named agent in a new window of this session."))
            .child(f.name.clone())
            .child(choices)
            .children(p.error.map(|e| div().child(e)))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        crate::tmux_snapshot::controls::button(
                            "new-agent-submit",
                            Some("Create agent"),
                            "Create agent",
                            crate::tmux_snapshot::controls::Icon::Plus,
                            &theme,
                        )
                        .on_click(cx.listener(
                            move |view, _, window, cx| view.submit_new_agent(&submit, window, cx),
                        )),
                    )
                    .child(
                        crate::tmux_snapshot::controls::button(
                            "new-agent-cancel",
                            Some("Cancel"),
                            "Cancel",
                            crate::tmux_snapshot::controls::Icon::Close,
                            &theme,
                        )
                        .on_click(cx.listener(
                            move |view, _, window, cx| view.cancel_new_agent(&cancel, window, cx),
                        )),
                    ),
            )
            .into_any_element()
    }
}
