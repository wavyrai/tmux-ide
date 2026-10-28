//! Scoped native browser commands; no terminal input and no mutation retry.
use super::{EditorTarget, Error, ServerClient};
use serde::{Deserialize, Serialize};
const SAFE: u64 = 9_007_199_254_740_991;
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserState {
    pub version: u8,
    pub instance: String,
    pub pane: String,
    pub tab: u64,
    pub revision: u64,
    pub enabled: bool,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}
fn text(value: &str, max: usize) -> bool {
    value.len() <= max && !value.chars().any(char::is_control)
}
fn identity(version: u8, instance: &str, pane: &str, tab: u64, revision: u64) -> bool {
    version == 1
        && uuid::Uuid::parse_str(instance).is_ok()
        && pane.len() <= 32
        && pane
            .strip_prefix('%')
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && (1..=SAFE).contains(&tab)
        && (1..=SAFE).contains(&revision)
}
impl BrowserState {
    pub fn valid(&self) -> bool {
        identity(
            self.version,
            &self.instance,
            &self.pane,
            self.tab,
            self.revision,
        ) && text(&self.url, 65536)
            && text(&self.title, 2048)
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserAction {
    Back,
    Forward,
    Reload,
    Stop,
    Navigate,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserCommand {
    pub version: u8,
    pub instance: String,
    pub pane: String,
    pub tab: u64,
    pub revision: u64,
    pub action: BrowserAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}
impl BrowserCommand {
    pub fn new(state: &BrowserState, action: BrowserAction, text: Option<String>) -> Self {
        Self {
            version: 1,
            instance: state.instance.clone(),
            pane: state.pane.clone(),
            tab: state.tab,
            revision: state.revision,
            action,
            text,
        }
    }
    pub fn valid(&self) -> bool {
        identity(
            self.version,
            &self.instance,
            &self.pane,
            self.tab,
            self.revision,
        ) && match (self.action, self.text.as_deref()) {
            (BrowserAction::Navigate, Some(value)) => {
                text(value, 16384) && !value.trim().is_empty()
            }
            (BrowserAction::Navigate, None) | (_, Some(_)) => false,
            (_, None) => true,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    version: u8,
    state: Option<BrowserState>,
}
impl ServerClient {
    pub fn native_browser(
        &self,
        target: &EditorTarget,
        command: Option<&BrowserCommand>,
    ) -> Result<Option<BrowserState>, Error> {
        self.assert_current()?;
        if !target.valid() || command.is_some_and(|c| !c.valid()) {
            return Err(Error::ActionInput);
        }
        if target.generation != self.scope().generation {
            return Err(Error::ServerChanged);
        }
        self.daemon.verify_current()?;
        self.assert_current()?;
        let scope = self.scope();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/native-browser",
            scope.server_id, scope.generation
        );
        let body = serde_json::to_vec(&serde_json::json!({"target":target,"command":command}))
            .map_err(|_| Error::ActionInput)?;
        let bytes = self.daemon.post_resource(&path, &body)?;
        self.assert_current()?;
        parse_response(&bytes, command)
    }
}
fn parse_response(
    bytes: &[u8],
    command: Option<&BrowserCommand>,
) -> Result<Option<BrowserState>, Error> {
    if bytes.len() > 128 * 1024 {
        return Err(Error::ResourceFormat);
    }
    let response: Response = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if response.version != 1
        || response.state.as_ref().is_some_and(|s| {
            !s.valid() || command.is_some_and(|c| c.instance != s.instance || c.pane != s.pane)
        })
    {
        return Err(Error::ResourceFormat);
    }
    Ok(response.state)
}
#[cfg(test)]
#[path = "browser_controls_tests.rs"]
mod tests;
