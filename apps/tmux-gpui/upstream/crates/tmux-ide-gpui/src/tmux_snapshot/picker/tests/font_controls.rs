use super::*;
#[test]
fn font_query_filters_before_cap_without_presentation_glyphs() {
    let mut settings = super::super::super::terminal_font::Settings::default();
    settings
        .names
        .extend((0..4096).map(|i| format!("Mono {i:04}")));
    settings.config.family = "Mono 4095".into();
    let rows = super::super::fonts::rows(&settings, "mono 4095");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].label, "Mono 4095");
    assert!(
        matches!(&rows[0].target, Target::Font(super::super::super::terminal_font::Choice::Family(name)) if name == "Mono 4095")
    );
    assert_eq!(super::super::fonts::rows(&settings, "").len(), 256);
}
#[gpui::test]
fn same_font_and_size_limit_do_not_save_or_invalidate_geometry(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.terminal_font.ready = true;
            view.terminal_font.names = vec![view.terminal_font.config.family.clone()];
            let revision = view.terminal_font.revision;
            view.painted_frame = view.frame.clone();
            let frame = view.painted_frame.clone().unwrap();
            view.choose_terminal_font(
                super::super::super::terminal_font::Choice::Family(
                    view.terminal_font.config.family.clone(),
                ),
                cx,
            );
            view.terminal_font.config.size = *crate::config::FONT_SIZE_RANGE.end();
            view.choose_terminal_font(super::super::super::terminal_font::Choice::Size(1), cx);
            assert!(!view.terminal_font.saving);
            assert!(view.terminal_font.note.is_none());
            assert_eq!(view.terminal_font.revision, revision);
            assert!((view.painted_frame.as_ref().unwrap()).same(&frame));
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn current_font_row_is_visible_but_pointer_cannot_queue_a_noop(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.terminal_font.ready = true;
            view.terminal_font.names = vec![view.terminal_font.config.family.clone()];
            view.open_picker_mode(Mode::Font, window, cx);
        });
        window.draw(cx).clear(cx);
    });
    let row = cx.debug_bounds("picker-row-2").unwrap();
    let list = cx.debug_bounds("picker-results").unwrap();
    assert!(row.top() >= list.top() && row.bottom() <= list.bottom());
    assert!(row.size.height >= px(crate::tmux_snapshot::controls::CONTROL_HEIGHT));
    cx.simulate_click(row.center(), Modifiers::default());
    view.read_with(cx, |view, _| {
        assert!(!view.terminal_font.saving);
        assert!(view.terminal_font.note.is_none());
        assert_eq!(view.terminal_font.revision, 0);
        assert!(view.picker.as_ref().is_some_and(|p| p.mode == Mode::Font));
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn opening_the_font_picker_lists_installed_fonts(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.terminal_font.ready, "listed before the picker opened");
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.open_picker_mode(Mode::Font, window, cx));
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(
            view.terminal_font.ready,
            "opening the font picker did not list installed fonts"
        );
    });
}
