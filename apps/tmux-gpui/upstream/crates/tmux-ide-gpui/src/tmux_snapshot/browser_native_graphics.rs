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
    /// Whether a pane in `window` shows placeholder cells for an image the
    /// daemon does not hold (group H).
    pub fn images_lost(&self, window: &PresentedWindow) -> bool {
        window.paint.regions.iter().any(|region| {
            self.panes.get(&region.pane).is_some_and(|graphics| {
                graphics.orphaned && Arc::ptr_eq(&graphics.identity, &region.source.identity)
            })
        })
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use herdr_client::{
        tmux_delivery::{Update, decode_compact},
        tmux_native_session::{CommittedIdentity, CommittedPane},
        tmux_topology::{CopyRegion, Region, WindowPaint},
    };
    use serde_json::json;

    fn pane(incarnation: &str) -> Arc<CommittedPane> {
        let value = json!({"v":1,"k":"terminal-semantic-compact","f":"s","r":0,"s":[2,1,[[0,[[2,"a",1,0,0,0]]]],[],[0,0,0,"block",0],[0,0,0,0,0,0,1,0,null,null,0],[],["authoritative-stream","observed-from-start"]]});
        let Update::Seed { snapshot, .. } =
            decode_compact(&serde_json::to_vec(&value).unwrap()).unwrap()
        else {
            panic!("seed")
        };
        Arc::new(CommittedPane {
            snapshot: Some(Arc::new(snapshot)),
            identity: Arc::new(CommittedIdentity {
                generation: "12345678-1234-4234-8234-123456789abc".into(),
                incarnation: incarnation.into(),
                delivery_nonce: "nonce".into(),
                canonical_revision: 1,
                canonical_state_hash: "0000000000000001".into(),
            }),
        })
    }

    fn window(source: &Arc<CommittedPane>) -> PresentedWindow {
        let snapshot = source.snapshot.as_ref().unwrap();
        PresentedWindow {
            coherent: true,
            paint: Arc::new(WindowPaint {
                window: "window".into(),
                selected_pane: "pane".into(),
                cols: 2,
                rows: 1,
                copy_region: CopyRegion {
                    pane: "pane".into(),
                    left: 0,
                    top: 0,
                    width: 2,
                    height: 1,
                    wrapped: vec![false],
                },
                modes: snapshot.modes.clone(),
                cursor: snapshot.cursor.clone(),
                mode_keys: None,
                zoomed: false,
                regions: vec![Region {
                    pane: "pane".into(),
                    left: 0,
                    top: 0,
                    width: 2,
                    height: 1,
                    content_top: 0,
                    content_rows: 1,
                    source: Arc::clone(source),
                }],
            }),
        }
    }

    fn graphics(source: &Arc<CommittedPane>, orphaned: bool) -> Graphics {
        let mut graphics = Graphics::new(Store::default());
        graphics
            .accept(
                Vec::new(),
                BTreeMap::from([(
                    "pane".to_string(),
                    Arc::new(PaneGraphics {
                        identity: Arc::clone(&source.identity),
                        placements: Vec::new(),
                        orphaned,
                    }),
                )]),
            )
            .unwrap();
        graphics
    }

    /// Group H: a pane on screen whose placeholders name an image the daemon
    /// does not hold makes the window say so; only for the rows on screen.
    #[test]
    fn images_lost_follows_the_pane_on_screen() {
        let shown = pane("one");
        assert!(graphics(&shown, true).images_lost(&window(&shown)));
        assert!(!graphics(&shown, false).images_lost(&window(&shown)));
        // A report about rows no longer on screen says nothing.
        let newer = pane("two");
        assert!(!graphics(&shown, true).images_lost(&window(&newer)));
        // No report for the pane at all.
        let empty = Graphics::new(Store::default());
        assert!(!empty.images_lost(&window(&shown)));
    }
}
