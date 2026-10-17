//! Native chrome primitives. Terminal geometry and routing stay with their owners.
use crate::config::Theme;
use bezel_theme::{ControlSize, Sizing};
use bezel_ui::widgets::Buttons;
use gpui::{prelude::*, *};

/// Quiet structural boundaries are independent of selection and focus accents.
pub(super) fn separator(theme: &Theme) -> Rgba {
    let alpha = if theme.contrast == crate::contrast::Contrast::High {
        0x59
    } else {
        0x14
    };
    rgba((theme.foreground << 8) | alpha)
}

pub(super) const CONTROL_HEIGHT: f32 = 32.;
const CONTENT_GAP: f32 = 6.;

#[cfg(test)]
#[path = "controls_tests.rs"]
mod tests;

#[derive(Clone, Copy)]
pub(super) enum Icon {
    Sidebar,
    Plus,
    Trash,
    Close,
    Home,
    Terminal,
    Sessions,
    Theme,
    Refresh,
    Check,
}
impl Icon {
    fn path(self) -> &'static str {
        match self {
            Self::Trash => "icons/trash.svg",
            Self::Close => "icons/close.svg",
            Self::Sidebar => "icons/panel-left.svg",
            Self::Plus => "icons/plus.svg",
            Self::Home => "icons/tmux-home.svg",
            Self::Terminal => "icons/terminal.svg",
            Self::Sessions => "icons/sessions.svg",
            Self::Theme => "icons/theme.svg",
            Self::Refresh => "icons/refresh.svg",
            Self::Check => "icons/check.svg",
        }
    }
}

/// Visual presentation is independent of command admission, which stays with callers.
#[derive(Clone, Copy)]
pub(super) enum ButtonStyle {
    Primary,
    Secondary,
    Destructive,
    Unavailable,
    Quiet,
}

pub(super) fn button(
    id: &'static str,
    label: Option<&'static str>,
    hint: &'static str,
    icon: Icon,
    theme: &Theme,
) -> Stateful<Div> {
    action_button(id, label, hint, icon, ButtonStyle::Quiet, theme)
}

pub(super) fn action_button(
    id: &'static str,
    label: Option<&'static str>,
    hint: &'static str,
    icon: Icon,
    style: ButtonStyle,
    theme: &Theme,
) -> Stateful<Div> {
    use bezel_ui::widgets::ButtonStyle as BezelStyle;
    let bezel = super::design::palette(theme);
    let asset = bezel_ui::icons::Icon::asset(icon.path());
    let base = match style {
        ButtonStyle::Primary => bezel.icon_button(asset, BezelStyle::Prominent, None).id(id),
        ButtonStyle::Destructive => bezel
            .icon_button(asset, BezelStyle::Destructive, None)
            .id(id),
        ButtonStyle::Unavailable => bezel.icon_button(asset, BezelStyle::Ghost, None).id(id),
        ButtonStyle::Secondary | ButtonStyle::Quiet => bezel.ghost(id).child(
            bezel_ui::icons::icon(asset)
                .size(px(bezel_ui::widgets::ICON_GLYPH))
                .flex_shrink_0()
                .text_color(bezel.text_muted),
        ),
    };
    base.control_size(ControlSize::Regular)
        .role(Role::Button)
        .border_1()
        .border_color(transparent_black())
        .accessibility_id(id)
        .aria_label(label.unwrap_or(hint))
        .debug_selector(move || id.to_owned())
        .h(px(CONTROL_HEIGHT))
        .min_w(px(CONTROL_HEIGHT))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(CONTENT_GAP))
        .map(|control| {
            if label.is_some() {
                control.w_auto().px(px(10.))
            } else {
                control.w(px(CONTROL_HEIGHT)).px_0()
            }
        })
        .when(matches!(style, ButtonStyle::Unavailable), |control| {
            control.opacity(0.5).cursor_default()
        })
        .children(label.map(|label| div().min_w_0().truncate().child(label)))
        .tooltip(move |window, cx| bezel_ui::tooltip::Tooltip::text(hint, window, cx))
}

pub(super) fn tab(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    icon: Icon,
    selected: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let key = format!("{:?}", id.into());
    bezel_ui::tabs::tab(
        &super::design::palette(theme),
        key,
        bezel_ui::tabs::Label::new(label).with_icon(bezel_ui::icons::Icon::asset(icon.path())),
        if selected {
            bezel_ui::tabs::State::Focused
        } else {
            bezel_ui::tabs::State::Resting
        },
    )
    .h(px(CONTROL_HEIGHT))
}

/// The same Bezel tab component in the compact native titlebar.
pub(super) fn titlebar_tab(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    icon: Icon,
    selected: bool,
    theme: &Theme,
) -> Stateful<Div> {
    tab(id, label, icon, selected, theme)
        .h(px(26.))
        .min_w(px(108.))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}
