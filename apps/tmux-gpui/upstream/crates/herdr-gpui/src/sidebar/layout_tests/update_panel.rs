use super::*;

/// Draw one preview state in a freshly opened panel and return its bounds.
#[cfg(test)]
fn draw_update_state(
    cx: &mut gpui::VisualTestContext,
    view: &Entity<HerdrWindow>,
    state: &crate::updater::State,
) -> (Bounds<Pixels>, Option<Bounds<Pixels>>) {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_app_update(false, window, cx);
            view.update_preview = Some(state.clone());
            cx.notify();
        });
        full_draw(window, cx).clear(cx);
    });
    let panel = cx.debug_bounds("app-update-panel").unwrap();
    (panel, cx.debug_bounds("app-update-action"))
}

// `debug_bounds` keeps the last frame that drew an element, so a state that
// must show no button is only provable before any button has been drawn.
#[gpui::test]
fn a_homebrew_upgrade_in_progress_offers_nothing_to_interrupt(cx: &mut gpui::TestAppContext) {
    use crate::updater::State;
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    // Homebrew output is arbitrary length; a long line must not burst the panel.
    let states = [
        State::Upgrading {
            detail: "==> Downloading ".to_owned() + &"herdr".repeat(24),
        },
        State::Restarting,
    ];
    for (width, height) in [(320., 360.), (800., 600.)] {
        cx.simulate_resize(size(px(width), px(height)));
        for state in &states {
            let (panel, action) = draw_update_state(cx, &view, state);
            assert!(action.is_none(), "{state:?} cannot be interrupted");
            let progress = cx.debug_bounds("app-update-progress").unwrap();
            let fill = cx.debug_bounds("app-update-progress-fill").unwrap();
            assert_eq!(progress.size.height, px(6.));
            assert!((fill.size.width - progress.size.width * 0.3).abs() < px(1.));
            assert!(progress.left() >= panel.left() && progress.right() <= panel.right());
            assert!(
                panel.left() >= px(0.) && panel.right() <= px(width),
                "{state:?}: {panel:?}"
            );
            assert!(
                panel.top() >= px(0.) && panel.bottom() <= px(height),
                "{state:?}: {panel:?}"
            );
            cx.update(|window, cx| {
                view.update(cx, |view, cx| view.dismiss_menu(window, cx));
                full_draw(window, cx).clear(cx);
            });
        }
    }
}

#[gpui::test]
fn qa_update_progress_actions_are_isolated_and_dismissible(cx: &mut gpui::TestAppContext) {
    use crate::{
        actions::{ShowUpdateDownloadPreview, ShowUpdateHomebrewPreview},
        updater::State,
    };
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        fixture_window(window, cx)
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    let before = view.read_with(cx, |view, _| view.updater.state().clone());
    for homebrew in [false, true] {
        cx.update(|window, cx| {
            window.focus(&view.read(cx).focus.clone(), cx);
            full_draw(window, cx).clear(cx);
        });
        cx.update(|window, cx| {
            if homebrew {
                window.dispatch_action(Box::new(ShowUpdateHomebrewPreview), cx);
            } else {
                window.dispatch_action(Box::new(ShowUpdateDownloadPreview), cx);
            }
        });
        cx.update(|window, cx| {
            full_draw(window, cx).clear(cx);
            let view = view.read(cx);
            assert_eq!(view.menu.page, Some(crate::menu::Page::AppUpdate));
            assert_eq!(view.updater.state(), &before);
            if homebrew {
                assert!(matches!(view.update_preview, Some(State::Upgrading { .. })));
            } else {
                assert_eq!(
                    view.update_preview,
                    Some(State::Downloading {
                        received: 50_000_000,
                        total: 100_000_000
                    })
                );
            }
        });
        let bar = cx.debug_bounds("app-update-progress").unwrap();
        let fill = cx.debug_bounds("app-update-progress-fill").unwrap();
        assert!(
            (fill.size.width - bar.size.width * if homebrew { 0.3 } else { 0.5 }).abs() < px(1.)
        );
        if homebrew {
            let close = cx.debug_bounds("app-update-close").unwrap();
            cx.simulate_click(close.center(), Default::default());
        } else {
            // Even Cancel belongs to the preview, never to the real worker.
            let cancel = cx.debug_bounds("app-update-action").unwrap();
            cx.simulate_click(cancel.center(), Default::default());
            assert_eq!(
                view.read_with(cx, |view, _| view.update_preview.clone()),
                Some(State::Idle)
            );
            cx.simulate_keystrokes("escape");
        }
        cx.update(|window, cx| {
            let view = view.read(cx);
            assert!(view.menu.page.is_none());
            assert!(view.update_preview.is_none());
            assert!(view.focus.is_focused(window));
            assert_eq!(view.updater.state(), &before);
        });
    }
}

#[gpui::test]
fn update_progress_tracks_downloads_and_keeps_verification_busy(cx: &mut gpui::TestAppContext) {
    use crate::updater::State;
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    let states = [
        (
            State::Downloading {
                received: 0,
                total: 100,
            },
            0.,
        ),
        (
            State::Downloading {
                received: 25,
                total: 100,
            },
            0.25,
        ),
        (
            State::Downloading {
                received: 75,
                total: 100,
            },
            0.75,
        ),
        (
            State::Downloading {
                received: 100,
                total: 100,
            },
            0.3,
        ),
        (
            State::Downloading {
                received: u64::MAX,
                total: 100,
            },
            0.3,
        ),
        (
            State::Downloading {
                received: 25,
                total: 0,
            },
            0.3,
        ),
        (State::Checking, 0.3),
        (State::Installing, 0.3),
        (State::Cancelling, 0.3),
        (
            State::Ready {
                version: "9999.0.0".into(),
            },
            1.,
        ),
        (
            State::Restart {
                version: "9999.0.0".into(),
            },
            1.,
        ),
    ];
    for (width, height) in [(320., 360.), (800., 600.)] {
        cx.simulate_resize(size(px(width), px(height)));
        for (state, fraction) in &states {
            let (panel, _) = draw_update_state(cx, &view, state);
            let progress = cx.debug_bounds("app-update-progress").unwrap();
            let fill = cx.debug_bounds("app-update-progress-fill").unwrap();
            assert!(progress.size.width > px(0.));
            assert_eq!(progress.size.height, px(6.));
            assert!(
                (fill.size.width - progress.size.width * *fraction).abs() < px(1.),
                "{state:?}"
            );
            assert!(progress.left() >= panel.left() && progress.right() <= panel.right());
            assert!(panel.top() >= px(0.) && panel.bottom() <= px(height));
        }
    }
}

#[gpui::test]
fn the_homebrew_update_states_stay_inside_the_panel(cx: &mut gpui::TestAppContext) {
    use crate::updater::State;
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    let disabled = cx.update(|_, cx| view.read(cx).updater.state().clone());
    let states = [
        State::Homebrew {
            version: "9999.0.0".into(),
        },
        State::Restart {
            version: "9999.0.0".into(),
        },
    ];
    for (width, height) in [(320., 360.), (320., 600.), (800., 600.)] {
        cx.simulate_resize(size(px(width), px(height)));
        for state in &states {
            let (panel, action) = draw_update_state(cx, &view, state);
            let action = action.unwrap();
            let footer = cx.debug_bounds("app-update-footer").unwrap();
            assert!(
                panel.left() >= px(0.) && panel.right() <= px(width),
                "{state:?}: {panel:?}"
            );
            assert!(
                panel.top() >= px(0.) && panel.bottom() <= px(height),
                "{state:?}: {panel:?}"
            );
            assert!(
                action.left() >= panel.left() && action.right() <= panel.right(),
                "{state:?}: {action:?}"
            );
            assert!(
                action.top() >= footer.top() && action.bottom() <= footer.bottom(),
                "{state:?}: {action:?}"
            );
            cx.simulate_click(action.center(), Default::default());
            // A preview click must never reach the real update service.
            cx.update(|_, cx| assert_eq!(view.read(cx).updater.state(), &disabled));
            cx.update(|window, cx| {
                view.update(cx, |view, cx| view.dismiss_menu(window, cx));
                full_draw(window, cx).clear(cx);
            });
        }
    }
}
