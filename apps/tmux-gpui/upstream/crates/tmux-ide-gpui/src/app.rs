use gpui::{App, WindowAppearance};

/// Whether the system appearance is light, which picks the side of a
/// `light:…,dark:…` theme.
pub(crate) fn light_appearance(cx: &App) -> bool {
    matches!(
        cx.window_appearance(),
        WindowAppearance::Light | WindowAppearance::VibrantLight
    )
}
