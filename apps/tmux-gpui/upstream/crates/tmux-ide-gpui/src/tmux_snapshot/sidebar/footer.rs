//! The sidebar's footer: two clear-glass capsules (#746 v3, owner: option B).
use super::*;
use crate::tmux_snapshot::{SnapshotView, controls};

/// A capsule's inset around its buttons: Bezel's control group pad.
const CAPSULE_PAD: f32 = 2.;

/// The footer's height: its two capsules and its 8 pt margins.
pub(in crate::tmux_snapshot) fn height() -> f32 {
    bezel_theme::ControlSize::Regular.height() + 2. * CAPSULE_PAD + 2. * bezel_theme::Theme::SPACE
}

impl SnapshotView {
    pub(in crate::tmux_snapshot) fn sidebar_footer(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme();
        let bezel = bezel_theme::Theme::of(cx).clone();
        let request = self.browser_request;
        let sessions = self
            .sidebar_focus_control(
                controls::button(
                    "open-picker",
                    None,
                    "Switch session",
                    controls::Icon::Sessions,
                    &theme,
                ),
                0,
                &theme,
            )
            .on_click(cx.listener(move |view, _, window, cx| {
                if view.sidebar_footer_current(request) {
                    view.open_picker(window, cx);
                }
            }));
        let machines = self
            .sidebar_focus_control(
                controls::button(
                    "open-machines",
                    None,
                    "Switch machine",
                    controls::Icon::Machines,
                    &theme,
                ),
                1,
                &theme,
            )
            .on_click(cx.listener(move |view, _, window, cx| {
                if view.sidebar_footer_current(request) {
                    view.open_saved_machines(window, cx);
                }
            }));
        let appearance = self.browser_state.appearance.is_some();
        let theme_button = self
            .sidebar_focus_control(
                controls::action_button(
                    "open-theme-picker",
                    None,
                    "Choose theme",
                    controls::Icon::Theme,
                    if appearance {
                        controls::ButtonStyle::Quiet
                    } else {
                        controls::ButtonStyle::Unavailable
                    },
                    &theme,
                ),
                2,
                &theme,
            )
            .when(!appearance, |control| {
                control.aria_description("Appearance settings are not available yet")
            })
            .when(appearance, |control| {
                control.on_click(cx.listener(move |view, _, window, cx| {
                    if view.sidebar_footer_current(request) {
                        view.open_theme_picker(window, cx);
                    }
                }))
            });
        let settings = self
            .sidebar_focus_control(
                controls::button(
                    "open-commands",
                    None,
                    "Settings and commands",
                    controls::Icon::Settings,
                    &theme,
                ),
                3,
                &theme,
            )
            .on_click(cx.listener(move |view, _, window, cx| {
                if view.sidebar_footer_current(request) {
                    view.open_commands(window, cx);
                }
            }));
        div()
            .debug_selector(|| "tmux-sidebar-footer".into())
            .flex_none()
            .m(px(bezel_theme::Theme::SPACE))
            .flex()
            .items_center()
            .justify_between()
            .child(capsule(
                "tmux-sidebar-footer-left",
                &bezel,
                [sessions, machines],
            ))
            .child(self.connection_slot(cx))
            .child(capsule(
                "tmux-sidebar-footer-right",
                &bezel,
                [theme_button, settings],
            ))
            .into_any_element()
    }
}

/// One clear-glass capsule around a pair of icon buttons: Bezel's Clear
/// material (its own rim and lens; no dimming slab), the buttons at Bezel's
/// regular control height, inset by the control group's pad.
fn capsule(
    selector: &'static str,
    bezel: &bezel_theme::Theme,
    buttons: [Stateful<Div>; 2],
) -> impl IntoElement {
    use bezel_ui::surface::Surfaced as _;
    div()
        .debug_selector(move || selector.into())
        .flex_none()
        .flex()
        .items_center()
        .gap(px(CAPSULE_PAD))
        .p(px(CAPSULE_PAD))
        .h(px(
            bezel_theme::ControlSize::Regular.height() + 2. * CAPSULE_PAD
        ))
        .rounded_full()
        // 24 pt icon buttons: Bezel's regular control height, square.
        .children(buttons.map(|button| {
            button
                .flex_none()
                .size(px(bezel_theme::ControlSize::Regular.height()))
                .min_w(px(bezel_theme::ControlSize::Regular.height()))
                .max_w(px(bezel_theme::ControlSize::Regular.height()))
                .justify_center()
                .px_0()
                .rounded_full()
        }))
        .surface(
            bezel,
            bezel_theme::SurfaceStyle::Glass(bezel_theme::Glass::Clear),
        )
}
