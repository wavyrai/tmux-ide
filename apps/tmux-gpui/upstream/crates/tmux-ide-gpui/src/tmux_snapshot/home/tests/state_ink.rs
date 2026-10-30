use super::ink::{Preset, faint_muted, plates_under_text, theme_of};
use super::*;
use crate::tmux_snapshot::design::{self, InkProbes};
use browser::local_setup::{Phase, Setup};

/// The washes Bezel's strips paint their message on, and the bare canvas the
/// error rows sit on, worked out here rather than read from `strip_plate`.
fn strip_plates(theme: &crate::config::Theme, canvas: u32) -> [(Hsla, Hsla); 2] {
    let bezel = design::palette(theme);
    let canvas: Hsla = rgb(canvas).into();
    [
        (
            bezel_theme::flatten(bezel.danger.opacity(0.06), canvas),
            canvas,
        ),
        (
            bezel_theme::flatten(bezel.warning.opacity(0.06), canvas),
            canvas,
        ),
    ]
}

fn reads(text: Hsla, plate: Hsla) -> f32 {
    bezel_theme::contrast_ratio(bezel_theme::flatten(text, plate), plate)
}

/// Error text reads on the error strip and on the canvas, warning text on the
/// warning strip, in every catalog theme.
#[test]
fn strip_and_error_text_reads_in_every_catalog_theme() {
    let presets: Vec<Preset> =
        serde_json::from_str(include_str!("../../appearance/catalog.json")).unwrap();
    let mut failures = Vec::new();
    for preset in &presets {
        for (variant, colors) in [("dark", &preset.dark), ("light", &preset.light)] {
            let theme = theme_of(colors);
            let home = palette(&theme, colors.canvas);
            let [(error, canvas), (warning, _)] = strip_plates(&theme, colors.canvas);
            for (role, text, plate, name) in [
                ("error", home.danger_muted, error, "error strip"),
                ("error", home.danger_muted, canvas, "canvas"),
                ("warning", home.warning_muted, warning, "warning strip"),
            ] {
                let ratio = reads(text, plate);
                if ratio < 4.5 {
                    failures.push(format!(
                        "{} ({variant}): {role} on {name} is {ratio:.2}:1",
                        preset.id
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

const HINT_KEYS: [&str; 14] = [
    "home-key-cap-↑↓",
    "home-key-cap-Enter",
    "home-key-cap-/",
    "home-key-cap-0",
    "home-key-cap-W",
    "home-key-cap-A",
    "home-key-cap-Esc",
    "home-key-label-Select",
    "home-key-label-Open",
    "home-key-label-Search",
    "home-key-label-All",
    "home-key-label-Working",
    "home-key-label-Attention",
    "home-key-label-Clear search",
];

/// The colours the strips, error rows and key hints are painted in, on the
/// faint theme where Bezel's own tones and muted fail Home's plates.
#[gpui::test]
fn state_text_is_painted_inked(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.frame = None;
        view.browser_state.frame = None;
        view.browser_state.appearance = Some(serde_json::from_value(faint_muted()).unwrap());
        view.browser_state.fleet = Some(
            serde_json::from_value(serde_json::json!({"groups":[],"omittedGroups":0})).unwrap(),
        );
        view.browser_state.home_agents = Some(serde_json::from_value(serde_json::json!({"revision":4,"phase":"live","rows":[],"observedSessions":0,"totalSessions":0,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap());
        view.browser_state.home_agent_filter = Some(machine_filter::Capability {
            revision: 4,
            machine_id: None,
        });
        view.browser_state.local_setup = Some(Setup {
            phase: Phase::Failed,
        });
        view
    });
    receiver.try_iter().for_each(drop);
    let (theme, canvas) = view.read_with(cx, |v, _| (v.theme(), v.canvas()));
    let [(error, bare), (warning, _)] = strip_plates(&theme, canvas);
    let stock = design::palette(&theme);
    assert!(
        reads(stock.text_muted.opacity(0.45), bare) < 4.5,
        "Bezel's key hint label must fail here, or the test proves nothing"
    );
    cx.simulate_resize(size(px(1400.), px(1800.)));
    let paint = |cx: &mut VisualTestContext, change: &dyn Fn(&mut SnapshotView)| {
        cx.update(|window, cx| {
            cx.set_global(InkProbes::default());
            view.update(cx, |v, _| change(v));
            window.draw(cx).clear(cx);
            cx.global::<InkProbes>().0.clone()
        })
    };
    paint(cx, &|_| {});
    let probes = paint(cx, &|v| {
        let controls = v.home_filter.as_mut().unwrap();
        controls.recovery_error = true;
        controls.machine_error = true;
    });
    let mut failures = Vec::new();
    let mut check =
        |probes: &std::collections::BTreeMap<String, Hsla>, key: &str, plate| match probes.get(key)
        {
            None => failures.push(format!("{key}: not painted")),
            Some(&text) if reads(text, plate) < 4.5 => {
                failures.push(format!("{key} is {:.2}:1", reads(text, plate)))
            }
            Some(_) => {}
        };
    check(&probes, "home-status", error);
    check(&probes, "home-recovery-error", bare);
    check(&probes, "home-machine-error", bare);
    let plates = plates_under_text(&theme, canvas);
    for key in HINT_KEYS {
        for &(plate, _) in &plates {
            check(&probes, key, plate);
        }
    }
    let probes = paint(cx, &|v| {
        v.browser_state.local_setup = None;
        v.browser_state.fleet = None;
        v.browser_state.home_phase = browser::HomePhase::Unavailable;
        v.browser_state.status = "The local daemon could not be reached.".into();
    });
    check(&probes, "home-status", warning);
    check(&probes, "home-guidance-warning", warning);
    let probes = paint(cx, &|v| v.browser_commands = None);
    check(&probes, "home-guidance-error", error);
    assert!(failures.is_empty(), "{failures:#?}");
}
