use super::*;
use crate::tmux_snapshot::design::{self, InkProbes};

/// What Home paints text on, worked out here rather than read from `plates`.
fn plates_under_text(theme: &crate::config::Theme, canvas: u32) -> Vec<(Hsla, &'static str)> {
    let bezel = design::palette(theme);
    let canvas: Hsla = rgb(canvas).into();
    let card = bezel_theme::flatten(bezel.card_glass_bg(), canvas);
    vec![
        (canvas, "canvas"),
        (card, "card"),
        (
            bezel_theme::flatten(bezel.element_hover, canvas),
            "hovered row",
        ),
        (
            bezel_theme::flatten(bezel.element_hover, card),
            "hovered row in a card",
        ),
        (
            bezel_theme::flatten(bezel.card_selected_bg(), canvas),
            "selected row",
        ),
    ]
}

#[derive(serde::Deserialize)]
struct Preset {
    id: String,
    dark: crate::tmux_snapshot::appearance::Colors,
    light: crate::tmux_snapshot::appearance::Colors,
}

fn theme_of(colors: &crate::tmux_snapshot::appearance::Colors) -> crate::config::Theme {
    let mut theme = crate::config::Theme {
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.cursor,
        surface: colors.surface,
        active: colors.active,
        muted: colors.muted,
        ..Default::default()
    };
    for (slot, value) in theme.palette.iter_mut().zip(&colors.palette) {
        *slot = *value;
    }
    theme
}

/// The shipped themes all read with Bezel's own roles today; this keeps
/// Home's inked roles at 4.5:1 on every plate as the catalog changes.
#[test]
fn home_text_reads_on_every_plate_in_every_catalog_theme() {
    let presets: Vec<Preset> =
        serde_json::from_str(include_str!("../../appearance/catalog.json")).unwrap();
    let mut failures = Vec::new();
    for preset in &presets {
        for (variant, colors) in [("dark", &preset.dark), ("light", &preset.light)] {
            let theme = theme_of(colors);
            let home = palette(&theme, colors.canvas);
            for (plate, plate_name) in plates_under_text(&theme, colors.canvas) {
                for (role, text) in [("text", home.text), ("muted", home.text_muted)] {
                    let ratio = bezel_theme::contrast_ratio(text, plate);
                    if ratio < 4.5 {
                        failures.push(format!(
                            "{} ({variant}): {role} on {plate_name} is {ratio:.2}:1",
                            preset.id
                        ));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The same theme on two canvases inks for each: a cached ink from one
/// canvas reused on the other leaves text under 4.5:1.
#[test]
fn home_ink_follows_the_canvas() {
    let colors: crate::tmux_snapshot::appearance::Colors =
        serde_json::from_value(faint_muted()["theme"].clone()).unwrap();
    let theme = theme_of(&colors);
    let mut failures = Vec::new();
    for canvas in [0x0b0b10, 0x404040, 0x0b0b10] {
        let home = palette(&theme, canvas);
        for (plate, name) in plates_under_text(&theme, canvas) {
            for (role, text) in [("text", home.text), ("muted", home.text_muted)] {
                let ratio = bezel_theme::contrast_ratio(text, plate);
                if ratio < 4.5 {
                    failures.push(format!("{role} on {name} of {canvas:06x} is {ratio:.2}:1"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// A dark theme on a lighter canvas than its surface: Bezel's text and muted,
/// made to read on the surface, drop under 4.5:1 on Home's canvas.
fn faint_muted() -> serde_json::Value {
    serde_json::json!({
        "selected":"dark","system":"dark","error":null,
        "theme":{"canvas":0x404040,"background":0x0b0b10,"foreground":0x8a8a8a,
            "cursor":0x222b38,"surface":0x212121,"active":0x303030,"muted":0x5c5c5c,
            "accent":0x68a8ff,"palette":vec![0x808080;256]},
        "options":[{"id":"dark","name":"Dark"}]
    })
}

#[gpui::test]
fn home_text_reads_where_bezel_roles_do_not(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.frame = None;
        view.browser_state.frame = None;
        view.browser_state.appearance = Some(serde_json::from_value(faint_muted()).unwrap());
        view.browser_state.fleet = Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../fixtures/home-fleet.json"
            ))
            .unwrap(),
        );
        view.browser_state.home_agents = Some(serde_json::from_value(serde_json::json!({"revision":4,"phase":"live","rows":[{"key":"s\u{0}a","sessionId":"s","paneId":"p","name":"Agent","sessionLabel":"Main","status":"WORKING","attention":false,"available":true}],"observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap());
        view
    });
    receiver.try_iter().for_each(drop);
    let (theme, canvas) = view.read_with(cx, |v, _| (v.theme(), v.canvas()));
    let plates = plates_under_text(&theme, canvas);
    let stock = design::palette(&theme);
    for (role, color) in [("text", stock.text), ("muted", stock.text_muted)] {
        assert!(
            plates.iter().any(|(plate, _)| {
                bezel_theme::contrast_ratio(bezel_theme::flatten(color, *plate), *plate) < 4.5
            }),
            "Bezel's {role} must fail on Home's plates here, or the test proves nothing"
        );
    }
    cx.update(|_, cx| cx.set_global(InkProbes::default()));
    cx.simulate_resize(size(px(1400.), px(1800.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|_, cx| {
        let probes = &cx.global::<InkProbes>().0;
        let mut failures = Vec::new();
        for key in [
            "home-text",
            "home-summary",
            "home-agent-counts",
            "home-agent-context-0",
            "home-agent-action-0",
            "home-filter-hints",
            "fleet-machine-guidance-3",
            // The shared quiet buttons, painted from Home's palette.
            "control-home-theme",
            "control-tmux-home-refresh",
            "control-icon-home-theme",
            "control-icon-tmux-home-refresh",
        ] {
            let Some(&text) = probes.get(key) else {
                failures.push(format!("{key}: not painted"));
                continue;
            };
            for (plate, name) in &plates {
                let ratio = bezel_theme::contrast_ratio(bezel_theme::flatten(text, *plate), *plate);
                if ratio < 4.5 {
                    failures.push(format!("{key} on {name} is {ratio:.2}:1"));
                }
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    });
}
