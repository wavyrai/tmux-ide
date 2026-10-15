#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;

#[path = "controls_tests/accessibility.rs"]
mod accessibility;

struct Controls;
impl Render for Controls {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::default();
        div()
            .flex()
            .items_start()
            .child(button("icon-only", None, "Refresh", Icon::Refresh, &theme))
            .child(button(
                "labelled",
                Some("Switch"),
                "Switch session",
                Icon::Sessions,
                &theme,
            ))
            .child(
                tab("inactive", "Home", Icon::Home, false, &theme)
                    .debug_selector(|| "inactive".into()),
            )
            .child(
                tab("selected", "Home", Icon::Home, true, &theme)
                    .debug_selector(|| "selected".into()),
            )
    }
}

#[gpui::test]
fn compact_controls_share_height_and_selection_does_not_reflow_tabs(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Controls);
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    let icon = cx.debug_bounds("icon-only").unwrap();
    let labelled = cx.debug_bounds("labelled").unwrap();
    let inactive = cx.debug_bounds("inactive").unwrap();
    let selected = cx.debug_bounds("selected").unwrap();
    assert_eq!(icon.size, size(px(32.), px(32.)));
    assert_eq!(labelled.size.height, icon.size.height);
    assert_eq!(inactive.size.height, icon.size.height);
    assert_eq!(selected.size.height, icon.size.height);
    assert_eq!(selected.size.width, inactive.size.width);
    assert_eq!(labelled.left(), icon.right());
    assert_eq!(inactive.left(), labelled.right());
    assert_eq!(selected.left(), inactive.right());
}

#[path = "controls_tests/unavailable.rs"]
mod unavailable;
