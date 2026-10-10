//! Resolve user-selected links within the painted pane or popup only: web
//! addresses, and the local file paths a pane prints, which open only on a
//! link-modifier click on the machine that runs the pane.
use super::{HIDDEN, InputTarget, popup_origin, selection::shown, wheel_target};
use herdr_client::protocol::{FrameData, PaneSurfaceFrame};
use std::ops::Range;

mod path;

pub(super) const MAX_ROW_BYTES: usize = 32768;

fn web_url(value: &str) -> Option<String> {
    crate::browser::WebUrl::try_from(value)
        .ok()
        .map(String::from)
}

/// The local path a `file://` hyperlink names. A file on another host is not
/// this machine's to open, so only an empty host or `localhost` qualifies:
/// Windows would otherwise read any other host as a network share.
fn file_url_path(value: &str) -> Option<String> {
    let url = url::Url::parse(value)
        .ok()
        .filter(|url| url.scheme() == "file")?;
    if url.host_str().is_some_and(|host| host != "localhost") {
        return None;
    }
    url.to_file_path().ok()?.into_os_string().into_string().ok()
}

/// What a row-local link points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RowTarget {
    /// A web address that passed `WebUrl` validation.
    Web(String),
    /// A local path as the pane printed it, with `~/` and relative paths left
    /// for the click to resolve, or the absolute path of a `file://` link.
    Path(String),
}

/// A link read from one row, and the frame columns it covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RowLink {
    pub(crate) target: RowTarget,
    pub(crate) row: u16,
    pub(crate) columns: Range<u16>,
}

/// A row-local link in a pane, which a popup never is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PaneLink {
    pub(crate) pane_id: String,
    pub(crate) link: RowLink,
}

/// The web address under a point, in a pane or a popup.
pub(crate) fn link_at(
    surface: &PaneSurfaceFrame,
    x: f32,
    y: f32,
    cell_width: f32,
    cell_height: f32,
) -> Option<String> {
    match located(surface, x, y, cell_width, cell_height)?.1.target {
        RowTarget::Web(url) => Some(url),
        RowTarget::Path(_) => None,
    }
}

/// The link of either kind under a point in a pane, in surface frame cells.
pub(crate) fn pane_link_at(
    surface: &PaneSurfaceFrame,
    x: f32,
    y: f32,
    cell_width: f32,
    cell_height: f32,
) -> Option<PaneLink> {
    let (pane_id, link) = located(surface, x, y, cell_width, cell_height)?;
    Some(PaneLink {
        pane_id: pane_id?,
        link,
    })
}

fn located(
    surface: &PaneSurfaceFrame,
    x: f32,
    y: f32,
    cell_width: f32,
    cell_height: f32,
) -> Option<(Option<String>, RowLink)> {
    // Share popup isolation, pane bounds, and invalid-geometry handling with input.
    let target = wheel_target(surface, x, y, cell_width, cell_height)?;
    let (frame, x, y, start, end, pane_id) = match target.target {
        InputTarget::Popup(_) => {
            let popup = surface.popup.as_ref()?;
            let origin = popup_origin(&surface.frame, &popup.frame, cell_width, cell_height);
            (
                &popup.frame,
                x - f32::from(origin.x),
                y - f32::from(origin.y),
                0,
                popup.frame.width,
                None,
            )
        }
        InputTarget::Pane(id) => {
            let pane = surface.panes.iter().find(|pane| pane.pane_id == id)?;
            (
                &surface.frame,
                x,
                y,
                pane.inner_rect.x,
                pane.inner_rect.x.saturating_add(pane.inner_rect.width),
                Some(id),
            )
        }
    };
    let link = frame_link(
        frame,
        (x / cell_width).floor() as u16,
        (y / cell_height).floor() as u16,
        start,
        end,
    )?;
    Some((pane_id, link))
}

fn frame_link(frame: &FrameData, column: u16, row: u16, start: u16, end: u16) -> Option<RowLink> {
    if column < start || column >= end || end > frame.width || row >= frame.height {
        return None;
    }
    let offset = usize::from(row) * usize::from(frame.width);
    let cells = frame
        .cells
        .get(offset + usize::from(start)..offset + usize::from(end))?;
    let selected = usize::from(column - start);
    let mut source = selected;
    while cells.get(source)?.skip && source > 0 {
        source -= 1;
    }
    let cell = cells.get(source)?;
    if cell.modifier & HIDDEN != 0 {
        return None;
    }
    // Cell indexes fit the row, whose width is a `u16`.
    let columns = |cells: Range<usize>| start + cells.start as u16..start + cells.end as u16;
    // An explicit link is authoritative, even if its destination is disallowed.
    if let Some(index) = cells[selected].hyperlink.or(cell.hyperlink) {
        let destination = frame.hyperlinks.get(index as usize)?;
        let target = match web_url(destination) {
            Some(url) => RowTarget::Web(url),
            None => RowTarget::Path(file_url_path(destination)?),
        };
        let on_link = |i: &usize| cells[*i].skip || cells[*i].hyperlink == Some(index);
        let first = (0..=source)
            .rev()
            .take_while(on_link)
            .last()
            .unwrap_or(source);
        let last = (selected..cells.len())
            .take_while(on_link)
            .last()
            .unwrap_or(selected);
        return Some(RowLink {
            target,
            row,
            columns: columns(first..last + 1),
        });
    }
    // Byte offsets into the row's text, so a link maps back to its cells.
    let mut text = String::new();
    let mut starts = Vec::with_capacity(cells.len());
    for cell in cells {
        starts.push(text.len());
        if cell.skip {
            continue;
        }
        let symbol = shown(cell);
        if text.len() + symbol.len() > MAX_ROW_BYTES {
            return None;
        }
        text.push_str(symbol);
    }
    let hit = starts[source];
    // Plain links are row-local: the surface doesn't distinguish soft wraps
    // from separate lines, so joining rows could silently change the
    // destination. A daemon offering `pane.link.resolve` reads wrapped URLs
    // from its own terminal state instead; see `crate::links`.
    let (range, target) = match plain_url(&text, hit) {
        Some((_, true)) => return None,
        Some((range, false)) => {
            let url = web_url(&text[range.clone()])?;
            (range, RowTarget::Web(url))
        }
        None => match path::plain_path(&text, hit)? {
            (_, _, true) => return None,
            // A path starting the row may be the tail of whatever filled the
            // row above, such as a wrapped URL.
            (range, _, false) if range.start == 0 && row_full(frame, row, end) => return None,
            (range, path, false) => (range, RowTarget::Path(path.to_owned())),
        },
    };
    let first = (0..cells.len()).find(|&i| !cells[i].skip && starts[i] >= range.start)?;
    let last = (0..cells.len())
        .rev()
        .find(|&i| !cells[i].skip && starts[i] < range.end)?;
    // A wide character's continuation cells belong to the link too.
    let end = (last + 1..cells.len())
        .find(|&i| !cells[i].skip)
        .unwrap_or(cells.len());
    Some(RowLink {
        target,
        row,
        columns: columns(first..end),
    })
}

/// Whether the row above `row` prints up to the pane's right edge, `end`,
/// where its text may wrap onto `row`.
fn row_full(frame: &FrameData, row: u16, end: u16) -> bool {
    let Some(above) = row.checked_sub(1) else {
        return false;
    };
    let index = usize::from(above) * usize::from(frame.width) + usize::from(end) - 1;
    frame
        .cells
        .get(index)
        .is_some_and(|cell| cell.skip || shown(cell) != " ")
}

/// The byte range of the plain web URL in one row's `text` that covers the
/// byte at `hit`, trimmed of the prose punctuation around it, and whether the
/// URL runs to the end of the row, where it may continue off-screen or on the
/// next row.
pub(super) fn plain_url(text: &str, hit: usize) -> Option<(Range<usize>, bool)> {
    for (start, _) in text.match_indices("http") {
        if start > hit {
            break;
        }
        let tail = &text[start..];
        if !tail.starts_with("http://") && !tail.starts_with("https://") {
            continue;
        }
        let end = tail
            .find(|c: char| {
                c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | '\'' | '`')
            })
            .unwrap_or(tail.len());
        // Check the original token: punctuation at the edge may be part of a
        // destination continuing off-screen or on the next row.
        let open = end == tail.len();
        let mut candidate = tail[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
        for (open, close) in [('(', ')'), ('[', ']'), ('{', '}')] {
            let excess = candidate
                .matches(close)
                .count()
                .saturating_sub(candidate.matches(open).count());
            for _ in 0..excess {
                let Some(trimmed) = candidate.strip_suffix(close) else {
                    break;
                };
                candidate = trimmed;
            }
        }
        if hit < start + candidate.len() {
            return Some((start..start + candidate.len(), open));
        }
        if open {
            return None;
        }
    }
    None
}

#[cfg(test)]
mod tests;
