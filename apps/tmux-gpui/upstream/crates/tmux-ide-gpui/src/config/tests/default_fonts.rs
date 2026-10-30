use crate::config::fonts::{LINUX_FONTS, MACOS_FONTS, WINDOWS_FONTS};
use std::collections::BTreeSet;

fn installed(families: &[&str]) -> BTreeSet<String> {
    families.iter().map(|family| (*family).to_owned()).collect()
}

#[test]
fn installed_defaults_are_kept() {
    let fonts = installed(&["DejaVu Sans Mono", "DejaVu Sans", "Noto Sans Mono"]);
    assert_eq!(LINUX_FONTS.substitute("DejaVu Sans Mono", &fonts), None);
    assert_eq!(LINUX_FONTS.substitute("DejaVu Sans", &fonts), None);
    let fonts = installed(&["Cascadia Mono", "Consolas"]);
    assert_eq!(WINDOWS_FONTS.substitute("Cascadia Mono", &fonts), None);
}

#[test]
fn missing_linux_defaults_take_the_first_known_alternative() {
    let fonts = installed(&["Ubuntu Mono", "Liberation Mono", "Cantarell", "Noto Sans"]);
    assert_eq!(
        LINUX_FONTS
            .substitute("DejaVu Sans Mono", &fonts)
            .as_deref(),
        Some("Liberation Mono")
    );
    assert_eq!(
        LINUX_FONTS.substitute("DejaVu Sans", &fonts).as_deref(),
        Some("Noto Sans")
    );
}

#[test]
fn omarchy_gets_its_jetbrains_mono_nerd_font() {
    // Omarchy's default font, alongside the Noto fonts Arch also installs.
    let fonts = installed(&[
        "CaskaydiaMono Nerd Font",
        "JetBrainsMono Nerd Font",
        "JetBrainsMono Nerd Font Mono",
        "Noto Sans",
        "Noto Sans Mono",
        "Noto Color Emoji",
    ]);
    assert_eq!(
        LINUX_FONTS
            .substitute("DejaVu Sans Mono", &fonts)
            .as_deref(),
        Some("JetBrainsMono Nerd Font")
    );
    assert_eq!(
        LINUX_FONTS.substitute("DejaVu Sans", &fonts).as_deref(),
        Some("Noto Sans")
    );
}

#[test]
fn missing_linux_monospace_falls_back_to_an_installed_text_mono_family() {
    // No listed family: any text `Mono` face beats a proportional fallback.
    let fonts = installed(&[
        "Symbols Nerd Font Mono",
        "Iosevka Nerd Font Propo",
        "Iosevka Nerd Font Mono",
        "Noto Color Emoji",
    ]);
    assert_eq!(
        LINUX_FONTS
            .substitute("DejaVu Sans Mono", &fonts)
            .as_deref(),
        Some("Iosevka Nerd Font Mono")
    );
    // With no sans family, the UI reads in monospace text, not a missing face.
    assert_eq!(
        LINUX_FONTS.substitute("DejaVu Sans", &fonts).as_deref(),
        Some("Iosevka Nerd Font Mono")
    );
}

#[test]
fn windows_without_cascadia_uses_consolas() {
    // Windows 10 without Windows Terminal has no Cascadia Mono.
    let fonts = installed(&["Segoe UI", "Lucida Console", "Consolas"]);
    assert_eq!(
        WINDOWS_FONTS.substitute("Cascadia Mono", &fonts).as_deref(),
        Some("Consolas")
    );
}

#[test]
fn chosen_aliased_and_unmatched_families_are_left_alone() {
    let fonts = installed(&["Noto Sans Mono", "Consolas"]);
    assert_eq!(LINUX_FONTS.substitute("Iosevka", &fonts), None);
    assert_eq!(
        LINUX_FONTS.substitute("DejaVu Sans Mono", &installed(&["Zapfino"])),
        None
    );
    // GPUI resolves `.SystemUIFont` itself; it is never listed as installed.
    assert_eq!(WINDOWS_FONTS.substitute(".SystemUIFont", &fonts), None);
    // macOS always ships its defaults, so resolution never checks them.
    assert!(!MACOS_FONTS.is_replaceable("Menlo"));
    assert_eq!(MACOS_FONTS.substitute("Menlo", &fonts), None);
}
