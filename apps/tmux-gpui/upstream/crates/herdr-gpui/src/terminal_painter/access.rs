//! Preserve the legacy flat-frame call surface while native callers borrow rows.
use super::*;
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
    pub fn paint_link(
        &self,
        frame: &FrameData,
        origin: Point<Pixels>,
        cell_width: f32,
        rows: &[(u16, std::ops::Range<u16>)],
        window: &mut Window,
    ) {
        self.paint_link_view(FrameView::Flat(frame), origin, cell_width, rows, window);
    }
}

/// The cell rectangle covering every in-frame cell of `rows`, if any.
pub(super) fn link_bounds<'a>(
    frame: impl Into<FrameView<'a>>,
    rows: &[(u16, std::ops::Range<u16>)],
) -> Option<SurfaceRect> {
    let frame = frame.into();
    let mut cells = rows.iter().filter_map(|(row, columns)| {
        let end = columns.end.min(frame.width());
        (*row < frame.height() && columns.start < end).then_some((*row, columns.start, end))
    });
    let (row, start, end) = cells.next()?;
    let (top, bottom, left, right) = cells.fold(
        (row, row, start, end),
        |(top, bottom, left, right), (row, start, end)| {
            (
                top.min(row),
                bottom.max(row),
                left.min(start),
                right.max(end),
            )
        },
    );
    Some(SurfaceRect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top + 1,
    })
}
