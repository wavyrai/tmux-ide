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
    }
}

#[gpui::test]
fn compact_controls_share_height(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Controls);
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    let icon = cx.debug_bounds("icon-only").unwrap();
    let labelled = cx.debug_bounds("labelled").unwrap();
    assert_eq!(icon.size, size(px(32.), px(32.)));
    assert_eq!(labelled.size.height, icon.size.height);
    assert_eq!(labelled.left(), icon.right());
}

#[path = "controls_tests/unavailable.rs"]
mod unavailable;

#[test]
fn separator_is_bezels_faint_hairline_and_its_strong_one_in_high_contrast() {
    let normal = Theme::default();
    let high = Theme {
        contrast: crate::contrast::Contrast::High,
        ..Theme::default()
    };
    assert_eq!(
        separator(&normal),
        crate::tmux_snapshot::design::palette(&normal).border_faint
    );
    assert_eq!(
        separator(&high),
        crate::tmux_snapshot::design::palette(&high).border_strong
    );
    assert_ne!(separator(&normal), separator(&high));
}
