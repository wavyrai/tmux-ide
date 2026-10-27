use super::*;

/// A link is a destination for a click and text for a drag: the same
/// press must be able to become either one.
#[gpui::test]
fn dragging_across_a_link_copies_it_instead_of_opening_it(cx: &mut TestAppContext) {
    let url = "https://example.com/x";
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut frame = surface(&[url], 24);
        let snapshot = view.live.snapshot.as_ref().unwrap();
        frame.boot_id = snapshot.boot_id.clone();
        frame.projection_revision = snapshot.revision;
        view.live.surface = Some(Arc::new(frame));
        view
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let (origin, width) = view.read_with(cx, |view, _| (view.bounds.origin, view.cell_width));
    let at = |column: f32| origin + point(px(column * width), px(10.));

    cx.simulate_mouse_down(at(0.), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(at(20.6), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(at(20.6), MouseButton::Left, Modifiers::default());
    assert!(cx.opened_url().is_none());
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some(url.into())
    );

    // The press that never left its half-cell is still the click that opens
    // the link, and it copies nothing.
    cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("kept".into())));
    cx.simulate_click(at(1.), Modifiers::default());
    assert_eq!(cx.opened_url().as_deref(), Some(url));
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("kept".into())
    );
}

#[gpui::test]
fn application_mouse_takes_precedence_and_shift_keeps_copy_and_links(cx: &mut TestAppContext) {
    let url = "https://example.com/x";
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut frame = surface(&[url], 24);
        let snapshot = view.live.snapshot.as_ref().unwrap();
        frame.boot_id = snapshot.boot_id.clone();
        frame.projection_revision = snapshot.revision;
        frame.panes[0].mouse_reporting = true;
        view.live.surface = Some(Arc::new(frame));
        view
    });
    cx.update(|window, cx| {
        cx.write_to_clipboard(ClipboardItem::new_string("kept".into()));
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let (origin, width) = view.read_with(cx, |view, _| (view.bounds.origin, view.cell_width));
    let at = |column: f32| origin + point(px(column * width), px(10.));
    cx.simulate_mouse_down(at(0.), MouseButton::Left, Modifiers::default());
    view.read_with(cx, |view, _| {
        assert!(view.selection.is_none());
        assert!(view.pressed_terminal_link.is_none());
    });
    cx.simulate_mouse_move(at(20.6), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(at(20.6), MouseButton::Left, Modifiers::default());
    cx.simulate_click(at(1.), Modifiers::default());
    assert!(cx.opened_url().is_none());
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("kept".into())
    );
    cx.simulate_mouse_down(at(1.), MouseButton::Right, Modifiers::default());
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
    cx.simulate_mouse_up(at(1.), MouseButton::Right, Modifiers::default());

    let shift = Modifiers {
        shift: true,
        ..Default::default()
    };
    cx.simulate_mouse_down(at(0.), MouseButton::Left, shift);
    assert!(view.read_with(cx, |view, _| view.selection.is_some()));
    cx.simulate_mouse_move(at(20.6), MouseButton::Left, shift);
    cx.simulate_mouse_up(at(20.6), MouseButton::Left, shift);
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some(url.into())
    );
    assert!(cx.opened_url().is_none());
    cx.simulate_click(at(1.), shift);
    assert_eq!(cx.opened_url().as_deref(), Some(url));
}

#[gpui::test]
fn external_file_drag_cancels_local_selection_without_copying(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut frame = surface(&["hello there"], 12);
        let snapshot = view.live.snapshot.as_ref().unwrap();
        frame.boot_id = snapshot.boot_id.clone();
        frame.projection_revision = snapshot.revision;
        view.live.surface = Some(Arc::new(frame));
        view
    });
    cx.update(|window, cx| {
        cx.write_to_clipboard(ClipboardItem::new_string("kept".into()));
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let (origin, width) = view.read_with(cx, |view, _| (view.bounds.origin, view.cell_width));
    let at = |column: f32| origin + point(px(column * width), px(10.));
    cx.simulate_mouse_down(at(0.), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(at(5.), MouseButton::Left, Modifiers::default());
    assert!(view.read_with(cx, |view, _| view.selection.is_some()));
    cx.simulate_event(gpui::FileDropEvent::Entered {
        position: at(5.),
        paths: gpui::ExternalPaths::default(),
    });
    assert!(view.read_with(cx, |view, _| view.selection.is_none()));
    cx.simulate_event(gpui::FileDropEvent::Submit { position: at(5.) });
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("kept".into())
    );
}

/// A menu page holds the whole gesture: nothing is selected, copied, or
/// reported while one is up.
#[gpui::test]
fn a_menu_page_holds_the_gesture(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut frame = surface(&["copied text"], 12);
        let snapshot = view.live.snapshot.as_ref().unwrap();
        frame.boot_id = snapshot.boot_id.clone();
        frame.projection_revision = snapshot.revision;
        view.live.surface = Some(Arc::new(frame));
        view
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let (origin, cell) = view.read_with(cx, |view, _| {
        (
            view.bounds.origin,
            (view.cell_width, view.config.terminal.line_height()),
        )
    });
    let at = |column: f32| origin + point(px(column * cell.0), px(0.5 * cell.1));

    cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("kept".into())));
    view.update(cx, |view, cx| {
        view.menu.page = Some(crate::menu::Page::Menu);
        view.begin_selection(at(0.), 1, cx);
        assert!(view.selection.is_none());
        assert!(!view.extend_selection(at(6.), cx));
        assert!(!view.release_selection(cx));
        assert!(view.flash.is_none());
        view.menu.page = None;
    });
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("kept".into())
    );

    // The same drag with the menu gone copies and reports.
    cx.simulate_mouse_down(at(0.), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(at(6.), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(at(6.), MouseButton::Left, Modifiers::default());
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("copied".into())
    );
    view.read_with(cx, |view, _| assert!(view.flash.is_some()));
}
