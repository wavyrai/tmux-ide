//! Native chrome and GitHub account access.
mod decorations;
mod status;
mod tabs;

pub(crate) use tabs::{Ends, strip_height};

use decorations::controls;
pub(crate) use decorations::frame;

use crate::{HerdrWindow, fonts::StyledFont, menu::Page};
use gpui::{prelude::*, *};

/// Avatar or signed-out GitHub icon. Smaller than the hit target, which stays a
/// comfortable size for the pointer.
const AVATAR: f32 = 20.;

/// Native chrome the window draws above its body; popups must clear it.
pub(super) const HEIGHT: f32 = 34.;

impl HerdrWindow {
    fn open_profile(&mut self, connect: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.menu.page != Some(Page::GitHub) && !self.open_menu(window, cx) {
            return;
        }
        self.menu.page = Some(Page::GitHub);
        // A device already covered by the main account opens the page rather
        // than starting a second sign-in for itself.
        if connect && self.pr_profile().is_none() && !self.github_auth().loading_profile() {
            self.start_github();
        }
        cx.notify();
    }

    /// Git actions for the focused checkout, left of the account slot. Hidden
    /// when no local checkout is tracked, so remote endpoints show no control
    /// that cannot act.
    ///
    /// One set of counts only, so two "+N -M" pairs can never sit side by side
    /// meaning different things. A branch with a prefetched pull request shows
    /// that pull request, exactly as its sidebar row does, and a badge when the
    /// checkout also has uncommitted work; the popup says how much. A branch
    /// without one shows what a commit would include right now.
    fn render_git_button(&self, cx: &mut Context<Self>) -> Option<Div> {
        self.git.tracked()?;
        let theme = &self.theme;
        let font = &self.config.ui;
        let background = rgb(theme.surface).blend(rgba(0xffffff1a));
        let status = self.git.status();
        let running = self.git.running().is_some();
        let pr = self.git_pull_request().map(|pr| {
            (
                format!("#{}", pr.number),
                pr.color(theme),
                pr.additions,
                pr.deletions,
                pr.url.clone(),
            )
        });
        Some(
            div()
                .debug_selector(|| "titlebar-git-slot".into())
                .flex()
                .items_center()
                .flex_none()
                .h_full()
                .pr(px(2.))
                .gap(px(4.))
                .text_font(font)
                .text_size(px(font.size))
                .text_color(rgb(theme.foreground))
                .map(|button| match pr {
                    Some((number, color, additions, deletions, url)) => button
                        .child(
                            div()
                                .id("titlebar-git-pr-link")
                                .debug_selector(|| "titlebar-git-pr-link".into())
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .h(px(24.))
                                .px(px(6.))
                                .rounded(px(crate::config::corners::CONTROL))
                                .cursor_pointer()
                                .hover(|link| {
                                    link.bg(background.blend(rgba((theme.foreground << 8) | 0x14)))
                                })
                                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                .on_click(move |_, _, cx| {
                                    cx.stop_propagation();
                                    cx.open_url(&url);
                                })
                                .child(
                                    div()
                                        .debug_selector(|| "titlebar-git-pr".into())
                                        .text_color(rgb(color))
                                        .child(number),
                                )
                                .child(
                                    div()
                                        .debug_selector(|| "titlebar-git-pr-lines".into())
                                        .flex()
                                        .child(
                                            div()
                                                .debug_selector(|| {
                                                    "titlebar-git-pr-additions".into()
                                                })
                                                .text_color(rgb(theme.ink(theme.palette[2])))
                                                .child(format!(
                                                    "+{}",
                                                    crate::sidebar::compact(additions)
                                                )),
                                        )
                                        .child(div().text_color(rgb(theme.muted)).child("/"))
                                        .child(
                                            div()
                                                .debug_selector(|| {
                                                    "titlebar-git-pr-deletions".into()
                                                })
                                                .text_color(rgb(theme.ink(theme.palette[1])))
                                                .child(format!(
                                                    "-{}",
                                                    crate::sidebar::compact(deletions)
                                                )),
                                        ),
                                ),
                        )
                        // The pull request's churn is history; the badge
                        // says work is still sitting in the checkout.
                        .when(status.is_some_and(|status| status.dirty()), |button| {
                            button.child(
                                crate::icons::uncommitted(theme, 18.)
                                    .debug_selector(|| "titlebar-git-dirty".into()),
                            )
                        }),
                    None => button.when_some(
                        status.filter(|status| status.dirty()),
                        |button, status| {
                            button
                                .when(status.additions > 0, |button| {
                                    button.child(
                                        div()
                                            .debug_selector(|| "titlebar-git-additions".into())
                                            .text_color(rgb(theme.ink(theme.palette[2])))
                                            .child(format!("+{}", status.additions)),
                                    )
                                })
                                .when(status.deletions > 0, |button| {
                                    button.child(
                                        div()
                                            .debug_selector(|| "titlebar-git-deletions".into())
                                            .text_color(rgb(theme.ink(theme.palette[1])))
                                            .child(format!("-{}", status.deletions)),
                                    )
                                })
                                .child(
                                    crate::icons::uncommitted(theme, 18.)
                                        .debug_selector(|| "titlebar-git-dirty".into()),
                                )
                        },
                    ),
                })
                .child(
                    div()
                        .id("titlebar-git")
                        .debug_selector(|| "titlebar-git".into())
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .h(px(24.))
                        .px(px(6.))
                        .rounded(px(crate::config::corners::CONTROL))
                        .cursor_pointer()
                        .hover(|button| {
                            button.bg(background.blend(rgba((theme.foreground << 8) | 0x14)))
                        })
                        .child(
                            svg()
                                .path("icons/git-branch.svg")
                                .size(px(14.))
                                .flex_none()
                                .text_color(rgb(if running {
                                    theme.ink(theme.palette[3])
                                } else {
                                    theme.muted
                                })),
                        )
                        .child(
                            svg()
                                .path("icons/chevron-down.svg")
                                .size(px(12.))
                                .flex_none()
                                .text_color(rgb(theme.muted)),
                        )
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, event: &MouseDownEvent, window, cx| {
                                cx.stop_propagation();
                                this.open_git_menu(event.position, window, cx);
                            }),
                        ),
                ),
        )
    }

    pub(super) fn render_titlebar(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        // The toggle leads the bar so it stays put whether or not the sidebar
        // below it is showing, and can always bring the sidebar back.
        render(self.theme.surface, Some(self.sidebar_toggle(cx)), window)
            .child(
                div()
                    .debug_selector(|| "titlebar-center".into())
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .when(self.config.usage.topbar, |center| {
                        center.child(status::render(&self.live, &self.config.ui, &self.theme))
                    }),
            )
            .child(self.titlebar_end(window, cx))
    }

    fn sidebar_toggle(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("toggle-sidebar")
            .debug_selector(|| "toggle-sidebar".into())
            .flex_none()
            .self_center()
            .mr(px(4.))
            .size(px(28.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(crate::config::corners::CONTROL))
            .cursor_pointer()
            .hover(|style| style.bg(rgb(self.theme.active)))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|this, _, window, cx| {
                cx.stop_propagation();
                this.command(crate::controls::Command::ToggleSidebar, window, cx);
            }))
            .child(sidebar_glyph(self.sidebar_visible, &self.theme))
            .into_any_element()
    }

    /// What ends the bar: git actions, the account, and the window controls
    /// a client-decorated window draws.
    fn titlebar_end(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let image = self.pr_profile().and_then(|p| p.avatar.clone());
        div()
            .flex()
            .flex_none()
            .items_center()
            .children(self.render_git_button(cx))
            .child(
                div()
                    .debug_selector(|| "titlebar-account-slot".into())
                    .flex()
                    .items_center()
                    .justify_center()
                    .flex_none()
                    .w(px(40.))
                    .h_full()
                    .child(
                        div()
                            .id("titlebar-avatar")
                            .group("titlebar-account")
                            .debug_selector(|| "titlebar-avatar".into())
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(28.))
                            .rounded_full()
                            .cursor_pointer()
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.open_profile(true, window, cx);
                            }))
                            .on_mouse_down(
                                MouseButton::Right,
                                cx.listener(|this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.open_profile(false, window, cx);
                                }),
                            )
                            .child(
                                div()
                                    .debug_selector(|| "titlebar-avatar-circle".into())
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(AVATAR))
                                    .rounded_full()
                                    .group_hover("titlebar-account", |s| {
                                        s.shadow(vec![BoxShadow {
                                            color: rgba((self.theme.foreground << 8) | 0x38).into(),
                                            offset: point(px(0.), px(0.)),
                                            blur_radius: px(5.),
                                            spread_radius: px(1.),
                                            inset: false,
                                        }])
                                    })
                                    .map(|circle| match image {
                                        Some(image) => {
                                            circle.child(img(image).size(px(AVATAR)).rounded_full())
                                        }
                                        None => circle.child(
                                            svg()
                                                .path("icons/github.svg")
                                                .size(px(AVATAR))
                                                .text_color(rgb(self.theme.foreground)),
                                        ),
                                    }),
                            ),
                    ),
            )
            .children(controls(window, &self.theme, |window, _| {
                window.remove_window();
            }))
    }
}

/// `leading` sits right after the traffic lights, ahead of the draggable center.
pub(super) fn render(surface: u32, leading: Option<AnyElement>, window: &Window) -> Stateful<Div> {
    let bar = div()
        .id("titlebar")
        .debug_selector(|| "titlebar".into())
        .flex()
        .flex_none()
        .w_full()
        .h(px(HEIGHT))
        .bg(rgb(surface).blend(rgba(0xffffff1a)))
        .child(div().flex_none().w(px(LEADING)).h_full())
        .children(leading);
    movable(bar, window)
}

/// Makes `area` do a title bar's job: pressing it moves the window, and a
/// double-click acts as the platform's does. Its controls stop their own
/// presses so they never start a move.
///
/// macOS windows own titlebar dragging (`app_owns_titlebar_drag`), so AppKit
/// never moves the window from under a tab, and a client-decorated window has
/// nothing else to move it. A server-drawn frame moves the window from its own
/// title bar, so there `area` is left alone.
pub(crate) fn movable<E: InteractiveElement>(area: E, window: &Window) -> E {
    let client = decorations::client(window);
    if !cfg!(target_os = "macos") && !client {
        return area;
    }
    // The move starts on the press: pointer motion during a press is claimed
    // by window-level drag handlers (selection, splits) before it bubbles up.
    let supported = window.window_controls();
    let area = area.on_mouse_down(MouseButton::Left, move |event, window, _| {
        match event.click_count {
            2 if !client => window.titlebar_double_click(),
            2 if supported.maximize => window.zoom_window(),
            _ => window.start_window_move(),
        }
    });
    if client && supported.window_menu {
        area.on_mouse_down(MouseButton::Right, |event, window, _| {
            window.show_window_menu(event.position);
        })
    } else {
        area
    }
}

/// The bar a secondary window shows: macOS always draws one under its
/// transparent titlebar, and a client-decorated window needs one to be moved
/// and closed at all. Elsewhere the platform frame already provides both.
pub(crate) fn header(
    theme: &crate::config::Theme,
    window: &Window,
    close: impl Fn(&mut Window, &mut App) + 'static,
) -> Option<Stateful<Div>> {
    (cfg!(target_os = "macos") || decorations::client(window)).then(|| {
        let buttons = controls(window, theme, close);
        render(theme.surface, None, window).children(buttons)
    })
}

/// Room before the first control: macOS keeps it clear for the traffic
/// lights, which every other platform draws elsewhere or not at all.
const LEADING: f32 = if cfg!(target_os = "macos") { 80. } else { 8. };

pub(super) fn options(title: &str) -> TitlebarOptions {
    TitlebarOptions {
        title: Some(title.to_owned().into()),
        appears_transparent: cfg!(target_os = "macos"),
        traffic_light_position: cfg!(target_os = "macos").then(|| point(px(9.), px(9.))),
    }
}

/// A window with its sidebar panel, filled while the sidebar is expanded.
pub(crate) fn sidebar_glyph(expanded: bool, theme: &crate::config::Theme) -> Div {
    div()
        .w(px(18.))
        .h(px(14.))
        .flex_none()
        .border_1()
        .border_color(rgb(theme.foreground))
        .rounded(px(2.))
        .child(
            div()
                .w(px(5.))
                .h_full()
                .border_r_1()
                .border_color(rgb(theme.foreground))
                .when(expanded, |bar| bar.bg(rgb(theme.foreground))),
        )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use crate::menu::Page;
    use gpui::{
        Bounds, Context, Modifiers, MouseButton, MouseDownEvent, TestAppContext, Window, point, px,
        size,
    };

    /// The fixture window with Herdr's tab bar at the bottom, so it keeps the
    /// full-width header these tests measure.
    pub(crate) fn header_window(
        window: &mut Window,
        cx: &mut Context<crate::HerdrWindow>,
    ) -> crate::HerdrWindow {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.settings.shared = Some(
            crate::herdr_settings::Settings::parse_text("[ui]\ntab_bar_position = 'bottom'")
                .unwrap(),
        );
        view
    }

    #[gpui::test]
    fn sidebar_button_collapses_and_reopens_without_moving(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(header_window);
        for width in [1200., 360.] {
            cx.simulate_resize(size(px(width), px(600.)));
            for visible in [true, false] {
                cx.update(|window, cx| {
                    window.refresh();
                    window.draw(cx).clear(cx);
                });
                assert_eq!(view.read_with(cx, |view, _| view.sidebar_visible), visible);
                assert_eq!(cx.debug_bounds("sidebar").is_some(), visible);
                let button = cx.debug_bounds("toggle-sidebar").unwrap();
                assert_eq!(button.origin.x, px(super::LEADING));
                assert_eq!(button.size, size(px(28.), px(28.)));
                cx.simulate_click(button.center(), Modifiers::default());
            }
            assert!(view.read_with(cx, |view, _| view.sidebar_visible));
        }
    }

    #[gpui::test]
    fn account_icon_keeps_the_same_bounds_when_signed_out_failed_or_connected(
        cx: &mut TestAppContext,
    ) {
        let (view, cx) = cx.add_window_view(header_window);
        for width in [1200., 360.] {
            cx.simulate_resize(size(px(width), px(400.)));
            for state in 0..4 {
                cx.update(|_, cx| {
                    view.update(cx, |view, cx| {
                        view.menu.github = match state {
                            2 => crate::github::Auth::fixture(true),
                            3 => crate::github::Auth::connected_fixture(),
                            _ => crate::github::Auth::default(),
                        };
                        view.menu.github.failed = state == 1;
                        if let Some(profile) = view.menu.github.profile.as_mut() {
                            profile.avatar = Some(std::sync::Arc::new(gpui::Image::from_bytes(
                                gpui::ImageFormat::Svg,
                                include_bytes!("../../../assets/icons/user.svg").to_vec(),
                            )));
                        }
                        cx.notify();
                    });
                });
                for hovered in [false, true] {
                    cx.update(|window, cx| {
                        window.refresh();
                        let _ = window.draw(cx);
                    });
                    let hit = cx.debug_bounds("titlebar-avatar").unwrap();
                    cx.simulate_event(gpui::MouseMoveEvent {
                        position: if hovered {
                            hit.center()
                        } else {
                            point(px(100.), px(100.))
                        },
                        ..Default::default()
                    });
                    cx.update(|window, cx| {
                        window.refresh();
                        let _ = window.draw(cx);
                    });
                    let icon = cx.debug_bounds("titlebar-avatar-circle").unwrap();
                    assert_eq!(icon.size, size(px(super::AVATAR), px(super::AVATAR)));
                    assert_eq!(icon.center(), hit.center());
                    assert_eq!(hit.size, size(px(28.), px(28.)));
                }
            }
        }
    }

    #[gpui::test]
    fn profile_slot_bounds_and_context_menu_do_not_start_auth(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(header_window);
        for (width, height) in [(1200., 780.), (640., 400.), (360., 400.)] {
            cx.simulate_resize(size(px(width), px(height)));
            cx.run_until_parked();
            cx.update(|window, cx| {
                window.refresh();
                let _ = window.draw(cx);
            });
            assert_eq!(
                cx.debug_bounds("titlebar").unwrap(),
                Bounds::new(point(px(0.), px(0.)), size(px(width), px(34.)))
            );
            assert_eq!(
                cx.debug_bounds("titlebar-avatar").unwrap(),
                Bounds::new(point(px(width - 34.), px(3.)), size(px(28.), px(28.)))
            );
            let banner_height = if env!("HERDR_BUILD_WORKTREE") == "1" {
                22.
            } else {
                0.
            };
            assert_eq!(
                cx.debug_bounds("window-body").unwrap().top(),
                px(34. + banner_height)
            );
        }
        let bounds = cx.debug_bounds("titlebar-avatar").unwrap();
        cx.simulate_event(MouseDownEvent {
            button: MouseButton::Right,
            position: bounds.center(),
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        });
        cx.update(|_, cx| {
            let view = view.read(cx);
            assert!(view.menu.page == Some(Page::GitHub));
            assert!(!view.menu.github.busy());
            assert!(!view.menu.github.loading_profile());
        });
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.dismiss_menu(window, cx);
                view.menu.github = crate::github::Auth::connected_fixture();
                view.open_profile(true, window, cx);
                assert!(view.menu.github.connected());
                assert!(!view.menu.github.busy());
            })
        });
    }
}

#[cfg(test)]
mod git_button_tests;

#[cfg(all(test, target_os = "macos"))]
#[allow(clippy::unwrap_used)]
mod native_chrome_tests {
    use gpui::{Bounds, TestAppContext, point, px, size};

    #[gpui::test]
    fn header_bounds_above_body_in_windowed_and_fullscreen(cx: &mut TestAppContext) {
        let (_, cx) = cx.add_window_view(super::tests::header_window);
        for fullscreen in [false, true, false] {
            cx.update(|window, _| {
                if window.is_fullscreen() != fullscreen {
                    window.toggle_fullscreen();
                }
                assert_eq!(window.is_fullscreen(), fullscreen);
            });
            for (width, height) in [(1200., 780.), (640., 400.), (360., 400.)] {
                cx.simulate_resize(size(px(width), px(height)));
                cx.run_until_parked();
                cx.update(|window, cx| {
                    window.refresh();
                    let _ = window.draw(cx);
                });
                assert_eq!(
                    cx.debug_bounds("titlebar").unwrap(),
                    Bounds::new(point(px(0.), px(0.)), size(px(width), px(34.)))
                );
                assert_eq!(
                    cx.debug_bounds("titlebar-account-slot").unwrap(),
                    Bounds::new(point(px(width - 40.), px(0.)), size(px(40.), px(34.)))
                );
                assert_eq!(
                    cx.debug_bounds("titlebar-avatar").unwrap(),
                    Bounds::new(point(px(width - 34.), px(3.)), size(px(28.), px(28.)))
                );
                assert_eq!(
                    cx.debug_bounds("titlebar-avatar-circle").unwrap(),
                    Bounds::new(point(px(width - 30.), px(7.)), size(px(20.), px(20.)))
                );
                // Signing in swaps the placeholder for the avatar, which sits
                // inside the same hit target rather than filling it.
                let view =
                    cx.update(|window, _| window.root::<crate::HerdrWindow>().unwrap().unwrap());
                cx.update(|_, cx| {
                    view.update(cx, |view, cx| {
                        view.menu.github = crate::github::Auth::connected_fixture();
                        if let Some(profile) = view.menu.github.profile.as_mut() {
                            profile.avatar = Some(std::sync::Arc::new(gpui::Image::from_bytes(
                                gpui::ImageFormat::Svg,
                                include_bytes!("../../../assets/icons/user.svg").to_vec(),
                            )));
                        }
                        cx.notify();
                    })
                });
                cx.update(|window, cx| {
                    window.refresh();
                    let _ = window.draw(cx);
                });
                let hit = cx.debug_bounds("titlebar-avatar").unwrap();
                let circle = cx.debug_bounds("titlebar-avatar-circle").unwrap();
                assert_eq!(circle.size, size(px(super::AVATAR), px(super::AVATAR)));
                assert_eq!(circle.center(), hit.center());
                assert!(circle.size.width < hit.size.width);
                cx.update(|_, cx| {
                    view.update(cx, |view, cx| {
                        view.menu.github = Default::default();
                        cx.notify();
                    })
                });
                cx.update(|window, cx| {
                    window.refresh();
                    let _ = window.draw(cx);
                });
                assert_eq!(
                    cx.debug_bounds("titlebar-center").unwrap(),
                    Bounds::new(point(px(112.), px(0.)), size(px(width - 152.), px(34.)))
                );
                let body = cx.debug_bounds("window-body").unwrap();
                let banner_height = if env!("HERDR_BUILD_WORKTREE") == "1" {
                    22.
                } else {
                    0.
                };
                assert_eq!(body.top(), px(34. + banner_height));
                assert_eq!(body.size.width, px(width));
                assert!(body.bottom() <= px(height));
            }
        }
    }
}
