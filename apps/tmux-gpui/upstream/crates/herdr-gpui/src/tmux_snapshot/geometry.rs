//! Quantize the drawable area, never round into a clipped terminal cell.
pub(super) fn cell_grid(
    width: f32,
    height: f32,
    cell_width: f32,
    cell_height: f32,
) -> Option<(u16, u16)> {
    if ![width, height, cell_width, cell_height]
        .into_iter()
        .all(|v| v.is_finite() && v > 0.)
    {
        return None;
    }
    let cols = (width / cell_width).floor();
    let rows = (height / cell_height).floor();
    if cols < 2. || rows < 2. {
        return None;
    }
    Some((cols.min(1000.) as u16, rows.min(500.) as u16))
}
#[cfg(test)]
#[path = "geometry_tests.rs"]
mod tests;
