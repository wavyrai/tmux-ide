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
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn card_surfaces(&self, width: f32) -> Vec<Div> {
        let Some(mut layout) = self.card_layout(width) else {
            return Vec::new();
        };
        if let Some(preview) = self.divider_content_preview() {
            layout = layout.reflow(&preview.regions);
        }
        let theme = self.theme();
        layout
            .regions
            .iter()
            .map(|r| {
                let rect = layout.card(r);
                div()
                    .absolute()
                    .left(rect.origin.x)
                    .top(rect.origin.y)
                    .w(rect.size.width)
                    .h(rect.size.height)
                    .rounded(px(RADIUS))
                    .bg(rgb(theme.background))
                    .border_1()
                    .border_color(super::super::controls::separator(&theme))
            })
            .collect()
    }
}
