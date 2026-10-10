use super::*;

/// A drag across the painted cells copies what it covered when the button
/// comes up, keeps it highlighted, and says so; a press alone leaves the
/// clipboard alone and clears the highlight.
#[gpui::test]
fn dragging_copies_on_release_keeps_the_highlight_and_reports(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut frame = surface(&["hello there", "second row"], 12);
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
    let at = |column: f32, row: f32| -> Point<Pixels> {
        origin + point(px(column * cell.0), px(row * cell.1))
    };

    cx.simulate_mouse_down(at(0., 0.), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(at(5., 0.), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(at(5., 0.), MouseButton::Left, Modifiers::default());
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("hello".into())
    );
    let expires = view.read_with(cx, |view, _| {
        assert!(view.selection_retained(), "the release keeps the highlight");
        view.flash.clone().expect("the release reports the copy").1
    });
    assert!(cx.update(|_, _| expires) > Instant::now());
    assert!(cx.debug_bounds("flash").is_some());

    // A drag over two rows keeps the rows apart and drops the padding the
    // terminal added to the row it carried through to the edge.
    cx.simulate_mouse_down(at(6., 0.), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(at(6., 1.), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(at(6., 1.), MouseButton::Left, Modifiers::default());
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("there\nsecond".into())
    );

    // A press with no drag selects nothing, so neither the clipboard nor
    // the flash reports one.
    view.update(cx, |view, _| view.flash = None);
    cx.simulate_click(at(2., 0.), Modifiers::default());
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("there\nsecond".into())
    );
    view.read_with(cx, |view, _| {
        assert!(view.selection.is_none());
        assert!(view.flash.is_none());
    });

    // The flash retires on its own once its two seconds are up. Whether it
    // is still painted is state, not layout: gpui keeps every debug bound
    // a frame ever registered, so a removed element still has one.
    cx.simulate_mouse_down(at(0., 0.), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(at(5., 0.), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(at(5., 0.), MouseButton::Left, Modifiers::default());
    view.update(cx, |view, _| {
        let (flash, expires) = view.flash.clone().expect("a copy reports itself");
        assert_eq!(flash, crate::window::Flash::success("copied to clipboard"));
        assert!(!view.tick_flash(expires - Duration::from_nanos(1)));
        assert!(view.flash.is_some());
        assert!(view.tick_flash(expires));
        assert!(view.flash.is_none());
        assert!(!view.tick_flash(expires));
    });
}

/// With Herdr's `copy_on_select` off, a release keeps the highlight and
/// leaves the clipboard alone until Cmd-C or Ctrl-C, as in Herdr's TUI;
/// any other key drops it. The copy keeps the highlight too.
#[gpui::test]
fn without_copy_on_select_a_release_keeps_the_selection_for_an_explicit_copy(
    cx: &mut TestAppContext,
) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut frame = surface(&["hello there", "second row"], 12);
        let snapshot = view.live.snapshot.as_ref().unwrap();
        frame.boot_id = snapshot.boot_id.clone();
        frame.projection_revision = snapshot.revision;
        view.live.surface = Some(Arc::new(frame));
        view.settings.shared = Some(
            crate::herdr_settings::Settings::parse_text("[ui]\ncopy_on_select = false").unwrap(),
        );
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
    let at = |column: f32, row: f32| -> Point<Pixels> {
        origin + point(px(column * cell.0), px(row * cell.1))
    };
    let clipboard = |cx: &mut gpui::VisualTestContext| {
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()))
    };
    let select = |cx: &mut gpui::VisualTestContext| {
        cx.simulate_mouse_down(at(0., 0.), MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_move(at(5., 0.), MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_up(at(5., 0.), MouseButton::Left, Modifiers::default());
    };
    let copy_available = |cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
            window.is_action_available(&crate::actions::Copy, cx)
        })
    };
    cx.write_to_clipboard(ClipboardItem::new_string("before".into()));

    select(cx);
    assert_eq!(clipboard(cx).as_deref(), Some("before"));
    view.read_with(cx, |view, _| {
        assert!(view.selection_retained());
        assert!(view.flash.is_none());
    });
    assert!(copy_available(cx));

    // Another key drops the highlight without copying.
    cx.simulate_keystrokes("x");
    view.read_with(cx, |view, _| assert!(view.selection.is_none()));
    assert_eq!(clipboard(cx).as_deref(), Some("before"));
    assert!(!copy_available(cx));

    for keystroke in ["cmd-c", "ctrl-c"] {
        cx.write_to_clipboard(ClipboardItem::new_string("before".into()));
        select(cx);
        cx.simulate_keystrokes(keystroke);
        assert_eq!(clipboard(cx).as_deref(), Some("hello"), "{keystroke}");
        view.read_with(cx, |view, _| {
            assert!(view.selection_retained(), "{keystroke}");
            assert!(view.flash.is_some(), "{keystroke}");
        });
    }

    // The Edit menu's Copy takes a kept selection too.
    cx.write_to_clipboard(ClipboardItem::new_string("before".into()));
    select(cx);
    cx.update(|window, cx| window.dispatch_action(Box::new(crate::actions::Copy), cx));
    assert_eq!(clipboard(cx).as_deref(), Some("hello"));
    view.read_with(cx, |view, _| assert!(view.selection_retained()));

    // A press with no drag keeps nothing.
    cx.simulate_click(at(2., 0.), Modifiers::default());
    view.read_with(cx, |view, _| assert!(view.selection.is_none()));
}

/// A selection the release copied stays for Cmd-C and the Edit menu,
/// while Ctrl-C still reaches the pane and drops it, as any other key or
/// click does. With `keep_selection_after_copy` off, the release clears it.
#[gpui::test]
fn a_copied_selection_stays_until_the_next_key_or_click(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut frame = surface(&["hello there", "second row"], 12);
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
    let at = |column: f32, row: f32| -> Point<Pixels> {
        origin + point(px(column * cell.0), px(row * cell.1))
    };
    let clipboard = |cx: &mut gpui::VisualTestContext| {
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()))
    };
    let select = |cx: &mut gpui::VisualTestContext| {
        cx.simulate_mouse_down(at(0., 0.), MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_move(at(5., 0.), MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_up(at(5., 0.), MouseButton::Left, Modifiers::default());
    };
    let retained =
        |cx: &mut gpui::VisualTestContext| view.read_with(cx, |view, _| view.selection_retained());

    select(cx);
    assert_eq!(clipboard(cx).as_deref(), Some("hello"));
    assert!(retained(cx));
    for copy in ["cmd-c", "edit"] {
        cx.write_to_clipboard(ClipboardItem::new_string("before".into()));
        if copy == "edit" {
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
                assert!(window.is_action_available(&crate::actions::Copy, cx));
                window.dispatch_action(Box::new(crate::actions::Copy), cx);
            });
        } else {
            cx.simulate_keystrokes(copy);
        }
        assert_eq!(clipboard(cx).as_deref(), Some("hello"), "{copy}");
        assert!(retained(cx), "{copy}");
    }

    // Ctrl-C belongs to the pane once the release has copied.
    cx.write_to_clipboard(ClipboardItem::new_string("before".into()));
    cx.simulate_keystrokes("ctrl-c");
    assert_eq!(clipboard(cx).as_deref(), Some("before"));
    assert!(!retained(cx));

    select(cx);
    cx.simulate_click(at(8., 1.), Modifiers::default());
    assert!(!retained(cx));

    view.update(cx, |view, _| view.config.keep_selection_after_copy = false);
    select(cx);
    assert_eq!(clipboard(cx).as_deref(), Some("hello"));
    view.read_with(cx, |view, _| assert!(view.selection.is_none()));
}

#[gpui::test]
fn chinese_mouse_selection_copies_exact_text_only_on_release(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        // Daemon-style wide cells: ordinary blank continuations, skip=false.
        let mut frame = surface(&["你 好 世 界 ", "A你  B"], 12);
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
    let (origin, width, height) = view.read_with(cx, |view, _| {
        (
            view.bounds.origin,
            view.cell_width,
            view.config.terminal.line_height(),
        )
    });
    let at = |column: f32, row: f32| origin + point(px(column * width), px((row + 0.5) * height));
    for (from, to, row, expected) in [
        (0.1, 7.9, 0., "你好世界"),
        (7.9, 0.1, 0., "你好世界"),
        (0.1, 8.9, 0., "你好世界 "),
        (0.1, 4.9, 1., "A你 B"),
    ] {
        cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("before".into())));
        cx.simulate_mouse_down(at(from, row), MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_move(at(to, row), MouseButton::Left, Modifiers::default());
        assert_eq!(
            cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
            Some("before".into())
        );
        cx.simulate_mouse_up(at(to, row), MouseButton::Left, Modifiers::default());
        assert_eq!(
            cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
            Some(expected.into())
        );
        assert!(view.read_with(cx, |view, _| view.selection_retained()));
    }
}

/// The flash obeys the resolved clipboard-toast settings: turned off, a
/// copy still happens silently, and each position puts it where it says.
#[gpui::test]
fn the_flash_follows_the_clipboard_toast_configuration(cx: &mut TestAppContext) {
    use crate::config::ClipboardToastPosition::*;
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut frame = surface(&["configured"], 12);
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
    let drag = |view: &gpui::Entity<HerdrWindow>, cx: &mut gpui::VisualTestContext| {
        cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("stale".into())));
        cx.simulate_mouse_down(at(0.), MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_move(at(10.), MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_up(at(10.), MouseButton::Left, Modifiers::default());
        view.read_with(cx, |view, _| view.flash.is_some())
    };

    view.update(cx, |view, _| view.config.clipboard_toast.enabled = false);
    assert!(!drag(&view, cx), "a silent copy is still a copy");
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("configured".into())
    );

    // Each corner lands where it says, measured against the terminal area.
    view.update(cx, |view, _| view.config.clipboard_toast.enabled = true);
    let bounds = view.read_with(cx, |view, _| view.bounds);
    let mut seen = Vec::new();
    for position in [
        TopLeft,
        TopCenter,
        TopRight,
        BottomLeft,
        BottomCenter,
        BottomRight,
    ] {
        view.update(cx, |view, _| {
            view.config.clipboard_toast.position = position
        });
        assert!(drag(&view, cx));
        let flash = cx.debug_bounds("flash").expect("the flash paints");
        let top = matches!(position, TopLeft | TopCenter | TopRight);
        assert_eq!(
            flash.origin.y - bounds.origin.y < bounds.size.height / 2.,
            top,
            "{position:?}"
        );
        let left = flash.origin.x - bounds.origin.x;
        let right = bounds.size.width - (left + flash.size.width);
        match position {
            TopLeft | BottomLeft => assert!(left < right, "{position:?}"),
            TopRight | BottomRight => assert!(right < left, "{position:?}"),
            TopCenter | BottomCenter => {
                assert!((left - right).abs() <= px(1.), "{position:?}")
            }
        }
        assert!(
            !seen.contains(&(flash.origin.x, flash.origin.y)),
            "{position:?}"
        );
        seen.push((flash.origin.x, flash.origin.y));
    }
}
