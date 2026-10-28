//! Accessible adapter for this menu's flat, label-only action/separator list.
//! Bezel 0.2.16 owns the surfaces, row metrics and cursor; its `menu::card`
//! does not expose accessibility customization for rows. Keep this adaptation
//! limited to our list rather than forking Bezel's submenu/search machinery.
use super::SnapshotView;
use bezel_ui::{
    menu::{Cursor, Hit, Item, MenuWidth},
    popover, scroll,
};
use gpui::{prelude::*, *};
use std::{cell::Cell, rc::Rc};

// Match the pinned Bezel card's private MENU_PAD and SNAP geometry.
const MENU_PAD: f32 = 4.;
const SNAP: f32 = 8.;
type Shown = (Option<usize>, Size<Pixels>);
#[derive(Clone, Default)]
struct Scrolled(ScrollHandle, Rc<Cell<Option<Shown>>>);

pub(super) fn card(
    theme: &bezel_theme::Theme,
    items: &[Item],
    cursor: &Cursor,
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
) -> Div {
    let lit = cursor.lit(0);
    let Scrolled(handle, shown) = window
        .use_keyed_state("pane-actions-rows-scrolled", cx, |_, _| Scrolled::default())
        .read(cx)
        .clone();
    let size = handle.bounds().size;
    if size.height > Pixels::ZERO && shown.get() != Some((lit, size)) {
        shown.set(Some((lit, size)));
        if let Some(at) = lit {
            handle.scroll_to_item(at);
        }
    }
    let rows =
        div()
            .id("pane-actions-rows")
            .p(px(MENU_PAD))
            .children(items.iter().enumerate().map(|(index, item)| {
                match item {
                    Item::Separator => popover::divider(theme).into_any_element(),
                    Item::Action {
                        label, keystroke, ..
                    } => {
                        let label = label.clone();
                        let enabled = item.selectable();
                        popover::menu_row(theme, lit == Some(index), None)
                            .id(SharedString::from(format!("pane-actions-{index}")))
                            .role(Role::MenuItem)
                            .aria_label(label.clone())
                            .aria_description(keystroke.clone().unwrap_or_default())
                            .debug_selector({
                                let label = label.clone();
                                move || format!("pane-actions/{label}")
                            })
                            .when(enabled, |row| {
                                row.on_mouse_move(cx.listener(move |view, _, window, cx| {
                                    view.pane_menu_hit(Hit::Point(vec![index]), window, cx);
                                }))
                                .on_click(cx.listener(
                                    move |view, _, window, cx| {
                                        view.pane_menu_hit(Hit::Choose(vec![index]), window, cx);
                                    },
                                ))
                            })
                            .when(!enabled, |row| {
                                row.cursor_default().text_color(theme.text_faint)
                            })
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .child(div().truncate().child(label)),
                            )
                            .children(
                                keystroke
                                    .iter()
                                    .map(|key| super::super::kbd::badge(theme, key.clone())),
                            )
                            .into_any_element()
                    }
                    // This adapter intentionally has no submenu, search or alternate action owner.
                    _ => Empty.into_any_element(),
                }
            }));
    let inset = px(SNAP) + window.client_inset().unwrap_or(Pixels::ZERO);
    let min_width = cx
        .try_global::<MenuWidth>()
        .copied()
        .unwrap_or_default()
        .min;
    popover::popover_card(theme)
        .p_0()
        .flex()
        .flex_col()
        .max_h(window.viewport_size().height - inset * 2.)
        .min_w(min_width)
        .on_mouse_down_out(cx.listener(|view, _, window, cx| {
            view.pane_menu_hit(Hit::Dismiss, window, cx);
            // Swallow the dismissing press before an underlying terminal/row records it.
            cx.stop_propagation();
        }))
        .child(
            scroll::Viewport::new("pane-actions-rows", rows, Axis::Vertical)
                .track_scroll(&handle)
                .fill(),
        )
}

#[cfg(test)]
#[path = "menu_render_tests.rs"]
mod tests;
