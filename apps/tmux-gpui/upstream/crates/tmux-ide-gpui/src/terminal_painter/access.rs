//! The flat-frame call surface the painter tests use; native callers borrow rows.
use super::*;
use herdr_client::protocol::FrameData;
impl TerminalPainter {
    #[allow(clippy::too_many_arguments)]
    pub fn paint_frame(
        &mut self,
        frame: &FrameData,
        origin: Point<Pixels>,
        available: Option<Size<Pixels>>,
        cell_width: f32,
        font: &Font,
        highlights: &[Highlight],
        panes: &[PaneSurfacePane],
        part: Option<Part<'_>>,
        images: Option<PlacedImages<'_>>,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.paint_view(
            FrameView::Flat(frame),
            origin,
            available,
            cell_width,
            font,
            highlights,
            panes,
            part,
            images,
            window,
            cx,
        );
    }
}
