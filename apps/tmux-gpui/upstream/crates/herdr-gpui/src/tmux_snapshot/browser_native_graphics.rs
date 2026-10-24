//! Native placements remain tied to the committed rows that produced them.
use super::{
    Error,
    kitty_graphics::{self, Placement, Store},
};
use herdr_client::{
    tmux_native_session::{GraphicsEvent, PaneGraphics},
    tmux_topology::PresentedWindow,
};
use std::{collections::BTreeMap, sync::Arc};
pub(super) struct Graphics {
    store: Store,
    panes: BTreeMap<String, Arc<PaneGraphics>>,
}
impl Graphics {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            panes: BTreeMap::new(),
        }
    }
    pub fn accept(
        &mut self,
        events: Vec<GraphicsEvent>,
        placements: BTreeMap<String, Arc<PaneGraphics>>,
    ) -> Result<bool, Error> {
        let changed = !events.is_empty() || !placements.is_empty();
        for event in events {
            match event {
                GraphicsEvent::Chunk(chunk) => self.store.accept_native(chunk)?,
                GraphicsEvent::Invalidate(digests) => self.store.invalidate_native(&digests),
            }
        }
        self.panes.extend(placements);
        Ok(changed)
    }
    pub fn placements(
        &self,
        window: &PresentedWindow,
        history_offset: usize,
    ) -> Result<Vec<Placement>, Error> {
        let mut output = Vec::new();
        let convert = |value: usize| {
            u16::try_from(value).map_err(|_| Error::Invalid("native graphics coordinate overflow"))
        };
        for region in &window.paint.regions {
            if history_offset > 0 && region.pane == window.paint.selected_pane {
                continue;
            }
            let Some(placements) = self.panes.get(&region.pane) else {
                continue;
            };
            if !Arc::ptr_eq(&placements.identity, &region.source.identity) {
                continue;
            }
            for keyed in &placements.placements {
                let p = &keyed.placement;
                if p.row
                    .checked_add(p.rows)
                    .is_none_or(|end| end > region.content_rows)
                    || p.column
                        .checked_add(p.columns)
                        .is_none_or(|end| end > region.width)
                {
                    return Err(Error::Invalid("native image outside committed pane"));
                }
                output.push(Placement {
                    digest: p.digest.clone(),
                    row: convert(region.content_top + p.row)?,
                    column: convert(region.left + p.column)?,
                    rows: convert(p.rows)?,
                    columns: convert(p.columns)?,
                    source_row: convert(p.source_row)?,
                    source_column: convert(p.source_column)?,
                    total_rows: convert(p.total_rows)?,
                    total_columns: convert(p.total_columns)?,
                    image: Some(keyed.image.clone()),
                });
                if output.len() > 256 {
                    return Err(Error::Invalid("too many native image placements"));
                }
            }
        }
        kitty_graphics::validate(
            &output,
            convert(window.paint.cols)?,
            convert(window.paint.rows)?,
        )?;
        Ok(output)
    }
}
impl Drop for Graphics {
    fn drop(&mut self) {
        self.store.retire_native();
    }
}
