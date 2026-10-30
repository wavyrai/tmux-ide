use gpui::App;

/// Whether the system appearance is light, which picks the side of a
/// `light:…,dark:…` theme.
pub(crate) fn light_appearance(cx: &App) -> bool {
    bezel_theme::Appearance::from_window(cx.window_appearance()) == bezel_theme::Appearance::Light
}
