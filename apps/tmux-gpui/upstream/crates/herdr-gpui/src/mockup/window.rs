//! The comparison window: every variant framed side by side, with a pick
//! toggle and a note for each, and "Send to agent" for the lot.
use super::{Body, Look, Mockup, feedback};
use crate::{
    config::{Config, Theme, corners},
    fonts::StyledFont,
    search_input::SearchInput,
};
use gpui::{prelude::*, *};
use std::path::PathBuf;

actions!(mockup, [Close, Send]);

/// The window's own keys. Note fields keep Escape, which hands focus back to
/// the window so the number keys choose a variant again.
pub(super) fn key_bindings() -> [KeyBinding; 2] {
    [
        KeyBinding::new("cmd-w", Close, Some("MockupWindow")),
        KeyBinding::new("cmd-enter", Send, Some("MockupWindow")),
    ]
}

/// How wide each frame is drawn, relative to the width it was designed for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Width {
    Narrow,
    #[default]
    Design,
    Wide,
}

impl Width {
    const ALL: [Self; 3] = [Self::Narrow, Self::Design, Self::Wide];

    fn label(self) -> &'static str {
        match self {
            Self::Narrow => "Narrow",
            Self::Design => "Design",
            Self::Wide => "Wide",
        }
    }

    fn of(self, design: Pixels) -> Pixels {
        match self {
            Self::Narrow => (design * 0.66).round(),
            Self::Design => design,
            Self::Wide => (design * 1.5).round(),
        }
    }
}

/// What the window starts with, besides the mockup itself.
pub(super) struct Setup {
    pub config: Config,
    /// Offered themes, by name; `theme` indexes the first one shown.
    pub themes: Vec<(SharedString, Theme)>,
    pub theme: usize,
    /// Where "Send to agent" writes; without one it only prints.
    pub feedback: Option<PathBuf>,
}

struct Card {
    picked: bool,
    note: Entity<SearchInput>,
    /// Built once for `Body::View` variants, so their state is kept.
    view: Option<AnyView>,
}

pub(super) struct MockupWindow {
    mockup: Mockup,
    look: Look,
    themes: Vec<(SharedString, Theme)>,
    theme: usize,
    width: Width,
    /// One variant shown alone, or all of them.
    solo: Option<usize>,
    cards: Vec<Card>,
    overall: Entity<SearchInput>,
    feedback: Option<PathBuf>,
    /// Whether a write is running; sends wait for it.
    sending: bool,
    status: SharedString,
    focus: FocusHandle,
}

fn letter(index: usize) -> char {
    u8::try_from(index)
        .ok()
        .filter(|index| *index < 26)
        .map_or('?', |index| char::from(b'A' + index))
}

fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    on: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let (fill, text) = if on {
        (theme.primary_wash(), theme.foreground)
    } else {
        (theme.surface, theme.subtext())
    };
    let hover = theme.active;
    div()
        .id(id)
        .flex_none()
        .px_2()
        .py_0p5()
        .rounded(px(corners::CONTROL))
        .bg(rgb(fill))
        .text_color(rgb(text))
        .cursor_pointer()
        .when(!on, |el| el.hover(move |style| style.bg(rgb(hover))))
        .child(label.into())
}

impl MockupWindow {
    pub(super) fn new(
        mockup: Mockup,
        setup: Setup,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let Setup {
            config,
            themes,
            theme,
            feedback,
        } = setup;
        let look = Look {
            theme: themes
                .get(theme)
                .map(|(_, theme)| theme.clone())
                .unwrap_or_default(),
            config,
        };
        // Views read the look from the global, so it must exist before they do.
        cx.set_global(look.clone());
        let input = |placeholder: String, cx: &mut Context<Self>| {
            let input = cx.new(SearchInput::new);
            input.update(cx, |input, cx| {
                input.set_placeholder(&placeholder, cx);
                input.set_appearance(look.config.ui.clone(), look.theme.clone(), cx);
            });
            input
        };
        let cards = mockup
            .variants
            .iter()
            .enumerate()
            .map(|(index, variant)| Card {
                picked: false,
                note: input(format!("Note on {}...", letter(index)), cx),
                view: match variant.body {
                    Body::View(build) => Some(build(window, cx)),
                    Body::Element(_) => None,
                },
            })
            .collect();
        let overall = input("Overall note, e.g. B's header with C's list...".into(), cx);
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            mockup,
            look,
            themes,
            theme,
            width: Width::default(),
            solo: None,
            cards,
            overall,
            status: match &feedback {
                Some(path) => format!("Send writes {}", path.display()).into(),
                None => "Send prints to the terminal".into(),
            },
            feedback,
            sending: false,
            focus,
        }
    }

    fn set_theme(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some((_, theme)) = self.themes.get(index) else {
            return;
        };
        self.theme = index;
        self.look.theme = theme.clone();
        cx.set_global(self.look.clone());
        for input in self
            .cards
            .iter()
            .map(|card| &card.note)
            .chain([&self.overall])
        {
            input.update(cx, |input, cx| {
                input.set_appearance(self.look.config.ui.clone(), self.look.theme.clone(), cx);
            });
        }
        cx.notify();
    }

    fn width_label(&self) -> String {
        format!(
            "{} ({} px)",
            self.width.label(),
            f32::from(self.width.of(self.mockup.frame.width))
        )
    }

    fn report(&self, cx: &App) -> String {
        feedback::Report {
            title: self.mockup.title,
            theme: self
                .themes
                .get(self.theme)
                .map_or("Default", |(name, _)| name.as_ref()),
            width: &self.width_label(),
            choices: self
                .mockup
                .variants
                .iter()
                .zip(&self.cards)
                .enumerate()
                .map(|(index, (variant, card))| feedback::Choice {
                    letter: letter(index),
                    name: variant.name,
                    picked: card.picked,
                    note: card.note.read(cx).text(),
                })
                .collect(),
            overall: self.overall.read(cx).text(),
        }
        .text()
    }

    fn send(&mut self, cx: &mut Context<Self>) {
        if self.sending {
            return;
        }
        let text = self.report(cx);
        // The terminal copy is for an agent that reads the process output.
        println!("{text}");
        let Some(path) = self.feedback.clone() else {
            self.status = "Sent: printed to the terminal".into();
            cx.notify();
            return;
        };
        self.sending = true;
        self.status = "Sending...".into();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let target = path.clone();
            let written = cx
                .background_executor()
                .spawn(async move { feedback::write(&target, text.as_bytes()) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.sending = false;
                this.status = match written {
                    Ok(()) => {
                        println!("mockup: feedback written {}", path.display());
                        format!("Sent to {}", path.display()).into()
                    }
                    Err(error) => {
                        eprintln!("mockup: {error}");
                        format!("Not sent: {error}").into()
                    }
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        if key == "escape" {
            // Escape belongs to the native input system during composition.
            if self
                .cards
                .iter()
                .map(|card| &card.note)
                .chain([&self.overall])
                .any(|input| {
                    let input = input.read(cx);
                    input.focus.is_focused(window) && input.is_composing()
                })
            {
                return;
            }
            window.focus(&self.focus, cx);
            cx.notify();
            return;
        }
        // Digits belong to a note field while one has focus.
        if !self.focus.is_focused(window) || event.keystroke.modifiers.modified() {
            return;
        }
        let Some(digit) = key.parse::<usize>().ok().filter(|_| key.len() == 1) else {
            return;
        };
        self.solo = digit
            .checked_sub(1)
            .filter(|index| *index < self.cards.len());
        cx.notify();
    }

    fn render_toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = &self.look.theme;
        let label = |text: &'static str| div().flex_none().text_color(rgb(theme.muted)).child(text);
        div()
            .flex()
            .flex_none()
            .flex_wrap()
            .items_center()
            .gap_1()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(rgb(theme.active))
            .child(
                div()
                    .flex_none()
                    .mr_3()
                    .text_size(px(self.look.config.ui.size + 3.))
                    .child(self.mockup.title),
            )
            .child(label("Theme"))
            .children(self.themes.iter().enumerate().map(|(index, (name, _))| {
                button(("theme", index), name.clone(), index == self.theme, theme)
                    .debug_selector(move || format!("mockup-theme-{index}"))
                    .on_click(cx.listener(move |this, _, _, cx| this.set_theme(index, cx)))
            }))
            .child(div().flex_none().w_3())
            .child(label("Width"))
            .children(Width::ALL.into_iter().enumerate().map(|(index, width)| {
                button(("width", index), width.label(), width == self.width, theme).on_click(
                    cx.listener(move |this, _, _, cx| {
                        this.width = width;
                        cx.notify();
                    }),
                )
            }))
            .child(div().flex_none().w_3())
            .child(label("Show"))
            .child(
                button("show-all", "All", self.solo.is_none(), theme)
                    .debug_selector(|| "mockup-show-all".into())
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.solo = None;
                        cx.notify();
                    })),
            )
            .children((0..self.cards.len()).map(|index| {
                button(
                    ("show", index),
                    letter(index).to_string(),
                    self.solo == Some(index),
                    theme,
                )
                .debug_selector(move || format!("mockup-show-{}", letter(index)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.solo = Some(index);
                    cx.notify();
                }))
            }))
    }

    fn render_card(&self, index: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = &self.look.theme;
        let variant = &self.mockup.variants[index];
        let card = &self.cards[index];
        let key = letter(index);
        let width = self.width.of(self.mockup.frame.width);
        let body = match (variant.body, &card.view) {
            (_, Some(view)) => view.clone().into_any_element(),
            (Body::Element(draw), None) => draw(&self.look, window, cx),
            // A view is always built with its card.
            (Body::View(_), None) => div().into_any_element(),
        };
        div()
            .id(("variant", index))
            .debug_selector(move || format!("variant-{key}"))
            .flex()
            .flex_col()
            .flex_none()
            .gap_2()
            .p_3()
            .w(width + px(26.))
            .rounded(px(corners::PANEL))
            .bg(rgb(theme.surface))
            .border_1()
            .border_color(rgb(if card.picked {
                theme.primary()
            } else {
                theme.active
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_none()
                            .size(px(22.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(corners::SMALL))
                            .bg(rgb(theme.primary()))
                            .text_color(rgb(theme.text_on(theme.primary())))
                            .child(key.to_string()),
                    )
                    .child(div().flex_1().min_w_0().truncate().child(variant.name))
                    .child(
                        button(
                            ("pick", index),
                            if card.picked { "Picked" } else { "Pick" },
                            card.picked,
                            theme,
                        )
                        .debug_selector(move || format!("mockup-pick-{key}"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(card) = this.cards.get_mut(index) {
                                card.picked = !card.picked;
                                cx.notify();
                            }
                        })),
                    ),
            )
            .child(div().text_color(rgb(theme.muted)).child(variant.note))
            .child(
                // The frame the variant would sit in: the window background,
                // at the width it was designed for.
                div()
                    .debug_selector(move || format!("frame-{key}"))
                    .w(width)
                    .min_h(self.mockup.frame.height)
                    .overflow_hidden()
                    .rounded(px(corners::CONTROL))
                    .border_1()
                    .border_color(rgb(theme.active))
                    .bg(rgb(theme.background))
                    .child(body),
            )
            .child(card.note.clone())
            .into_any_element()
    }
}

impl Render for MockupWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.look.theme.clone();
        let config = &self.look.config;
        let shown: Vec<_> = match self.solo {
            Some(index) => vec![index],
            None => (0..self.cards.len()).collect(),
        };
        let cards: Vec<_> = shown
            .into_iter()
            .map(|index| self.render_card(index, window, cx))
            .collect();
        let empty = cards.is_empty();
        let header = crate::titlebar::header(&theme, window, |window, _| {
            window.remove_window();
        });
        let root = div()
            .key_context("MockupWindow")
            .track_focus(&self.focus)
            .on_action(cx.listener(|_, _: &Close, window, _| window.remove_window()))
            .on_action(cx.listener(|this, _: &Send, _, cx| this.send(cx)))
            .on_key_down(cx.listener(Self::key_down))
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(theme.background))
            .text_color(rgb(theme.foreground))
            .text_font(&config.ui)
            .text_size(px(config.ui.size))
            .line_height(px(config.ui.line_height()))
            .children(header)
            .child(self.render_toolbar(cx))
            .child(
                div()
                    .id("mockup-grid")
                    .debug_selector(|| "mockup-grid".into())
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_4()
                    .flex()
                    .flex_wrap()
                    .content_start()
                    .items_start()
                    .gap_4()
                    .when(empty, |el| {
                        el.child(
                            div()
                                .text_color(rgb(theme.muted))
                                .child("This mockup has no variants."),
                        )
                    })
                    .children(cards),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap_2()
                    .px_4()
                    .py_2()
                    .border_t_1()
                    .border_color(rgb(theme.active))
                    .bg(rgb(theme.surface))
                    .child(div().flex_1().min_w_0().child(self.overall.clone()))
                    .child(
                        button(
                            "send",
                            if self.sending {
                                "Sending..."
                            } else {
                                "Send to agent"
                            },
                            true,
                            &theme,
                        )
                        .debug_selector(|| "mockup-send".into())
                        .on_click(cx.listener(|this, _, _, cx| this.send(cx))),
                    )
                    .child(
                        div()
                            .flex_none()
                            .max_w(px(360.))
                            .truncate()
                            .text_color(rgb(theme.muted))
                            .child(self.status.clone()),
                    ),
            );
        crate::titlebar::frame(window, theme.active, root)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
