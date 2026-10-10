#![allow(clippy::unwrap_used)]

use super::*;
use crate::sidebar::STATUS_WIDTH;
use core::prelude::v1::test;
use std::sync::Arc;

#[gpui::test]
fn a_tab_leads_its_title_with_its_status_dot_unless_unknown(cx: &mut TestAppContext) {
    status_layout(cx, None, crate::config::Config::default().tabs.size);
}

#[gpui::test]
fn shared_custom_dots_keep_the_tab_label_centered(cx: &mut TestAppContext) {
    status_layout(
        cx,
        Some("[ui]\nstatus_indicators = 'dots'\n[theme.custom]\nyellow = '#123456'\n"),
        19.,
    );
}

#[gpui::test]
fn shared_symbols_extend_the_tab_without_displacing_its_label(cx: &mut TestAppContext) {
    status_layout(
        cx,
        Some("[ui]\nstatus_indicators = 'symbols'\n[theme.custom]\nyellow = '#ff9900'\n"),
        19.,
    );
}

/// A zoomed tab carries its mark after the title, inside the width
/// measured for it, and a tab that is not zoomed carries none.
#[gpui::test]
fn zoomed_tab_shows_its_mark_within_its_width(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut snapshot: herdr_client::protocol::ClientShellSnapshot = serde_json::from_str(
            include_str!("../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"),
        )
        .unwrap();
        snapshot.tabs[0].zoomed = true;
        // Long enough that neither width is the narrowest tab's.
        snapshot.tabs[0].label = "a title long enough to outgrow the narrowest tab".into();
        let mut plain = snapshot.tabs[0].clone();
        plain.tab_id = "plain".into();
        plain.focused = false;
        plain.zoomed = false;
        snapshot.tabs.push(plain);
        view.live.snapshot = Some(Arc::new(snapshot));
        view
    });
    cx.simulate_resize(size(px(1600.), px(600.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tab-zoom-plain").is_none());
    let tab = cx.debug_bounds("tab-w1:t1").unwrap();
    let mark = cx.debug_bounds("tab-zoom-w1:t1").unwrap();
    let close = cx.debug_bounds("close-tab-w1:t1").unwrap();
    assert_eq!(mark.size, size(px(ZOOM_ICON), px(ZOOM_ICON)));
    assert!(mark.right() <= close.left(), "{mark:?} before {close:?}");
    assert!((mark.center().y - tab.center().y).abs() <= px(0.5));
    let (zoomed, unzoomed) = cx.update(|window, cx| {
        let view = view.read(cx);
        let indicators = Indicators::new(None, false, &view.theme);
        let label = view.live.snapshot.as_ref().unwrap().tabs[0].label.clone();
        let lead = Lead::of(view.live.snapshot.as_ref().unwrap().tabs[0].agent_status);
        (
            view.tab_width(&label.clone().into(), lead, true, indicators, window),
            view.tab_width(&label.into(), lead, false, indicators, window),
        )
    });
    assert_eq!(zoomed - unzoomed, DOT_GAP + ZOOM_ICON);
    assert!((tab.size.width - px(zoomed)).abs() <= px(0.5), "{tab:?}");
}

fn status_layout(cx: &mut TestAppContext, settings: Option<&str>, font_size: f32) {
    let label = "a title long enough to outgrow the narrowest tab";
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.settings.shared =
            settings.map(|text| crate::herdr_settings::Settings::parse_text(text).unwrap());
        view.config.tabs.size = font_size;
        let mut snapshot: herdr_client::protocol::ClientShellSnapshot = serde_json::from_str(
            include_str!("../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"),
        )
        .unwrap();
        snapshot.tabs[0].label = label.into();
        assert_eq!(snapshot.tabs[0].agent_status, AgentStatus::Working);
        let mut plain = snapshot.tabs[0].clone();
        plain.tab_id = "plain".into();
        plain.focused = false;
        plain.agent_status = AgentStatus::Unknown;
        snapshot.tabs.push(plain);
        view.live.snapshot = Some(Arc::new(snapshot));
        view
    });
    cx.simulate_resize(size(px(1600.), px(600.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });

    // Layout snaps to device pixels, so edges agree within half of one.
    let near = |a: Pixels, b: Pixels| (a - b).abs() <= px(0.5);
    let tab = cx.debug_bounds("tab-w1:t1").unwrap();
    let dot = cx.debug_bounds("tab-status-w1:t1").unwrap();
    let (width, measured) = cx.update(|window, cx| {
        let view = view.read(cx);
        let indicators = Indicators::new(
            view.settings.shared.as_ref(),
            matches!(
                cx.window_appearance(),
                WindowAppearance::Light | WindowAppearance::VibrantLight
            ),
            &view.theme,
        );
        (
            indicators.width(&view.config.tabs),
            view.tab_width(&label.into(), Lead::Status, false, indicators, window),
        )
    });
    assert_eq!(dot.size.width, px(width));
    if settings.is_none() {
        assert_eq!(dot.size, size(px(STATUS_WIDTH), px(STATUS_WIDTH)));
    }
    assert!(
        near(tab.size.width, px(measured)),
        "{tab:?} measured {measured}"
    );
    assert!(near(dot.left(), tab.left() + px(12.)), "{dot:?} in {tab:?}");
    assert!(near(dot.center().y, tab.center().y), "{dot:?} in {tab:?}");

    assert!(cx.debug_bounds("tab-status-plain").is_none());
    let plain = cx.debug_bounds("tab-plain").unwrap();
    // The dot and its gap widen the tab by what they take, so the
    // title and close button keep their room.
    assert!(
        near(tab.size.width - plain.size.width, px(width + DOT_GAP)),
        "{tab:?} beside {plain:?}"
    );
    let close = cx.debug_bounds("close-tab-w1:t1").unwrap();
    let plain_close = cx.debug_bounds("close-tab-plain").unwrap();
    assert!(near(close.center().y, plain_close.center().y));
    assert!(near(tab.size.height, plain.size.height));
    assert!(near(
        tab.right() - close.right(),
        plain.right() - plain_close.right()
    ));
}

/// A window whose focused workspace has far more tabs than fit in
/// 800 pixels, the last of them focused when `last_focused`.
fn crowded(
    cx: &mut TestAppContext,
    last_focused: bool,
) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    // Reveal must see the intended viewport on its first frame. Opening
    // maximized and then resizing preserves the already-revealed offset.
    let window = cx.open_window(size(px(800.), px(600.)), |window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut snapshot: herdr_client::protocol::ClientShellSnapshot = serde_json::from_str(
            include_str!("../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"),
        )
        .unwrap();
        let first = snapshot.tabs[0].clone();
        for index in 0..30 {
            let mut tab = first.clone();
            tab.tab_id = format!("x{index}");
            tab.label = format!("tab number {index}");
            tab.focused = false;
            snapshot.tabs.push(tab);
        }
        if last_focused {
            snapshot.tabs[0].focused = false;
            snapshot.tabs[30].focused = true;
            snapshot.focused_tab_id = Some("x29".into());
        }
        view.live.snapshot = Some(Arc::new(snapshot));
        view
    });
    let view = window.root(cx).unwrap();
    let cx = VisualTestContext::from_window(window.into(), cx).into_mut();
    for _ in 0..2 {
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    }
    (view, cx)
}

/// Where the strip's tabs can be seen: from the first group's left
/// edge to its "+" button.
fn viewport(cx: &mut VisualTestContext) -> (Pixels, Pixels) {
    let new_tab = cx.debug_bounds("new-tab").unwrap();
    let strip = view_scroll(cx).bounds();
    assert!(
        (strip.right() - new_tab.left()).abs() <= px(0.5),
        "{strip:?} {new_tab:?}"
    );
    (strip.left(), strip.right())
}

fn view_scroll(cx: &mut VisualTestContext) -> ScrollHandle {
    cx.update(|window, cx| {
        let view = window.root::<HerdrWindow>().flatten().unwrap();
        view.update(cx, |view, _| {
            let group = view.group_slots()[0].id;
            view.strip_scroll(group)
        })
    })
}

#[gpui::test]
fn the_wheel_scrolls_a_crowded_strip_sideways(cx: &mut TestAppContext) {
    let (_, cx) = crowded(cx, false);
    let (_, right) = viewport(cx);
    let last = cx.debug_bounds("tab-x29").unwrap();
    assert!(last.left() > right, "{last:?} starts out of view");
    let first = cx.debug_bounds("tab-w1:t1").unwrap();
    for _ in 0..40 {
        cx.simulate_event(ScrollWheelEvent {
            position: first.center(),
            delta: ScrollDelta::Pixels(point(px(0.), px(-200.))),
            ..Default::default()
        });
    }
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    let last = cx.debug_bounds("tab-x29").unwrap();
    assert!(
        (last.right() - right).abs() <= px(0.5),
        "{last:?} ends at {right:?}"
    );
}

#[gpui::test]
fn the_chosen_tab_is_scrolled_into_view(cx: &mut TestAppContext) {
    let (_, cx) = crowded(cx, true);
    let (left, right) = viewport(cx);
    let last = cx.debug_bounds("tab-x29").unwrap();
    assert!(
        last.left() >= left && (last.right() - right).abs() <= px(0.5),
        "{last:?}"
    );

    // Scrolled away by hand, the strip stays put while the choice holds.
    let first = cx.debug_bounds("tab-x28").unwrap();
    cx.simulate_event(ScrollWheelEvent {
        position: first.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(300.))),
        ..Default::default()
    });
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("tab-x29").unwrap().left() > right);
}

#[gpui::test]
fn choosing_a_far_tab_later_scrolls_it_into_view(cx: &mut TestAppContext) {
    let (view, cx) = crowded(cx, false);
    let (left, right) = viewport(cx);
    assert!(cx.debug_bounds("tab-x29").unwrap().left() > right);
    view.update(cx, |view, cx| {
        let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
        snapshot.tabs[0].focused = false;
        snapshot.tabs[30].focused = true;
        snapshot.focused_tab_id = Some("x29".into());
        cx.notify();
    });
    for _ in 0..2 {
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    }
    let last = cx.debug_bounds("tab-x29").unwrap();
    assert!(
        last.left() >= left && (last.right() - right).abs() <= px(0.5),
        "{last:?}"
    );
}

#[gpui::test]
fn dragging_the_thumb_scrolls_the_strip(cx: &mut TestAppContext) {
    let (_, cx) = crowded(cx, false);
    let (left, right) = viewport(cx);
    let thumb = cx.debug_bounds("tab-scroll-thumb").unwrap();
    assert!(
        (thumb.left() - left).abs() <= px(0.5),
        "{thumb:?} starts at the left"
    );
    assert!(thumb.size.width < right - left);
    let start = thumb.center();
    let end = point(right + px(200.), start.y);
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(
        start + point(px(10.), px(0.)),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    let last = cx.debug_bounds("tab-x29").unwrap();
    assert!(
        (last.right() - right).abs() <= px(0.5),
        "{last:?} ends at {right:?}"
    );
    let thumb = cx.debug_bounds("tab-scroll-thumb").unwrap();
    assert!(
        (thumb.right() - right).abs() <= px(0.5),
        "{thumb:?} ends at the right"
    );
}

#[gpui::test]
fn a_strip_whose_tabs_fit_has_no_thumb(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(
            serde_json::from_str(include_str!(
                "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
            ))
            .unwrap(),
        ));
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    for _ in 0..2 {
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    }
    assert!(cx.debug_bounds("tab-w1:t1").is_some());
    assert!(cx.debug_bounds("tab-scroll-thumb").is_none());
}

/// A connected window whose focused workspace has four Herdr tabs, `a`
/// to `d`, with room for all of them.
fn four_tabs(
    cx: &mut TestAppContext,
    supports_tab_move: bool,
) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut snapshot: herdr_client::protocol::ClientShellSnapshot = serde_json::from_str(
            include_str!("../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"),
        )
        .unwrap();
        let first = snapshot.tabs[0].clone();
        snapshot.tabs = ["a", "b", "c", "d"]
            .into_iter()
            .map(|id| {
                let mut tab = first.clone();
                tab.tab_id = id.into();
                tab.label = format!("tab {id}");
                tab.focused = id == "a";
                tab
            })
            .collect();
        snapshot.focused_tab_id = Some("a".into());
        view.live.snapshot = Some(Arc::new(snapshot));
        view.live.status = crate::state::ConnectionStatus::Connected;
        view.live.supports_tab_move = supports_tab_move;
        view
    });
    cx.simulate_resize(size(px(1600.), px(600.)));
    for _ in 0..2 {
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    }
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

fn target(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) -> Option<(usize, String)> {
    view.read_with(cx, |view, _| {
        let target = view.tab_drag.as_ref()?.target.as_ref()?;
        let beside = match &target.beside {
            crate::reorder::Beside::Before(Pick::Herdr(id)) => format!("before {id}"),
            crate::reorder::Beside::After(Pick::Herdr(id)) => format!("after {id}"),
            other => format!("{other:?}"),
        };
        Some((target.slot, beside))
    })
}

#[gpui::test]
fn holding_a_tab_lifts_it_bigger_and_a_release_picks_the_gap(cx: &mut TestAppContext) {
    let (view, cx) = four_tabs(cx, true);
    let a = cx.debug_bounds("tab-a").unwrap();
    let b = cx.debug_bounds("tab-b").unwrap();
    let c = cx.debug_bounds("tab-c").unwrap();

    // A quick click stays a click.
    cx.simulate_mouse_down(a.center(), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(a.center(), MouseButton::Left, Modifiers::default());
    cx.executor().advance_clock(crate::reorder::LIFT_DELAY * 2);
    cx.run_until_parked();
    view.read_with(cx, |view, _| assert!(view.tab_drag.is_none()));

    // Held in place, it lifts without moving, on a card larger than it.
    cx.simulate_mouse_down(a.center(), MouseButton::Left, Modifiers::default());
    view.read_with(cx, |view, _| {
        assert!(view.tab_drag.as_ref().unwrap().lifted.is_none())
    });
    cx.executor().advance_clock(crate::reorder::LIFT_DELAY);
    cx.run_until_parked();
    draw(cx);
    view.read_with(cx, |view, _| {
        assert!(view.tab_drag.as_ref().unwrap().lifted.is_some())
    });
    assert_eq!(target(&view, cx), None);
    assert_eq!(cx.debug_bounds("tab-a").unwrap(), a);
    let card = cx.debug_bounds("lifted-tab-a").unwrap();
    assert!(
        card.left() < a.left() && card.right() > a.right(),
        "{card:?} around {a:?}"
    );
    assert!(
        card.top() < a.top() && card.bottom() > a.bottom(),
        "{card:?} around {a:?}"
    );

    // Past the second tab's middle, it lands before the third, which
    // the second closes the gap for.
    let over = point(a.center().x + b.size.width / 2. + px(4.), a.center().y);
    for _ in 0..2 {
        cx.simulate_mouse_move(over, MouseButton::Left, Modifiers::default());
        draw(cx);
    }
    assert_eq!(target(&view, cx), Some((2, "before c".into())));
    let lifted = cx.debug_bounds("tab-a").unwrap();
    assert!((lifted.left() - (a.left() + over.x - a.center().x)).abs() <= px(0.5));
    let passed = cx.debug_bounds("tab-b").unwrap();
    assert!((passed.left() - a.left()).abs() <= px(0.5), "{passed:?}");
    assert_eq!(cx.debug_bounds("tab-c").unwrap(), c);

    // Carried past the last tab, it lands after it.
    let end = point(a.center().x + px(2000.), a.center().y);
    for _ in 0..2 {
        cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::default());
        draw(cx);
    }
    assert_eq!(target(&view, cx), Some((4, "after d".into())));

    // The release is the drop, not a click on the tab under it; without
    // a daemon nothing moves, so every tab is back in place.
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
    draw(cx);
    view.read_with(cx, |view, _| assert!(view.tab_drag.is_none()));
    assert_eq!(cx.debug_bounds("tab-a").unwrap(), a);
    assert_eq!(cx.debug_bounds("tab-b").unwrap(), b);
    assert!(cx.debug_bounds("lifted-tab-a").is_none());

    // A drag lifts without waiting, and escape puts it back.
    cx.simulate_mouse_down(c.center(), MouseButton::Left, Modifiers::default());
    let back = point(a.left() + px(2.), c.center().y);
    for _ in 0..2 {
        cx.simulate_mouse_move(back, MouseButton::Left, Modifiers::default());
        draw(cx);
    }
    assert_eq!(target(&view, cx), Some((0, "before a".into())));
    cx.simulate_keystrokes("escape");
    draw(cx);
    view.read_with(cx, |view, _| assert!(view.tab_drag.is_none()));
    assert_eq!(cx.debug_bounds("tab-c").unwrap(), c);
}

#[gpui::test]
fn tabs_stay_put_when_the_daemon_cannot_move_them(cx: &mut TestAppContext) {
    let (view, cx) = four_tabs(cx, false);
    let a = cx.debug_bounds("tab-a").unwrap();
    cx.simulate_mouse_down(a.center(), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(
        a.center() + point(px(200.), px(0.)),
        MouseButton::Left,
        Modifiers::default(),
    );
    draw(cx);
    view.read_with(cx, |view, _| assert!(view.tab_drag.is_none()));
    assert_eq!(cx.debug_bounds("tab-a").unwrap(), a);
    cx.simulate_mouse_up(a.center(), MouseButton::Left, Modifiers::default());
}

#[gpui::test]
fn carrying_a_tab_to_the_strip_s_end_scrolls_it(cx: &mut TestAppContext) {
    let (view, cx) = crowded(cx, false);
    view.update(cx, |view, _| view.live.supports_tab_move = true);
    view.update(cx, |view, _| {
        view.live.status = crate::state::ConnectionStatus::Connected
    });
    let (_, right) = viewport(cx);
    let first = cx.debug_bounds("tab-w1:t1").unwrap();
    cx.simulate_mouse_down(first.center(), MouseButton::Left, Modifiers::default());
    let edge = point(right - px(2.), first.center().y);
    cx.simulate_mouse_move(edge, MouseButton::Left, Modifiers::default());
    let scroll = view_scroll(cx);
    let before = scroll.offset().x;
    draw(cx);
    assert!(scroll.offset().x < before, "{:?}", scroll.offset());
    // The carried tab stays within the strip, under the pointer's end.
    let carried = cx.debug_bounds("tab-w1:t1").unwrap();
    assert!(carried.right() <= right + px(0.5), "{carried:?}");
    cx.simulate_keystrokes("escape");
}

/// A window over `tabs` in one workspace, with Herdr's shared `ui` config.
fn shared_tabs<'a>(
    cx: &'a mut TestAppContext,
    tabs: &[&str],
    ui: &str,
) -> (Entity<HerdrWindow>, &'a mut VisualTestContext) {
    let tabs: Vec<String> = tabs.iter().map(|id| (*id).to_owned()).collect();
    let shared = crate::herdr_settings::Settings::parse_text(&format!("[ui]\n{ui}")).unwrap();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut snapshot: herdr_client::protocol::ClientShellSnapshot = serde_json::from_str(
            include_str!("../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"),
        )
        .unwrap();
        let first = snapshot.tabs[0].clone();
        snapshot.tabs = tabs
            .iter()
            .map(|id| {
                let mut tab = first.clone();
                tab.tab_id = id.clone();
                tab.label = format!("tab {id}");
                tab.focused = *id == tabs[0];
                tab
            })
            .collect();
        snapshot.focused_tab_id = Some(tabs[0].clone());
        view.live.snapshot = Some(Arc::new(snapshot));
        view.live.status = crate::state::ConnectionStatus::Connected;
        view.settings.shared = Some(shared);
        view
    });
    cx.simulate_resize(size(px(1200.), px(600.)));
    draw(cx);
    draw(cx);
    (view, cx)
}

#[gpui::test]
fn the_strip_sits_below_the_group_when_herdr_puts_it_at_the_bottom(cx: &mut TestAppContext) {
    let (_, cx) = shared_tabs(cx, &["a", "b"], "tab_bar_position = 'bottom'");
    let group = cx.debug_bounds("group").unwrap();
    let tab = cx.debug_bounds("tab-a").unwrap();
    let new_tab = cx.debug_bounds("new-tab").unwrap();
    assert!(
        (group.bottom() - new_tab.bottom()).abs() <= px(0.5),
        "{group:?} {new_tab:?}"
    );
    assert!(tab.top() > group.top() + px(100.), "{group:?} {tab:?}");

    let (_, cx) = shared_tabs(&mut cx.cx, &["a", "b"], "tab_bar_position = 'top'");
    let group = cx.debug_bounds("group").unwrap();
    let tab = cx.debug_bounds("tab-a").unwrap();
    assert!(
        (group.top() - tab.top()).abs() <= px(0.5),
        "{group:?} {tab:?}"
    );
}

#[gpui::test]
fn a_lone_tab_hides_the_strip_only_when_herdr_asks_and_the_window_is_not_split(
    cx: &mut TestAppContext,
) {
    let (view, cx) = shared_tabs(cx, &["a"], "hide_tab_bar_when_single_tab = true");
    assert!(cx.debug_bounds("new-tab").is_none());
    assert!(cx.debug_bounds("tab-a").is_none());
    assert!(cx.debug_bounds("group").is_some());

    // A second tab, Herdr's or a page's, brings the strip back.
    view.update(cx, |view, _| {
        let mut snapshot = (**view.live.snapshot.as_ref().unwrap()).clone();
        let mut second = snapshot.tabs[0].clone();
        second.tab_id = "b".into();
        second.focused = false;
        snapshot.tabs.push(second);
        view.live.snapshot = Some(Arc::new(snapshot));
    });
    draw(cx);
    assert!(cx.debug_bounds("tab-a").is_some());
    assert!(cx.debug_bounds("tab-b").is_some());

    // Split, every group keeps its strip, even one listing a single tab.
    let (view, cx) = shared_tabs(&mut cx.cx, &["a"], "hide_tab_bar_when_single_tab = true");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let group = view.group_slots()[0].id;
            view.split_group(group, window, cx);
        })
    });
    draw(cx);
    assert!(view.read_with(cx, |view, _| view.is_split()));
    assert!(cx.debug_bounds("new-tab").is_some());
    assert!(cx.debug_bounds("g1-new-tab").is_some());

    // Without the setting, a lone tab keeps its strip.
    let (_, cx) = shared_tabs(&mut cx.cx, &["a"], "");
    assert!(cx.debug_bounds("tab-a").is_some());
}

#[gpui::test]
fn a_bottom_strip_still_reorders_by_dragging(cx: &mut TestAppContext) {
    let (view, cx) = shared_tabs(
        cx,
        &["a", "b", "c"],
        "tab_bar_position = 'bottom'\nhide_tab_bar_when_single_tab = true",
    );
    view.update(cx, |view, _| view.live.supports_tab_move = true);
    let a = cx.debug_bounds("tab-a").unwrap();
    let b = cx.debug_bounds("tab-b").unwrap();
    cx.simulate_mouse_down(a.center(), MouseButton::Left, Modifiers::default());
    let over = point(a.center().x + b.size.width / 2. + px(4.), a.center().y);
    for _ in 0..2 {
        cx.simulate_mouse_move(over, MouseButton::Left, Modifiers::default());
        draw(cx);
    }
    assert_eq!(target(&view, cx), Some((2, "before c".into())));
    cx.simulate_mouse_up(over, MouseButton::Left, Modifiers::default());
    draw(cx);
    view.read_with(cx, |view, _| assert!(view.tab_drag.is_none()));
}
