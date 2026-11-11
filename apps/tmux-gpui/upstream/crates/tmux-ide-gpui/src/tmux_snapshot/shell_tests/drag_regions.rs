//! #359 review (card 5): where the strip used to be, the sidebar's band and
//! the 8 pt over the cards are the window's drag regions; the band's
//! controls are not. And the strip stays where the window draws its own
//! caption buttons.
use super::*;
use crate::titlebar::{PRESSES, Press};

#[test]
fn the_strip_stays_without_the_sidebar_or_with_client_caption_buttons() {
    use super::super::super::workspace_chrome::keeps_title_strip;
    assert!(!keeps_title_strip(true, false));
    assert!(keeps_title_strip(true, true));
    assert!(keeps_title_strip(false, false));
    assert!(keeps_title_strip(false, true));
}

fn presses_at(cx: &mut VisualTestContext, at: Point<Pixels>, clicks: usize) -> Vec<Press> {
    PRESSES.with(|p| p.borrow_mut().clear());
    cx.simulate_event(MouseDownEvent {
        button: MouseButton::Left,
        position: at,
        modifiers: Modifiers::default(),
        click_count: clicks,
        first_mouse: false,
    });
    cx.simulate_event(MouseUpEvent {
        button: MouseButton::Left,
        position: at,
        modifiers: Modifiers::default(),
        click_count: clicks,
    });
    PRESSES.with(|p| p.borrow_mut().drain(..).collect())
}

#[gpui::test]
fn the_band_and_the_gutter_over_the_cards_move_and_zoom_the_window(cx: &mut TestAppContext) {
    let (sender, _receiver) = std::sync::mpsc::sync_channel(64);
    let (_view, cx) = cx.add_window_view(|_, cx| browser_fixture(cx, sender));
    cx.simulate_resize(size(px(1000.), px(700.)));
    cx.update(|w, cx| w.draw(cx).clear(cx));
    let grip = cx.debug_bounds("content-titlebar-grip").unwrap();
    let toggle = cx.debug_bounds("sidebar-toggle").unwrap();
    let search = cx.debug_bounds("application-search").unwrap();
    // Between the toggle and search: the band itself.
    let band = point((toggle.right() + search.left()) / 2., toggle.center().y);
    for (name, at) in [("grip", grip.center()), ("band", band)] {
        assert_eq!(
            presses_at(cx, at, 1),
            [Press::Move],
            "{name}: a press moves"
        );
        assert_eq!(
            presses_at(cx, at, 2),
            [Press::DoubleClick],
            "{name}: a double-click is the system's"
        );
    }
    // The band's controls act, and never move the window.
    assert!(presses_at(cx, toggle.center(), 1).is_empty());
    assert!(presses_at(cx, search.center(), 1).is_empty());
}

/// Owner, 11 Nov: with the sidebar hidden the strip is only the traffic
/// lights' row on macOS; it stays full where the window draws its own
/// caption buttons or a server-drawn frame sits above it. Its controls keep
/// the full strip's centre line.
#[test]
fn the_hidden_sidebar_strip_is_the_lights_row_on_macos() {
    use crate::titlebar::{COMPACT_HEIGHT, HEIGHT, row_inset, strip_height};
    assert_eq!(strip_height(true, false), COMPACT_HEIGHT);
    assert_eq!(strip_height(true, true), HEIGHT);
    assert_eq!(strip_height(false, false), HEIGHT);
    assert_eq!(strip_height(false, true), HEIGHT);
    for height in [COMPACT_HEIGHT, HEIGHT] {
        let inset = row_inset(height);
        assert_eq!((inset + height) / 2., HEIGHT / 2., "{height}");
    }
}

#[gpui::test]
fn with_the_sidebar_hidden_the_strip_moves_the_window_and_its_controls_keep_their_presses(
    cx: &mut TestAppContext,
) {
    let (sender, _receiver) = std::sync::mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|_, cx| browser_fixture(cx, sender));
    cx.update(|_, cx| view.update(cx, |v, _| v.sidebar_hidden = true));
    for width in [640., 1000.] {
        cx.simulate_resize(size(px(width), px(700.)));
        cx.update(|w, cx| w.draw(cx).clear(cx));
        let strip = cx.debug_bounds("titlebar").unwrap();
        // Bare strip: right of the controls, inside the strip's height.
        let bare = point(strip.right() - px(40.), strip.center().y);
        assert_eq!(
            presses_at(cx, bare, 1),
            [Press::Move],
            "{width}: a press moves"
        );
        assert_eq!(
            presses_at(cx, bare, 2),
            [Press::DoubleClick],
            "{width}: a double-click is the system's"
        );
        // No grip under the strip's controls: their lower part, which hangs
        // into the gutter, still takes their presses (#369 review).
        assert!(cx.debug_bounds("content-titlebar-grip").is_none());
        // Home's button joins the row only in a workspace; the others always.
        for (control, required) in [
            ("sidebar-toggle", true),
            ("application-home", false),
            ("application-search", true),
            ("application-new-session", true),
        ] {
            let Some(b) = cx.debug_bounds(control) else {
                assert!(!required, "{width}: {control} not drawn");
                continue;
            };
            assert!(
                b.bottom() > strip.bottom(),
                "{control} hangs into the gutter"
            );
            for y in [b.top() + px(1.), b.center().y, b.bottom() - px(1.)] {
                // Each press is a click: start from the hidden sidebar again.
                cx.update(|w, cx| {
                    view.update(cx, |v, _| v.sidebar_hidden = true);
                    w.draw(cx).clear(cx);
                });
                let at = point(b.center().x, y);
                assert!(
                    presses_at(cx, at, 1).is_empty(),
                    "{width}: {control} at {y:?} moved the window"
                );
            }
        }
        // And the toggle acts from its bottom edge.
        cx.update(|w, cx| {
            view.update(cx, |v, _| v.sidebar_hidden = true);
            w.draw(cx).clear(cx);
        });
        let toggle = cx.debug_bounds("sidebar-toggle").unwrap();
        cx.simulate_click(
            point(toggle.center().x, toggle.bottom() - px(1.)),
            Modifiers::default(),
        );
        assert!(
            view.read_with(cx, |v, _| !v.sidebar_hidden),
            "{width}: the toggle's bottom edge shows the sidebar"
        );
        cx.update(|_, cx| view.update(cx, |v, _| v.sidebar_hidden = true));
    }
}
