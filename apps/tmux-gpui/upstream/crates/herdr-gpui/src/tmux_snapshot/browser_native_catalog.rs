//! Suppress epoch-only topology notices on the metadata pipe.
use herdr_client::tmux_topology::Layout;
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct CatalogNotice {
    last: Option<Sent>,
}
struct Sent {
    request: u64,
    presence: u64,
    pane: String,
    epoch: u64,
    layouts: BTreeMap<String, Layout>,
}
impl CatalogNotice {
    pub(super) fn changed(
        &mut self,
        request: u64,
        presence: u64,
        pane: &str,
        epoch: u64,
        layouts: &BTreeMap<String, Layout>,
    ) -> bool {
        if let Some(last) = &mut self.last
            && last.request == request
            && last.presence == presence
            && last.pane == pane
        {
            if last.epoch == epoch {
                return false;
            }
            // Daemon authority/link updates can advance the epoch without changing
            // the layouts exported to the broker. Keep the epoch fast path current.
            last.epoch = epoch;
            if &last.layouts == layouts {
                return false;
            }
        }
        self.last = Some(Sent {
            request,
            presence,
            pane: pane.to_owned(),
            epoch,
            layouts: layouts.clone(),
        });
        true
    }
}
#[cfg(test)]
#[path = "browser_native_catalog_tests.rs"]
mod tests;
