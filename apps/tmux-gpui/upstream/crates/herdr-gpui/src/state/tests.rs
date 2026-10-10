use super::*;
use herdr_client::protocol::FrameData;

mod agent_recency;
mod agent_status;
mod announcements;
mod connection_status;
mod daemon_messages;
mod focus_acks;
mod requests;
mod surfaces;
mod version_mismatch;

fn snapshot() -> Arc<ClientShellSnapshot> {
    Arc::new(
        serde_json::from_str(include_str!(
            "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
        ))
        .unwrap(),
    )
}

fn surface(snapshot: &ClientShellSnapshot) -> Arc<PaneSurfaceFrame> {
    Arc::new(PaneSurfaceFrame {
        boot_id: snapshot.boot_id.clone(),
        projection_revision: snapshot.revision,
        surface_revision: 1,
        frame: FrameData {
            cells: vec![],
            width: 0,
            height: 0,
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        panes: vec![],
        splits: vec![],
        popup: None,
        graphics: Default::default(),
    })
}
