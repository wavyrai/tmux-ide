//! A machine header's action as small muted text (#746 v3): a real control,
//! with a tab stop, Enter and Space activation and a focus ring, as the
//! Bezel button it replaced had (bezel_ui::focus::pressable).
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
            bezel: bezel.clone(),
            activate: None,
        }
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
        let text = bezel.text;
        let selector = self.selector.clone();
        let focused = focus.is_focused(window);
        let link = div()
            .id(self.id)
            .role(Role::Button)
            .aria_label(self.label)
            .accessibility_id(self.selector.clone())
            .debug_selector(move || selector.clone())
            .flex_none()
            .px(px(3.))
            .rounded(px(4.))
            // The ring's slot: transparent until keyboard focus shows it.
            .border_1()
            .border_color(transparent_black())
            .text_style(TextStyle::Subheadline)
            .text_color(bezel.text_muted)
            .when(enabled, |link| {
                link.cursor_pointer().hover(move |s| s.text_color(text))
            })
            .when(!enabled, |link| link.opacity(0.6))
            .child(self.label)
            // Tests find the focused control by this marker.
            .when(focused, |link| {
                let selector = self.selector.clone();
                link.child(
                    div()
                        .size_0()
                        .debug_selector(move || format!("{selector}:focused")),
                )
            });
        let activate = self.activate;
        bezel_ui::focus::pressable(&bezel, &focus, link, enabled, move |event, window, cx| {
            if let Some(activate) = &activate {
                activate(event, window, cx);
            }
        })
    }
}
