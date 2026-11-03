use super::*;
use crate::tmux_snapshot::design::{self, InkProbes};

/// What Home paints text on, worked out here rather than read from `plates`.
pub(super) fn plates_under_text(
    theme: &crate::config::Theme,
    canvas: u32,
) -> Vec<(Hsla, &'static str)> {
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
        (bezel_theme::flatten(bezel.ink(0.05), canvas), "key cap"),
    ]
}

#[derive(serde::Deserialize)]
pub(super) struct Preset {
    pub id: String,
    pub dark: crate::tmux_snapshot::appearance::Colors,
    pub light: crate::tmux_snapshot::appearance::Colors,
}

pub(super) fn theme_of(colors: &crate::tmux_snapshot::appearance::Colors) -> crate::config::Theme {
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
pub(super) fn faint_muted() -> serde_json::Value {
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
        // An attached row, for its marker's ink.
        view.browser_state.fleet.as_mut().unwrap().groups[0].sessions[0].active = true;
        // A default server among several, for its marker's ink.
        view.browser_state.selected_server = Some(server_on(&view, 0, 0));
        view.browser_state.home_agents = Some(serde_json::from_value(serde_json::json!({"revision":4,"phase":"live","rows":[{"key":"s\u{0}a","sessionId":"s","paneId":"p","name":"Agent","sessionLabel":"Main","status":"WORKING","attention":false,"available":true},{"key":"s\u{0}b","sessionId":"s","paneId":"q","name":"Waiting","sessionLabel":"Main","status":"BLOCKED","attention":true,"available":true}],"observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap());
        // Option A's row (#705): its agent, its windows and when it was
        // last active, each in its own ink.
        let session = &mut view.browser_state.fleet.as_mut().unwrap().groups[0].sessions[0];
        session.session_id = Some("s".into());
        session.window_count = Some(2);
        session.last_activity = Some(0);
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
    // The table's keyboard row, for the ↵ hint's ink on the selected plate.
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.prepare_home_filter(cx);
            v.home_filter
                .as_ref()
                .unwrap()
                .fleet_table
                .clone()
                .focus(window, cx);
        })
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|_, cx| {
        let probes = &cx.global::<InkProbes>().0;
        let mut failures = Vec::new();
        for key in [
            "home-text",
            "home-agents-attention",
            "fleet-session-agent-0-0",
            "fleet-session-status-0-0",
            "fleet-session-active-0-0",
            "fleet-machine-label-0",
            "fleet-machine-guidance-3",
            // The shared quiet buttons, painted from Home's palette, with
            // their words (#705) and their glyphs.
            "home-browse",
            "home-browse-key",
            "home-nav-count-0",
            "home-nav-machines",
            "fleet-columns",
            "fleet-session-attached-0-0",
            "fleet-session-enter-0-0",
            "fleet-server-default-0-0",
            "control-icon-home-theme",
            "control-icon-tmux-home-refresh",
            "control-home-theme",
            "control-tmux-home-refresh",
            "control-home-new-local-session",
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

/// The fleet's server `server` on machine `group`, as the default.
pub(super) fn server_on(
    view: &SnapshotView,
    group: usize,
    server: usize,
) -> browser::fleet::SelectedServer {
    let group = &view.browser_state.fleet.as_ref().unwrap().groups[group];
    let server = &group.servers[server];
    browser::fleet::SelectedServer {
        machine_id: group.id.clone(),
        machine_label: group.label.clone(),
        server_id: server.id.clone(),
        generation: server.generation.clone().unwrap(),
        label: server.label.clone(),
    }
}
