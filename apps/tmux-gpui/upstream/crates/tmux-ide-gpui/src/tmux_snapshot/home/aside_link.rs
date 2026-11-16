//! A machine header's action as small muted text (#746 v3): a real control,
//! as the Bezel button it replaced was (bezel_ui::focus::pressable's tab
//! stop, Activate and focus ring), in a 24 pt hit box with side padding.

/// The hit box's height: easy to hit on purpose, hard to hit by accident.
pub(super) const HEIGHT: f32 = 24.;
/// The room between two aside actions.
pub(super) const GAP: f32 = 20.;
use bezel_theme::{TextStyle, Typeset as _};
use gpui::{prelude::*, *};
use std::rc::Rc;

type Activation = dyn Fn(&(), &mut Window, &mut App);

#[derive(IntoElement)]
pub(super) struct AsideLink {
    id: ElementId,
    selector: String,
    label: &'static str,
    enabled: bool,
    /// A destructive action (Disconnect): the danger ink on hover and focus.
    danger: bool,
    /// Home's palette: the muted and text inks, and the ring.
    bezel: bezel_theme::Theme,
    activate: Option<Rc<Activation>>,
    /// Home's own handle for this action, so Home's Tab order can name it
    /// (#803); without one the element keeps a handle of its own.
    stop: Option<FocusHandle>,
}

impl AsideLink {
    /// `selector` is the debug selector and accessibility id; a disabled
    /// link stays muted, has no tab stop, and ignores presses.
    pub(super) fn new(
        id: impl Into<ElementId>,
        selector: String,
        label: &'static str,
        enabled: bool,
        bezel: &bezel_theme::Theme,
    ) -> Self {
        Self {
            id: id.into(),
            selector,
            label,
            enabled,
            danger: false,
            bezel: bezel.clone(),
            activate: None,
            stop: None,
        }
    }

    /// The focus handle Home keeps for this action (see `stop`).
    pub(super) fn stop(mut self, stop: Option<FocusHandle>) -> Self {
        self.stop = stop;
        self
    }

    /// Marks the action destructive (see `danger`).
    pub(super) fn danger(mut self) -> Self {
        self.danger = true;
        self
    }

    /// Click, Enter and Space each call it once, when enabled.
    pub(super) fn on_press(
        mut self,
        activate: impl Fn(&(), &mut Window, &mut App) + 'static,
    ) -> Self {
        self.activate = Some(Rc::new(activate));
        self
    }
}

impl RenderOnce for AsideLink {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let focus = match self.stop.clone() {
            Some(stop) => stop,
            None => window
                .use_keyed_state(self.id.clone(), cx, |_, cx| cx.focus_handle())
                .read(cx)
                .clone(),
        };
        let bezel = self.bezel;
        let enabled = self.enabled && self.activate.is_some();
        // A destructive action turns to the danger ink when it is the one
        // under the pointer or the keyboard (Disconnect).
        let lit = if self.danger {
            bezel.danger_muted
        } else {
            bezel.text
        };
        let ring = bezel.ring;
        let selector = self.selector.clone();
        let probe = self.selector.clone();
        let focused = focus.is_focused(window);
        let click = self.activate.clone();
        let press = self.activate.clone();
        let pressed = focus.clone();
        let activate = self.activate;
        div()
            .id(self.id)
            .role(Role::Button)
            .aria_label(self.label)
            .accessibility_id(self.selector.clone())
            .debug_selector(move || selector.clone())
            .key_context(bezel_ui::focus::CONTROL_KEY_CONTEXT)
            .track_focus(&focus.tab_stop(enabled))
            .flex_none()
            .h(px(HEIGHT))
            .px(px(6.))
            .flex()
            .items_center()
            .rounded(px(6.))
            // The ring's slot: transparent until keyboard focus shows it.
            .border_1()
            .border_color(transparent_black())
            .focus_visible(move |s| s.border_color(ring))
            .text_style(TextStyle::Subheadline)
            .text_color(if focused && enabled {
                lit
            } else {
                bezel.text_muted
            })
            .when(enabled, |link| {
                link.cursor_pointer().hover(move |s| s.text_color(lit))
            })
            .when(!enabled, |link| link.opacity(0.6))
            .children(crate::tmux_snapshot::design::ink_probe(move || {
                format!("{probe}:ink")
            }))
            .child(self.label)
            // Tests find the focused control by this marker.
            .when(focused, |link| {
                let selector = self.selector.clone();
                link.child(
                    div()
                        .size_0()
                        .debug_selector(move || format!("{selector}:focused")),
                )
            })
            .on_click(move |_, window, cx| {
                if enabled && let Some(click) = &click {
                    click(&(), window, cx);
                }
            })
            // Return and Space press the focused action and go no further:
            // the same keys act on Home's table when it has the keyboard.
            .on_key_down(move |event, window, cx| {
                let key = &event.keystroke;
                let m = &key.modifiers;
                if !pressed.is_focused(window)
                    || m.platform
                    || m.control
                    || m.alt
                    || m.shift
                    || !matches!(key.key.as_str(), "enter" | "space")
                {
                    return;
                }
                cx.stop_propagation();
                window.prevent_default();
                if enabled
                    && !event.is_held
                    && let Some(press) = &press
                {
                    press(&(), window, cx);
                }
            })
            .on_action(move |_: &bezel_ui::focus::Activate, window, cx| {
                if enabled && let Some(activate) = &activate {
                    activate(&(), window, cx);
                }
            })
    }
}

/// One machine action, by what it acts on, never by where it is drawn: a
/// list that shifts must not move a focused Disconnect onto another machine
/// (review of #803). `server: None` is the machine's Disconnect.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::tmux_snapshot) struct Stop {
    pub machine: String,
    pub server: Option<String>,
}
impl Stop {
    pub fn disconnect(machine: &str) -> Self {
        Self {
            machine: machine.into(),
            server: None,
        }
    }
    pub fn server(machine: &str, server: &str) -> Self {
        Self {
            machine: machine.into(),
            server: Some(server.into()),
        }
    }
}
/// Home's keyboard stops for the machines' text actions (#803): one handle
/// per action, kept across frames, and which of them the last table paint
/// drew enabled, in the order it drew them. In a machine, each "Use for new
/// sessions" comes before its Disconnect, so Disconnect is never a machine's
/// first stop.
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Stops {
    handles: std::collections::BTreeMap<Stop, FocusHandle>,
    shown: Vec<Stop>,
}
impl Stops {
    /// A new table paint: nothing is shown until it draws it.
    pub(super) fn begin(&mut self) {
        self.shown.clear();
    }
    /// The handle of `stop`; a keyboard stop if `enabled`.
    pub(super) fn stop(&mut self, stop: Stop, enabled: bool, cx: &mut App) -> FocusHandle {
        let handle = self
            .handles
            .entry(stop.clone())
            .or_insert_with(|| cx.focus_handle())
            .clone();
        if enabled && !self.shown.contains(&stop) {
            self.shown.push(stop);
        }
        handle
    }
    /// The enabled actions on screen, in keyboard order: machine by machine as
    /// drawn, and in a machine its servers' actions before its Disconnect.
    pub(super) fn order(&self) -> Vec<FocusHandle> {
        let machine_rank = |stop: &Stop| {
            self.shown
                .iter()
                .position(|s| s.machine == stop.machine)
                .unwrap_or(usize::MAX)
        };
        let mut order: Vec<&Stop> = self.shown.iter().collect();
        order.sort_by_key(|stop| (machine_rank(stop), stop.server.is_none()));
        order
            .into_iter()
            .filter_map(|stop| self.handles.get(stop).cloned())
            .collect()
    }
    pub(super) fn focused(&self, window: &Window) -> bool {
        self.handles.values().any(|stop| stop.is_focused(window))
    }
    /// Whether the keyboard is on an action the last table paint did not draw
    /// (an empty-state table draws no machine at all).
    pub(super) fn focused_unshown(&self, window: &Window) -> bool {
        self.handles
            .iter()
            .any(|(stop, handle)| handle.is_focused(window) && !self.shown.contains(stop))
    }
    /// Forgets the actions `exists` no longer has; true if one of them held
    /// the keyboard, which then is on nothing that is on screen.
    pub(super) fn retain(&mut self, window: &Window, exists: impl Fn(&Stop) -> bool) -> bool {
        let mut stranded = false;
        self.handles.retain(|stop, handle| {
            let keep = exists(stop);
            stranded |= !keep && handle.is_focused(window);
            keep
        });
        let handles = &self.handles;
        self.shown.retain(|stop| handles.contains_key(stop));
        stranded
    }
}
