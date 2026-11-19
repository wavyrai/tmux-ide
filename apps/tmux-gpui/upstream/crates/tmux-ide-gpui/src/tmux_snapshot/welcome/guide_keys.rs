//! The guide's Keys step: eight keys from the app's own key table, the one
//! the menus and Keyboard shortcuts… read. Pressing one here ticks its row
//! instead of acting, and every other key goes on as usual.
use super::guide::Act as GuideAct;
use super::render::{Stop, mark};
use super::*;
use crate::tmux_snapshot::keymap::{self, GUIDE};
use bezel_theme::{TextStyle, Typeset as _};

/// The Keys step's row for the key press `key`, if it lists it.
pub(super) fn row_for(key: &Keystroke) -> Option<usize> {
    GUIDE.iter().position(|(_, ids)| {
        ids.iter()
            .any(|id| keymap::matches(keymap::keystroke(*id), key))
    })
}

impl SnapshotView {
    pub(super) fn keys_body(
        &self,
        bezel: &bezel_theme::Theme,
        cx: &mut Context<Self>,
    ) -> (AnyElement, Vec<Stop>, Option<usize>) {
        let tried = self.welcome.guide.tried;
        let rows = GUIDE.iter().enumerate().map(|(index, (label, ids))| {
            let done = tried.get(index).copied().unwrap_or(false);
            let mut keys: Vec<String> = ids
                .iter()
                .map(|id| keymap::symbols(keymap::keystroke(*id)))
                .collect();
            // The four arrows share their modifiers: one badge, so the row's
            // label keeps its room.
            if keys.len() == 4 {
                let modifiers: String = keys[0].chars().take(keys[0].chars().count() - 1).collect();
                let arrows: Vec<String> = keys
                    .iter()
                    .filter_map(|k| k.chars().last().map(String::from))
                    .collect();
                keys = vec![format!("{modifiers} {}", arrows.join(" "))];
            }
            let spoken = format!(
                "{label}, {}{}",
                ids.iter()
                    .map(|id| keymap::spelled(keymap::keystroke(*id)))
                    .collect::<Vec<_>>()
                    .join(" or "),
                if done { ", tried" } else { "" }
            );
            div()
                .id(("welcome-key", index))
                .debug_selector(move || format!("welcome-key-{index}"))
                .role(Role::ListItem)
                .aria_label(spoken)
                .w(px(268.))
                .px(px(10.))
                .py(px(6.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(6.))
                .cursor_pointer()
                .child(mark(if done { Mark::Done } else { Mark::Pending }, bezel))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(bezel.text)
                        .child(*label),
                )
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .gap(px(4.))
                        .children(keys.into_iter().map(|k| super::super::kbd::badge(bezel, k))),
                )
                .on_click(cx.listener(move |view, _, window, cx| {
                    cx.stop_propagation();
                    view.guide_act(GuideAct::Tick(index), window, cx);
                }))
        });
        let body = div()
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .id("welcome-keys")
                    .debug_selector(|| "welcome-keys".into())
                    .role(Role::List)
                    .aria_label("Keys you'll use")
                    .w_full()
                    .flex()
                    .flex_wrap()
                    .justify_between()
                    .gap(px(6.))
                    .children(rows),
            )
            .child(
                div()
                    .debug_selector(|| "welcome-keys-note".into())
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .children(super::super::design::ink_probe(|| {
                        "welcome-keys-note".into()
                    }))
                    .child(SKIP_HINT),
            )
            .into_any_element();
        (body, Vec::new(), Some(guide::slot::NEXT))
    }
}
