//! Paint counters the terminal painter's tests read through the
//! `integration-test` feature.
use gpui::Global;

#[derive(Default, Debug, Clone, Copy)]
pub(crate) struct Counts {
    pub shapes: usize,
    pub quads: usize,
    pub glyphs: usize,
    /// Cell-geometry paths, such as prompt separators.
    pub paths: usize,
    pub decorations: usize,
    pub paint_errors: usize,
    pub metric_shapes: usize,
    pub paints: usize,
}
impl Global for Counts {}
