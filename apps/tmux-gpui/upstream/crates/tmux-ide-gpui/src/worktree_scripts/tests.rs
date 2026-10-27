#![allow(clippy::unwrap_used)]

// Not a glob: the parent's `gpui::*` would shadow the `#[test]` that
// `gpui::test` expands to.
use super::{
    Checkout, HerdrWindow, Launch, NavigationTarget, Page, ScriptKind, Step, Trust, config, launch,
    script_lines,
};
use crate::{sidebar::layout_tests::fixture_window, window::MockPeer};
use herdr_client::protocol::ClientMessage;
use herdr_client::protocol::ClientPaneInputEvent;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;

mod flow;
mod review;

/// A window connected to `peer`, projecting the peer's own snapshot so
/// requests carry the boot it accepts.
pub(crate) fn connect(
    view: &mut HerdrWindow,
    peer: &MockPeer,
    cx: &mut gpui::Context<HerdrWindow>,
) {
    peer.prepare(view, cx);
    let local = &mut view.endpoints[0];
    // Scripts are read from this machine's files, as a local daemon's are.
    local.connection.target =
        herdr_client::ConnectTarget::Socket("/unused-worktree-scripts.sock".into());
    // The endpoint and its mailbox agree it is connected, so no tick retries.
    local.live = view.live.clone();
    if let Ok(mut inbox) = local.connection.inbox.lock() {
        *inbox = view.live.clone();
        inbox.dirty = false;
    }
}

fn launch(view: &HerdrWindow, kind: ScriptKind, checkout: Option<&std::path::Path>) -> Launch {
    Launch {
        kind,
        endpoint: (view.selection_epoch, view.endpoints[0].generation),
        endpoint_id: crate::endpoint::LOCAL.into(),
        boot: "boot-v1".into(),
        workspace: "w1".into(),
        repo: "main".into(),
        repo_key: "repo/main".into(),
        checkout: checkout.map(|path| Checkout {
            path: path.to_str().unwrap().into(),
            root: Some("/repo".into()),
        }),
        force: false,
        requested: true,
    }
}

pub(crate) fn write_scripts(dir: &std::path::Path, text: &str) {
    std::fs::create_dir_all(dir.join(".herdr")).unwrap();
    std::fs::write(dir.join(config::PATH), text).unwrap();
}

fn step(view: &HerdrWindow) -> &'static str {
    match view.worktree_script.as_ref().map(|job| &job.step) {
        None => "none",
        Some(Step::Locating(_)) => "locating",
        Some(Step::Reading) => "reading",
        Some(Step::Asking { .. }) => "asking",
        Some(Step::Opening(_)) => "opening",
    }
}

/// `response` as the daemon's envelope for request `id`.
fn answer(id: &str, mut response: Value) -> Value {
    response["id"] = id.into();
    response
}

// Built outside the test bodies, whose macro expansion they would overflow.
fn listing(checkout: &str) -> Value {
    json!({"result":{"type":"worktree_list","worktrees":[
        {"path":"/repo","is_linked_worktree":false,"is_bare":false},
        {"path":checkout,"is_linked_worktree":true,"is_bare":false,"open_workspace_id":"w1"}
    ]}})
}

fn run_tab(checkout: &str) -> Value {
    json!({"workspace_id":"w1","cwd":checkout,"label":"run","focus":true,"env":{
        "HERDR_WORKTREE_SCRIPT":"make dev","HERDR_WORKTREE_PATH":checkout,"HERDR_ROOT_PATH":"/repo"}})
}

fn tab_created() -> Value {
    json!({"result":{"type":"tab_created","tab":{"tab_id":"w1:t9"},"root_pane":{"pane_id":"w1:p9"}}})
}
