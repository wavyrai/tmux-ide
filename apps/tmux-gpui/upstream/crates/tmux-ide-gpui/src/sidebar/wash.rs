//! A host's colour over its rows. The config file names a colour per host;
//! painted faintly behind the host's header, its workspace rows, and its
//! agents' rows, it lets a long list read by colour. Selecting a workspace
//! can raise its host's wash and quiet the other hosts, so the active
//! machine stands out from the ones it shares the sidebar with.

use super::layout::SidebarLook;
use crate::config::{SelectMode, SidebarStyle, Theme};
use gpui::{Div, InteractiveElement, ParentElement, Styled, div, px, rgba};

/// Alpha of a host's colour over rows at rest: a tint, never a fill, so
/// `theme.foreground` text stays legible on it in any theme.
pub(super) const REST_ALPHA: u32 = 0x1a;
/// Alpha over the selected host's rows in the group modes.
pub(super) const SELECTED_ALPHA: u32 = 0x38;
/// Opacity of every row on a host that is not selected in `group-dim`.
const DIM_OPACITY: f32 = 0.55;

/// A colour and how strongly it shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Wash {
    pub(super) color: u32,
    pub(super) alpha: u32,
}

/// What one host's rows get: a wash, a dimming, both, or neither.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct HostMark {
    pub(super) wash: Option<Wash>,
    pub(super) dim: bool,
}

impl HostMark {
    /// The mark for the host named `label`, given whether it holds the
    /// selected workspace. In `row` mode only configured colours show. The
    /// group modes raise the selected host's wash, with the theme's active
    /// colour standing in when no colour was configured, so the mode works
    /// without one; `group-dim` also quiets every other host.
    pub(super) fn resolve(
        style: &SidebarStyle,
        label: &str,
        selected: bool,
        theme: &Theme,
    ) -> Self {
        let configured = style.hosts.get(label).copied();
        let rest = configured.map(|color| Wash {
            color,
            alpha: REST_ALPHA,
        });
        match style.select {
            SelectMode::Row => Self {
                wash: rest,
                dim: false,
            },
            SelectMode::Group | SelectMode::GroupDim if selected => Self {
                wash: Some(Wash {
                    color: configured.unwrap_or(theme.active),
                    alpha: SELECTED_ALPHA,
                }),
                dim: false,
            },
            SelectMode::Group => Self {
                wash: rest,
                dim: false,
            },
            SelectMode::GroupDim => Self {
                wash: rest,
                dim: true,
            },
        }
    }

    /// The row's wash layer and dimming. The layer is absolutely positioned,
    /// inset like the highlight, and added before it, so the highlight and
    /// the row's content paint over the colour.
    pub(super) fn apply<E: ParentElement + Styled>(
        &self,
        row: E,
        key: &str,
        look: &SidebarLook,
    ) -> E {
        let row = if self.dim {
            row.opacity(DIM_OPACITY)
        } else {
            row
        };
        match self.wash {
            Some(wash) => row.child(layer(
                key,
                wash,
                (look.inset(), look.spacing() / 2., look.density.radius),
            )),
            None => row,
        }
    }

    /// As [`Self::apply`] for a row that is already its own card, such as
    /// orca's: the wash fills the card inside its corners.
    pub(super) fn fill<E: ParentElement + Styled>(&self, card: E, key: &str, radius: f32) -> E {
        let card = if self.dim {
            card.opacity(DIM_OPACITY)
        } else {
            card
        };
        match self.wash {
            Some(wash) => card.child(layer(key, wash, (0., 0., radius))),
            None => card,
        }
    }
}

/// The wash as a layer `inset` from the row's sides, `edge` from its top and
/// bottom, with `radius` corners.
fn layer(key: &str, wash: Wash, (inset, edge, radius): (f32, f32, f32)) -> Div {
    div()
        .debug_selector(|| format!("wash-{key}"))
        .absolute()
        .left(px(inset))
        .right(px(inset))
        .top(px(edge))
        .bottom(px(edge))
        .rounded(px(radius))
        .bg(rgba((wash.color << 8) | wash.alpha))
}
