//! Session terminal font sizing: the stepping and clamping rules, the baseline
//! Reset restores, and the cell geometry a size change is supposed to move.

#![allow(clippy::unwrap_used)]

use super::HerdrWindow;
use crate::{
    config::{FONT_SIZE_RANGE, FONT_SIZE_STEP},
    controls::Command,
    sidebar::layout_tests::fixture_window,
};
use gpui::{TestAppContext, px, size};

fn run(view: &gpui::Entity<HerdrWindow>, command: Command, cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| view.update(cx, |view, cx| view.command(command, window, cx)));
}

#[gpui::test]
fn stepping_moves_the_size_and_its_line_height(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    let start = view.read_with(cx, |view, _| view.config.terminal.size);

    run(&view, Command::IncreaseFontSize, cx);
    view.read_with(cx, |view, _| {
        assert_eq!(view.config.terminal.size, start + FONT_SIZE_STEP);
        // The cell grid is derived from the size, so it moves with the glyphs.
        assert_eq!(
            view.config.terminal.line_height(),
            (start + FONT_SIZE_STEP) * 20.0 / 14.0
        );
    });

    run(&view, Command::DecreaseFontSize, cx);
    run(&view, Command::DecreaseFontSize, cx);
    view.read_with(cx, |view, _| {
        assert_eq!(view.config.terminal.size, start - FONT_SIZE_STEP);
    });
}

/// Reset restores the size the loaded config asked for, which for a fresh
/// window is the size it started with. [`crate::menu`] covers the baseline
/// moving with a reload.
#[gpui::test]
fn reset_returns_to_the_configured_size(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    let start = view.read_with(cx, |view, _| view.config.terminal.size);
    run(&view, Command::IncreaseFontSize, cx);
    run(&view, Command::IncreaseFontSize, cx);
    run(&view, Command::ResetFontSize, cx);
    view.read_with(cx, |view, _| {
        assert_eq!(view.config.terminal.size, start);
        assert_eq!(view.configured_terminal_size, start);
    });
}

#[gpui::test]
fn stepping_clamps_to_the_configured_range(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    let (&low, &high) = (FONT_SIZE_RANGE.start(), FONT_SIZE_RANGE.end());
    // Enough steps to overshoot either end from any size the range allows.
    let steps = ((high - low) / FONT_SIZE_STEP) as usize + 4;

    for _ in 0..steps {
        run(&view, Command::IncreaseFontSize, cx);
    }
    view.read_with(cx, |view, _| {
        assert_eq!(view.config.terminal.size, high);
        assert!(view.config.terminal.line_height().is_finite());
    });

    for _ in 0..steps {
        run(&view, Command::DecreaseFontSize, cx);
    }
    view.read_with(cx, |view, _| {
        assert_eq!(view.config.terminal.size, low);
        assert!(view.config.terminal.line_height().is_finite());
    });
}

/// The daemon is told how many rows and cells of what size the window holds, so
/// a font change has to reach `options` or the shell keeps its old grid.
#[gpui::test]
fn a_size_change_recomputes_the_surface_geometry(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.run_until_parked();
    let before = view.read_with(cx, |view, _| view.options);
    assert!(before.cell_height_px > 0 && before.surface_size.rows > 0);

    for _ in 0..4 {
        run(&view, Command::IncreaseFontSize, cx);
    }
    cx.run_until_parked();
    let after = view.read_with(cx, |view, _| view.options);
    assert!(
        after.cell_height_px > before.cell_height_px,
        "{before:?} -> {after:?}"
    );
    assert!(
        after.surface_size.rows < before.surface_size.rows,
        "taller cells must fit fewer rows: {before:?} -> {after:?}"
    );

    run(&view, Command::ResetFontSize, cx);
    cx.run_until_parked();
    view.read_with(cx, |view, _| assert_eq!(view.options, before));
}

/// The keymap is the main way these commands get used, and `cmd--` and `cmd-+`
/// are the two whose strings the keystroke parser treats specially.
#[gpui::test]
fn the_bound_keystrokes_reach_the_commands(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        fixture_window(window, cx)
    });
    cx.update(|window, cx| {
        // Actions dispatch along the focus path, as they do for a live window.
        view.update(cx, |view, cx| window.focus(&view.focus, cx));
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
    let start = view.read_with(cx, |view, _| view.config.terminal.size);

    for (keystrokes, expected) in [
        ("cmd-=", start + FONT_SIZE_STEP),
        ("cmd--", start),
        // `+` arrives as its own key with the shift dropped, not as shift-`=`.
        ("cmd-+", start + FONT_SIZE_STEP),
        ("cmd-0", start),
    ] {
        cx.simulate_keystrokes(keystrokes);
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            assert_eq!(view.config.terminal.size, expected, "{keystrokes}");
        });
    }
}
