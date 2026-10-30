//! The header's text, as painted, reads at 4.5:1 on its plate in every
//! catalog variant.
#![allow(clippy::unwrap_used)]
use super::bezel::header_view;
use super::*;
use crate::tmux_snapshot::{
    appearance::{Appearance, Colors, OptionItem, System},
    browser_toolbar::Mark,
    design::{InkProbes, dialog_muted, palette},
};
use std::sync::mpsc;

#[derive(serde::Deserialize)]
struct Preset {
    id: String,
    dark: Colors,
    light: Colors,
}

fn catalog() -> Vec<(String, Colors)> {
    let presets: Vec<Preset> =
        serde_json::from_str(include_str!("../appearance/catalog.json")).unwrap();
    presets
        .into_iter()
        .flat_map(|p| {
            [
                (format!("{} (dark)", p.id), p.dark),
                (format!("{} (light)", p.id), p.light),
            ]
        })
        .collect()
}

fn appearance(colors: Colors) -> Appearance {
    Appearance {
        selected: "preset".into(),
        system: System::Dark,
        theme: colors,
        options: vec![OptionItem {
            id: "preset".into(),
            name: "Preset".into(),
        }],
        error: None,
    }
}

fn ratio(text: Hsla, plate: Hsla) -> f32 {
    bezel_theme::contrast_ratio(bezel_theme::flatten(text, plate), plate)
}

/// The header's plate: the pane's background, bare and under Bezel's hover
/// and selected washes.
fn header_plates(theme: &crate::config::Theme) -> [Hsla; 3] {
    let bezel = palette(theme);
    let plate = bezel.terminal_bg;
    [
        plate,
        bezel_theme::flatten(bezel.element_hover, plate),
        bezel_theme::flatten(bezel.card_selected_bg(), plate),
    ]
}

#[test]
fn bezels_own_roles_miss_on_the_header_somewhere() {
    let (mut muted, mut warning) = (false, false);
    for (_, colors) in catalog() {
        let theme = appearance(colors).native();
        let bezel = palette(&theme);
        let plates = header_plates(&theme);
        muted |= plates.iter().any(|&p| ratio(bezel.text_muted, p) < 4.5);
        warning |= ratio(bezel.warning, plates[0]) < 4.5;
    }
    assert!(muted && warning, "else the inking below proves nothing");
}

#[gpui::test]
fn header_text_reads_on_its_plate_in_every_catalog_variant(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(256);
    cx.update(|cx| cx.set_global(InkProbes::default()));
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state
                .browser_marks
                .insert("pane-c".into(), Mark::Rejected(1));
        });
        window.draw(cx).clear(cx);
    });
    let address = cx.debug_bounds("browser-address").unwrap();
    cx.simulate_click(address.center(), Modifiers::default());
    assert!(view.read_with(cx, |v, _| v.browser_address.is_some()));
    let themes = catalog();
    assert_eq!(themes.len(), 50);
    let mut failures = Vec::new();
    for (name, colors) in themes {
        cx.update(|window, cx| {
            view.update(cx, |v, _| {
                v.browser_state.appearance = Some(appearance(colors))
            });
            cx.global_mut::<InkProbes>().0.clear();
            window.draw(cx).clear(cx);
        });
        receiver.try_iter().for_each(drop);
        let theme = view.read_with(cx, |v, _| v.theme());
        let ink = header_ink(&theme);
        let header = header_plates(&theme);
        let card = Hsla {
            a: 1.,
            ..palette(&theme).surface_dialog
        };
        let cap = [card, bezel_theme::flatten(bezel_theme::ink(0.05), card)];
        let probes = cx.update(|_, cx| cx.global::<InkProbes>().0.clone());
        // The cap's ink is what the bridge's dialog muted becomes on the cap;
        // that it reads there is what is checked.
        let probes_cap = probes
            .get("browser-address-cap-esc")
            .copied()
            .unwrap_or_default();
        for (key, expected, plates) in [
            ("pane-mode:pane-a", ink.muted, &header[..]),
            ("pane-title:pane-a", ink.text, &header[..]),
            ("pane-title:pane-b", ink.muted, &header[..]),
            ("browser-address:pane-c", ink.muted, &header[..]),
            ("browser-rejected", ink.warning, &header[..1]),
            ("browser-address-cap-return", probes_cap, &cap[..]),
            ("browser-address-hint-Open", dialog_muted(&theme), &cap[..1]),
            ("browser-address-cap-esc", probes_cap, &cap[..]),
            (
                "browser-address-hint-Cancel",
                dialog_muted(&theme),
                &cap[..1],
            ),
        ] {
            let Some(&painted) = probes.get(key) else {
                failures.push(format!("{name}: {key} not painted"));
                continue;
            };
            if painted != expected {
                failures.push(format!("{name}: {key} painted {painted:?}"));
            }
            for &plate in plates {
                let r = ratio(painted, plate);
                if r < 4.5 {
                    failures.push(format!("{name}: {key} is {r:.2}:1 on {plate:?}"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
