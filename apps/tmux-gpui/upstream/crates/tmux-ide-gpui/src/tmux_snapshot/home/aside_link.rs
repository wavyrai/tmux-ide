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
        }
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
        let focus = window.use_keyed_state(self.id.clone(), cx, |_, cx| cx.focus_handle());
        let focus = focus.read(cx).clone();
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
            .on_action(move |_: &bezel_ui::focus::Activate, window, cx| {
                if enabled && let Some(activate) = &activate {
                    activate(&(), window, cx);
                }
            })
    }
}
