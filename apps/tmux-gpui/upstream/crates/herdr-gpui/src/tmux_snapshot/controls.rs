//! Native chrome primitives. Terminal geometry and routing stay with their owners.
use crate::config::Theme;
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
const ICON_SIZE: f32 = 16.;
const LABEL_SIZE: f32 = 12.;
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

fn glyph(icon: Icon, foreground: u32) -> Svg {
    svg()
        .path(icon.path())
        .size(px(ICON_SIZE))
        .flex_shrink_0()
        // GPUI SVG paint requires its own color; parent text is insufficient.
        .text_color(rgb(foreground))
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
    // Reuse Herdr's palette-derived danger ink (menu/devices/host_menu.rs).
    // This helper guarantees mark contrast, not small-text contrast. Keep labels
    // and tooltips in the normal foreground; tint only the icon and border.
    // GPUI packs Rgba as RRGGBBAA; glyph consumes RGB only.
    let icon_foreground = match style {
        ButtonStyle::Destructive => u32::from(crate::menu::danger(theme)) >> 8,
        _ => theme.foreground,
    };
    let (foreground, surface, active) = (theme.foreground, theme.surface, theme.active);
    div()
        .id(id)
        .role(Role::Button)
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
                control.px(px(10.))
            } else {
                control.w(px(CONTROL_HEIGHT))
            }
        })
        .text_size(px(LABEL_SIZE))
        .font_weight(FontWeight::NORMAL)
        .rounded(px(crate::config::corners::CONTROL))
        .text_color(rgb(foreground))
        .map(|control| match style {
            ButtonStyle::Primary => control.bg(rgb(active)).font_weight(FontWeight::MEDIUM),
            ButtonStyle::Secondary => control.border_1().border_color(separator(theme)),
            ButtonStyle::Destructive => control.border_1().border_color(rgb(icon_foreground)),
            ButtonStyle::Quiet | ButtonStyle::Unavailable => control,
        })
        // Adapt Herdr titlebar/navigation.rs: unavailable controls never paint
        // hover/pressed affordances. Owners still decide whether to attach a callback.
        .when(matches!(style, ButtonStyle::Unavailable), |control| {
            control.opacity(0.5).cursor_default()
        })
        .when(!matches!(style, ButtonStyle::Unavailable), |control| {
            control
                .cursor_pointer()
                .hover(move |hover| {
                    hover.bg(match style {
                        ButtonStyle::Primary => rgb(active).blend(rgba((foreground << 8) | 0x14)),
                        _ => rgb(active),
                    })
                })
                .active(move |pressed| {
                    pressed.bg(rgb(active).blend(rgba((foreground << 8) | 0x24)))
                })
        })
        .child(glyph(icon, icon_foreground))
        .children(label.map(|label| div().min_w_0().truncate().child(label)))
        .tooltip(move |_, cx| {
            cx.new(|_| crate::usage::Hint {
                text: hint.into(),
                foreground,
                surface,
            })
            .into()
        })
}

pub(super) fn tab(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    icon: Icon,
    selected: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let foreground = if selected {
        theme.foreground
    } else {
        theme.muted
    };
    let hover = theme.active;
    div()
        .id(id)
        .h(px(CONTROL_HEIGHT))
        .flex_shrink_0()
        .flex()
        .items_center()
        .gap(px(CONTENT_GAP))
        .px(px(12.))
        .text_size(px(LABEL_SIZE))
        .font_weight(FontWeight::MEDIUM)
        .bg(if selected {
            rgb(theme.active).into()
        } else {
            transparent_black()
        })
        .rounded(px(crate::config::corners::CONTROL))
        .text_color(rgb(foreground))
        .cursor_pointer()
        .hover(move |style| style.bg(rgb(hover)))
        .child(glyph(icon, foreground))
        .child(div().min_w_0().truncate().child(label.into()))
}

/// Adapt Herdr window/tab_strip.rs: contiguous full-height cells, a single
/// neutral selected fill. These destinations are not closable.
pub(super) fn titlebar_tab(
    id: &'static str,
    label: &'static str,
    icon: Icon,
    selected: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let background = if selected { rgb(theme.active) } else { rgba(0) };
    let foreground = if selected {
        theme.foreground
    } else {
        theme.muted
    };
    // Inactive destinations remain ghost controls, including while hovered.
    let hover = background;
    div()
        .id(id)
        .h(px(26.))
        .rounded(px(crate::config::corners::CONTROL))
        .min_w(px(108.))
        .flex_none()
        .flex()
        .items_center()
        .gap(px(CONTENT_GAP))
        .px(px(14.))
        .text_size(px(LABEL_SIZE))
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgb(foreground))
        .bg(background)
        .cursor_pointer()
        .hover(move |tab| tab.bg(hover))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(glyph(icon, foreground))
        .child(label)
}
