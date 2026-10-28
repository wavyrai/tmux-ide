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

/// Navigation within the painted window does not change its drawable viewport.
/// Transfer only a fit belonging to the exact previous navigation lifetime.
pub(super) fn reselect_fit(
    fit: Option<(u64, u16, u16)>,
    previous_request: u64,
    request: u64,
) -> Option<(u64, u16, u16)> {
    fit.filter(|(owner, _, _)| *owner == previous_request)
        .map(|(_, cols, rows)| (request, cols, rows))
}

/// Matches the existing Herdr window settle interval without holding a UI task.
const FIT_QUIET: std::time::Duration = std::time::Duration::from_millis(150);
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Fit {
    pub request: u64,
    pub cols: u16,
    pub rows: u16,
    pub pixels: (u32, u32, u32, u32),
}
#[derive(Default)]
pub(super) struct FitSettle {
    pending: Option<(Fit, std::time::Instant)>,
}
impl FitSettle {
    pub fn clear(&mut self) {
        self.pending = None;
    }
    pub fn due(&self, now: std::time::Instant) -> bool {
        self.pending
            .is_some_and(|(_, since)| now.saturating_duration_since(since) >= FIT_QUIET)
    }
    pub fn ready(
        &mut self,
        desired: Fit,
        last: Option<(u64, u16, u16)>,
        pixels_changed: bool,
        now: std::time::Instant,
    ) -> bool {
        if last == Some((desired.request, desired.cols, desired.rows)) && !pixels_changed {
            self.clear();
            return false;
        }
        if last.is_none_or(|(request, _, _)| request != desired.request) {
            self.clear();
            return true;
        }
        if self.pending.is_some_and(|(fit, _)| fit == desired) {
            return self.due(now);
        }
        self.pending = Some((desired, now));
        false
    }
}
