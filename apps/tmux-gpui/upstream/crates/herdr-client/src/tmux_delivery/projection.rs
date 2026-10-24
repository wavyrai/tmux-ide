//! Partial alternate-screen state. Its receipt never acknowledges materialized history.
use super::{Error, Result, hash_snapshot, hash_tombstone, types::*};
use std::sync::Arc;
#[derive(Debug, Clone)]
pub enum ProjectionUpdate {
    Seed {
        revision: u64,
        snapshot: Snapshot,
    },
    Patch {
        revision: u64,
        base_revision: u64,
        patch: Patch,
        history: DeferredHistory,
    },
    Tombstone {
        revision: u64,
        base_revision: u64,
        reason: String,
    },
}
impl ProjectionUpdate {
    pub fn revision(&self) -> u64 {
        match self {
            Self::Seed { revision, .. }
            | Self::Patch { revision, .. }
            | Self::Tombstone { revision, .. } => *revision,
        }
    }
    pub fn base_revision(&self) -> Option<u64> {
        match self {
            Self::Seed { .. } => None,
            Self::Patch { base_revision, .. } | Self::Tombstone { base_revision, .. } => {
                Some(*base_revision)
            }
        }
    }
    pub fn frame(&self) -> &'static str {
        match self {
            Self::Seed { .. } => "seed",
            Self::Patch { .. } => "patch",
            Self::Tombstone { .. } => "tombstone",
        }
    }
}
#[derive(Default)]
pub struct ProjectionStore {
    snapshot: Option<Arc<Snapshot>>,
    revision: Option<u64>,
}
impl ProjectionStore {
    pub fn snapshot(&self) -> Option<&Arc<Snapshot>> {
        self.snapshot.as_ref()
    }
    pub fn apply(
        &mut self,
        update: ProjectionUpdate,
        source_hash: &str,
        projection_hash: &str,
    ) -> Result<Vec<usize>> {
        let revision = update.revision();
        let same_seed =
            matches!(update, ProjectionUpdate::Seed { .. }) && self.revision == Some(revision);
        if same_seed
            && self.snapshot.as_ref().is_none_or(|snapshot| {
                hash_snapshot(snapshot) != source_hash
                    || !super::hash::hash_projection(snapshot)
                        .is_ok_and(|hash| hash == projection_hash)
            })
        {
            return Err(Error::Hash);
        }
        if self
            .revision
            .is_some_and(|r| revision < r || (revision == r && !same_seed))
            || update
                .base_revision()
                .is_some_and(|r| self.revision != Some(r))
        {
            return Err(Error::Revision);
        }
        let snapshot = match update {
            ProjectionUpdate::Seed { snapshot, .. } => snapshot,
            ProjectionUpdate::Patch { patch, history, .. } => super::store::apply_projection_patch(
                self.snapshot.as_ref().ok_or(Error::Revision)?,
                patch,
                history,
            )?,
            ProjectionUpdate::Tombstone { reason, .. } => {
                if self.snapshot.is_none()
                    || hash_tombstone(&reason) != source_hash
                    || super::hash::hash_projection_tombstone(&reason) != projection_hash
                {
                    return Err(Error::Hash);
                }
                self.snapshot = None;
                self.revision = Some(revision);
                return Ok(Vec::new());
            }
        };
        if !matches!(snapshot.history, History::Deferred(_)) {
            return Err(Error::Invalid("projection materialized history"));
        }
        super::store::validate(&snapshot)?;
        if hash_snapshot(&snapshot) != source_hash
            || super::hash::hash_projection(&snapshot)? != projection_hash
        {
            return Err(Error::Hash);
        }
        let changed = snapshot
            .grid
            .iter()
            .enumerate()
            .filter_map(|(i, row)| {
                (!self
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.grid.get(i))
                    .is_some_and(|old| Arc::ptr_eq(old, row)))
                .then_some(i)
            })
            .collect();
        self.snapshot = Some(Arc::new(snapshot));
        self.revision = Some(revision);
        Ok(changed)
    }
}
