use super::{Error, ServerClient};
use crate::tmux_history::{AnchorRequest, AnchorResult, decode_result};
impl ServerClient {
    pub fn history_anchor(&self, request: &AnchorRequest) -> Result<Option<AnchorResult>, Error> {
        self.assert_current()?;
        let scope = self.scope();
        if request.identity().2 != scope.generation {
            return Err(Error::ServerChanged);
        }
        let path = format!(
            "api/v1/tmux-servers/{}/{}/history-anchor",
            scope.server_id, scope.generation
        );
        let body = request.body().map_err(Error::History)?;
        let response = self.daemon.post_resource(&path, &body);
        self.assert_current()?;
        let bytes = match response {
            Err(Error::RequestStatus(404)) => return Ok(None),
            other => other?,
        };
        let result =
            decode_result(&bytes, &scope.server_id, &scope.generation).map_err(Error::History)?;
        request.check_result(&result).map_err(Error::History)?;
        self.assert_current()?;
        Ok(Some(result))
    }
}
