//! The host header pinned above the spaces list while that host's workspaces
//! scroll under it, as section headers stay in native lists, so a scrolled
//! list still says which machine its rows belong to.

/// A host header row as the spaces list last laid it out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct HostHeader {
    /// The host's endpoint index.
    pub(super) host: usize,
    /// The row's top, relative to the top of the visible list: negative once
    /// it has scrolled above it.
    pub(super) top: f32,
    pub(super) height: f32,
}

/// The header to pin, with `top` where its copy is drawn: at the list's top,
/// or above it once pushed. The last header scrolled above the top pins in
/// place until the next one reaches the pinned copy's bottom edge and pushes
/// it up and out. `headers` follow list order. None while every header is at
/// or below the top, as the rows then show their own.
pub(super) fn pinned(headers: &[HostHeader]) -> Option<HostHeader> {
    let position = headers.iter().rposition(|header| header.top < 0.)?;
    let header = headers.get(position)?;
    let push = headers
        .get(position + 1)
        .map_or(0., |next| (next.top - header.height).min(0.));
    Some(HostHeader {
        top: push,
        ..*header
    })
}

/// How far down the list's top the pinned copy hides rows; 0 with none.
pub(super) fn cover(headers: &[HostHeader]) -> f32 {
    pinned(headers).map_or(0., |pinned| pinned.top + pinned.height)
}
