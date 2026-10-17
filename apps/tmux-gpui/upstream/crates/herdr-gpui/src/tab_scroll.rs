//! Vertical mouse wheels retain horizontal tab-strip navigation on Bezel GPUI.
use gpui::{App, Pixels, ScrollHandle, ScrollWheelEvent, Window, px};

pub(crate) fn wheel(
    handle: &ScrollHandle,
    event: &ScrollWheelEvent,
    window: &mut Window,
    cx: &mut App,
) {
    let delta = event.delta.pixel_delta(window.line_height());
    // Native horizontal/diagonal trackpad movement remains renderer-owned.
    if delta.x != Pixels::ZERO || delta.y == Pixels::ZERO {
        return;
    }
    let mut offset = handle.offset();
    let next = (offset.x + delta.y).max(-handle.max_offset().x).min(px(0.));
    if next != offset.x {
        offset.x = next;
        handle.set_offset(offset);
        window.refresh();
        cx.stop_propagation();
    }
}
