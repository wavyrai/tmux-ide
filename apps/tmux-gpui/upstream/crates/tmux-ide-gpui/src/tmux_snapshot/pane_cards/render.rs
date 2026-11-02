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
        ok
    }
}
impl Layout {
    /// Each pane's opaque card under its cells, on Bezel's panel radius and
    /// hairline border, sized to the canvas `bounds` it paints in.
    pub fn paint_cards(
        &self,
        bounds: Bounds<Pixels>,
        background: Hsla,
        border: Hsla,
        window: &mut Window,
    ) {
        for r in &self.regions {
            let mut card = self.card_in(r, bounds.size.height);
            card.origin += bounds.origin;
            window.paint_quad(quad(
                card,
                px(bezel_theme::Theme::panel_radius()),
                background,
                px(1.),
                border,
                BorderStyle::Solid,
            ));
        }
    }
}
