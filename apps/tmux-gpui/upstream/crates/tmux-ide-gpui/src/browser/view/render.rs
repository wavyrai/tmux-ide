//! Drawing browser tabs: their entries in a group's strip, and the page with
//! its toolbar where the terminal would be.

use super::{store, tab_label};
use crate::{
    HerdrWindow,
    browser::{
        Location, Store, Tab, TabId, WebUrl,
        groups::{GroupId, Pick, Slot},
    },
    listening_ports::Link,
    window::Flash,
};
use gpui::{prelude::*, *};

impl HerdrWindow {
    /// The workspace's browser tabs, after its Herdr tabs in a group's strip.
    pub(crate) fn browser_tab_entries(
        &self,
        slot: Slot,
        shown: Option<TabId>,
        cx: &mut Context<Self>,
    ) -> Vec<(TabId, Stateful<Div>)> {
        let (Some((scope, workspace)), Some(store)) = (self.browser_key(), store(cx)) else {
            return Vec::new();
        };
        let tabs: Vec<Tab> = store
            .in_workspace(&scope, &workspace)
            .filter(|tab| self.group_lists(slot.id, &Pick::Page(tab.id)))
            .cloned()
            .collect();
        tabs.into_iter()
            .map(|tab| {
                let id = tab.id;
                let (background, text) = self.tab_colors(shown == Some(id), slot.id);
                // A review tab shows a diff, not a page.
                let icon = if tab
                    .location
                    .as_ref()
                    .is_some_and(|location| !location.is_page())
                {
                    "icons/diff-unified.svg"
                } else {
                    "icons/globe.svg"
                };
                let tab = div()
                    .id(SharedString::from(format!("browser-tab-{id}")))
                    .debug_selector(move || slot.selector(&format!("browser-tab-{id}")))
                    .pl(px(10.))
                    .pr(px(3.))
                    .py(px(2.))
                    .min_w(px(crate::TAB_WIDTH))
                    .map(|tab| self.grow_tab(tab, slot.id, &Pick::Page(id)))
                    .border_r_1()
                    .border_color(rgb(self.theme.active))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .cursor_pointer()
                    .bg(rgb(background))
                    .text_color(rgb(text))
                    .child(
                        svg()
                            .path(icon)
                            .size(px(12.))
                            .flex_none()
                            .text_color(rgb(text)),
                    )
                    .child(tab_label(&tab.title))
                    .child(
                        div()
                            .id("close-browser-tab")
                            .debug_selector(move || {
                                slot.selector(&format!("close-browser-tab-{id}"))
                            })
                            .size(px(18.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(crate::config::corners::CONTROL))
                            .hover(move |s| s.bg(rgba((text << 8) | 0x24)))
                            .child(
                                svg()
                                    .path("icons/close.svg")
                                    .size(px(12.))
                                    .text_color(rgb(text)),
                            )
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            // Split, the page closes in its group alone.
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.close_strip_tab(slot.id, Pick::Page(id), window, cx);
                            })),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.show_browser_tab_in(Some(slot.id), id, window, cx);
                    }));
                (id, tab)
            })
            .collect()
    }

    fn toolbar_button(
        &self,
        slot: Slot,
        id: &'static str,
        icon: &'static str,
        enabled: bool,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> Stateful<Div> {
        let color = if enabled {
            self.theme.foreground
        } else {
            self.theme.muted
        };
        div()
            .id(id)
            .debug_selector(move || slot.selector(id))
            .size(px(24.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(crate::config::corners::CONTROL))
            .when(enabled, |button| {
                button
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(self.theme.active)))
                    .on_click(cx.listener(move |this, _, window, cx| action(this, window, cx)))
            })
            .child(svg().path(icon).size(px(14.)).text_color(rgb(color)))
    }

    /// The page with its toolbar, drawn in a group where the terminal would
    /// be. `keyboard` marks the one element holding the window's focus
    /// handle when no terminal is drawn to hold it.
    pub(crate) fn render_browser(
        &mut self,
        slot: Slot,
        tab: &Tab,
        gap: f32,
        keyboard: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = tab.id;
        let loaded = tab.location.is_some();
        let external = match &tab.location {
            Some(Location::Web { url }) => Some(url.clone()),
            _ => None,
        };
        #[cfg(any(target_os = "macos", windows))]
        let (annotate_button, panel) = {
            let annotating = self.browser.annotations.armed(id);
            // The panel slides open and closed beside the page: its content
            // keeps its width and the edge moves.
            let shown = self
                .browser
                .annotations
                .panel_shown(id, std::time::Instant::now());
            let panel = (shown > 0.).then(|| {
                div()
                    .flex_none()
                    .h_full()
                    .w(px(self.notes_panel_width() * shown))
                    .overflow_hidden()
                    .child(self.render_annotations(tab, cx))
                    .into_any_element()
            });
            let button = {
                // Annotating needs the page itself, so a blank tab or a
                // build without pages has nothing to annotate.
                let enabled = loaded && crate::browser::EMBEDDED;
                let color = if annotating {
                    self.theme.text_on(self.theme.primary_wash())
                } else if enabled {
                    self.theme.foreground
                } else {
                    self.theme.muted
                };
                div()
                    .id("browser-annotate")
                    .debug_selector(move || slot.selector("browser-annotate"))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .h(px(24.))
                    .px(px(6.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .when(annotating, |button| {
                        button.bg(rgb(self.theme.primary_wash()))
                    })
                    .text_color(rgb(color))
                    .child(
                        svg()
                            .path("icons/pencil.svg")
                            .size(px(13.))
                            .text_color(rgb(color)),
                    )
                    .child("Annotate")
                    .when(enabled, |button| {
                        button
                            .cursor_pointer()
                            .hover(|s| s.bg(rgb(self.theme.active)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.toggle_annotating(id, window, cx);
                            }))
                    })
            };
            (Some(button), panel)
        };
        // Linux builds show no pages, so there is nothing to annotate.
        #[cfg(not(any(target_os = "macos", windows)))]
        let (annotate_button, panel): (Option<Stateful<Div>>, Option<AnyElement>) = (None, None);
        #[cfg(any(target_os = "macos", windows))]
        let page = self.browser.pages.page(id).cloned();
        #[cfg(not(any(target_os = "macos", windows)))]
        let page: Option<AnyView> = None;
        let failure = self
            .browser
            .failed
            .as_ref()
            .filter(|(failed, _)| *failed == id)
            .map(|(_, message)| message.clone());
        let placeholder: SharedString = match (&failure, loaded) {
            (Some(message), _) => format!("Could not show this page: {message}").into(),
            (None, false) => "Type an address above and press Return.".into(),
            (None, true) if !crate::browser::EMBEDDED => {
                "This build cannot show pages in the window; open it in the system browser.".into()
            }
            (None, true) => "Loading\u{2026}".into(),
        };
        let toolbar = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .px(px(6.))
            .py(px(4.))
            .bg(rgb(self.theme.surface))
            .border_b_1()
            .border_color(rgb(self.theme.active))
            .child(self.toolbar_button(
                slot,
                "browser-back",
                "icons/arrow-left.svg",
                loaded,
                cx,
                move |this, _, cx| {
                    #[cfg(any(target_os = "macos", windows))]
                    this.browser.pages.back(id, cx);
                    #[cfg(not(any(target_os = "macos", windows)))]
                    let _ = (this, cx);
                },
            ))
            .child(self.toolbar_button(
                slot,
                "browser-forward",
                "icons/arrow-right.svg",
                loaded,
                cx,
                move |this, _, cx| {
                    #[cfg(any(target_os = "macos", windows))]
                    this.browser.pages.forward(id, cx);
                    #[cfg(not(any(target_os = "macos", windows)))]
                    let _ = (this, cx);
                },
            ))
            .child(self.toolbar_button(
                slot,
                "browser-reload",
                "icons/refresh.svg",
                loaded,
                cx,
                move |this, _, cx| {
                    #[cfg(any(target_os = "macos", windows))]
                    this.browser.pages.reload(id, cx);
                    #[cfg(not(any(target_os = "macos", windows)))]
                    let _ = (this, cx);
                },
            ))
            .child(
                div()
                    .id("browser-address")
                    .debug_selector(move || slot.selector("browser-address"))
                    .flex_1()
                    .min_w_0()
                    .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                        match event.keystroke.key.as_str() {
                            "enter" => this.submit_address(slot.id, id, window, cx),
                            "escape" => {
                                let tab = store(cx).and_then(|store| store.get(id)).cloned();
                                this.sync_address(slot.id, tab.as_ref(), true, window, cx);
                                window.focus(&this.focus, cx);
                            }
                            _ => return,
                        }
                        cx.stop_propagation();
                    }))
                    .child(self.group_address(slot.id, cx)),
            )
            // A split shows the window's flash once, in the group in use.
            .children(
                self.flash
                    .as_ref()
                    .filter(|_| Some(slot.id) == self.active_group())
                    .map(|(flash, _)| {
                        div()
                            .flex_none()
                            .max_w(px(240.))
                            .truncate()
                            .text_color(rgb(flash.accent(&self.theme)))
                            .child(flash.text.clone())
                    }),
            )
            .children(annotate_button)
            .child(self.toolbar_button(
                slot,
                "browser-external",
                "icons/external.svg",
                external.is_some(),
                cx,
                move |_, _, cx| {
                    if let Some(url) = &external {
                        cx.open_url(url.as_str());
                    }
                },
            ));
        #[cfg(any(target_os = "macos", windows))]
        let (picture, bounds) = (self.frozen_picture(id), self.browser.page_bounds.clone());
        let content = match (page, &failure) {
            (Some(page), None) => div()
                .flex_1()
                .min_h_0()
                .relative()
                .child(page)
                // Where the page draws, so a menu hides only the pages it
                // covers; and, while one does, the page's picture in its place.
                .map(|content| {
                    #[cfg(any(target_os = "macos", windows))]
                    let content = content
                        .child(
                            canvas(
                                move |area, _, _| {
                                    bounds.borrow_mut().insert(id, area);
                                },
                                |_, _, _, _| {},
                            )
                            .absolute()
                            .inset_0(),
                        )
                        .children(picture.map(|picture| {
                            img(picture)
                                .debug_selector(|| "page-picture".into())
                                .absolute()
                                .inset_0()
                                .size_full()
                        }));
                    content
                })
                .into_any_element(),
            _ => div()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .flex_col()
                .gap(px(10.))
                .px_4()
                .text_color(rgb(self.theme.muted))
                .child(
                    div()
                        .debug_selector(move || slot.selector("browser-placeholder"))
                        .child(placeholder),
                )
                .children(
                    (failure.is_none() && !loaded)
                        .then(|| self.render_blank_ports(slot, id, cx))
                        .flatten(),
                )
                .into_any_element(),
        };
        div()
            .id(SharedString::from(slot.selector("browser")))
            .debug_selector(move || slot.selector("browser"))
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .pl(px(gap))
            .bg(rgb(self.theme.background))
            // Keeps window shortcuts reachable while the page does not hold
            // the keyboard; nothing here types into a terminal. A focus
            // handle belongs to one element, so a drawn terminal keeps it.
            .when(keyboard, |browser| browser.track_focus(&self.focus))
            .child(toolbar)
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(div().flex().flex_col().flex_1().min_w_0().child(content))
                    .children(panel),
            )
            .into_any_element()
    }

    /// The workspace's listening ports under a blank tab's prompt, each
    /// opening its page in this tab; None while it listens on none.
    fn render_blank_ports(&self, slot: Slot, id: TabId, cx: &mut Context<Self>) -> Option<Div> {
        let (_, _, listed) = self.focused_listening_ports()?;
        let theme = &self.theme;
        let chips = listed.ports.iter().filter_map(|port| {
            let link = port.link(listed.origin)?;
            let selector = slot.selector(&format!("blank-port-{}", port.number));
            Some(
                div()
                    .id(SharedString::from(selector.clone()))
                    .debug_selector(move || selector.clone())
                    .flex()
                    .gap(px(6.))
                    .px(px(10.))
                    .py(px(2.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .border_1()
                    .border_color(rgb(theme.active))
                    .cursor_pointer()
                    .hover(|chip| chip.bg(rgb(theme.active)))
                    .child(
                        div()
                            .flex_none()
                            .text_color(rgb(theme.foreground))
                            .child(link.label()),
                    )
                    // A long process name gives way; the address stays whole.
                    .when(!port.process.is_empty(), |chip| {
                        chip.child(div().max_w(px(160.)).truncate().child(port.process.clone()))
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_blank_port(slot.id, id, &link, window, cx);
                    })),
            )
        });
        Some(
            div()
                .flex()
                .flex_wrap()
                .justify_center()
                .gap(px(6.))
                .children(chips),
        )
    }

    /// A port picked on a blank tab loads in that tab. A port behind an SSH
    /// tunnel opens as its status bar number does, once the tunnel is up.
    fn open_blank_port(
        &mut self,
        group: GroupId,
        id: TabId,
        link: &Link,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match link {
            Link::Page(url) => {
                self.visit(group, id, Location::Web { url: url.clone() }, window, cx);
            }
            Link::Tunnel(_) => {
                let Some((endpoint, workspace)) = self
                    .focused_listening_ports()
                    .map(|(endpoint, workspace, _)| (endpoint.to_owned(), workspace.to_owned()))
                else {
                    return;
                };
                self.open_port_link(&endpoint, &workspace, link, window, cx);
            }
        }
    }

    fn submit_address(
        &mut self,
        group: GroupId,
        id: TabId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.group_address(group, cx).read(cx).text().to_owned();
        let Ok(url) = WebUrl::from_typed(&text) else {
            self.show_flash(Flash::warning("Not an http or https address"), cx);
            return;
        };
        self.visit(group, id, Location::Web { url }, window, cx);
    }

    /// Loads `location` in tab `id`, shown in `group`.
    fn visit(
        &mut self,
        group: GroupId,
        id: TabId,
        location: Location,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        Store::update(cx, |store| store.visited(id, Some(location.clone()), None));
        #[cfg(any(target_os = "macos", windows))]
        if self.browser.pages.contains(id) {
            self.browser.pages.load(id, &location, cx);
            self.browser.pages.focus(id, cx);
        }
        self.show_browser_tab_in(Some(group), id, window, cx);
    }
}
