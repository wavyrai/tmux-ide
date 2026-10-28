//! Pi usage. Not ported: it is never detected. Pi has no account, quota, or
//! balance to ask a service about. CodexBar instead scans the Pi and OMP
//! session transcripts under `~/.pi/agent/sessions` (and profile stores
//! chosen by `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
//! `OMP_PROFILE`) and prices each recorded assistant turn with the
//! models.dev catalog. That needs listing directories and reading private
//! transcripts in bulk, which the probe does not offer: `read` brings a whole
//! file back and is meant for files holding nothing private, and transcripts
//! can exceed its size limit. A local cost-history source would have to come
//! first.

use crate::{
    Result,
    usage::{
        model::Report,
        probe::Probe,
        service::{Meta, Service},
    },
};

pub(crate) struct Pi;

static META: Meta = Meta::new("pi", "Pi");

impl Service for Pi {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, _probe: &mut Probe) -> Option<Result<Report>> {
        None
    }
}
