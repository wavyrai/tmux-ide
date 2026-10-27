//! Classic macOS-style About box: build identity only. It reads embedded build
//! constants, never the daemon or the network; links open in the browser.
use crate::{HerdrWindow, menu::Page};
use gpui::{prelude::*, *};
use std::sync::{Arc, LazyLock};

pub(super) const WEBSITE: &str = "https://herdr.dev/";
pub(super) const REPOSITORY: &str = "https://github.com/penso/herdr-gpui";
const COPYRIGHT_YEAR: &str = "© 2026";
const AUTHOR: &str = "Fabien Penso";
const AUTHOR_URL: &str = "https://pen.so";
const TWITTER_URL: &str = "https://x.com/fabienpenso";
const LICENSE: &str = "· Apache-2.0";
const SUMMARY: &str = "Native client for an existing local Herdr daemon.";
const UNAFFILIATED: &str = "An independent project, not affiliated with or endorsed by herdr.dev.";

static ICON: LazyLock<Arc<Image>> = LazyLock::new(|| {
    Arc::new(Image::from_bytes(
        ImageFormat::Png,
        crate::app_icon::PNG.to_vec(),
    ))
});

impl HerdrWindow {
    pub(super) fn open_about(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open_menu(window, cx) {
            return;
        }
        self.menu.page = Some(Page::About);
    }

    pub(super) fn render_about(&self, cx: &mut Context<Self>) -> Div {
        let font = &self.config.ui;
        let theme = &self.theme;
        let muted = rgb(theme.muted);
        div()
            .debug_selector(|| "about".into())
            .flex()
            .flex_col()
            .items_center()
            .gap(px(6.))
            .px(px(24.))
            .py(px(28.))
            .text_center()
            .child(
                div()
                    .debug_selector(|| "about-icon".into())
                    .size(px(96.))
                    .mb(px(6.))
                    .child(img(ICON.clone()).size_full()),
            )
            .child(
                div()
                    .debug_selector(|| "about-name".into())
                    .text_size(px(font.size * 1.8))
                    .line_height(px(font.size * 2.2))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Herdr"),
            )
            .child(
                div()
                    .debug_selector(|| "about-version".into())
                    .text_color(muted)
                    .child(format!("Version {}", crate::APP_VERSION)),
            )
            .child(
                div()
                    .debug_selector(|| "about-summary".into())
                    .pt(px(6.))
                    .text_color(muted)
                    .child(SUMMARY),
            )
            .child(
                div()
                    .debug_selector(|| "about-unaffiliated".into())
                    .pt(px(4.))
                    .text_size(px(font.size * 0.85))
                    .text_color(muted)
                    .child(UNAFFILIATED),
            )
            .children(self.render_about_build(theme))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(16.))
                    .pt(px(10.))
                    .child(self.about_link("about-website", "herdr.dev", WEBSITE))
                    .child(self.about_link("about-repository", "GitHub", REPOSITORY)),
            )
            .child(
                div()
                    .debug_selector(|| "about-copyright".into())
                    .flex()
                    .items_center()
                    .gap(px(3.))
                    .pt(px(10.))
                    .text_size(px(font.size * 0.85))
                    .text_color(muted)
                    .child(COPYRIGHT_YEAR)
                    .child(self.about_link("about-author", AUTHOR, AUTHOR_URL))
                    .child(
                        self.about_link(
                            "about-twitter",
                            svg()
                                .path("icons/x.svg")
                                .size(px(font.size * 0.85))
                                .text_color(crate::menu::accent(theme)),
                            TWITTER_URL,
                        ),
                    )
                    .child(LICENSE),
            )
            .child(
                div()
                    .id("about-close")
                    .debug_selector(|| "about-close".into())
                    .mt(px(14.))
                    .px(px(16.))
                    .py(px(6.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .border_1()
                    .border_color(rgb(theme.active))
                    .bg(rgb(theme.active))
                    .cursor_pointer()
                    .child("OK")
                    .on_click(cx.listener(|this, _, window, cx| {
                        cx.stop_propagation();
                        this.dismiss_menu(window, cx);
                    })),
            )
    }

    /// Worktree builds are throwaway; name the branch that produced this one.
    fn render_about_build(&self, theme: &crate::config::Theme) -> Option<Div> {
        (env!("HERDR_BUILD_WORKTREE") == "1").then(|| {
            let pr = env!("HERDR_BUILD_PR");
            div()
                .debug_selector(|| "about-build".into())
                .flex()
                .items_center()
                .gap(px(8.))
                .pt(px(6.))
                .max_w_full()
                .text_size(px(self.config.ui.size * 0.85))
                .text_color(rgb(theme.muted))
                .child(
                    div()
                        .debug_selector(|| "about-branch".into())
                        .min_w_0()
                        .truncate()
                        .child(env!("HERDR_BUILD_BRANCH")),
                )
                .when(!pr.is_empty(), |row| {
                    row.child(self.about_link(
                        "about-pr",
                        format!("PR #{pr}"),
                        crate::worktree_banner::pull_request_url(pr),
                    ))
                })
        })
    }

    fn about_link(
        &self,
        id: &'static str,
        label: impl IntoElement,
        url: impl Into<String>,
    ) -> Stateful<Div> {
        let url = url.into();
        div()
            .id(id)
            .debug_selector(move || id.into())
            .flex_none()
            .flex()
            .items_center()
            .cursor_pointer()
            .text_color(crate::menu::accent(&self.theme))
            .border_b_1()
            .border_color(transparent_black())
            .hover(|style| style.border_color(crate::menu::accent(&self.theme)))
            .child(label)
            .on_click(move |_, _, cx| {
                cx.stop_propagation();
                cx.open_url(&url);
            })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use core::prelude::v1::test;

    /// The visible copyright must not drift from the repository's NOTICE.
    #[test]
    fn copyright_tracks_the_repository_notice() {
        let notice = include_str!("../../../NOTICE");
        let holder = notice
            .lines()
            .find_map(|line| line.strip_prefix("Copyright "))
            .unwrap();
        let copyright = format!("{COPYRIGHT_YEAR} {AUTHOR} {LICENSE}");
        assert!(copyright.contains(holder), "{copyright} lacks {holder}");
        assert!(notice.contains("Apache License, Version 2.0"));
        assert!(LICENSE.contains("Apache-2.0"));
    }

    /// Classic macOS puts About first in the application menu, above a separator.
    #[test]
    fn about_leads_the_application_menu() {
        let menus = crate::menus(Default::default());
        let application = menus.first().unwrap();
        assert_eq!(application.name.as_ref(), "Herdr");
        let MenuItem::Action { name, action, .. } = application.items.first().unwrap() else {
            panic!("the application menu must start with an action");
        };
        assert_eq!(name.as_ref(), "About Herdr");
        assert!(action.partial_eq(&crate::RunCommand {
            command: crate::controls::Command::About,
        }));
        assert!(matches!(application.items[1], MenuItem::Separator));
        assert!(matches!(
            application.items.last().unwrap(),
            MenuItem::Action { name, .. } if name.as_ref() == "Quit Herdr"
        ));
    }

    #[gpui::test]
    fn about_box_shows_build_identity_and_opens_links(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
        for width in [800., 360.] {
            cx.update(|window, cx| view.update(cx, |view, cx| view.open_about(window, cx)));
            cx.simulate_resize(size(px(width), px(600.)));
            cx.update(|window, cx| window.draw(cx).clear(cx));
            let about = cx.debug_bounds("about").unwrap();
            let icon = cx.debug_bounds("about-icon").unwrap();
            let name = cx.debug_bounds("about-name").unwrap();
            let version = cx.debug_bounds("about-version").unwrap();
            let disclaimer = cx.debug_bounds("about-unaffiliated").unwrap();
            let copyright = cx.debug_bounds("about-copyright").unwrap();
            let close = cx.debug_bounds("about-close").unwrap();
            assert_eq!(icon.size, size(px(96.), px(96.)));
            for row in [icon, name, version, disclaimer, copyright, close] {
                assert!(row.top() >= about.top() && row.bottom() <= about.bottom());
                assert!(row.left() >= about.left() && row.right() <= about.right());
            }
            assert!(icon.bottom() <= name.top());
            assert!(name.bottom() <= version.top());
            assert!(version.bottom() <= disclaimer.top());
            assert!(disclaimer.bottom() <= copyright.top());
            assert!(copyright.bottom() <= close.top());
            assert!(about.right() <= px(width));
            assert_eq!(
                cx.debug_bounds("about-build").is_some(),
                env!("HERDR_BUILD_WORKTREE") == "1"
            );

            for (selector, url) in [
                ("about-website", WEBSITE.to_owned()),
                ("about-repository", REPOSITORY.to_owned()),
                ("about-author", "https://pen.so".to_owned()),
                ("about-twitter", "https://x.com/fabienpenso".to_owned()),
            ] {
                let link = cx.debug_bounds(selector).unwrap();
                cx.simulate_click(link.center(), Modifiers::default());
                assert_eq!(cx.opened_url(), Some(url));
                view.read_with(cx, |view, _| {
                    assert_eq!(view.menu.page, Some(Page::About));
                });
            }

            // Both the OK button and Escape close the box without other effects.
            cx.simulate_click(close.center(), Modifiers::default());
            view.read_with(cx, |view, _| assert!(view.menu.page.is_none()));
            cx.update(|window, cx| view.update(cx, |view, cx| view.open_about(window, cx)));
            cx.update(|window, cx| window.draw(cx).clear(cx));
            cx.simulate_keystrokes("escape");
            view.read_with(cx, |view, _| assert!(view.menu.page.is_none()));
        }
    }

    #[gpui::test]
    fn the_in_app_menu_opens_the_about_box(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
        cx.simulate_resize(size(px(800.), px(600.)));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                // Anchor the popup to the status bar so the row is on screen.
                view.menu.anchor = point(px(60.), px(560.));
                view.open_menu(window, cx);
            })
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let row = cx.debug_bounds("menu-about").unwrap();
        cx.simulate_click(row.center(), Modifiers::default());
        view.read_with(cx, |view, _| assert_eq!(view.menu.page, Some(Page::About)));
    }
}
