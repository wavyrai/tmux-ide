//! The host terminal theme a client shell reports to the daemon. Herdr answers
//! OSC 10/11/4 color queries from pane applications with it and picks its own
//! light or dark theme override from the appearance.

use crate::protocol::{
    ClientHostAppearance, ClientHostColor, ClientHostDefaultColorKind, ClientHostThemeUpdate,
};

/// Upstream closes a connection whose palette update has more entries than this.
pub(crate) const MAX_PALETTE_COLORS: usize = 256;

/// Everything Herdr tracks about the host terminal's colors, in one value so a
/// caller can report its whole theme and leave the per-connection diffing here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostTheme {
    pub foreground: ClientHostColor,
    pub background: ClientHostColor,
    pub palette: [ClientHostColor; MAX_PALETTE_COLORS],
    pub appearance: ClientHostAppearance,
}

impl HostTheme {
    /// The updates that move a daemon from `previous` to this theme, or from a
    /// fresh client's unknown theme when there is none.
    ///
    /// A fresh client sends the appearance first: an explicit appearance stops
    /// Herdr inferring one from the background color that follows it. Later
    /// the appearance goes last. Herdr tells pane applications about a new
    /// appearance at once, and one that then asks for the background, as
    /// Claude Code does, must get the colors that go with it.
    pub(crate) fn updates(&self, previous: Option<&Self>) -> Vec<ClientHostThemeUpdate> {
        let mut appearance = previous
            .is_none_or(|p| p.appearance != self.appearance)
            .then_some(ClientHostThemeUpdate::Appearance(self.appearance));
        let mut updates = Vec::new();
        if previous.is_none() {
            updates.extend(appearance.take());
        }
        for (kind, color, old) in [
            (
                ClientHostDefaultColorKind::Foreground,
                self.foreground,
                previous.map(|p| p.foreground),
            ),
            (
                ClientHostDefaultColorKind::Background,
                self.background,
                previous.map(|p| p.background),
            ),
        ] {
            if old != Some(color) {
                updates.push(ClientHostThemeUpdate::DefaultColor { kind, color });
            }
        }
        let palette: Vec<_> = (0..=u8::MAX)
            .zip(self.palette)
            .filter(|&(index, color)| {
                previous.is_none_or(|p| p.palette[usize::from(index)] != color)
            })
            .collect();
        if !palette.is_empty() {
            updates.push(ClientHostThemeUpdate::PaletteColors(palette));
        }
        updates.extend(appearance);
        updates
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(value: u32) -> ClientHostColor {
        let [_, r, g, b] = value.to_be_bytes();
        ClientHostColor { r, g, b }
    }

    fn theme() -> HostTheme {
        HostTheme {
            foreground: rgb(0xd8dee9),
            background: rgb(0x2e3440),
            palette: std::array::from_fn(|index| rgb(index as u32 * 0x010101)),
            appearance: ClientHostAppearance::Dark,
        }
    }

    #[test]
    fn a_fresh_connection_receives_the_whole_theme_appearance_first() {
        let updates = theme().updates(None);
        assert_eq!(updates.len(), 4);
        assert_eq!(
            updates[..3],
            [
                ClientHostThemeUpdate::Appearance(ClientHostAppearance::Dark),
                ClientHostThemeUpdate::DefaultColor {
                    kind: ClientHostDefaultColorKind::Foreground,
                    color: rgb(0xd8dee9),
                },
                ClientHostThemeUpdate::DefaultColor {
                    kind: ClientHostDefaultColorKind::Background,
                    color: rgb(0x2e3440),
                },
            ]
        );
        let ClientHostThemeUpdate::PaletteColors(palette) = &updates[3] else {
            panic!("expected palette")
        };
        assert_eq!(palette.len(), MAX_PALETTE_COLORS);
        assert_eq!(palette[0], (0, rgb(0)));
        assert_eq!(palette[255], (255, rgb(0xffffff)));
    }

    #[test]
    fn later_updates_carry_only_what_changed() {
        let old = theme();
        assert!(old.updates(Some(&old)).is_empty());

        let mut next = old.clone();
        next.appearance = ClientHostAppearance::Light;
        assert_eq!(
            next.updates(Some(&old)),
            [ClientHostThemeUpdate::Appearance(
                ClientHostAppearance::Light
            )]
        );

        let mut next = old.clone();
        next.background = rgb(0xffffff);
        next.palette[4] = rgb(0x81a1c1);
        next.palette[200] = rgb(0x123456);
        assert_eq!(
            next.updates(Some(&old)),
            [
                ClientHostThemeUpdate::DefaultColor {
                    kind: ClientHostDefaultColorKind::Background,
                    color: rgb(0xffffff),
                },
                ClientHostThemeUpdate::PaletteColors(vec![
                    (4, rgb(0x81a1c1)),
                    (200, rgb(0x123456)),
                ]),
            ]
        );
    }
}
