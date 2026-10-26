use super::{Error, ServerClient};
use crate::{
    tmux_control::{SplitLayout, WindowLink},
    tmux_handoff::ServerScope,
};
use serde::Deserialize;
use std::time::Duration;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    version: u8,
    server: ServerScope,
    resource: SplitLayout,
}
impl ServerClient {
    /// Observe exact canonical ancestry. This read neither acquires geometry
    /// authority nor sends a resize. Lazy owner readiness may take up to 45s.
    pub fn split_layout(&self, workspace: &str, window: &WindowLink) -> Result<SplitLayout, Error> {
        self.assert_current()?;
        if !crate::tmux_stream::valid_identity(workspace) {
            return Err(Error::ActionInput);
        }
        window.validate().map_err(Error::Control)?;
        let scope = self.scope();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/split-layout/{workspace}",
            scope.server_id, scope.generation
        );
        let body = serde_json::to_vec(window).map_err(|_| Error::ActionInput)?;
        let result =
            self.daemon
                .post_resource_with_options(&path, &body, &[], Duration::from_secs(45));
        self.assert_current()?;
        let resource = parse(&result?, scope, window)?;
        self.assert_current()?;
        Ok(resource)
    }
}
fn parse(bytes: &[u8], scope: &ServerScope, window: &WindowLink) -> Result<SplitLayout, Error> {
    let response: Response = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if response.version != 1 {
        return Err(Error::ResourceFormat);
    }
    if &response.server != scope || &response.resource.window != window {
        return Err(Error::ServerChanged);
    }
    response.resource.validate().map_err(Error::Control)?;
    Ok(response.resource)
}
#[cfg(test)]
#[path = "split_layout_tests.rs"]
mod tests;
