//! The guide's Look step: Match macOS / Light / Dark, the themes drawn from
//! their own colours (applied to the window as they are picked, as
//! Appearance… does), a static preview, terminal text size, cursor
//! animation and Opaque window. Each change is saved as it is made; a
//! failed save keeps the saved value and says so.
use super::guide::{Act as GuideAct, Filter, Kind, filter_of, preset, slot, themes};
use super::render::Stop;
use super::*;
use crate::tmux_snapshot::{
    appearance::{Colors, System},
    terminal_font::Choice,
};
use bezel_theme::{TextStyle, Typeset as _};
use bezel_ui::widgets::{ButtonStyle, Controls as _, Status as _};

/// Tiles per row under Light or Dark.
const COLUMNS: usize = 6;
const TILE: f32 = 84.;
pub(super) const UNAVAILABLE: &str = "Appearance loads with the background service.";
pub(super) const MATCH_NOTE: &str =
    "Match macOS switches between these two themes when macOS changes between light and dark.";
pub(super) const CURSOR_NOTE: &str =
    "The cursor glides to where you type. Off when Reduce Motion is on.";
pub(super) const OPAQUE_NOTE: &str = "The window also turns opaque by itself with Reduce Transparency or Increase Contrast, and for themes whose text would not read on glass.";

/// One radio group of themes: the ids in order, what picking one does, how
/// many a row holds, and which is chosen.
struct Group {
    ids: Vec<String>,
    act: fn(String) -> GuideAct,
    columns: usize,
    current: Option<usize>,
}

impl SnapshotView {
    fn look_filter(&self) -> Option<Filter> {
        let appearance = self.browser_state.appearance.as_ref()?;
        Some(
            self.welcome
                .guide
                .filter
                .unwrap_or_else(|| filter_of(&appearance.selected)),
        )
    }
    fn look_group(&self, slot: usize) -> Option<Group> {
        let appearance = self.browser_state.appearance.as_ref()?;
        let ids = |filter| -> Vec<String> { themes(filter).iter().map(|p| p.id.clone()).collect() };
        let at = |ids: &[String], id: &str| ids.iter().position(|i| i == id);
        Some(match (self.look_filter()?, slot) {
            (Filter::System, slot::GRID) => {
                let ids = ids(Filter::Light);
                Group {
                    current: at(&ids, &appearance.light),
                    ids,
                    act: |id| GuideAct::ThemeFor(System::Light, id),
                    columns: usize::MAX,
                }
            }
            (Filter::System, slot::GRID_DARK) => {
                let ids = ids(Filter::Dark);
                Group {
                    current: at(&ids, &appearance.dark),
                    ids,
                    act: |id| GuideAct::ThemeFor(System::Dark, id),
                    columns: usize::MAX,
                }
            }
            (filter @ (Filter::Light | Filter::Dark), slot::GRID) => {
                let ids = ids(filter);
                Group {
                    current: at(&ids, &appearance.selected),
                    ids,
                    act: GuideAct::Theme,
                    columns: COLUMNS,
                }
            }
            _ => return None,
        })
    }
    /// Arrows inside the segmented control and the theme groups.
    pub(super) fn look_arrow(&self, slot: usize, key: &str) -> Option<GuideAct> {
        if slot == slot::SEGMENT {
            let at = Filter::ALL
                .iter()
                .position(|f| Some(*f) == self.look_filter())?;
            let to = match key {
                "left" | "up" => at.checked_sub(1)?,
                _ => at + 1,
            };
            return Filter::ALL.get(to).map(|f| GuideAct::Filter(*f));
        }
        let group = self.look_group(slot)?;
        let at = group.current.unwrap_or(0);
        let step = group.columns.min(group.ids.len());
        let to = match key {
            "left" => at.checked_sub(1)?,
            "right" => at + 1,
            "up" => at.checked_sub(step)?,
            _ => at + step,
        };
        group.ids.get(to).map(|id| (group.act)(id.clone()))
    }

    pub(super) fn look_body(
        &mut self,
        bezel: &bezel_theme::Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (AnyElement, Vec<Stop>, Option<usize>) {
        let _ = window;
        // The size buttons need the installed families listed.
        self.list_terminal_fonts(cx);
        let mut stops: Vec<Stop> = Vec::new();
        let mut body = div().w_full().flex().flex_col().gap(px(14.));
        let mut start = None;
        if let (Some(appearance), Some(filter)) =
            (self.browser_state.appearance.clone(), self.look_filter())
        {
            start = Some(slot::SEGMENT);
            stops.push((
                slot::SEGMENT,
                Act::Guide(GuideAct::Filter(filter)),
                Kind::Group,
            ));
            body = body.child(self.look_segment(filter, bezel, cx));
            if filter == Filter::System {
                for (slot, side, label) in [
                    (slot::GRID, System::Light, "In light mode"),
                    (slot::GRID_DARK, System::Dark, "In dark mode"),
                ] {
                    stops.push((slot, Act::Guide(GuideAct::Filter(filter)), Kind::Group));
                    body = body.child(self.look_side(slot, side, label, bezel, cx));
                }
                body = body.child(note(bezel, "welcome-look-match", MATCH_NOTE));
            } else {
                stops.push((
                    slot::GRID,
                    Act::Guide(GuideAct::Filter(filter)),
                    Kind::Group,
                ));
                body = body.child(self.look_grid(filter, bezel, cx));
            }
            body = body.child(preview(&appearance, bezel));
            for message in [appearance.error.as_deref(), self.welcome.guide.note] {
                body = body.children(message.map(|m| warning(bezel, m)));
            }
        } else {
            body = body.child(note(bezel, "welcome-look-unavailable", UNAVAILABLE));
        }
        // Terminal text size.
        let font = &self.terminal_font;
        let size = font.config.size;
        let smaller = font.can_choose(&Choice::Size(-1));
        let larger = font.can_choose(&Choice::Size(1));
        if smaller {
            stops.push((
                slot::FONT_DOWN,
                Act::Guide(GuideAct::FontSize(-1)),
                Kind::Press,
            ));
        }
        if larger {
            stops.push((
                slot::FONT_UP,
                Act::Guide(GuideAct::FontSize(1)),
                Kind::Press,
            ));
        }
        let stepper = div()
            .id("welcome-font-size")
            .debug_selector(|| "welcome-font-size".into())
            .role(Role::Group)
            .aria_label(format!("Terminal text size, {size} points"))
            .flex()
            .items_center()
            .gap(px(6.))
            .child(
                self.guide_button(
                    slot::FONT_DOWN,
                    "welcome-font-smaller",
                    "−",
                    Act::Guide(GuideAct::FontSize(-1)),
                    ButtonStyle::Ghost,
                    smaller,
                    bezel,
                    cx,
                )
                .aria_label("Smaller terminal text"),
            )
            .child(
                div()
                    .min_w(px(44.))
                    .text_align(TextAlign::Center)
                    .child(format!("{size} pt")),
            )
            .child(
                self.guide_button(
                    slot::FONT_UP,
                    "welcome-font-larger",
                    "+",
                    Act::Guide(GuideAct::FontSize(1)),
                    ButtonStyle::Ghost,
                    larger,
                    bezel,
                    cx,
                )
                .aria_label("Larger terminal text"),
            );
        let family = font.config.family.clone();
        body = body.child(setting_row(
            bezel,
            "Terminal text",
            &format!("Font: {family} · change it any time in Commands: Terminal font…"),
            stepper.into_any_element(),
        ));
        body = body.children(
            font.note
                .filter(|n| n.starts_with("Could not") || n.contains("unavailable"))
                .map(|m| warning(bezel, m)),
        );
        // Cursor animation and Opaque window.
        let cursor = &self.cursor_motion;
        let opaque = &self.chrome.opaque;
        let switches = [
            (
                slot::CURSOR,
                "Cursor animation",
                CURSOR_NOTE,
                cursor.enabled,
                cursor.ready && !cursor.saving,
                GuideAct::CursorMotion(!cursor.enabled),
                cursor.note,
            ),
            (
                slot::OPAQUE,
                "Opaque window",
                OPAQUE_NOTE,
                opaque.enabled,
                opaque.ready && !opaque.saving,
                GuideAct::Opaque(!opaque.enabled),
                opaque.note,
            ),
        ];
        for (slot, title, detail, on, enabled, act, message) in switches {
            if enabled {
                stops.push((slot, Act::Guide(act.clone()), Kind::Switch));
            }
            let control = self.guide_switch(slot, title, on, enabled, act, bezel, cx);
            body = body.child(setting_row(bezel, title, detail, control));
            body = body.children(
                message
                    .filter(|n| n.starts_with("Could not") || n.contains("unavailable"))
                    .map(|m| warning(bezel, m)),
            );
        }
        (body.into_any_element(), stops, start)
    }

    fn look_segment(
        &self,
        filter: Filter,
        bezel: &bezel_theme::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ring = bezel.ring;
        bezel
            .toggle_group()
            .id("welcome-filter")
            .debug_selector(|| "welcome-filter".into())
            .role(Role::RadioGroup)
            .aria_label("Appearance")
            .children(Filter::ALL.iter().enumerate().map(|(index, f)| {
                let f = *f;
                let selected = f == filter;
                bezel
                    .toggle_group_item(f.label(), selected)
                    .id(("welcome-filter", index))
                    .debug_selector(move || format!("welcome-filter-{index}"))
                    .role(Role::RadioButton)
                    .aria_label(f.label())
                    .aria_toggled(if selected {
                        Toggled::True
                    } else {
                        Toggled::False
                    })
                    .when(selected, |s| {
                        s.track_focus(&self.welcome.focus[slot::SEGMENT].clone().tab_stop(true))
                    })
                    .border_1()
                    .border_color(transparent_black())
                    .focus_visible(move |s| s.border_color(ring))
                    .cursor_pointer()
                    .on_click(cx.listener(move |view, _, window, cx| {
                        cx.stop_propagation();
                        view.guide_act(GuideAct::Filter(f), window, cx);
                    }))
            }))
            .into_any_element()
    }

    /// Light or Dark: the themes as tiles, six to a row.
    fn look_grid(
        &self,
        filter: Filter,
        bezel: &bezel_theme::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(group) = self.look_group(slot::GRID) else {
            return div().into_any_element();
        };
        let ring = bezel.ring;
        let tiles = group.ids.iter().enumerate().filter_map(|(index, id)| {
            let p = preset(id)?;
            let colors = if filter == Filter::Light {
                &p.light
            } else {
                &p.dark
            };
            let selected = group.current == Some(index);
            let focus_here = selected || (group.current.is_none() && index == 0);
            let act = (group.act)(id.clone());
            Some(
                div()
                    .id(("welcome-theme", index))
                    .debug_selector(move || format!("welcome-theme-{index}"))
                    .role(Role::RadioButton)
                    .aria_label(format!("{}, {}", p.name, filter.label().to_lowercase()))
                    .aria_toggled(if selected {
                        Toggled::True
                    } else {
                        Toggled::False
                    })
                    .when(focus_here, |t| {
                        t.track_focus(&self.welcome.focus[slot::GRID].clone().tab_stop(true))
                    })
                    .w(px(TILE))
                    .flex()
                    .flex_col()
                    .rounded(px(8.))
                    .overflow_hidden()
                    .border_2()
                    .border_color(if selected {
                        bezel.text
                    } else {
                        bezel.border_faint
                    })
                    .focus_visible(move |s| s.border_color(ring))
                    .cursor_pointer()
                    .child(mini(colors))
                    .child(
                        div()
                            .px(px(6.))
                            .py(px(3.))
                            .text_style(TextStyle::Caption)
                            .text_color(bezel.text)
                            .truncate()
                            .child(p.name.clone()),
                    )
                    .on_click(cx.listener(move |view, _, window, cx| {
                        cx.stop_propagation();
                        view.guide_act(act.clone(), window, cx);
                    })),
            )
        });
        div()
            .id("welcome-themes")
            .debug_selector(|| "welcome-themes".into())
            .role(Role::RadioGroup)
            .aria_label("Theme")
            .w_full()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .children(tiles)
            .into_any_element()
    }

    /// One side of Match macOS: a row of swatches and the chosen name.
    fn look_side(
        &self,
        slot: usize,
        side: System,
        label: &'static str,
        bezel: &bezel_theme::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(group) = self.look_group(slot) else {
            return div().into_any_element();
        };
        let ring = bezel.ring;
        let chosen = group
            .current
            .and_then(|i| group.ids.get(i))
            .and_then(|id| preset(id))
            .map_or(String::new(), |p| p.name.clone());
        let swatches = group.ids.iter().enumerate().filter_map(|(index, id)| {
            let p = preset(id)?;
            let colors = match side {
                System::Light => &p.light,
                System::Dark => &p.dark,
            };
            let selected = group.current == Some(index);
            let focus_here = selected || (group.current.is_none() && index == 0);
            let act = (group.act)(id.clone());
            Some(
                div()
                    .id((
                        if slot == slot::GRID {
                            "welcome-light"
                        } else {
                            "welcome-dark"
                        },
                        index,
                    ))
                    .debug_selector(move || {
                        format!(
                            "welcome-{}-{index}",
                            if slot == slot::GRID { "light" } else { "dark" }
                        )
                    })
                    .role(Role::RadioButton)
                    .aria_label(p.name.clone())
                    .aria_toggled(if selected {
                        Toggled::True
                    } else {
                        Toggled::False
                    })
                    .when(focus_here, |t| {
                        t.track_focus(&self.welcome.focus[slot].clone().tab_stop(true))
                    })
                    .size(px(26.))
                    .rounded(px(6.))
                    .border_2()
                    .border_color(if selected {
                        bezel.text
                    } else {
                        bezel.border_faint
                    })
                    .focus_visible(move |s| s.border_color(ring))
                    .bg(rgb(colors.background))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .child(div().size(px(8.)).rounded_full().bg(rgb(colors.accent)))
                    .on_click(cx.listener(move |view, _, window, cx| {
                        cx.stop_propagation();
                        view.guide_act(act.clone(), window, cx);
                    })),
            )
        });
        div()
            .w_full()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .text_style(TextStyle::Callout)
                    .child(div().text_color(bezel.text).child(label))
                    .child(div().text_color(bezel.text_muted).child(chosen)),
            )
            .child(
                div()
                    .id(label)
                    .role(Role::RadioGroup)
                    .aria_label(label)
                    .flex()
                    .flex_wrap()
                    .gap(px(5.))
                    .children(swatches),
            )
            .into_any_element()
    }

    /// A switch: Bezel's toggle, as a VoiceOver switch on `slot`.
    #[allow(clippy::too_many_arguments)]
    fn guide_switch(
        &self,
        slot: usize,
        title: &'static str,
        on: bool,
        enabled: bool,
        act: GuideAct,
        bezel: &bezel_theme::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ring = bezel.ring;
        let selector = format!("welcome-switch-{slot}");
        bezel
            .toggle(on)
            .id(("welcome-switch", slot))
            .debug_selector(move || selector.clone())
            .role(Role::Switch)
            .aria_label(title)
            .aria_toggled(if on { Toggled::True } else { Toggled::False })
            .track_focus(&self.welcome.focus[slot].clone().tab_stop(enabled))
            .focus_visible(move |s| s.border_color(ring))
            .when(!enabled, |s| s.opacity(0.6))
            .when(enabled, |s| {
                s.cursor_pointer()
                    .on_click(cx.listener(move |view, _, window, cx| {
                        cx.stop_propagation();
                        view.guide_act(act.clone(), window, cx);
                    }))
            })
            .into_any_element()
    }
}

/// A theme's tile: its background with three lines in its own colours.
fn mini(colors: &Colors) -> Div {
    let bar = |width: f32, color: u32| div().h(px(3.)).w(px(width)).rounded(px(1.5)).bg(rgb(color));
    div()
        .h(px(40.))
        .w_full()
        .bg(rgb(colors.background))
        .px(px(7.))
        .py(px(7.))
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(bar(46., colors.foreground))
        .child(bar(30., colors.accent))
        .child(
            div()
                .flex()
                .gap(px(3.))
                .child(bar(14., colors.palette[1]))
                .child(bar(14., colors.palette[2]))
                .child(bar(14., colors.palette[4])),
        )
}

/// The chosen theme as a pane with an agent in it: static text in the
/// theme's colours, never a live pane.
fn preview(
    appearance: &crate::tmux_snapshot::appearance::Appearance,
    bezel: &bezel_theme::Theme,
) -> AnyElement {
    let c = &appearance.theme;
    let name = |id: &str| preset(id).map_or(id.to_string(), |p| p.name.clone());
    let spoken = if appearance.selected == "system" {
        format!(
            "Preview of Match macOS: {} and {}",
            name(&appearance.light),
            name(&appearance.dark)
        )
    } else {
        format!("Preview of {}", name(&appearance.selected))
    };
    let mono = crate::config::Config::default().terminal.family;
    let line = |color: u32, text: &'static str| div().text_color(rgb(color)).child(text);
    div()
        .id("welcome-preview")
        .debug_selector(|| "welcome-preview".into())
        .role(Role::Image)
        .aria_label(spoken)
        .w_full()
        .rounded(px(8.))
        .overflow_hidden()
        .border_1()
        .border_color(bezel.border_faint)
        .bg(rgb(c.background))
        .font_family(mono)
        .text_style(TextStyle::Caption)
        .child(
            div()
                .px(px(10.))
                .py(px(4.))
                .bg(rgb(c.surface))
                .text_color(rgb(c.muted))
                .child("api · claude"),
        )
        .child(
            div()
                .px(px(10.))
                .py(px(6.))
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(line(c.foreground, "~/api $ npm test"))
                .child(line(c.palette[2], "✓ 41 passed"))
                .child(line(c.palette[1], "✗ 1 failed: parses an empty body"))
                .child(line(c.accent, "● Claude is working on the failing test")),
        )
        .into_any_element()
}

fn note(bezel: &bezel_theme::Theme, selector: &'static str, text: &'static str) -> AnyElement {
    div()
        .debug_selector(move || selector.into())
        .text_style(TextStyle::Callout)
        .text_color(bezel.text_muted)
        .children(crate::tmux_snapshot::design::ink_probe(move || {
            selector.into()
        }))
        .child(text)
        .into_any_element()
}

fn warning(bezel: &bezel_theme::Theme, message: &str) -> AnyElement {
    bezel
        .warning_strip(crate::notifications::safe_text(message, 240))
        .text_color(bezel.warning_muted)
        .debug_selector(|| "welcome-look-warning".into())
        .w_full()
        .into_any_element()
}

fn setting_row(
    bezel: &bezel_theme::Theme,
    title: &str,
    detail: &str,
    control: AnyElement,
) -> AnyElement {
    div()
        .w_full()
        .pt(px(10.))
        .border_t_1()
        .border_color(bezel.border_faint)
        .flex()
        .items_center()
        .gap(px(16.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().text_color(bezel.text).child(title.to_string()))
                .child(
                    div()
                        .text_style(TextStyle::Callout)
                        .text_color(bezel.text_muted)
                        .child(detail.to_string()),
                ),
        )
        .child(div().flex_none().child(control))
        .into_any_element()
}
