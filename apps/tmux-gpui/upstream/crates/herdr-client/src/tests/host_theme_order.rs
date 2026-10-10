use super::*;

fn theme(background: u8, appearance: ClientHostAppearance) -> HostTheme {
    let rgb = |value: u8| ClientHostColor {
        r: value,
        g: value,
        b: value,
    };
    HostTheme {
        foreground: rgb(0xff - background),
        background: rgb(background),
        palette: std::array::from_fn(|index| rgb(index as u8)),
        appearance,
    }
}

#[test]
fn a_new_appearance_follows_the_colors_that_go_with_it() {
    let light = theme(0xf4, ClientHostAppearance::Light);
    let dark = theme(0x10, ClientHostAppearance::Dark);
    // An application told the appearance changed asks for the background
    // next, so Herdr must already hold the new one.
    let updates = dark.updates(Some(&light));
    assert_eq!(
        updates,
        [
            ClientHostThemeUpdate::DefaultColor {
                kind: ClientHostDefaultColorKind::Foreground,
                color: dark.foreground,
            },
            ClientHostThemeUpdate::DefaultColor {
                kind: ClientHostDefaultColorKind::Background,
                color: dark.background,
            },
            ClientHostThemeUpdate::Appearance(ClientHostAppearance::Dark),
        ]
    );
    // A fresh connection still names the appearance before any color.
    assert_eq!(
        dark.updates(None).first(),
        Some(&ClientHostThemeUpdate::Appearance(
            ClientHostAppearance::Dark
        ))
    );
}
