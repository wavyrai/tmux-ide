//! How a trusted script reaches a visible pane.
//!
//! The endpoint API has no method that starts a command in a pane, so the
//! script runs in a new tab's shell: `tab.create` gives that shell the script
//! and its paths as environment variables, and one fixed line is typed to run
//! it. The typed line holds no repository content, so nothing from the file
//! is ever parsed by the user's interactive shell, whatever shell that is.

use super::ScriptKind;
use serde_json::{Value, json};

/// The variable the typed line runs. Internal plumbing, not a stable API.
pub(crate) const SCRIPT_ENV: &str = "HERDR_WORKTREE_SCRIPT";
/// The repository's main checkout, as Conductor's `CONDUCTOR_ROOT_PATH`.
pub(crate) const ROOT_ENV: &str = "HERDR_ROOT_PATH";
/// The checkout the script runs in, also its working directory.
pub(crate) const WORKTREE_ENV: &str = "HERDR_WORKTREE_PATH";

/// The line typed into the new tab's shell.
///
/// Single-quoted with no quote or backslash inside, so POSIX shells, fish,
/// and nushell all pass it to `sh` unchanged. `-e` stops at the first failing
/// command. An archive removes its checkout through the pane's own `herdr`
/// (Herdr sets `HERDR_BIN_PATH` and `HERDR_WORKSPACE_ID` in every pane) only
/// after the script succeeds; a failure leaves the tab open on its output and
/// the checkout in place.
pub(crate) fn command_line(kind: ScriptKind, force: bool) -> &'static str {
    match (kind, force) {
        (ScriptKind::Setup | ScriptKind::Run, _) => r#"sh -ec 'eval "$HERDR_WORKTREE_SCRIPT"'"#,
        (ScriptKind::Archive, false) => {
            r#"sh -ec 'eval "$HERDR_WORKTREE_SCRIPT"; exec "${HERDR_BIN_PATH:-herdr}" worktree remove --workspace "$HERDR_WORKSPACE_ID"'"#
        }
        (ScriptKind::Archive, true) => {
            r#"sh -ec 'eval "$HERDR_WORKTREE_SCRIPT"; exec "${HERDR_BIN_PATH:-herdr}" worktree remove --workspace "$HERDR_WORKSPACE_ID" --force'"#
        }
    }
}

/// Where a script runs: the checkout, and the repository's main checkout
/// when the daemon named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Checkout {
    pub(crate) path: String,
    pub(crate) root: Option<String>,
}

/// The `tab.create` a script runs in, labelled after its kind.
pub(crate) fn tab_params(
    workspace: &str,
    checkout: &Checkout,
    kind: ScriptKind,
    script: &str,
) -> Value {
    let mut env = serde_json::Map::new();
    env.insert(SCRIPT_ENV.into(), script.into());
    env.insert(WORKTREE_ENV.into(), checkout.path.as_str().into());
    if let Some(root) = &checkout.root {
        env.insert(ROOT_ENV.into(), root.as_str().into());
    }
    json!({
        "workspace_id": workspace,
        "cwd": checkout.path,
        "label": kind.name(),
        "focus": true,
        "env": env,
    })
}

/// The checkout of `workspace`, and its repository's main checkout, from a
/// `worktree.list` response.
pub(crate) fn locate(response: &Value, workspace: &str) -> crate::Result<Checkout> {
    let result = response_result(response)?;
    let entries = (result["type"] == "worktree_list")
        .then(|| result["worktrees"].as_array())
        .flatten()
        .ok_or(crate::Error::WorktreeScriptsCheckout)?;
    let mut own = entries
        .iter()
        .filter(|entry| entry["open_workspace_id"] == workspace);
    let path = match (own.next(), own.next()) {
        (Some(entry), None) => entry["path"].as_str().filter(|path| !path.is_empty()),
        _ => None,
    }
    .ok_or(crate::Error::WorktreeScriptsCheckout)?;
    Ok(Checkout {
        path: path.to_owned(),
        root: main_checkout(result),
    })
}

/// The repository's main checkout in a `worktree.list` result: its one
/// entry that is neither linked nor bare.
pub(crate) fn main_checkout(result: &Value) -> Option<String> {
    let mut main = result["worktrees"]
        .as_array()?
        .iter()
        .filter(|entry| entry["is_linked_worktree"] == false && entry["is_bare"] == false);
    match (main.next(), main.next()) {
        (Some(entry), None) => entry["path"]
            .as_str()
            .filter(|path| !path.is_empty())
            .map(str::to_owned),
        _ => None,
    }
}

/// The tab and pane a `tab.create` response made.
pub(crate) fn created_tab(response: &Value) -> crate::Result<(String, String)> {
    let result = response_result(response)?;
    let id = |value: &Value| {
        value
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
    };
    (result["type"] == "tab_created")
        .then(|| {
            Some((
                id(&result["tab"]["tab_id"])?,
                id(&result["root_pane"]["pane_id"])?,
            ))
        })
        .flatten()
        .ok_or(crate::Error::WorktreeScriptsResponse)
}

fn response_result(response: &Value) -> crate::Result<&Value> {
    match response.get("error").filter(|error| !error.is_null()) {
        Some(error) => Err(crate::Error::DaemonResponse(error.clone())),
        None => Ok(&response["result"]),
    }
}

#[cfg(test)]
mod tests;
