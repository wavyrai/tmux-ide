use super::*;
use gpui::TestAppContext;
#[gpui::test]
fn bounded_input_refuses_oversized_replacements_without_changing_marked_selection(
    cx: &mut TestAppContext,
) {
    let (input, cx) = cx.add_window_view(|_, cx| SearchInput::new(cx).with_max_bytes(8));
    cx.update(|window, cx| {
        input.update(cx, |input, cx| {
            input.replace_and_mark_text_in_range(None, "界😀", Some(1..3), window, cx);
            let before = (
                input.edit.text.clone(),
                input.edit.anchor,
                input.edit.cursor,
                input.edit.marked.clone(),
            );
            for composing in [false, true] {
                if composing {
                    input.replace_and_mark_text_in_range(
                        None,
                        &"z".repeat(10000),
                        Some(0..1),
                        window,
                        cx,
                    );
                } else {
                    input.replace_text_in_range(None, &"z".repeat(10000), window, cx);
                }
                assert_eq!(
                    (
                        input.edit.text.clone(),
                        input.edit.anchor,
                        input.edit.cursor,
                        input.edit.marked.clone()
                    ),
                    before
                );
            }
            input.replace_text_in_range(None, "12345678", window, cx);
            assert_eq!(input.text(), "12345678");
            input.replace_text_in_range(None, "x", window, cx);
            assert_eq!(input.text(), "12345678");
        })
    });
}
#[gpui::test]
fn default_input_remains_unbounded(cx: &mut TestAppContext) {
    let (input, cx) = cx.add_window_view(|_, cx| SearchInput::new(cx));
    cx.update(|window, cx| {
        input.update(cx, |input, cx| {
            input.replace_text_in_range(None, &"x".repeat(2048), window, cx);
            assert_eq!(input.text().len(), 2048);
        })
    });
}
