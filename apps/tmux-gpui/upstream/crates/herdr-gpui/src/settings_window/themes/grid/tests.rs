use super::*;
use core::prelude::v1::test;

#[gpui::test]
fn scheduled_palettes_load_without_a_display_frame(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(super::super::tests::fixture);
    view.update(cx, |view, cx| {
        view.themes.names = vec!["Nord".into(), "Dracula".into()];
        view.themes.herdr_enabled = false;
        view.themes.filter(None);
        view.themes.grid.running = false;
        view.schedule_grid_palettes(0..1, cx);
        assert!(view.themes.grid.queued);
        assert!(!view.themes.grid.running);
    });
    // Process deferred UI work and the worker, but deliver no display frame.
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.themes.grid.queued);
        assert!(!view.themes.grid.running);
        assert_eq!(view.themes.grid.palettes.len(), 2);
        assert!(
            view.themes
                .grid
                .palettes
                .iter()
                .all(|(_, theme)| theme.is_some())
        );
    });
}

#[gpui::test]
fn palettes_are_per_theme_and_contrast_is_applied_once(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(super::super::tests::fixture);
    view.update(cx, |view, cx| {
        view.themes.names = vec!["Nord".into(), "Dracula".into()];
        view.themes.herdr_enabled = false;
        view.themes.filter(None);
        view.config.contrast = Contrast::High;
        view.themes.grid.running = false;
        view.themes.grid.visible = 0..2;
        view.load_grid_palettes(cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let palettes = &view.themes.grid.palettes;
        assert_eq!(palettes.len(), 2);
        assert_eq!(
            palettes[0].1,
            Theme::builtin("Dracula").map(|theme| theme.with_contrast(Contrast::High))
        );
        assert_eq!(
            palettes[1].1,
            Theme::builtin("Nord").map(|theme| theme.with_contrast(Contrast::High))
        );
        assert_ne!(palettes[0].1, palettes[1].1);
        assert!(!view.theme_dirty());
    });
}

#[gpui::test]
fn identical_names_in_different_sources_keep_distinct_palettes(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(super::super::tests::fixture);
    view.update(cx, |view, cx| {
        view.shared =
            herdr_settings::Settings::parse_text("[theme.custom]\naccent='#123456'\n").ok();
        view.themes.filtered = [Scope::App, Scope::Herdr]
            .map(|scope| Choice {
                scope,
                name: "Nord".into(),
            })
            .to_vec();
        view.themes.grid.running = false;
        view.themes.grid.visible = 0..2;
        view.load_grid_palettes(cx);
    });
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        let palettes = &view.themes.grid.palettes;
        assert_eq!(palettes.len(), 2);
        assert_eq!(palettes[0].0.name, palettes[1].0.name);
        assert_eq!(palettes[0].0.scope, Scope::App);
        assert_eq!(palettes[1].0.scope, Scope::Herdr);
        assert_eq!(palettes[0].1, Theme::builtin("Nord"));
        assert_eq!(palettes[1].1.as_ref().map(Theme::primary), Some(0x123456));
        assert_ne!(palettes[0].1, palettes[1].1);
        view.load_grid_palettes(cx);
        assert!(!view.themes.grid.running);
    });
}

#[gpui::test]
fn shared_palette_uses_prepared_overrides_and_read_only_does_not_dirty(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(super::super::tests::fixture);
    view.update(cx, |view, cx| {
        view.shared =
            herdr_settings::Settings::parse_text("[theme.custom]\naccent='#123456'\n").ok();
        view.themes.ghostty_enabled = false;
        view.themes.query = "nord".into();
        view.themes.filter(None);
        view.themes.grid.running = false;
        view.themes.grid.visible = 0..1;
        view.load_grid_palettes(cx);
        if !Scope::Herdr.editable() {
            view.select_settings_theme(0, cx);
            assert!(!view.theme_dirty());
        }
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.themes.grid.palettes[0].1.as_ref().map(Theme::primary),
            Some(0x123456)
        );
        assert!(!view.theme_dirty());
    });
}
#[test]
fn geometry_navigation_and_stale_results() {
    assert_eq!(columns(680. - 240.), 2);
    assert_eq!(columns(960. - 240.), 4);
    assert_eq!(navigate(5, 400, 4, false), 9);
    assert_eq!(navigate(5, 400, 4, true), 1);
    assert_eq!(navigate(398, 400, 4, false), 399);
    let mut grid = Grid::default();
    grid.invalidate();
    grid.finish(
        0,
        vec![(
            Choice {
                scope: Scope::App,
                name: "old".into(),
            },
            Some(Theme::default()),
        )],
    );
    assert!(grid.palettes.is_empty());
    for i in 0..400 {
        grid.finish(
            1,
            vec![(
                Choice {
                    scope: Scope::App,
                    name: i.to_string(),
                },
                None,
            )],
        );
    }
    assert_eq!(grid.palettes.len(), CACHE_LIMIT);
}
