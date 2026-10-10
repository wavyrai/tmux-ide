#![allow(clippy::unwrap_used)]
use super::*;
use crate::{
    browser::Store,
    controls::Command,
    sidebar::layout_tests::{fixture_window, full_draw, snapshot},
};
use core::prelude::v1::test;
use gpui::{TestAppContext, VisualTestContext};
use std::sync::Arc;

fn window(cx: &mut TestAppContext) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut shown = snapshot(40);
        shown.focused_workspace_id = Some("w0".into());
        shown.focused_tab_id = Some("t0".into());
        view.live.snapshot = Some(Arc::new(shown));
        view
    })
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
}

/// Opens blank tabs, which need no native page, without showing them.
fn open_pages(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, count: usize) {
    cx.update(|_, cx| {
        let scope = crate::browser::scope(&view.read(cx).endpoints[0]);
        Store::update(cx, |store| {
            for _ in 0..count {
                store.open(scope.clone(), "w0", None, None);
            }
        });
    });
}

fn groups(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) -> Vec<GroupId> {
    draw(cx);
    view.read_with(cx, |view, _| {
        view.group_slots().into_iter().map(|slot| slot.id).collect()
    })
}

fn actions(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, group: GroupId) -> Vec<Action> {
    cx.update(|_, cx| view.read(cx).group_actions(group, cx))
}

fn run(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, group: GroupId, action: Action) {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_group_menu(group, Point::default(), window, cx);
            view.activate_group_menu(action, window, cx);
        })
    });
    draw(cx);
}

fn tabs(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, group: GroupId) -> Vec<Pick> {
    cx.update(|_, cx| view.read(cx).group_tabs(group, cx))
}

/// Every Herdr tab the daemon has, which closing in a group never
/// touches.
fn herdr_tabs(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) -> usize {
    view.read_with(cx, |view, _| {
        view.live.snapshot.as_ref().unwrap().tabs.len()
    })
}

#[gpui::test]
fn menus_say_what_they_cover(cx: &mut TestAppContext) {
    use crate::menu::Cover;
    let (view, cx) = window(cx);
    draw(cx);
    // A popover covers its own panel.
    let button = cx.debug_bounds("tab-actions").unwrap();
    cx.simulate_click(button.center(), Modifiers::none());
    draw(cx);
    let panel = cx.debug_bounds("menu-panel").unwrap();
    let Cover::Panel(covered) = view.read_with(cx, |view, _| view.menu.cover.get()) else {
        panic!("a popover covers its panel")
    };
    // The panel, and a margin around it for its border and shadow.
    assert!(covered.contains(&panel.origin) && covered.contains(&panel.bottom_right()));
    assert!(covered.size.width < panel.size.width + px(24.));
    // A dimmed dialog covers the window.
    cx.simulate_keystrokes("escape");
    assert_eq!(
        view.read_with(cx, |view, _| view.menu.cover.get()),
        Cover::Unknown
    );
    cx.update(|window, cx| view.update(cx, |view, cx| view.command(Command::Palette, window, cx)));
    draw(cx);
    assert_eq!(
        view.read_with(cx, |view, _| view.menu.cover.get()),
        Cover::All
    );
}

#[gpui::test]
fn a_lone_group_offers_no_close(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    let [group] = groups(&view, cx)[..] else {
        panic!("one group")
    };
    assert_eq!(
        actions(&view, cx, group),
        [Action::NewBrowserTab, Action::Split]
    );
}

#[gpui::test]
fn closing_in_a_group_never_closes_a_tab(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    open_pages(&view, cx, 2);
    let herdr = herdr_tabs(&view, cx);
    let pages = cx.update(|_, cx| view.read(cx).browser_tab_ids(cx));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.command(Command::SplitEditor, window, cx)
        })
    });
    let [left, right] = groups(&view, cx)[..] else {
        panic!("two groups")
    };
    // Split, both groups list every tab.
    assert_eq!(tabs(&view, cx, left), tabs(&view, cx, right));
    assert_eq!(
        actions(&view, cx, right),
        [
            Action::NewBrowserTab,
            Action::Close,
            Action::CloseOthers,
            Action::CloseAll,
            Action::Split
        ]
    );

    // Close Others leaves the right group its own tab alone.
    let shown = view
        .read_with(cx, |view, _| view.group_pick(right))
        .unwrap();
    run(&view, cx, right, Action::CloseOthers);
    assert_eq!(tabs(&view, cx, right), std::slice::from_ref(&shown));
    assert_eq!(tabs(&view, cx, left).len(), herdr + pages.len());
    assert!(cx.debug_bounds("browser-tab-0").is_some());
    assert!(cx.debug_bounds("g1-browser-tab-0").is_none());

    // Close takes the left group to the next tab it lists.
    let left_shown = view.read_with(cx, |view, _| view.group_pick(left)).unwrap();
    run(&view, cx, left, Action::Close);
    let now = view.read_with(cx, |view, _| view.group_pick(left)).unwrap();
    assert_ne!(now, left_shown);
    assert!(!tabs(&view, cx, left).contains(&left_shown));

    // Close All closes the group, not its tabs.
    run(&view, cx, right, Action::CloseAll);
    assert_eq!(groups(&view, cx), [left]);
    // Nothing was closed in Herdr or the browser, and no dialog opened.
    assert_eq!(herdr_tabs(&view, cx), herdr);
    assert_eq!(cx.update(|_, cx| view.read(cx).browser_tab_ids(cx)), pages);
    view.read_with(cx, |view, _| assert!(view.menu.page.is_none()));
}

#[gpui::test]
fn a_tabs_close_button_in_a_split_closes_it_in_its_group_alone(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    let herdr = herdr_tabs(&view, cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.command(Command::SplitEditor, window, cx)
        })
    });
    let [left, right] = groups(&view, cx)[..] else {
        panic!("two groups")
    };
    let close = cx.debug_bounds("g1-close-tab-t1").unwrap();
    cx.simulate_click(close.center(), Modifiers::none());
    draw(cx);
    // No confirmation, nothing sent to Herdr: the tab left one strip.
    view.read_with(cx, |view, _| assert!(view.menu.page.is_none()));
    assert_eq!(herdr_tabs(&view, cx), herdr);
    assert!(!tabs(&view, cx, right).contains(&Pick::Herdr("t1".into())));
    assert!(tabs(&view, cx, left).contains(&Pick::Herdr("t1".into())));
    assert!(cx.debug_bounds("tab-t1").is_some());
    assert!(cx.debug_bounds("g1-tab-t1").is_none());
}

#[gpui::test]
fn a_group_left_with_nothing_closes(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.command(Command::SplitEditor, window, cx)
        })
    });
    let [_, right] = groups(&view, cx)[..] else {
        panic!("two groups")
    };
    let all = tabs(&view, cx, right);
    cx.update(|window, cx| view.update(cx, |view, cx| view.close_in_group(right, all, window, cx)));
    assert_eq!(groups(&view, cx).len(), 1);
}

#[gpui::test]
fn the_menu_opens_from_the_strip_and_steps_with_the_keyboard(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    draw(cx);
    let button = cx.debug_bounds("tab-actions").unwrap();
    cx.simulate_click(button.center(), Modifiers::none());
    draw(cx);
    assert!(view.read_with(cx, |view, _| view.menu.page == Some(Page::Group)));
    for row in ["group-menu-NewBrowserTab", "group-menu-Split"] {
        assert!(cx.debug_bounds(row).is_some(), "{row}");
    }
    assert!(cx.debug_bounds("group-menu-CloseAll").is_none());
    cx.simulate_keystrokes("down");
    assert_eq!(
        view.read_with(cx, |view, _| view.menu.group.as_ref().unwrap().selected),
        Some(0)
    );
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
}

mod new_tabs;
