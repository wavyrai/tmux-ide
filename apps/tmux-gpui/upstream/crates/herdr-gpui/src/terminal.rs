mod accessibility;
mod links;
mod selection;
pub(crate) mod splits;
pub(crate) use accessibility::Transcript;
pub(crate) use links::{PaneLink, RowLink, RowTarget, link_at, pane_link_at};
pub(crate) use selection::{MAX_SELECTION_BYTES, Selection};

use crate::config::Theme;
use gpui::{
    Bounds, KeyDownEvent, Keystroke, Modifiers, Pixels, Point, ScrollDelta, ScrollWheelEvent,
    TouchPhase, point, px, size,
};
use herdr_client::protocol::{
    CellData, ClientKeyCode, ClientKeyKind, ClientMouseGeometry, ClientMouseKind,
    ClientMousePosition, ClientPaneInputEvent, ClientSurfaceSize, CursorState, FrameData,
    PaneSurfaceFrame, PaneSurfacePane, SurfaceRect,
};

#[cfg(test)]
pub const BACKGROUND: u32 = 0x101419;
#[cfg(test)]
pub const FOREGROUND: u32 = 0xd8dee9;
pub const FONT_SIZE: f32 = 14.;
pub const CELL_HEIGHT: f32 = 20.;

pub(crate) const BOLD: u16 = 1;
pub(crate) const DIM: u16 = 1 << 1;
pub(crate) const ITALIC: u16 = 1 << 2;
pub(crate) const UNDERLINE: u16 = 1 << 3;
pub(crate) const REVERSED: u16 = 1 << 6;
pub(crate) const HIDDEN: u16 = 1 << 7;
pub(crate) const STRIKETHROUGH: u16 = 1 << 8;

pub(crate) fn popup_origin(
    frame: &FrameData,
    popup: &FrameData,
    cell_width: f32,
    cell_height: f32,
) -> Point<Pixels> {
    point(
        px((frame.width.saturating_sub(popup.width) as f32 * cell_width / 2.).floor()),
        px(frame.height.saturating_sub(popup.height) as f32 * cell_height / 2.),
    )
}

pub(crate) fn cursor_offset(
    cursor: &CursorState,
    cell_width: f32,
    cell_height: f32,
) -> Point<Pixels> {
    point(
        px(cursor.x as f32 * cell_width),
        px(cursor.y as f32 * cell_height),
    )
}

pub(crate) fn input_cursor_bounds(
    surface: Option<&PaneSurfaceFrame>,
    origin: Point<Pixels>,
    cell_width: f32,
    cell_height: f32,
) -> Bounds<Pixels> {
    let mut origin = origin;
    if let Some(surface) = surface {
        let frame = if let Some(popup) = &surface.popup {
            origin += popup_origin(&surface.frame, &popup.frame, cell_width, cell_height);
            &popup.frame
        } else {
            &surface.frame
        };
        if let Some(cursor) = &frame.cursor {
            origin += cursor_offset(cursor, cell_width, cell_height);
        }
    }
    Bounds::new(origin, size(px(cell_width), px(cell_height)))
}

/// Where input lands: the popup when one is open, otherwise the whole grid.
/// An IME composition and its candidate window stay inside this area.
pub(crate) fn input_area(
    surface: Option<&PaneSurfaceFrame>,
    grid: Bounds<Pixels>,
    cell_width: f32,
    cell_height: f32,
) -> Bounds<Pixels> {
    let Some((frame, popup)) =
        surface.and_then(|surface| Some((&surface.frame, surface.popup.as_ref()?)))
    else {
        return grid;
    };
    Bounds::new(
        grid.origin + popup_origin(frame, &popup.frame, cell_width, cell_height),
        size(
            px(f32::from(popup.frame.width) * cell_width),
            px(f32::from(popup.frame.height) * cell_height),
        ),
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum InputTarget {
    Pane(String),
    Popup(String),
}

/// Pane context actions include the pane's chrome, but never a popup or the
/// unused area outside the composite surface. Coordinates use the paint origin.
pub(crate) fn pane_at(
    surface: &PaneSurfaceFrame,
    bounds: Bounds<Pixels>,
    position: Point<Pixels>,
    cell_width: f32,
    cell_height: f32,
) -> Option<&str> {
    let x = (position.x - bounds.origin.x).to_f64() as f32;
    let y = (position.y - bounds.origin.y).to_f64() as f32;
    if surface.popup.is_some()
        || !x.is_finite()
        || !y.is_finite()
        || !cell_width.is_finite()
        || !cell_height.is_finite()
        || cell_width <= 0.
        || cell_height <= 0.
        || x < 0.
        || y < 0.
        || x >= bounds.size.width.to_f64() as f32
        || y >= bounds.size.height.to_f64() as f32
        || x >= f32::from(surface.frame.width) * cell_width
        || y >= f32::from(surface.frame.height) * cell_height
    {
        return None;
    }
    surface
        .panes
        .iter()
        .find(|pane| {
            let r = pane.rect;
            x >= f32::from(r.x) * cell_width
                && x < (u32::from(r.x) + u32::from(r.width)) as f32 * cell_width
                && y >= f32::from(r.y) * cell_height
                && y < (u32::from(r.y) + u32::from(r.height)) as f32 * cell_height
        })
        .map(|pane| pane.pane_id.as_str())
}

/// Whole wheel steps on each axis, signed as GPUI reports them: positive
/// lines scroll up and positive columns scroll left.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WheelSteps {
    pub lines: i16,
    pub columns: i16,
}

/// Sub-step motion kept between events on one axis.
#[derive(Default)]
pub(crate) struct WheelRemainder(f32);

impl WheelRemainder {
    pub(crate) fn add(&mut self, delta: f32) -> i16 {
        if !delta.is_finite() {
            return 0;
        }
        if delta != 0. && delta.signum() != self.0.signum() {
            self.0 = 0.;
        }
        // Bound each event's work; keep sub-cell trackpad motion, not an input backlog.
        let total = (self.0 + delta).clamp(-128., 128.);
        let steps = total.trunc() as i16;
        self.0 = total - f32::from(steps);
        steps
    }
}

/// Turns wheel and trackpad motion into whole lines and columns for one
/// target, resetting when the target or the gesture changes.
///
/// GPUI's platforms already turn Shift with a vertical wheel into horizontal
/// motion (macOS in the OS, X11 and Wayland in GPUI), so the axes are taken as
/// reported and Shift is forwarded unchanged rather than swapped again.
#[derive(Default)]
pub struct WheelAccumulator {
    target: Option<InputTarget>,
    lines: WheelRemainder,
    columns: WheelRemainder,
}

impl WheelAccumulator {
    pub fn steps(
        &mut self,
        target: &WheelTarget,
        event: &ScrollWheelEvent,
        cell_width: f32,
        cell_height: f32,
    ) -> WheelSteps {
        if self.target.as_ref() != Some(&target.target)
            || matches!(event.touch_phase, TouchPhase::Started)
        {
            *self = Self {
                target: Some(target.target.clone()),
                ..Self::default()
            };
        }
        // Dominance compares the reported motion itself: cells are not square.
        let (raw_x, raw_y, x, y) = match event.delta {
            ScrollDelta::Pixels(delta) => {
                let (x, y) = (delta.x.to_f64() as f32, delta.y.to_f64() as f32);
                (x, y, x / cell_width, y / cell_height)
            }
            ScrollDelta::Lines(delta) => (delta.x, delta.y, delta.x, delta.y),
        };
        let lines = self.lines.add(y);
        // Herdr turns a horizontal wheel only into a mouse report, so motion
        // over a pane that does not report the mouse would do nothing. A
        // mostly vertical swipe's sideways drift is not a column either.
        let columns = if !target.mouse_reporting {
            self.columns = WheelRemainder::default();
            0
        } else if raw_x.abs() > raw_y.abs() {
            self.columns.add(x)
        } else {
            0
        };
        WheelSteps { lines, columns }
    }
}

pub struct WheelTarget {
    pub target: InputTarget,
    pub(crate) mouse_reporting: bool,
    pub(crate) bounds: Bounds<Pixels>,
    position: ClientMousePosition,
    geometry: Option<ClientMouseGeometry>,
}

impl WheelTarget {
    /// One event per moving axis, vertical first. Like a terminal wheel event,
    /// each carries its whole count; Herdr reports one wheel button for it to
    /// a mouse-reporting application and scrolls host scrollback by the count.
    pub fn wheel_events(
        &self,
        steps: WheelSteps,
        modifiers: Modifiers,
    ) -> impl Iterator<Item = ClientPaneInputEvent> + '_ {
        let vertical = (steps.lines != 0).then(|| {
            let kind = if steps.lines > 0 {
                ClientMouseKind::ScrollUp
            } else {
                ClientMouseKind::ScrollDown
            };
            (kind, steps.lines)
        });
        let horizontal = (steps.columns != 0).then(|| {
            let kind = if steps.columns > 0 {
                ClientMouseKind::ScrollLeft
            } else {
                ClientMouseKind::ScrollRight
            };
            (kind, steps.columns)
        });
        vertical
            .into_iter()
            .chain(horizontal)
            .map(move |(kind, count)| {
                let mut event = self.mouse_event(kind, modifiers);
                if let ClientPaneInputEvent::Mouse { lines, .. } = &mut event {
                    *lines = count.unsigned_abs();
                }
                event
            })
    }

    pub(crate) fn mouse_event(
        &self,
        kind: ClientMouseKind,
        modifiers: Modifiers,
    ) -> ClientPaneInputEvent {
        ClientPaneInputEvent::Mouse {
            kind,
            position: self.position,
            geometry: self.geometry,
            modifiers: u8::from(modifiers.shift)
                | (u8::from(modifiers.control) << 1)
                | (u8::from(modifiers.alt) << 2)
                | (u8::from(modifiers.platform) << 3),
            lines: 1,
        }
    }
}

pub fn wheel_target(
    surface: &PaneSurfaceFrame,
    x: f32,
    y: f32,
    cell_width: f32,
    cell_height: f32,
) -> Option<WheelTarget> {
    if !x.is_finite()
        || !y.is_finite()
        || !cell_width.is_finite()
        || !cell_height.is_finite()
        || cell_width <= 0.
        || cell_height <= 0.
        || x < 0.
        || y < 0.
    {
        return None;
    }
    let (target, rect, mouse_reporting, pixel_mouse, width_px, height_px, origin_x, origin_y) =
        if let Some(popup) = &surface.popup {
            let origin = popup_origin(&surface.frame, &popup.frame, cell_width, cell_height);
            (
                InputTarget::Popup(popup.terminal_id.clone()),
                SurfaceRect {
                    x: 0,
                    y: 0,
                    width: popup.frame.width,
                    height: popup.frame.height,
                },
                popup.mouse_reporting,
                popup.sgr_pixel_mouse,
                popup.pixel_width,
                popup.pixel_height,
                origin.x.to_f64() as f32,
                origin.y.to_f64() as f32,
            )
        } else {
            let pane = surface.panes.iter().find(|pane| {
                let r = pane.inner_rect;
                x >= r.x as f32 * cell_width
                    && x < (u32::from(r.x) + u32::from(r.width)) as f32 * cell_width
                    && y >= r.y as f32 * cell_height
                    && y < (u32::from(r.y) + u32::from(r.height)) as f32 * cell_height
            })?;
            (
                InputTarget::Pane(pane.pane_id.clone()),
                pane.inner_rect,
                pane.mouse_reporting,
                pane.sgr_pixel_mouse,
                pane.pixel_width,
                pane.pixel_height,
                pane.inner_rect.x as f32 * cell_width,
                pane.inner_rect.y as f32 * cell_height,
            )
        };
    let x = x - origin_x;
    let y = y - origin_y;
    if x < 0.
        || y < 0.
        || x >= rect.width as f32 * cell_width
        || y >= rect.height as f32 * cell_height
    {
        return None;
    }
    let column = (x / cell_width).floor() as u16;
    let row = (y / cell_height).floor() as u16;
    let geometry = (pixel_mouse && width_px > 0 && height_px > 0).then_some(ClientMouseGeometry {
        cols: rect.width,
        rows: rect.height,
        width_px,
        height_px,
    });
    let position = if geometry.is_some() {
        ClientMousePosition::Pixels {
            x: (x / (rect.width as f32 * cell_width) * width_px as f32).floor() as u32,
            y: (y / (rect.height as f32 * cell_height) * height_px as f32).floor() as u32,
            column,
            row,
        }
    } else {
        ClientMousePosition::Cell { column, row }
    };
    Some(WheelTarget {
        target,
        mouse_reporting,
        bounds: Bounds::new(
            point(px(origin_x), px(origin_y)),
            size(
                px(rect.width as f32 * cell_width),
                px(rect.height as f32 * cell_height),
            ),
        ),
        position,
        geometry,
    })
}

pub fn color(value: u32, default: u32, theme: &Theme) -> u32 {
    match value >> 24 {
        0 => match value & 255 {
            1..=16 => theme.palette[((value & 255) - 1) as usize],
            _ => default,
        },
        1 => theme.palette[(value & 255) as usize],
        2 => value & 0xffffff,
        _ => default,
    }
}

fn is_default(value: u32) -> bool {
    match value >> 24 {
        0 => !(1..=16).contains(&(value & 255)),
        1 | 2 => false,
        _ => true,
    }
}

pub fn cell_colors(cell: &CellData, theme: &Theme) -> (u32, u32) {
    let mut fg = match theme.bold {
        Some(bold) if cell.modifier & BOLD != 0 && is_default(cell.fg) => bold,
        _ => color(cell.fg, theme.foreground, theme),
    };
    let mut bg = color(cell.bg, theme.background, theme);
    if cell.modifier & REVERSED != 0 {
        std::mem::swap(&mut fg, &mut bg);
    }
    if cell.modifier & DIM != 0 {
        fg = ((fg & 0xfefefe) >> 1) + ((bg & 0xfefefe) >> 1);
    }
    if cell.modifier & HIDDEN != 0 {
        fg = bg;
    }
    (fg, bg)
}

pub fn viewport(width: f32, height: f32, cell_width: f32, cell_height: f32) -> ClientSurfaceSize {
    let cols = (width / cell_width.max(1.)).floor().clamp(1., 4096.) as u16;
    let rows = (height / cell_height.max(1.)).floor().clamp(1., 4096.) as u16;
    ClientSurfaceSize {
        cols,
        rows: rows.min((1_000_000 / u32::from(cols)) as u16),
    }
}

// Printable text belongs to EntityInputHandler, not key-down: this preserves
// keyboard layouts, dead keys and IME commits without double-sending characters.
// `alt_keys` claims Alt-modified characters as shortcuts instead; without it
// macOS Option-P commits `π` and the shortcut never reaches the pane.
pub fn key_input(event: &KeyDownEvent, alt_keys: bool) -> Option<ClientPaneInputEvent> {
    keystroke_input(&event.keystroke, event.is_held, alt_keys)
}

/// A `[pane_keys]` press: the pane receives `sent`, held as `event` is.
pub fn pane_key_input(event: &KeyDownEvent, sent: &Keystroke) -> Option<ClientPaneInputEvent> {
    keystroke_input(sent, event.is_held, true)
}

/// Whether a pane can receive `keystroke` as a key event, so `[pane_keys]`
/// never names one that would silently send nothing.
pub(crate) fn reaches_pane(keystroke: &Keystroke) -> bool {
    key_code(keystroke, true).is_some()
}

fn keystroke_input(
    keystroke: &Keystroke,
    is_held: bool,
    alt_keys: bool,
) -> Option<ClientPaneInputEvent> {
    key_code(keystroke, alt_keys).map(|code| ClientPaneInputEvent::Key {
        code,
        modifiers: u8::from(keystroke.modifiers.shift)
            | (u8::from(keystroke.modifiers.control) << 1)
            | (u8::from(keystroke.modifiers.alt) << 2),
        kind: if is_held {
            ClientKeyKind::Repeat
        } else {
            ClientKeyKind::Press
        },
        repeat_count: 1,
        shifted_codepoint: None,
        generated_text: None,
        tracks_release: false,
        physical_key_id: None,
        windows_record: None,
    })
}

/// Key presses sent while the daemon reported `ClientShellKeyboardReportAll`,
/// by GPUI key name, so a key-up releases exactly the key that was pressed even
/// when its modifiers were let go first. Bounded: a key-up lost to a focus
/// change must not grow it.
#[derive(Default)]
pub struct HeldKeys(Vec<(String, ClientPaneInputEvent)>);

impl HeldKeys {
    const LIMIT: usize = 16;

    /// Records a press about to be sent and marks it as tracking its release.
    /// Without report-all the press is returned unchanged and nothing is held.
    pub fn press(
        &mut self,
        key: &str,
        mut input: ClientPaneInputEvent,
        report_all: bool,
    ) -> ClientPaneInputEvent {
        self.forget(key);
        if !report_all {
            return input;
        }
        let ClientPaneInputEvent::Key { tracks_release, .. } = &mut input else {
            return input;
        };
        *tracks_release = true;
        let mut release = input.clone();
        if let ClientPaneInputEvent::Key {
            kind, repeat_count, ..
        } = &mut release
        {
            *kind = ClientKeyKind::Release;
            *repeat_count = 1;
        }
        if self.0.len() == Self::LIMIT {
            self.0.remove(0);
        }
        self.0.push((key.to_owned(), release));
        input
    }

    /// Drops a held key whose latest press went somewhere other than the pane.
    pub fn forget(&mut self, key: &str) {
        self.0.retain(|(held, _)| held != key);
    }

    /// The release for a key-up, if its press was sent while held.
    pub fn release(&mut self, key: &str) -> Option<ClientPaneInputEvent> {
        let index = self.0.iter().position(|(held, _)| held == key)?;
        Some(self.0.remove(index).1)
    }
}

fn key_code(key: &Keystroke, alt_keys: bool) -> Option<ClientKeyCode> {
    use ClientKeyCode::*;
    if key.modifiers.platform {
        return None;
    }
    Some(match key.key.as_str() {
        "enter" => Enter,
        "backspace" | "back" => Backspace,
        "escape" => Esc,
        "tab" if key.modifiers.shift => BackTab,
        "tab" => Tab,
        "up" => Up,
        "down" => Down,
        "left" => Left,
        "right" => Right,
        "home" => Home,
        "end" => End,
        "pageup" => PageUp,
        "pagedown" => PageDown,
        "delete" => Delete,
        "insert" => Insert,
        name if name.starts_with('f')
            && name[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) =>
        {
            F(name[1..].parse().ok()?)
        }
        "space" if key.modifiers.control => Char(' '),
        name if key.modifiers.control && name.chars().count() == 1 => Char(name.chars().next()?),
        "space" if key.modifiers.alt && alt_keys => Char(' '),
        // GPUI reports Shift-letter as the lowercase key plus Shift; a shifted
        // symbol arrives as the symbol itself. Herdr expects the typed letter.
        name if key.modifiers.alt && alt_keys && name.chars().count() == 1 => {
            let ch = name.chars().next()?;
            Char(if key.modifiers.shift {
                ch.to_ascii_uppercase()
            } else {
                ch
            })
        }
        _ => return None,
    })
}

const MIN_THUMB: f32 = 24.;

/// A pane's scrollbar in grid pixels. The daemon draws it as cells, which
/// move the thumb a whole row per many lines; this places it to the pixel.
/// Painting and dragging share it so the thumb is where it is grabbed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Scrollbar {
    pub track: Bounds<Pixels>,
    pub thumb: Bounds<Pixels>,
    max: u64,
}

impl Scrollbar {
    pub(crate) fn new(pane: &PaneSurfacePane, cell_width: f32, cell_height: f32) -> Option<Self> {
        let (rect, scroll) = (pane.scrollbar_rect?, pane.scroll?);
        if scroll.max_offset_from_bottom == 0 || rect.height == 0 {
            return None;
        }
        let track = Bounds::new(
            point(
                px(f32::from(rect.x) * cell_width),
                px(f32::from(rect.y) * cell_height),
            ),
            size(
                px(f32::from(rect.width) * cell_width),
                px(f32::from(rect.height) * cell_height),
            ),
        );
        let height = f32::from(track.size.height);
        let max = scroll.max_offset_from_bottom as f32;
        let visible = scroll.viewport_rows as f32;
        let thumb = (height * visible / (max + visible))
            .max(MIN_THUMB)
            .min(height);
        let offset = scroll.offset_from_bottom.min(scroll.max_offset_from_bottom) as f32;
        let top = (height - thumb) * (1. - offset / max);
        Some(Self {
            track,
            thumb: Bounds::new(
                track.origin + point(px(0.), px(top)),
                size(track.size.width, px(thumb)),
            ),
            max: scroll.max_offset_from_bottom,
        })
    }

    /// The offset from the bottom that puts the thumb's top at `top`.
    pub(crate) fn offset_at(&self, top: f32) -> u64 {
        let travel = f32::from(self.track.size.height - self.thumb.size.height);
        if travel <= 0. {
            return 0;
        }
        let fraction = ((top - f32::from(self.track.top())) / travel).clamp(0., 1.);
        ((1. - fraction) * self.max as f32).round() as u64
    }
}

pub(crate) fn in_rect(rect: SurfaceRect, x: u16, y: u16) -> bool {
    x >= rect.x
        && y >= rect.y
        && u32::from(x) < u32::from(rect.x) + u32::from(rect.width)
        && u32::from(y) < u32::from(rect.y) + u32::from(rect.height)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
