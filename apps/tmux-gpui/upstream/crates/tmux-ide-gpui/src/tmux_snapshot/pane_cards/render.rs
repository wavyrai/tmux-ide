use super::*;
use crate::terminal_painter::{
    FrameView, Highlight, Layer, Part, PlacedImages, Span, TerminalPainter,
};
use gpui::*;
impl Layout {
    #[allow(clippy::too_many_arguments)]
    pub fn paint(
        &self,
        sources: &[Region],
        painter: &mut TerminalPainter,
        frame: FrameView<'_>,
        bounds: Bounds<Pixels>,
        font: &Font,
        highlights: &[Highlight],
        images: Option<PlacedImages<'_>>,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        let mut ok = true;
        // The cards' fills show under the cells' default background.
        painter.set_card_backed(true);
        for source in sources {
            let Some(target) = self.regions.iter().find(|r| r.id == source.id) else {
                continue;
            };
            let area: Vec<_> = (source.top..source.top + source.height)
                .map(|row| Span {
                    row,
                    columns: source.left..source.left + source.width,
                })
                .collect();
            let mut clip = self.content(target);
            clip.origin += bounds.origin;
            let origin = bounds.origin + self.origin(target)
                - point(
                    px(f32::from(source.left) * self.width),
                    px(f32::from(source.top) * self.height),
                );
            window.with_content_mask(
                Some(ContentMask {
                    bounds: clip.intersect(&bounds),
                    ..Default::default()
                }),
                |window| {
                    for layer in Layer::ALL {
                        ok &= painter.paint_view(
                            frame,
                            origin,
                            None,
                            self.width,
                            font,
                            highlights,
                            &[],
                            Some(Part { area: &area, layer }),
                            images,
                            window,
                            cx,
                        );
                    }
                },
            );
        }
        painter.set_card_backed(false);
        ok
    }
}
/// The cards one terminal canvas paints: the layout, reflowed to a divider
/// preview while one is active, with Bezel's card fills and the border.
pub(in crate::tmux_snapshot) struct CardSurfaces {
    layout: Layout,
    fills: CardFills,
    focused: Option<String>,
    border: Hsla,
}
/// A card's fill (#746 v3, focus by fill): the focused pane's card on the
/// terminal's own background, the others a step toward the ink
/// (`surfaces::card_fills`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(in crate::tmux_snapshot) struct CardFills {
    pub rest: Hsla,
    pub focused: Hsla,
}
impl CardFills {
    pub fn of(theme: &crate::config::Theme) -> Self {
        let (focused, rest) = crate::tmux_snapshot::surfaces::card_fills(theme);
        Self { rest, focused }
    }
}
impl CardSurfaces {
    pub fn paint(&self, bounds: Bounds<Pixels>, window: &mut Window) {
        self.layout.paint_cards(
            bounds,
            self.fills,
            self.focused.as_deref(),
            self.border,
            window,
        );
    }
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn card_surfaces(&self, width: f32) -> Option<CardSurfaces> {
        let mut layout = self.card_layout(width)?;
        if let Some(preview) = self.divider_content_preview() {
            layout = layout.reflow(&preview.regions);
        }
        let palette = super::super::design::palette(&self.theme());
        let theme = self.theme();
        Some(CardSurfaces {
            layout,
            fills: CardFills::of(&theme),
            focused: self.browser_state.selected_pane.clone(),
            border: card_border(&theme, &palette),
        })
    }
    /// Records the terminal canvas a paint used. Headers span their cards as
    /// painted in it, so a new canvas size renders them again.
    pub(in crate::tmux_snapshot) fn record_canvas(
        &mut self,
        bounds: Bounds<Pixels>,
        cursor: Bounds<Pixels>,
        cx: &mut Context<Self>,
    ) {
        if self.input_geometry.map(|g| g.0.size) != Some(bounds.size) {
            cx.notify();
        }
        self.input_geometry = Some((bounds, cursor));
    }
}
/// A card's 1 px border: the preset's own when it names one (#746: Linen),
/// else Bezel's `border`.
pub(in crate::tmux_snapshot) fn card_border(
    theme: &crate::config::Theme,
    palette: &bezel_theme::Theme,
) -> Hsla {
    theme
        .card_border
        .map_or(palette.border, |value| rgb(value).into())
}
impl Layout {
    /// Each pane's opaque card under its cells, on Bezel's panel radius and
    /// hairline border, sized to the canvas `bounds` it paints in.
    pub fn paint_cards(
        &self,
        bounds: Bounds<Pixels>,
        fills: CardFills,
        focused: Option<&str>,
        border: Hsla,
        window: &mut Window,
    ) {
        #[cfg(test)]
        painted::begin();
        for r in &self.regions {
            let mut card = self.card_in(r, bounds.size);
            card.origin += bounds.origin;
            let fill = if focused == Some(r.id.as_str()) {
                fills.focused
            } else {
                fills.rest
            };
            #[cfg(test)]
            painted::record(&r.id, card, fill);
            window.paint_quad(quad(
                card,
                px(bezel_theme::Theme::panel_radius()),
                fill,
                px(1.),
                border,
                BorderStyle::Solid,
            ));
        }
    }
}
/// The card rects the last `paint_cards` on this thread painted, in window
/// coordinates, for tests.
#[cfg(test)]
pub(in crate::tmux_snapshot) mod painted {
    use super::*;
    use std::cell::RefCell;
    /// Whether the next card starts a new paint, then each card by pane id,
    /// with its fill.
    type Cards = (bool, Vec<(String, Bounds<Pixels>, Hsla)>);
    thread_local! {
        static CARDS: RefCell<Cards> = Default::default();
    }
    pub(super) fn begin() {
        CARDS.with(|c| c.borrow_mut().0 = true);
    }
    pub(super) fn record(id: &str, card: Bounds<Pixels>, fill: Hsla) {
        CARDS.with(|c| {
            let mut c = c.borrow_mut();
            if std::mem::take(&mut c.0) {
                c.1.clear();
            }
            c.1.push((id.to_owned(), card, fill));
        });
    }
    pub fn cards() -> Vec<(String, Bounds<Pixels>)> {
        CARDS.with(|c| {
            c.borrow()
                .1
                .iter()
                .map(|(id, b, _)| (id.clone(), *b))
                .collect()
        })
    }
    pub fn fills() -> Vec<(String, Hsla)> {
        CARDS.with(|c| {
            c.borrow()
                .1
                .iter()
                .map(|(id, _, f)| (id.clone(), *f))
                .collect()
        })
    }
}
