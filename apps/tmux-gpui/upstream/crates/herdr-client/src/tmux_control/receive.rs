use super::*;
impl Policy {
    /// Unknown controls remain the caller's responsibility; pass only authority, input ACK, viewport ACK, and input-rejection frames.
    /// Any invalid control retires the entire connection-local policy before returning.
    pub fn accept_json(&mut self, bytes: &[u8]) -> Result<Outcome> {
        let result = (|| {
            self.check()?;
            if bytes.len() > 1024 * 1024 {
                return Err(Error::Full);
            }
            let event: Event = serde_json::from_slice(bytes)?;
            self.accept(event)
        })();
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn apply_snapshot(&mut self, next: Snapshot) -> Result<Vec<InputCompletion>> {
        validate_snapshot(&next)?;
        if next.generation != self.generation
            || self.snapshot.as_ref().is_some_and(|old| {
                old.session != next.session
                    || old.revision > next.revision
                    || (old.revision == next.revision && old != &next)
            })
        {
            return Err(Error::Invalid);
        }
        let lost = self
            .snapshot
            .as_ref()
            .is_some_and(|old| old.owners.input.as_deref() == Some(self.client.as_str()))
            && next.owners.input.as_deref() != Some(self.client.as_str());
        self.grants
            .retain(|authority, _| next.owners.get(*authority) == Some(self.client.as_str()));
        self.snapshot = Some(next);
        Ok(if lost {
            self.cancel_paste();
            let keys = self.inputs.keys().cloned().collect();
            self.finish_inputs(keys, InputResult::AuthorityLost)
        } else {
            Vec::new()
        })
    }
    fn accept(&mut self, event: Event) -> Result<Outcome> {
        match event {
            Event::SemanticIntentAck {
                operation_id,
                outcome,
            } => self.accept_intent(operation_id, outcome),
            Event::AuthoritySnapshot { snapshot } => Ok(Outcome {
                inputs: self.apply_snapshot(snapshot)?,
                authority_changed: true,
                ..Outcome::default()
            }),
            Event::AuthorityReceipt {
                request_id,
                authority,
                status,
                lease,
                snapshot,
            } => {
                if !uuid(&request_id) {
                    return Err(Error::Invalid);
                }
                let retired_index = self
                    .retired_authorities
                    .iter()
                    .position(|(id, _)| id == &request_id);
                let pending = self
                    .authorities
                    .get(&request_id)
                    .or_else(|| {
                        retired_index.and_then(|i| self.retired_authorities.get(i).map(|(_, p)| p))
                    })
                    .ok_or(Error::Invalid)?;
                if pending.authority != authority {
                    return Err(Error::Invalid);
                }
                validate_snapshot(&snapshot)?;
                if snapshot.generation != self.generation
                    || self
                        .snapshot
                        .as_ref()
                        .is_some_and(|old| old.session != snapshot.session)
                {
                    return Err(Error::Invalid);
                }
                let action = pending.action;
                let matched = match (action, status, &lease) {
                    (Action::Release, ReceiptStatus::Released, None)
                    | (Action::Request, ReceiptStatus::Rejected, None) => true,
                    (Action::Request, ReceiptStatus::Granted, Some(l)) => {
                        validate_lease(l)?;
                        l.generation == self.generation
                            && l.session == snapshot.session
                            && l.client_id == self.client
                            && l.authority == authority
                            && l.revision <= snapshot.revision
                            && snapshot.owners.get(authority) == Some(self.client.as_str())
                    }
                    _ => false,
                };
                if !matched {
                    return Err(Error::Invalid);
                }
                if let Some(index) = retired_index {
                    // Consume one exact late receipt without applying its old snapshot
                    // or resurrecting a grant superseded by an explicit later operation.
                    self.retired_authorities.remove(index);
                    return Ok(Outcome::default());
                }
                let inputs = self.apply_snapshot(snapshot)?;
                self.authorities.remove(&request_id);
                let releasing = self
                    .authorities
                    .values()
                    .any(|p| p.authority == authority && p.action == Action::Release);
                if action == Action::Request
                    && status == ReceiptStatus::Granted
                    && self.foreground
                    && !releasing
                {
                    if let Some(lease) = lease {
                        self.grants.insert(authority, lease);
                    }
                } else {
                    self.grants.remove(&authority);
                }
                Ok(Outcome {
                    inputs,
                    authority_changed: true,
                    ..Outcome::default()
                })
            }
            Event::InputAck { pane: target, seq } => {
                if seq == 0 || !self.panes.contains(&target) {
                    return Err(Error::Invalid);
                }
                let key = (target, seq);
                let inputs = if self.inputs.contains_key(&key) {
                    self.finish_inputs(vec![key], InputResult::Ok)
                } else {
                    Vec::new()
                };
                Ok(Outcome {
                    inputs,
                    ..Outcome::default()
                })
            }
            Event::ViewportAck {
                seq,
                cols,
                rows,
                outcome,
                authority_lease,
            } => {
                validate_lease(&authority_lease)?;
                let pending = self.viewports.get(&seq).ok_or(Error::Invalid)?;
                let current = self.grants.get(&Authority::Geometry);
                if seq == 0
                    || cols != pending.cols
                    || rows != pending.rows
                    || authority_lease != pending.lease
                    || current.is_some_and(|l| l != &pending.lease)
                    || (outcome == ViewportOutcome::Ok && current.is_none())
                {
                    return Err(Error::Invalid);
                }
                self.viewports.remove(&seq);
                if outcome == ViewportOutcome::GeometryAuthorityConflict {
                    self.grants.remove(&Authority::Geometry);
                }
                Ok(Outcome {
                    viewport: Some((seq, outcome)),
                    ..Outcome::default()
                })
            }
            Event::Error {
                protocol_version,
                code,
                retryable,
            } => {
                let _ = retryable;
                if protocol_version != 2 || code != "input-rejected" {
                    return Err(Error::Invalid);
                }
                self.cancel_paste();
                let keys = self.inputs.keys().cloned().collect();
                Ok(Outcome {
                    inputs: self.finish_inputs(keys, InputResult::AuthorityLost),
                    ..Outcome::default()
                })
            }
        }
    }
}
fn validate_lease(l: &Lease) -> Result<()> {
    if !uuid(&l.generation)
        || !uuid(&l.token)
        || !identity(&l.session, 256)
        || !identity(&l.client_id, 4096)
        || l.revision == 0
        || l.revision > SAFE
    {
        return Err(Error::Invalid);
    }
    Ok(())
}
fn validate_snapshot(s: &Snapshot) -> Result<()> {
    if !uuid(&s.generation)
        || !identity(&s.session, 256)
        || s.revision > SAFE
        || !s.native_geometry_yield_until_ms.is_finite()
        || s.native_geometry_yield_until_ms < 0.0
        || s.clients.len() > 1024
    {
        return Err(Error::Invalid);
    }
    if [&s.owners.input, &s.owners.focus, &s.owners.geometry]
        .into_iter()
        .flatten()
        .any(|id| !identity(id, 4096))
    {
        return Err(Error::Invalid);
    }
    if s.clients.iter().any(|c| {
        !identity(&c.client_id, 4096)
            || c.connected_revision == 0
            || c.connected_revision > SAFE
            || c.activity_revision > SAFE
    }) {
        return Err(Error::Invalid);
    }
    Ok(())
}
