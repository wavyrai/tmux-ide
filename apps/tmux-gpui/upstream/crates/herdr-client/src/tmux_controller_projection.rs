//! Materialization is a scoped read request, never an input or canonical ACK.
use super::*;
impl Controller {
    pub fn materialize_history(&mut self, pane: &str) -> Result<bool, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        let proof = self.current.get(pane).ok_or(Error::Invalid)?;
        let snapshot = proof.snapshot.as_ref().ok_or(Error::Invalid)?;
        if snapshot.history.is_complete() {
            return Ok(false);
        }
        let identity = &proof.identity;
        let scope = (
            identity.incarnation.clone(),
            identity.delivery_nonce.clone(),
        );
        if self.materializing.get(pane) == Some(&scope) {
            return Ok(true);
        }
        let projection_hash =
            crate::tmux_delivery::hash_projection(snapshot).map_err(|_| Error::Invalid)?;
        let command = tmux_stream::Command::from_json(serde_json::to_string(
            &json!({"type":"terminal-projection-materialize","request":{
                "type":"terminal.projection.materialize","workspaceName":self.policy.workspace(),"semanticPaneId":pane,
                "generation":identity.generation,"incarnation":identity.incarnation,"deliveryNonce":identity.delivery_nonce,
                "requestId":uuid::Uuid::new_v4().to_string(),"canonicalRevision":identity.canonical_revision,"projectionStateHash":projection_hash
            }}),
        )?)?;
        if let Err(error) = self.session.try_send(command) {
            self.retire();
            return Err(Error::Session(error));
        }
        self.materializing.insert(pane.into(), scope);
        Ok(true)
    }
}
