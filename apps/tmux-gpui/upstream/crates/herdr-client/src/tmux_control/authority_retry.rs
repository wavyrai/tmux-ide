//! Asking for input again when the daemon did not answer.
//!
//! Input authority is asked for once, with the presence command. The daemon
//! elects the requester when it handles the request and never offers input
//! later by itself. A request that got no receipt within its deadline (seen in
//! the soak for about 20 s after the daemon closed a stream with 1011
//! "stream-unavailable") therefore left the stream showing frames and taking
//! no keys until it was replaced. The request is now sent again when it
//! lapses, at most [`RETRIES`] times per presence change: with the 2 s
//! deadline that covers 12 s, after which the app replaces the stream.
use super::*;

pub(super) const RETRIES: u8 = 5;

impl Policy {
    /// After [`Policy::expire`]: one more input request under the new `id`
    /// if `lapsed` holds an input request, the window is still in the
    /// foreground, input is not held and none is being asked for. `None`
    /// when there is nothing to ask again, or the retries are used up.
    pub fn retry_input(
        &mut self,
        lapsed: &[(String, Authority)],
        id: &str,
        now: u64,
    ) -> Result<Option<Command>> {
        let pending =
            |policy: &Self| (policy.authorities.values()).any(|p| p.authority == Authority::Input);
        if !lapsed.iter().any(|(_, a)| *a == Authority::Input)
            || !self.interactive
            || !self.foreground
            || self.grants.contains_key(&Authority::Input)
            || pending(self)
            || self.input_retries >= RETRIES
        {
            return Ok(None);
        }
        let command = self.request_authority(Authority::Input, id, now)?;
        self.input_retries += 1;
        Ok(Some(command))
    }
}

#[cfg(test)]
#[path = "authority_retry_tests.rs"]
mod tests;
