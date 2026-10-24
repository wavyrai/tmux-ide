use super::*;
use crate::tmux_delivery::projection::ProjectionUpdate;
impl Decoder<'_> {
    fn deferred(&mut self) -> Result<DeferredHistory> {
        self.tuple(2)?;
        let rows = self.size(0, 10000)?;
        let digest = self.string(true)?;
        if digest.len() != 16
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Invalid("history commitment"));
        }
        Ok(DeferredHistory {
            rows,
            digest: digest.into(),
        })
    }
    fn projection(&mut self) -> Result<Snapshot> {
        self.tuple(8)?;
        let cols = self.size(1, 4096)?;
        let rows = self.size(1, 4096)?;
        let grid = self.rows(Some(cols), rows as u64)?;
        let cursor = self.cursor()?;
        let modes = self.modes()?;
        let placements = self.placements()?;
        let bootstrap = self.bootstrap()?;
        let snapshot = Snapshot {
            cols,
            rows,
            grid,
            cursor,
            modes,
            placements,
            bootstrap,
            history: History::Deferred(self.deferred()?),
        };
        crate::tmux_delivery::store::validate(&snapshot)?;
        Ok(snapshot)
    }
    fn projection_patch(&mut self) -> Result<(Patch, DeferredHistory)> {
        self.tuple(7)?;
        let dimensions = self.optional(Self::dimensions)?;
        let count = self.list(4096)?;
        let rows = (0..count)
            .map(|_| {
                self.tuple(2)?;
                Ok((self.size(0, 4095)?, self.row(dimensions.map(|d| d.0))?))
            })
            .collect::<Result<_>>()?;
        let patch = Patch {
            dimensions,
            rows,
            history: None,
            history_delta: None,
            cursor: self.optional(Self::cursor)?,
            modes: self.optional(Self::modes)?,
            placements: self.optional(Self::placements)?,
            bootstrap: self.optional(Self::bootstrap)?,
        };
        if patch.modes.as_ref().is_some_and(|m| !m.alternate_screen) {
            return Err(Error::Invalid("projection normal screen"));
        }
        Ok((patch, self.deferred()?))
    }
}
pub fn decode_projection(bytes: &[u8]) -> Result<ProjectionUpdate> {
    if bytes.len() > 16 * 1024 * 1024 || !bytes.starts_with(b"TCP1") {
        return Err(Error::Invalid("projection representation"));
    }
    let mut d = Decoder {
        bytes: &bytes[4..],
        rows: 0,
        runs: 0,
        cells: 0,
        max_cells: 1_000_000,
        nodes: 0,
    };
    let frame = d.byte()?;
    let revision = d.varint(MAX_SAFE)?;
    let result = if frame == 0 {
        ProjectionUpdate::Seed {
            revision,
            snapshot: d.projection()?,
        }
    } else {
        let base_revision = d.varint(MAX_SAFE)?;
        if revision <= base_revision {
            return Err(Error::Revision);
        }
        match frame {
            1 => {
                let (patch, history) = d.projection_patch()?;
                ProjectionUpdate::Patch {
                    revision,
                    base_revision,
                    patch,
                    history,
                }
            }
            2 => {
                let reason = d.string(true)?;
                if !["pane-closed", "session-restarted", "runtime-disposed"].contains(&reason) {
                    return Err(Error::Invalid("tombstone"));
                }
                ProjectionUpdate::Tombstone {
                    revision,
                    base_revision,
                    reason: reason.into(),
                }
            }
            _ => return Err(Error::Invalid("projection frame")),
        }
    };
    if !d.bytes.is_empty() {
        return Err(Error::Invalid("projection trailing bytes"));
    }
    Ok(result)
}
