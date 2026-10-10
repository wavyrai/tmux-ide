use super::*;
use core::prelude::v1::test;

fn open(
    feedback: Option<PathBuf>,
    cx: &mut TestAppContext,
) -> (Entity<MockupWindow>, &mut VisualTestContext) {
    cx.update(|cx| cx.bind_keys(key_bindings()));
    let (view, cx) = cx.add_window_view(|window, cx| {
        MockupWindow::new(
            super::super::demo::mockup(),
            Setup {
                config: Config::default(),
                themes: super::super::themes(&Config::default(), None),
                theme: 0,
                feedback,
            },
            window,
            cx,
        )
    });
    cx.simulate_resize(size(px(1400.), px(900.)));
    draw(cx);
    (view, cx)
}

// Selectors are `&'static`; a test leaks the few it formats.
fn bounds(cx: &mut VisualTestContext, selector: String) -> Option<Bounds<Pixels>> {
    cx.debug_bounds(selector.leak())
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

#[test]
fn letters_and_widths() {
    assert_eq!((letter(0), letter(2), letter(25)), ('A', 'C', 'Z'));
    assert_eq!(letter(26), '?');
    assert_eq!(Width::Narrow.of(px(300.)), px(198.));
    assert_eq!(Width::Design.of(px(300.)), px(300.));
    assert_eq!(Width::Wide.of(px(300.)), px(450.));
}

#[gpui::test]
fn every_variant_is_framed_at_its_design_width(cx: &mut TestAppContext) {
    let (view, cx) = open(None, cx);
    let (count, frame) = view.read_with(cx, |view, _| (view.cards.len(), view.mockup.frame));
    assert!(count >= 3);
    let grid = cx.debug_bounds("mockup-grid").unwrap();
    for index in 0..count {
        let key = letter(index);
        let card = bounds(cx, format!("variant-{key}")).unwrap();
        let inner = bounds(cx, format!("frame-{key}")).unwrap();
        assert_eq!(inner.size.width, frame.width, "{key}");
        assert!(inner.size.height >= frame.height, "{key}");
        assert!(card.contains(&inner.origin), "{key}");
        assert!(
            card.left() >= grid.left() && card.top() >= grid.top(),
            "{key}"
        );
    }
    // Wider frames follow the width setting.
    view.update(cx, |view, cx| {
        view.width = Width::Wide;
        cx.notify();
    });
    draw(cx);
    assert_eq!(
        cx.debug_bounds("frame-A").unwrap().size.width,
        Width::Wide.of(frame.width)
    );
}

#[gpui::test]
fn number_keys_show_one_variant_and_zero_shows_all(cx: &mut TestAppContext) {
    let (view, cx) = open(None, cx);
    cx.simulate_keystrokes("2");
    draw(cx);
    view.read_with(cx, |view, _| assert_eq!(view.solo, Some(1)));
    assert!(cx.debug_bounds("variant-A").is_none());
    assert!(cx.debug_bounds("variant-B").is_some());
    // Past the last variant, or 0, is every variant again.
    cx.simulate_keystrokes("9");
    view.read_with(cx, |view, _| assert_eq!(view.solo, None));
    cx.simulate_keystrokes("3 0");
    draw(cx);
    view.read_with(cx, |view, _| assert_eq!(view.solo, None));
    assert!(cx.debug_bounds("variant-A").is_some());
    // While a note has focus, digits are text for it.
    view.update_in(cx, |view, window, cx| {
        let focus = view.cards[0].note.read(cx).focus.clone();
        window.focus(&focus, cx);
    });
    cx.simulate_input("2");
    cx.simulate_keystrokes("2");
    view.read_with(cx, |view, cx| {
        assert_eq!(view.solo, None);
        assert_eq!(view.cards[0].note.read(cx).text(), "22");
    });
    // Escape hands the keys back to the window.
    cx.simulate_keystrokes("escape 1");
    view.read_with(cx, |view, _| assert_eq!(view.solo, Some(0)));
}

#[gpui::test]
fn escape_preserves_composing_notes_and_leaves_committed_notes(cx: &mut TestAppContext) {
    let (view, cx) = open(None, cx);
    let notes = view.read_with(cx, |view, _| {
        [view.cards[0].note.clone(), view.overall.clone()]
    });
    for note in notes {
        note.update_in(cx, |note, window, cx| {
            window.focus(&note.focus, cx);
            note.replace_and_mark_text_in_range(None, "に", Some(1..1), window, cx);
            assert!(note.is_composing());
        });
        cx.simulate_keystrokes("escape");
        cx.update(|window, cx| {
            assert!(note.read(cx).focus.is_focused(window));
        });
        note.update_in(cx, |note, window, cx| {
            note.replace_text_in_range(None, "日本", window, cx);
            assert!(!note.is_composing());
        });
        cx.simulate_keystrokes("escape");
        cx.update(|window, cx| {
            assert!(view.read(cx).focus.is_focused(window));
            assert_eq!(note.read(cx).text(), "日本");
        });
    }
}

#[gpui::test]
fn theme_changes_reach_variants_and_notes(cx: &mut TestAppContext) {
    let (view, cx) = open(None, cx);
    let nord = Theme::builtin("Nord").unwrap();
    let index = view.read_with(cx, |view, _| {
        view.themes
            .iter()
            .position(|(name, _)| name == "Nord")
            .unwrap()
    });
    let button = bounds(cx, format!("mockup-theme-{index}")).unwrap();
    cx.simulate_click(button.center(), Modifiers::default());
    draw(cx);
    cx.update(|_, cx| {
        assert_eq!(cx.global::<Look>().theme, nord);
        assert_eq!(view.read(cx).look.theme, nord);
    });
}

#[gpui::test]
fn picks_and_notes_are_sent_to_the_feedback_file(cx: &mut TestAppContext) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("feedback.md");
    let (view, cx) = open(Some(path.clone()), cx);
    let pick = cx.debug_bounds("mockup-pick-B").unwrap();
    cx.simulate_click(pick.center(), Modifiers::default());
    view.update_in(cx, |view, window, cx| {
        assert!(view.cards[1].picked);
        let focus = view.cards[1].note.read(cx).focus.clone();
        window.focus(&focus, cx);
    });
    cx.simulate_input("tighter spacing");
    cx.simulate_keystrokes("cmd-enter");
    cx.run_until_parked();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("Picked: B\n"), "{text}");
    assert!(text.contains("[picked]: tighter spacing\n"), "{text}");
    assert!(text.contains("- A ("), "{text}");
    view.read_with(cx, |view, _| {
        assert!(!view.sending);
        assert!(view.status.starts_with("Sent to "), "{}", view.status);
    });
    // Sending again replaces the file with the current state.
    let send = cx.debug_bounds("mockup-send").unwrap();
    cx.simulate_click(pick.center(), Modifiers::default());
    cx.simulate_click(send.center(), Modifiers::default());
    cx.run_until_parked();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("Picked: none\n"), "{text}");
}

#[gpui::test]
fn view_variants_keep_their_state_across_theme_changes(cx: &mut TestAppContext) {
    let (view, cx) = open(None, cx);
    let views = view.read_with(cx, |view, _| {
        view.cards
            .iter()
            .filter_map(|card| card.view.as_ref().map(AnyView::entity_id))
            .collect::<Vec<_>>()
    });
    assert!(!views.is_empty(), "the demo shows a stateful variant");
    view.update(cx, |view, cx| view.set_theme(1, cx));
    draw(cx);
    view.read_with(cx, |view, _| {
        let after: Vec<_> = view
            .cards
            .iter()
            .filter_map(|card| card.view.as_ref().map(AnyView::entity_id))
            .collect();
        assert_eq!(after, views);
    });
}
