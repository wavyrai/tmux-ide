// The built-in mockup, shown when no HERDR_MOCKUP_FILE was given. It is also
// the template for an agent's own file: the same imports, the same
// `pub(super) fn mockup() -> Mockup`, and both kinds of body. A file compiled
// in through `include!` may not start with inner attributes or `//!` docs.

use super::{Body, Look, Mockup, Variant};
use crate::{config::corners, fonts::StyledFont, icons::AgentIcon};
use gpui::{prelude::*, *};

pub(super) fn mockup() -> Mockup {
    Mockup {
        title: "Workspace status chip",
        frame: size(px(300.), px(96.)),
        variants: vec![
            Variant {
                name: "Pill",
                note: "Everything on one line: agent, name, branch in a pill.",
                body: Body::Element(pill),
            },
            Variant {
                name: "Two-line",
                note: "Name first, branch and state quieter underneath.",
                body: Body::Element(two_line),
            },
            Variant {
                name: "Accent bar",
                note: "A state-colored bar carries status; no dot.",
                body: Body::Element(accent_bar),
            },
            Variant {
                name: "Expandable",
                note: "Click to reveal the agent's last message.",
                body: Body::View(|_, cx| cx.new(|_| Expandable::default()).into()),
            },
        ],
    }
}

/// Realistic content every variant shows, so they differ only in design.
const NAME: &str = "herdr-gpui";
const BRANCH: &str = "feat/native-mockups";
const MESSAGE: &str = "Ran just ci: 412 tests passed. Waiting for review.";

fn agent_icon(look: &Look, size: f32) -> Svg {
    svg()
        .flex_none()
        .size(px(size))
        .path(AgentIcon::Claude.path())
        .text_color(rgb(look.theme.foreground))
}

fn working(look: &Look) -> u32 {
    look.theme.ink(look.theme.palette[2])
}

fn pill(look: &Look, _: &mut Window, _: &mut App) -> AnyElement {
    let theme = &look.theme;
    div()
        .p_3()
        .flex()
        .items_center()
        .gap_2()
        .child(agent_icon(look, 16.))
        .child(div().flex_none().child(NAME))
        .child(
            div()
                .min_w_0()
                .px_2()
                .rounded(px(corners::CONTROL))
                .bg(rgb(theme.active))
                .text_color(rgb(theme.subtext()))
                .text_font(&look.config.terminal)
                .text_size(px(look.config.ui.size - 1.))
                .truncate()
                .child(BRANCH),
        )
        .child(div().flex_1())
        .child(
            div()
                .flex_none()
                .size(px(8.))
                .rounded_full()
                .bg(rgb(working(look))),
        )
        .into_any_element()
}

fn two_line(look: &Look, _: &mut Window, _: &mut App) -> AnyElement {
    let theme = &look.theme;
    div()
        .p_3()
        .flex()
        .gap_3()
        .child(agent_icon(look, 20.))
        .child(
            div()
                .flex()
                .flex_col()
                .min_w_0()
                .child(div().font_weight(FontWeight::SEMIBOLD).child(NAME))
                .child(
                    div()
                        .flex()
                        .gap_1()
                        .text_color(rgb(theme.muted))
                        .child(div().min_w_0().truncate().child(BRANCH))
                        .child("·")
                        .child(
                            div()
                                .flex_none()
                                .text_color(rgb(working(look)))
                                .child("working"),
                        ),
                ),
        )
        .into_any_element()
}

fn accent_bar(look: &Look, _: &mut Window, _: &mut App) -> AnyElement {
    let theme = &look.theme;
    div()
        .flex()
        .h_full()
        .child(div().flex_none().w(px(3.)).bg(rgb(working(look))))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .p_3()
                .flex()
                .flex_col()
                .child(NAME)
                .child(
                    div()
                        .text_color(rgb(theme.subtext()))
                        .truncate()
                        .child(BRANCH),
                ),
        )
        .into_any_element()
}

/// A stateful variant: the card keeps its expanded state across theme and
/// width changes, because the window builds the view only once.
#[derive(Default)]
struct Expandable {
    open: bool,
}

impl Render for Expandable {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let look = cx.global::<Look>();
        let theme = &look.theme;
        let hover = theme.surface;
        div()
            .id("expandable")
            .p_3()
            .flex()
            .flex_col()
            .gap_2()
            .cursor_pointer()
            .hover(move |style| style.bg(rgb(hover)))
            .on_click(cx.listener(|this, _, _, cx| {
                this.open = !this.open;
                cx.notify();
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(agent_icon(look, 16.))
                    .child(div().flex_1().min_w_0().truncate().child(NAME))
                    .child(
                        svg()
                            .flex_none()
                            .size(px(12.))
                            .path(if self.open {
                                "icons/chevron-up.svg"
                            } else {
                                "icons/chevron-down.svg"
                            })
                            .text_color(rgb(theme.muted)),
                    ),
            )
            .when(self.open, |el| {
                el.child(
                    div()
                        .p_2()
                        .rounded(px(corners::SMALL))
                        .bg(rgb(theme.surface))
                        .text_color(rgb(theme.subtext()))
                        .child(MESSAGE),
                )
            })
    }
}
