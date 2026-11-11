//! Deliberate web opening from the painted canonical panes: Cmd- or
//! Ctrl-click, or a Shift-click that does not drag, as the terminal app does.
use super::{SnapshotView, browser, copy, hit_regions};
use crate::terminal_painter::FrameView;
use gpui::{Context, Modifiers, MouseButton, MouseDownEvent, Pixels, Point};
use std::ops::Range;

/// A link under the pointer: what opens, and the painted cells it covers
/// (frame row, frame columns) for the hover cue.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Link {
    pub url: String,
    pub cells: Vec<(u16, Range<u16>)>,
}

/// The cue's link, kept with the frame it was read from: a new frame drops it.
pub(super) struct Hover {
    pub link: Link,
    pub frame: super::display_frame::DisplayFrame,
}

/// A Shift-press on a link, opened on release at the same cell.
pub(super) struct Pending {
    pub url: String,
    pub cell: (u16, u16),
}

/// Cmd- or Ctrl-click: opens on press.
pub(super) fn gesture(event: &MouseDownEvent) -> bool {
    event.button == MouseButton::Left && modifier(event.modifiers)
}

/// Shift-click: opens on release if the pointer stays on the same cell, so a
/// Shift-drag still selects text.
pub(super) fn shift_gesture(event: &MouseDownEvent) -> bool {
    event.button == MouseButton::Left
        && event.modifiers.shift
        && !event.modifiers.platform
        && !event.modifiers.control
        && !event.modifiers.alt
}

/// The modifier that turns a click into opening a link, and shows the cue.
pub(super) fn modifier(modifiers: Modifiers) -> bool {
    (modifiers.platform || modifiers.control) && !modifiers.shift && !modifiers.alt
}

impl SnapshotView {
    pub(super) fn terminal_web_link(&self, position: Point<Pixels>) -> Option<String> {
        self.terminal_link(position).map(|link| link.url)
    }

    /// The link in whichever pane is under `position`, selected or not.
    pub(super) fn terminal_link(&self, position: Point<Pixels>) -> Option<Link> {
        if self.browser_state.retained_preview
            || self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
            || self.divider.is_some()
            || !self.marked.is_empty()
            || !self.presence.ready()
            || self.browser_commands.is_none()
            || self.browser_state.request != self.browser_request
            || self.browser_state.surface != browser::Surface::Workspace
            || !(self.terminal_input_ready() || self.historical_selection_ready())
            || !hit_regions::is_painted(self.frame.as_ref(), self.painted_frame.as_ref())
            || !hit_regions::is_painted(self.frame.as_ref(), self.browser_state.frame.as_ref())
        {
            return None;
        }
        let (bounds, _) = self.input_geometry?;
        let width = self.input_cell_width?;
        let height = self.terminal_height();
        if !bounds.contains(&position) {
            return None;
        }
        let point = self.terminal_point(position)?;
        let id = hit_regions::hit(
            &self.browser_state.regions,
            f32::from(point.x),
            f32::from(point.y),
            width,
            height,
        )?;
        let frame = self.frame.as_ref()?;
        let region = self.link_region(id)?;
        resolve(
            frame.view(),
            &region,
            (f32::from(point.x) / width).floor() as u16,
            (f32::from(point.y) / height).floor() as u16,
        )
    }

    /// The content of pane `id`. The selected pane has its soft-wrap rows;
    /// another pane is read row by row, so a link that wraps there does not
    /// open (it would be cut short).
    fn link_region(&self, id: &str) -> Option<copy::Region> {
        if self.browser_state.selected_pane.as_deref() == Some(id) {
            return self.browser_state.copy_region.clone();
        }
        let content = self
            .browser_state
            .native_content_regions
            .iter()
            .find(|region| region.id == id)?;
        Some(copy::Region {
            id: content.id.clone(),
            left: content.left,
            top: content.top,
            width: content.width,
            height: content.height,
            wrapped: vec![false; usize::from(content.height)],
        })
    }

    /// Opens `url` in the default browser and says so, unless it names the
    /// remote machine's own loopback address, which would reach this Mac.
    pub(super) fn open_link(&mut self, url: &str, cx: &mut Context<Self>) {
        let machine = self.browser_state.remote_machine.clone();
        match machine.and_then(|machine| refusal(url, &machine)) {
            Some(note) => self.show_toast(note, cx),
            None => {
                cx.open_url(url);
                self.show_toast(format!("Opened {} in your browser", shown_host(url)), cx);
            }
        }
    }
}

/// The host (and port, when it is not the scheme's own) a note names.
fn shown_host(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else {
        return "the link".into();
    };
    let host = parsed.host_str().unwrap_or("the link");
    match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// Whether `url` names a computer's own loopback address: `localhost` (and
/// `*.localhost`), 127.0.0.0/8, `::1`, or the unspecified address.
pub(super) fn loopback(url: &str) -> bool {
    use url::Host;
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    match parsed.host() {
        Some(Host::Domain(domain)) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            domain == "localhost" || domain.ends_with(".localhost")
        }
        Some(Host::Ipv4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(Host::Ipv6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
        None => false,
    }
}

/// The note shown instead of opening a loopback link that a pane on another
/// machine printed: on this Mac it would reach this Mac's own server.
pub(super) fn refusal(url: &str, machine: &browser::RemoteMachine) -> Option<String> {
    if !loopback(url) {
        return None;
    }
    let port = url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.port_or_known_default())
        .unwrap_or(80);
    Some(format!(
        "{} is on {}, not this Mac, so it can't open here. \
         To view it on this Mac, forward the port: ssh -L {port}:localhost:{port} {}",
        shown_host(url),
        machine.label,
        machine.ssh_target,
    ))
}

fn resolve<'a>(
    frame: impl Into<FrameView<'a>>,
    region: &copy::Region,
    column: u16,
    row: u16,
) -> Option<Link> {
    let frame = frame.into();
    if !region.valid_view(frame, Some(&region.id))
        || column < region.left
        || row < region.top
        || column >= region.left + region.width
        || row >= region.top + region.height
    {
        return None;
    }
    let row = row - region.top;
    let mut first = row;
    let mut last = row;
    while first > 0 && region.wrapped[usize::from(first)] {
        first -= 1;
    }
    // The start of a retained logical line may be outside the displayed viewport.
    if region.wrapped[usize::from(first)] {
        return None;
    }
    while last + 1 < region.height && region.wrapped[usize::from(last + 1)] {
        last += 1;
    }
    let count = usize::from(last - first + 1) * usize::from(region.width);
    if count > 8192 {
        return None;
    }
    let mut cells = Vec::with_capacity(count);
    for y in first..=last {
        let start = usize::from(region.left);
        cells.extend(
            frame
                .row(usize::from(region.top + y))?
                .get(start..start + usize::from(region.width))?
                .iter(),
        );
    }
    let hit =
        usize::from(row - first) * usize::from(region.width) + usize::from(column - region.left);
    let (url, span) = crate::terminal::logical_web_link_span(&cells, hit, frame.hyperlinks())?;
    // One run of cells per painted row.
    let width = usize::from(region.width);
    let mut runs: Vec<(u16, Range<u16>)> = Vec::new();
    for index in span {
        let y = region.top + first + (index / width) as u16;
        let x = region.left + (index % width) as u16;
        match runs.last_mut() {
            Some((row, columns)) if *row == y && columns.end == x => columns.end = x + 1,
            _ => runs.push((y, x..x + 1)),
        }
    }
    Some(Link { url, cells: runs })
}

mod hover;

#[cfg(test)]
mod tests;
