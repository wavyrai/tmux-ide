//! Each editor group's tab strip and frame, and the row of groups. Every
//! group lists the same tabs, as an editor's groups do; which one a group
//! shows is its own choice.

use super::{HerdrWindow, tab_drag::StripDrag};
use crate::{
    TAB_HEIGHT, TAB_WIDTH,
    browser::{Fold, GroupId, Leaving, Listed, Pick, Shown, Slot, ThumbDrag},
    controls::Command,
    fonts::StyledFont,
    herdr_settings::TabBarPosition,
    sidebar::{Indicators, status_indicator},
    titlebar::Ends,
};
use gpui::{prelude::*, *};
use herdr_client::protocol::AgentStatus;

/// The gap between a Herdr tab's status indicator and its title.
const DOT_GAP: f32 = 6.;

/// How large the mark after a zoomed tab's title draws, `DOT_GAP` after it.
const ZOOM_ICON: f32 = 11.;

/// How tall the thumb along a scrolling strip's foot draws.
const THUMB_HEIGHT: f32 = 4.;

/// How far a lifted tab's card reaches past each side of the tab.
const LIFT_GROW: f32 = 5.;

/// How opaque the thumb draws over the strip's muted color, and while held.
const THUMB_ALPHA: u32 = 0x80;
const THUMB_HELD_ALPHA: u32 = 0xc0;

/// What a tab draws before its title.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lead {
    Nothing,
    /// A Herdr tab whose agents report a status.
    Status,
    /// A browser tab's globe.
    Globe,
}

impl Lead {
    /// Unknown is what a tab without an agent reports, so it draws nothing
    /// rather than the sidebar's small grey dot.
    fn of(status: AgentStatus) -> Self {
        match status {
            AgentStatus::Unknown => Self::Nothing,
            _ => Self::Status,
        }
    }
}

/// What a divider drags: the index of the group on its left. The row it
/// resizes reads the pointer.
#[derive(Clone, Copy)]
struct DividerDrag(usize);

impl HerdrWindow {
    /// A tab's colors. The chosen tab carries the theme's accent in the group
    /// in use and a quieter wash elsewhere, so a split shows which group has
    /// the keyboard; the rest recede into the strip.
    pub(crate) fn tab_colors(&self, selected: bool, group: GroupId) -> (u32, u32) {
        let active = !self.is_split() || self.active_group() == Some(group);
        match (selected, active) {
            (true, true) => {
                let background = self.theme.primary_wash();
                (background, self.theme.text_on(background))
            }
            (true, false) => (self.theme.active, self.theme.foreground),
            (false, _) => (self.theme.surface, self.theme.muted),
        }
    }

    /// How wide a tab with `label` draws, as its padding, gaps, close
    /// button, and whatever leads its title add up around the shaped text.
    fn tab_width(
        &self,
        label: &SharedString,
        lead: Lead,
        zoomed: bool,
        indicators: Indicators,
        window: &Window,
    ) -> f32 {
        let run = TextRun {
            len: label.len(),
            font: self.config.tabs.font(),
            color: black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let text = f32::from(
            window
                .text_system()
                .shape_line(label.clone(), px(self.config.tabs.size), &[run], None)
                .width,
        );
        // Padding, the gap before the close button, the button, the rule;
        // a status dot or a browser tab's globe, and its gap.
        let chrome = match lead {
            Lead::Nothing => 12. + 10.,
            Lead::Status => 12. + indicators.width(&self.config.tabs) + DOT_GAP + 10.,
            Lead::Globe => 10. + 12. + 6. + 6.,
        };
        let zoom = if zoomed { DOT_GAP + ZOOM_ICON } else { 0. };
        // GPUI rounds the text element's intrinsic width up during layout.
        (chrome + zoom + text.ceil() + 18. + 3. + 1.).max(TAB_WIDTH)
    }

    /// A closed tab where it stood, narrowing and fading out.
    fn leaving_tab(&self, slot: Slot, leaving: &Leaving, now: std::time::Instant) -> AnyElement {
        let left = leaving.left(now);
        div()
            .debug_selector(move || slot.selector("leaving-tab"))
            .flex_none()
            .h_full()
            .w(px(leaving.width * left))
            .overflow_hidden()
            .opacity(left)
            .flex()
            .items_center()
            .pl(px(12.))
            .whitespace_nowrap()
            .border_r_1()
            .border_color(rgb(self.theme.active))
            .bg(rgb(self.theme.surface))
            .text_color(rgb(self.theme.muted))
            .child(leaving.label.clone())
            .into_any_element()
    }

    /// Height of a group's tab strip, which grows with the tab font.
    pub(crate) fn tab_strip_height(&self) -> f32 {
        crate::titlebar::strip_height(
            (self.config.tabs.size * 1.6 + 4.).max(TAB_HEIGHT),
            self.tab_bar_position() == TabBarPosition::Top,
        )
    }

    /// `ends` says which of the header's parts the strip carries, when it
    /// stands in for the header.
    fn render_tab_strip(
        &mut self,
        slot: Slot,
        ends: Option<Ends>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let pick = self.group_pick(slot.id);
        let indicators = Indicators::new(
            self.settings.shared.as_ref(),
            matches!(
                cx.window_appearance(),
                WindowAppearance::Light | WindowAppearance::VibrantLight
            ),
            &self.theme,
        );
        // What the strip lists, measured, so the ones that just opened grow
        // in and the ones that just closed shrink out where they stood.
        let now = std::time::Instant::now();
        let herdr: Vec<((Pick, SharedString), Lead, bool)> = self
            .live
            .snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .tabs
                    .iter()
                    .filter(|t| Some(&t.workspace_id) == snapshot.focused_workspace_id.as_ref())
                    .map(|t| {
                        (
                            (
                                Pick::Herdr(t.tab_id.clone()),
                                SharedString::from(t.label.clone()),
                            ),
                            Lead::of(t.agent_status),
                            t.zoomed,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let listed: Vec<Listed> = herdr
            .into_iter()
            .chain(
                self.browser_tab_labels(cx)
                    .into_iter()
                    .map(|entry| (entry, Lead::Globe, false)),
            )
            .filter(|((pick, _), _, _)| self.group_lists(slot.id, pick))
            .map(|((pick, label), lead, zoomed)| Listed {
                width: self.tab_width(&label, lead, zoomed, indicators, window),
                pick,
                label,
            })
            .collect();
        // Leaving tabs slot in among these below; `None` marks where.
        let mut places: Vec<Option<Pick>> =
            listed.iter().map(|tab| Some(tab.pick.clone())).collect();
        self.observe_strip(slot.id, listed, now);
        let scroll = self.strip_scroll(slot.id);
        let mut built: Vec<(Pick, Stateful<Div>)> = Vec::new();
        let mut tabs = div()
            .id(SharedString::from(slot.selector("tabs")))
            .flex()
            .flex_none()
            .h(px(self.tab_strip_height()))
            .text_font(&self.config.tabs)
            .text_size(px(self.config.tabs.size))
            .overflow_x_scroll()
            .track_scroll(&scroll)
            .bg(rgb(self.theme.surface))
            .text_color(rgb(self.theme.foreground));
        if let Some(snapshot) = &self.live.snapshot {
            for tab in snapshot.tabs.iter().filter(|t| {
                Some(&t.workspace_id) == snapshot.focused_workspace_id.as_ref()
                    && self.group_lists(slot.id, &Pick::Herdr(t.tab_id.clone()))
            }) {
                let id = tab.tab_id.clone();
                let context_id = id.clone();
                let close_id = id.clone();
                let selected = matches!(&pick, Some(Pick::Herdr(picked)) if *picked == id);
                let (background, text) = self.tab_colors(selected, slot.id);
                built.push((
                    Pick::Herdr(id.clone()),
                    div()
                        .id(SharedString::from(format!("tab-{id}")))
                        .debug_selector({
                            let id = id.clone();
                            move || slot.selector(&format!("tab-{id}"))
                        })
                        .pl(px(12.))
                        // The close button hugs the tab's inner right edge, well
                        // clear of the label it would otherwise crowd.
                        .pr(px(3.))
                        .py(px(2.))
                        // Even cells divided by a single rule, as in the reference UI.
                        .min_w(px(TAB_WIDTH))
                        .map(|tab| self.grow_tab(tab, slot.id, &Pick::Herdr(id.clone())))
                        .border_r_1()
                        .border_color(rgb(self.theme.active))
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .cursor_pointer()
                        .bg(rgb(background))
                        .text_color(rgb(text))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(DOT_GAP))
                                .when(Lead::of(tab.agent_status) == Lead::Status, |title| {
                                    title.child(
                                        status_indicator(
                                            tab.agent_status,
                                            &self.config.tabs,
                                            indicators,
                                        )
                                        .mt_0()
                                        .debug_selector({
                                            let id = id.clone();
                                            move || slot.selector(&format!("tab-status-{id}"))
                                        }),
                                    )
                                })
                                .child(tab.label.clone())
                                // Herdr's " Z": one pane fills the tab, the
                                // rest are hidden behind it.
                                .when(tab.zoomed, |title| {
                                    title.child(
                                        svg()
                                            .path("icons/zoom.svg")
                                            .debug_selector({
                                                let id = id.clone();
                                                move || slot.selector(&format!("tab-zoom-{id}"))
                                            })
                                            .flex_none()
                                            .size(px(ZOOM_ICON))
                                            .text_color(rgb(text)),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .id("close-tab")
                                .debug_selector({
                                    let id = id.clone();
                                    move || slot.selector(&format!("close-tab-{id}"))
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
                                        .debug_selector({
                                            let id = id.clone();
                                            move || slot.selector(&format!("close-tab-icon-{id}"))
                                        })
                                        .size(px(12.))
                                        .text_color(rgb(text)),
                                )
                                .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                    cx.stop_propagation();
                                })
                                // Split, a tab closes in its group alone, as
                                // an editor's does.
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    cx.stop_propagation();
                                    let pick = Pick::Herdr(close_id.clone());
                                    this.close_strip_tab(slot.id, pick, window, cx);
                                })),
                        )
                        .on_mouse_down(
                            MouseButton::Right,
                            cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                                cx.stop_propagation();
                                this.open_tab_menu(
                                    &context_id,
                                    Some(slot.id),
                                    event.position,
                                    window,
                                    cx,
                                );
                                this.menu.opening_right_click =
                                    this.menu.page == Some(crate::menu::Page::Tab);
                            }),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.choose_herdr_tab(slot.id, &id, window, cx);
                        })),
                ));
            }
        }
        let shown = match pick {
            Some(Pick::Page(id)) => Some(id),
            _ => None,
        };
        built.extend(
            self.browser_tab_entries(slot, shown, cx)
                .into_iter()
                .map(|(id, tab)| (Pick::Page(id), tab)),
        );
        // Closed tabs go back where they stood, in the order they stood.
        let mut leaving = self.leaving_tabs(slot.id);
        leaving.sort_by_key(|leaving| leaving.index);
        for leaving in &leaving {
            places.insert(leaving.index.min(places.len()), None);
        }
        let drag = self.strip_drag(slot.id, &places, &scroll, now);
        if drag.as_ref().is_some_and(|drag| drag.moving) {
            window.request_animation_frame();
        }
        let mut entries: Vec<AnyElement> = built
            .into_iter()
            .map(|(tab_pick, tab)| {
                let selected = pick.as_ref() == Some(&tab_pick);
                self.draggable_tab(slot, tab_pick, tab, selected, drag.as_ref(), cx)
            })
            .collect();
        for leaving in leaving {
            let index = leaving.index.min(entries.len());
            entries.insert(index, self.leaving_tab(slot, &leaving, now));
        }
        tabs = tabs.children(entries);
        if let Some((index, pick)) = pick.as_ref().and_then(|pick| {
            let index = places
                .iter()
                .position(|place| place.as_ref() == Some(pick))?;
            Some((index, pick))
        }) && self.reveal_tab(slot.id, pick, index)
        {
            window.request_animation_frame();
        }
        let hover_group = SharedString::from(slot.selector("tab-scroller"));
        let thumb_color = |alpha| rgba((self.theme.muted << 8) | alpha);
        // The thumb sits over the tabs rather than inside them, so it stays
        // put as they scroll beneath it; the pointer finds it along the
        // strip's foot, as in an editor.
        let scroller = div()
            .id(SharedString::from(slot.selector("tab-scroller")))
            .group(hover_group.clone())
            .relative()
            .flex()
            .flex_shrink_1()
            .min_w_0()
            .on_drag_move(
                cx.listener(move |this, event: &DragMoveEvent<ThumbDrag>, _, cx| {
                    let ThumbDrag(group) = *event.drag(cx);
                    if group == slot.id && this.drag_strip_thumb(group, event.event.position.x) {
                        cx.notify();
                    }
                }),
            )
            .child(tabs.flex_shrink_1().min_w_0())
            .children(self.strip_thumb(slot.id).map(|thumb| {
                div()
                    .id(SharedString::from(slot.selector("tab-scroll-thumb")))
                    .debug_selector(move || slot.selector("tab-scroll-thumb"))
                    .absolute()
                    .bottom_0()
                    .left(px(thumb.left))
                    .w(px(thumb.width))
                    .h(px(THUMB_HEIGHT))
                    // The wheel still scrolls the strip over the thumb.
                    .block_mouse_except_scroll()
                    .group_hover(hover_group, |s| s.bg(thumb_color(THUMB_ALPHA)))
                    .hover(|s| s.bg(thumb_color(THUMB_ALPHA)))
                    .active(|s| s.bg(thumb_color(THUMB_HELD_ALPHA)))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, _, _| {
                            this.grab_strip_thumb(slot.id, event.position.x);
                        }),
                    )
                    .on_drag(ThumbDrag(slot.id), |_, _, _, cx| cx.new(|_| EmptyView))
            }));
        div()
            .flex()
            .flex_none()
            .relative()
            .bg(rgb(self.theme.surface))
            .text_color(rgb(self.theme.foreground))
            .when(self.tab_drag_in(slot.id), |strip| {
                strip.child(self.tab_drag_listeners(cx))
            })
            .children(
                ends.filter(|ends| ends.leading)
                    .and_then(|_| self.strip_leading(window, cx)),
            )
            // Tabs size to their content and shrink when the row is full, so
            // the button sits after the last tab instead of at the far right
            // of the window.
            .child(scroller)
            .child(
                div()
                    .id(SharedString::from(slot.selector("new-tab")))
                    .debug_selector(move || slot.selector("new-tab"))
                    .w(px(34.))
                    .min_h(px(TAB_HEIGHT))
                    .border_r_1()
                    .border_color(rgb(self.theme.active))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(self.theme.active)))
                    .child(
                        svg()
                            .path("icons/plus.svg")
                            .debug_selector(move || slot.selector("new-tab-icon"))
                            .size(px(14.))
                            // Quiet like the unselected tabs beside it.
                            .text_color(rgb(self.theme.muted)),
                    )
                    // A new Herdr tab opens in the group that asked for it;
                    // other kinds of tab are behind "…".
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.expect_new_tab_in(slot.id);
                        this.command(Command::Tab, window, cx);
                    })),
            )
            .child(self.strip_room(ends, window))
            .child(self.strip_button(
                slot,
                "split-editor",
                "icons/split.svg",
                cx,
                move |this, _, window, cx| this.split_group(slot.id, window, cx),
            ))
            .child(self.strip_button(
                slot,
                "tab-actions",
                "icons/more.svg",
                cx,
                move |this, event, window, cx| {
                    this.open_group_menu(slot.id, event.position(), window, cx);
                },
            ))
            .when(ends.is_some_and(|ends| ends.trailing), |strip| {
                strip.child(self.strip_trailing(window, cx))
            })
    }

    /// Closes a strip's tab as its close button does: split, in its group
    /// alone; otherwise a page at once and a Herdr tab through its
    /// confirmation.
    pub(crate) fn close_strip_tab(
        &mut self,
        group: GroupId,
        pick: Pick,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.is_split() {
            return self.close_in_group(group, vec![pick], window, cx);
        }
        match pick {
            Pick::Herdr(tab) => self.open_tab_close(&tab, window, cx),
            Pick::Page(id) => self.close_browser_tab(id, window, cx),
        }
    }

    /// A tab as the strip places it: armed to lift for reordering, slid
    /// aside for a drop in preview, or carried over the strip, grown so it
    /// reads as held.
    fn draggable_tab(
        &self,
        slot: Slot,
        pick: Pick,
        tab: Stateful<Div>,
        selected: bool,
        drag: Option<&StripDrag>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let shift = drag
            .and_then(|drag| drag.shifts.get(&pick))
            .copied()
            .unwrap_or(0.);
        let grown = drag
            .and_then(|drag| drag.carried.as_ref())
            .and_then(|(carried, grown)| (*carried == pick).then_some(*grown));
        let press = pick.clone();
        let close = pick.clone();
        let tab = tab
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                    if event.click_count == 1 {
                        this.press_tab(slot.id, &press, event.position, cx);
                    }
                }),
            )
            // Middle-click closes, as a browser's tabs do.
            .on_mouse_up(
                MouseButton::Middle,
                cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.close_strip_tab(slot.id, close.clone(), window, cx);
                }),
            )
            .when(shift != 0., |tab| tab.relative().left(px(shift)));
        let Some(grown) = grown else {
            return tab.into_any_element();
        };
        let (background, _) = self.tab_colors(selected, slot.id);
        let (wide, tall) = (LIFT_GROW * grown, LIFT_GROW * 0.5 * grown);
        let selector = match &pick {
            Pick::Herdr(id) => format!("lifted-tab-{id}"),
            Pick::Page(id) => format!("lifted-browser-tab-{id}"),
        };
        // A card behind the tab, a little larger than it in the tab's own
        // color, grows as it lifts, so the held tab reads as picked up while
        // its label stays where it was. The tab keeps its place in the row,
        // so the others hold still, and paints last, over the tabs it passes.
        let card = div()
            .debug_selector(move || slot.selector(&selector))
            .absolute()
            .left(px(-wide))
            .right(px(-wide))
            .top(px(-tall))
            .bottom(px(-tall))
            .rounded(px(crate::config::corners::CONTROL))
            .bg(rgb(background))
            .border_1()
            .border_color(rgb(self.theme.active))
            .shadow_lg();
        deferred(
            div()
                .flex_none()
                // A flex box, so the held tab keeps the strip's full height.
                .flex()
                .relative()
                .left(px(shift))
                .cursor_grabbing()
                .child(card)
                .child(tab.left(px(0.)).border_color(rgb(background))),
        )
        .with_priority(1)
        .into_any_element()
    }

    /// Follows the pointer anywhere in the window while a tab drag is armed,
    /// so the drag carries on past the strip, and a lifted tab's release is
    /// its drop rather than a click on whatever is under it.
    fn tab_drag_listeners(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        canvas(
            |_, _, _| (),
            move |_, _, window, _| {
                let moving = view.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture {
                        moving.update(cx, |this, cx| {
                            let held = event.pressed_button == Some(MouseButton::Left);
                            if this.move_tab_drag(event.position, held, cx) {
                                cx.stop_propagation();
                            }
                        });
                    }
                });
                window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture && event.button == MouseButton::Left {
                        view.update(cx, |this, cx| {
                            if this.release_tab_drag(cx) {
                                cx.stop_propagation();
                            }
                        });
                    }
                });
            },
        )
        .absolute()
        .size_full()
    }

    fn strip_button(
        &self,
        slot: Slot,
        id: &'static str,
        icon: &'static str,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &ClickEvent, &mut Window, &mut Context<Self>) + 'static,
    ) -> Stateful<Div> {
        div()
            .id(SharedString::from(slot.selector(id)))
            .debug_selector(move || slot.selector(id))
            .w(px(30.))
            .min_h(px(TAB_HEIGHT))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(|s| s.bg(rgb(self.theme.active)))
            .child(
                svg()
                    .path(icon)
                    .size(px(14.))
                    .text_color(rgb(self.theme.muted)),
            )
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |this, event, window, cx| {
                cx.stop_propagation();
                action(this, event, window, cx);
            }))
    }

    /// Stands in for a tab live in another group, or for nothing. Pressing
    /// the group, as the button invites, brings the tab here.
    pub(super) fn render_stand_in(
        &self,
        slot: Slot,
        shown: &Shown,
        gap: f32,
        keyboard: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (title, note): (SharedString, &str) = match shown {
            Shown::Elsewhere(Pick::Herdr(tab)) => {
                let label = self
                    .live
                    .snapshot
                    .as_ref()
                    .and_then(|snapshot| {
                        snapshot
                            .tabs
                            .iter()
                            .find(|candidate| &candidate.tab_id == tab)
                    })
                    .map_or_else(|| tab.clone(), |tab| tab.label.clone());
                let note = if self.group_connecting(slot.id) {
                    "Opening\u{2026}"
                } else {
                    "Shown in another group."
                };
                (label.into(), note)
            }
            Shown::Elsewhere(Pick::Page(id)) => {
                let title = cx
                    .try_global::<crate::browser::Store>()
                    .and_then(|store| store.get(*id))
                    .map_or_else(String::new, |tab| tab.title.clone());
                (title.into(), "Shown in another group.")
            }
            // A terminal group whose connection has not shown its tab yet.
            Shown::Terminal => ("".into(), "Opening\u{2026}"),
            Shown::Page(_) | Shown::Empty => ("".into(), "Nothing to show."),
        };
        let elsewhere = matches!(shown, Shown::Elsewhere(_));
        div()
            .id(SharedString::from(slot.selector("stand-in")))
            .debug_selector(move || slot.selector("stand-in"))
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .pl(px(gap))
            .items_center()
            .justify_center()
            .gap(px(10.))
            .bg(rgb(self.theme.background))
            .text_color(rgb(self.theme.muted))
            .when(keyboard, |stand_in| stand_in.track_focus(&self.focus))
            .when(!title.is_empty(), |stand_in| {
                stand_in.child(
                    div()
                        .max_w_full()
                        .truncate()
                        .text_color(rgb(self.theme.foreground))
                        .child(title),
                )
            })
            .child(note)
            // The group in use carries the window's flash, as a page's
            // toolbar and the terminal do.
            .children(
                self.flash
                    .as_ref()
                    .filter(|_| self.active_group() == Some(slot.id))
                    .map(|(flash, _)| {
                        div()
                            .debug_selector(|| "flash".into())
                            .max_w_full()
                            .truncate()
                            .text_color(rgb(flash.accent(&self.theme)))
                            .child(flash.text.clone())
                    }),
            )
            .when(elsewhere, |stand_in| {
                stand_in.child(
                    div()
                        .id(SharedString::from(slot.selector("show-here")))
                        .debug_selector(move || slot.selector("show-here"))
                        .px(px(10.))
                        .py(px(5.))
                        .rounded(px(crate::config::corners::CONTROL))
                        .border_1()
                        .border_color(rgb(self.theme.active))
                        .text_color(rgb(self.theme.foreground))
                        .cursor_pointer()
                        .hover(|s| s.bg(rgb(self.theme.active)))
                        .child("Show Here")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.activate_group(slot.id, window, cx);
                        })),
                )
            })
            .into_any_element()
    }

    /// Where Herdr's shared config puts the tab row.
    pub(crate) fn tab_bar_position(&self) -> TabBarPosition {
        self.settings
            .shared
            .as_ref()
            .map(|shared| shared.tab_bar_position)
            .unwrap_or_default()
    }

    /// Whether `group`'s strip steps aside under Herdr's
    /// `hide_tab_bar_when_single_tab`: only when the window is not split, so
    /// every group keeps the strip that names it and takes dropped tabs, and
    /// only while the strip would list one tab at most, browser tabs counted.
    pub(crate) fn strip_hidden(&self, group: GroupId, cx: &App) -> bool {
        self.settings
            .shared
            .as_ref()
            .is_some_and(|shared| shared.hide_tab_bar_when_single_tab)
            && !self.is_split()
            && self.folding_groups().is_empty()
            && !self.tab_drag_in(group)
            && self.group_tabs(group, cx).len() <= 1
    }

    /// One group: its strip above or below what it shows, as Herdr's
    /// `tab_bar_position` places it. Pressing anywhere in it makes it the
    /// group in use. `ends` is set while the strips stand in for the header.
    pub(super) fn render_group(
        &mut self,
        slot: Slot,
        body: AnyElement,
        ends: Option<Ends>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let strip = (!self.strip_hidden(slot.id, cx))
            .then(|| self.render_tab_strip(slot, ends, window, cx));
        let bottom = self.tab_bar_position() == TabBarPosition::Bottom;
        let share = (self.is_split() || !self.folding_groups().is_empty())
            .then(|| self.group_share(slot.id));
        let opened = self.group_opened(slot.id);
        let column = div()
            .id(SharedString::from(slot.selector("group")))
            .debug_selector(move || slot.selector("group"))
            .flex()
            .flex_col()
            .min_w_0()
            .min_h_0()
            .h_full()
            // Opening, the group is laid out at the width it opens to and
            // uncovered from the right, so it slides in rather than squeezing,
            // and its terminal keeps one size while it does.
            .map(|column| match opened {
                Some(k) => column.flex_none().w(relative(1. / k.max(0.02))),
                None => column.w_full(),
            })
            .capture_any_mouse_down(cx.listener(move |this, _, window, cx| {
                if this.menu.page.is_none() {
                    this.activate_group(slot.id, window, cx);
                }
            }))
            .map(|column| match (strip, bottom) {
                (Some(strip), false) => column.child(strip).child(body),
                (Some(strip), true) => column.child(body).child(strip),
                (None, _) => column.child(body),
            });
        div()
            .flex()
            .justify_end()
            .overflow_hidden()
            .min_w_0()
            .min_h_0()
            .map(|frame| match share {
                // Dividers take their width from every group alike.
                Some(share) => frame.flex_shrink(1.).w(relative(share)),
                None => frame.flex_1(),
            })
            .child(column)
            .into_any_element()
    }

    /// A closed group folding away to the right where it stood: its strip's
    /// band and an empty body.
    fn folding_group(&self, fold: &Fold) -> AnyElement {
        div()
            .debug_selector(|| "folding-group".into())
            .flex_shrink(1.)
            .w(relative(fold.share))
            .h_full()
            .overflow_hidden()
            .flex()
            .flex_col()
            .border_l_1()
            .border_color(rgb(self.theme.active))
            .bg(rgb(self.theme.background))
            .when(self.tab_bar_position() == TabBarPosition::Bottom, |group| {
                group.justify_end()
            })
            .child(
                div()
                    .flex_none()
                    .h(px(self.tab_strip_height()))
                    .bg(rgb(self.theme.surface)),
            )
            .into_any_element()
    }

    /// The groups in a row, with a divider between each pair that drags
    /// the two apart.
    pub(super) fn render_groups(
        &mut self,
        groups: Vec<AnyElement>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Real groups keep their layout index for the dividers between them;
        // folding ones slot in where they stood.
        let mut children: Vec<(Option<usize>, AnyElement)> = groups
            .into_iter()
            .enumerate()
            .map(|(index, group)| (Some(index), group))
            .collect();
        let mut folding = self.folding_groups();
        folding.sort_by_key(|folding| folding.index);
        for folding in folding {
            let at = folding.index.min(children.len());
            children.insert(at, (None, self.folding_group(&folding)));
        }
        let mut row = div()
            .id("groups")
            .flex()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .on_drag_move(
                cx.listener(|this, event: &DragMoveEvent<DividerDrag>, _, cx| {
                    let DividerDrag(divider) = *event.drag(cx);
                    let offset = f32::from(event.event.position.x - event.bounds.left());
                    if this.drag_divider(divider, offset, f32::from(event.bounds.size.width)) {
                        cx.notify();
                    }
                }),
            );
        let mut children = children.into_iter().peekable();
        while let Some((index, group)) = children.next() {
            row = row.child(group);
            // A divider sits between two real groups; a folding one draws its
            // own edge.
            if let (Some(index), Some((Some(_), _))) = (index, children.peek()) {
                row = row.child(
                    div()
                        .id(("group-divider", index))
                        .debug_selector(move || format!("group-divider-{index}"))
                        .flex_none()
                        .w(px(5.))
                        .flex()
                        .justify_center()
                        .bg(rgb(self.theme.background))
                        .cursor(CursorStyle::ResizeLeftRight)
                        .child(div().w(px(1.)).h_full().bg(rgb(self.theme.active)))
                        .on_drag(DividerDrag(index), |_, _, _, cx| cx.new(|_| EmptyView)),
                );
            }
        }
        row.into_any_element()
    }
}

#[cfg(test)]
mod tests;
