use super::*;

#[gpui::test]
fn retained_handler_preserves_search_composition_and_releases_its_view(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(fixture_window);
    let view = cx.new(SearchInput::new);
    let weak = view.downgrade();
    let bounds = Bounds::new(point(px(10.), px(20.)), size(px(200.), px(30.)));
    let mut handler = WeakInputHandler::new(bounds, view.clone());
    cx.update(|window, cx| {
        handler.replace_text_in_range(None, "a😀z", window, cx);
        handler.replace_and_mark_text_in_range(Some(1..3), "日本", Some(0..1), window, cx);
        assert_eq!(handler.marked_text_range(window, cx), Some(1..3));
        assert_eq!(
            handler
                .selected_text_range(false, window, cx)
                .unwrap()
                .range,
            1..2
        );
        let mut adjusted = None;
        assert_eq!(
            handler
                .text_for_range(0..4, &mut adjusted, window, cx)
                .as_deref(),
            Some("a日本z")
        );
        assert_eq!(adjusted, Some(0..4));
        handler.replace_text_in_range(None, "語", window, cx);
        assert_eq!(handler.marked_text_range(window, cx), None);
        handler.paste(ClipboardItem::new_string("é".into()), window, cx);
        assert_eq!(view.read(cx).text(), "a語éz");
        assert_eq!(handler.element_bounds(window, cx), Some(bounds));
        assert!(handler.accepts_text_input(window, cx));
        handler.replace_and_mark_text_in_range(None, "中", None, window, cx);
        handler.unmark_text(window, cx);
        assert_eq!(handler.marked_text_range(window, cx), None);
    });
    drop(view);
    cx.run_until_parked();
    assert!(
        weak.upgrade().is_none(),
        "retained input handler must not own the view"
    );
    cx.update(|window, cx| {
        assert!(handler.selected_text_range(false, window, cx).is_none());
        assert_eq!(handler.marked_text_range(window, cx), None);
        assert_eq!(handler.text_for_range(0..1, &mut None, window, cx), None);
        assert_eq!(handler.bounds_for_range(0..1, window, cx), None);
        assert_eq!(
            handler.character_index_for_point(point(px(0.), px(0.)), window, cx),
            None
        );
        assert_eq!(handler.element_bounds(window, cx), None);
        assert_eq!(handler.text_length_utf16(window, cx), None);
        assert_eq!(handler.text_input_editable_range(window, cx), None);
        assert!(!handler.accepts_text_input(window, cx));
        assert!(!handler.prefers_ime_for_printable_keys(window, cx));
        assert_eq!(
            handler.text_input_configuration(window, cx),
            TextInputConfiguration::default()
        );
        handler.replace_text_in_range(None, "late", window, cx);
        handler.replace_and_mark_text_in_range(None, "late", None, window, cx);
        handler.unmark_text(window, cx);
        handler.paste(ClipboardItem::new_string("late".into()), window, cx);
        handler.set_selected_text_range(0..1, window, cx);
    });
}

#[gpui::test]
fn terminal_and_dialog_handlers_do_not_keep_herdr_window_alive(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(fixture_window);
    let view = cx.update(|window, cx| cx.new(|cx| fixture_window(window, cx)));
    let weak = view.downgrade();
    let mut terminal = TerminalInputHandler::new(Bounds::default(), view.clone(), false);
    let mut dialog = WeakInputHandler::new(Bounds::default(), view.clone());
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.menu.page = Some(crate::menu::Page::RenameTab);
            view.menu.input = Some(crate::dialog_input::DialogInput::new("old".into()));
        });
        dialog.replace_and_mark_text_in_range(None, "日本", Some(0..1), window, cx);
        assert_eq!(dialog.marked_text_range(window, cx), Some(0..2));
        dialog.replace_text_in_range(None, "語", window, cx);
        assert_eq!(view.read(cx).menu.input.as_ref().unwrap().text, "語");
        view.update(cx, |view, _| {
            view.menu.page = None;
            view.marked = "日本".into();
        });
        assert_eq!(terminal.marked_text_range(window, cx), Some(0..2));
        assert_eq!(
            terminal
                .selected_text_range(false, window, cx)
                .unwrap()
                .range,
            2..2
        );
        terminal.unmark_text(window, cx);
        assert_eq!(terminal.marked_text_range(window, cx), None);
        assert!(!terminal.apple_press_and_hold_enabled());
    });
    drop(view);
    cx.run_until_parked();
    assert!(weak.upgrade().is_none());
    cx.update(|window, cx| {
        assert_eq!(terminal.marked_text_range(window, cx), None);
        assert_eq!(dialog.marked_text_range(window, cx), None);
        terminal.replace_text_in_range(None, "late", window, cx);
        dialog.replace_text_in_range(None, "late", window, cx);
    });
}
