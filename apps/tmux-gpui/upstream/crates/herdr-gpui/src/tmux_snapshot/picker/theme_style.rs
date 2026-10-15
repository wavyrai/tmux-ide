//! Theme picker presentation; selection and persistence remain bridge-owned.
use super::*;

pub(super) fn heading(view: &SnapshotView) -> AnyElement {
    let theme = view.theme();
    let appearance = view.browser_state.appearance.as_ref();
    let name = appearance
        .and_then(|a| a.options.iter().find(|o| o.id == a.selected))
        .map_or("Current theme", |o| o.name.as_str());
    let mode = appearance
        .filter(|a| a.selected == "system")
        .map_or("", |a| match a.system {
            super::super::appearance::System::Dark => " · dark",
            super::super::appearance::System::Light => " · light",
        });
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap_3()
        .pb_2()
        .child(
            div()
                .min_w_0()
                .flex()
                .flex_col()
                .gap_1()
                .child(div().font_weight(FontWeight::SEMIBOLD).child("Appearance"))
                .child(
                    div()
                        .text_sm()
                        .text_color(rgb(theme.muted))
                        .truncate()
                        .child(format!("Applied · {name}{mode}")),
                ),
        )
        .child(
            div().flex().gap_1().flex_shrink_0().children(
                [
                    theme.background,
                    theme.foreground,
                    theme.palette[1],
                    theme.palette[2],
                    theme.palette[4],
                ]
                .into_iter()
                .map(|color| {
                    div()
                        .size(px(12.))
                        .rounded(px(3.))
                        .border_1()
                        .border_color(rgb(theme.muted))
                        .bg(rgb(color))
                }),
            ),
        )
        .into_any_element()
}

pub(super) fn row(
    view: &SnapshotView,
    index: usize,
    row: &Row,
    enabled: bool,
    cx: &mut Context<SnapshotView>,
) -> AnyElement {
    let theme = view.theme();
    let target = row.target.clone();
    let applied = matches!(&target, Target::Theme(id)
        if view.browser_state.appearance.as_ref().is_some_and(|a| &a.selected == id));
    let focused = view.picker.as_ref().is_some_and(|p| p.selected == index);
    let fill = if focused { theme.active } else { theme.surface };
    div()
        .id(("picker-row", index))
        .debug_selector(move || format!("picker-row-{index}"))
        .h(px(32.))
        .px_2()
        .flex()
        .items_center()
        .gap_2()
        .rounded(px(4.))
        .bg(rgb(fill))
        .text_color(rgb(if enabled {
            theme.text_on(fill)
        } else {
            theme.muted
        }))
        .when(enabled, |item| {
            item.cursor_pointer()
                .hover(|style| style.bg(rgb(theme.active)))
        })
        .child(div().size(px(16.)).flex_shrink_0().when(applied, |slot| {
            slot.child(
                svg()
                    .path("icons/check.svg")
                    .size_full()
                    .text_color(rgb(theme.foreground)),
            )
        }))
        .child(div().flex_1().min_w_0().truncate().child(row.label.clone()))
        .when(applied, |item| item.child(div().text_xs().child("Applied")))
        .when(enabled, |item| {
            item.on_click(cx.listener(move |view, _, window, cx| {
                view.choose_picker(target.clone(), window, cx)
            }))
        })
        .into_any_element()
}
