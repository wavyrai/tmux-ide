//! Connection-local authority policy. One native worker owns this state and wire order.
//! Returned commands reserve their correlation immediately. A failed transport enqueue
//! MUST retire this policy and connection; commands are never replayable on a replacement.
mod intent;
mod paste;
mod receive;
pub use intent::{
    Axis, Direction, Intent, IntentCompletion, IntentOutcome, Rename, WindowLink, WindowTarget,
    Zoom,
};
mod topology;
mod types;
use serde_json::json;
use std::collections::{BTreeMap, VecDeque};
pub use topology::{SplitBoundary, SplitLayout, SplitPane, SplitSuccessor, SplitTarget};
pub use types::*;
const SAFE: u64 = 9_007_199_254_740_991;
const TIMEOUT_MS: u64 = 2000;
const MAX_INPUTS: usize = 256;
#[derive(thiserror::Error)]
pub enum Error {
    #[error("native authority policy retired")]
    Retired,
    #[error("invalid native control identity or schema")]
    Invalid,
    #[error("native control authority unavailable")]
    Authority,
    #[error("native byte input capability unavailable")]
    Capability,
    #[error("native control operation already pending")]
    Busy,
    #[error("native control queue bound exceeded")]
    Full,
    #[error("native input lifetime changed")]
    Lifetime,
    #[error("native control sequence exhausted")]
    Sequence,
    #[error("native control acknowledgement timed out; result is uncertain")]
    Timeout,
    #[error("invalid native control JSON")]
    Json(#[from] serde_json::Error),
}
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Request,
    Release,
}
#[derive(Clone)]
struct PendingAuthority {
    authority: Authority,
    action: Action,
    deadline: u64,
}
struct PendingViewport {
    cols: u16,
    rows: u16,
    lease: Lease,
    deadline: u64,
}
pub struct Policy {
    generation: String,
    workspace: String,
    client: String,
    panes: Vec<String>,
    interactive: bool,
    ready: bool,
    input_bytes: bool,
    retired: bool,
    foreground: bool,
    snapshot: Option<Snapshot>,
    grants: BTreeMap<Authority, Lease>,
    lifetimes: BTreeMap<String, Lifetime>,
    sequences: BTreeMap<String, u32>,
    inputs: BTreeMap<(String, u32), u64>,
    authorities: BTreeMap<String, PendingAuthority>,
    retired_authorities: VecDeque<(String, PendingAuthority)>,
    viewports: BTreeMap<u32, PendingViewport>,
    viewport_sequence: u32,
    paste: Option<paste::Transaction>,
    intents: BTreeMap<String, intent::PendingIntent>,
    split_layout: Option<(String, SplitLayout)>,
    split_scope: Option<(String, WindowLink)>,
}
impl Policy {
    pub fn new(
        generation: String,
        workspace: String,
        client: String,
        panes: Vec<String>,
        interactive: bool,
    ) -> Result<Self> {
        if !uuid(&generation)
            || !identity(&workspace, 512)
            || !identity(&client, 4096)
            || panes.is_empty()
            || panes.len() > 24
            || panes.iter().any(|p| !pane(p))
            || panes
                .iter()
                .enumerate()
                .any(|(i, p)| panes[..i].contains(p))
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            generation,
            workspace,
            client,
            panes,
            interactive,
            ready: false,
            input_bytes: false,
            retired: false,
            foreground: false,
            snapshot: None,
            grants: BTreeMap::new(),
            lifetimes: BTreeMap::new(),
            sequences: BTreeMap::new(),
            inputs: BTreeMap::new(),
            authorities: BTreeMap::new(),
            retired_authorities: VecDeque::new(),
            viewports: BTreeMap::new(),
            viewport_sequence: 0,
            paste: None,
            intents: BTreeMap::new(),
            split_layout: None,
            split_scope: None,
        })
    }
    /// Call once for the exact redeemed socket; this policy cannot be reused on reconnect.
    pub fn ready(
        &mut self,
        connection_client_id: Option<&str>,
        input_lifetime: bool,
    ) -> Result<()> {
        self.ready_with_input_bytes(connection_client_id, input_lifetime, false)
    }
    /// `input_bytes` must come from the redeemed socket's ready frame, never the offer alone.
    pub fn ready_with_input_bytes(
        &mut self,
        connection_client_id: Option<&str>,
        input_lifetime: bool,
        input_bytes: bool,
    ) -> Result<()> {
        if self.retired {
            return Err(Error::Retired);
        }
        if self.ready
            || connection_client_id.is_some_and(|id| id != self.client)
            || (self.interactive && (connection_client_id.is_none() || !input_lifetime))
        {
            self.retire();
            return Err(Error::Invalid);
        }
        self.input_bytes = input_bytes;
        self.ready = true;
        Ok(())
    }
    fn check(&self) -> Result<()> {
        if self.retired {
            Err(Error::Retired)
        } else if !self.ready {
            Err(Error::Invalid)
        } else {
            Ok(())
        }
    }
    pub fn owns(&self, authority: Authority) -> bool {
        !self.retired && self.ready && self.foreground && self.grants.contains_key(&authority)
    }
    pub fn pending_inputs(&self) -> usize {
        self.inputs.len()
    }
    pub fn barrier_ready(&self) -> bool {
        self.inputs.is_empty() && self.paste.is_none()
    }
    pub fn snapshot(&self) -> Option<&Snapshot> {
        self.snapshot.as_ref()
    }
    pub fn workspace(&self) -> &str {
        &self.workspace
    }
    pub fn bind_lifetime(
        &mut self,
        pane_id: &str,
        lifetime: Option<Lifetime>,
    ) -> Result<Vec<InputCompletion>> {
        self.check()?;
        if !self.panes.iter().any(|p| p == pane_id) {
            return Err(Error::Invalid);
        }
        if lifetime
            .as_ref()
            .is_some_and(|l| l.generation != self.generation || !identity(&l.incarnation, 256))
        {
            return Err(Error::Lifetime);
        }
        if self.lifetimes.get(pane_id) == lifetime.as_ref() {
            return Ok(Vec::new());
        }
        self.cancel_paste_for(pane_id);
        self.lifetimes.remove(pane_id);
        if let Some(l) = lifetime {
            self.lifetimes.insert(pane_id.into(), l);
        }
        let keys: Vec<_> = self
            .inputs
            .keys()
            .filter(|(p, _)| p == pane_id)
            .cloned()
            .collect();
        Ok(self.finish_inputs(keys, InputResult::AuthorityLost))
    }
    fn authority(
        &mut self,
        authority: Authority,
        action: Action,
        id: &str,
        now: u64,
    ) -> Result<Command> {
        self.check()?;
        if !self.interactive
            || !uuid(id)
            || self.authorities.contains_key(id)
            || self
                .retired_authorities
                .iter()
                .any(|(retired, _)| retired == id)
        {
            return Err(Error::Invalid);
        }
        if action == Action::Request
            && (!self.foreground || self.authorities.values().any(|p| p.authority == authority))
        {
            return Err(Error::Busy);
        }
        if action == Action::Release
            && self
                .authorities
                .values()
                .any(|p| p.authority == authority && p.action == Action::Release)
        {
            return Err(Error::Busy);
        }
        if self.authorities.len() >= 6 {
            return Err(Error::Full);
        }
        let command = command(
            json!({"type":if action==Action::Request{"authority-request"}else{"authority-release"},"generation":self.generation,"requestId":id,"authority":authority}),
        )?;
        if action == Action::Release {
            if authority == Authority::Input {
                self.cancel_paste();
            }
            self.grants.remove(&authority);
        }
        self.authorities.insert(
            id.into(),
            PendingAuthority {
                authority,
                action,
                deadline: now.saturating_add(TIMEOUT_MS),
            },
        );
        Ok(command)
    }
    pub fn request_authority(
        &mut self,
        authority: Authority,
        id: &str,
        now: u64,
    ) -> Result<Command> {
        self.authority(authority, Action::Request, id, now)
    }
    pub fn release_authority(
        &mut self,
        authority: Authority,
        id: &str,
        now: u64,
    ) -> Result<Command> {
        self.authority(authority, Action::Release, id, now)
    }
    /// Presence is a command barrier at the caller. Foreground never requests geometry.
    /// Background returns both releases even if a snapshot already revoked local grants.
    pub fn presence(
        &mut self,
        active: bool,
        input_id: &str,
        geometry_id: &str,
        now: u64,
    ) -> Result<Vec<Command>> {
        self.check()?;
        // Focus loss revokes local use immediately, including while ACKs or earlier
        // authority requests are still settling. Retrying this barrier cannot restore it.
        if !active {
            self.paste = None;
            self.foreground = false;
            self.grants.clear();
        }
        if !self.barrier_ready() {
            return Err(Error::Busy);
        }
        if self.interactive
            && (!uuid(input_id) || (!active && (!uuid(geometry_id) || input_id == geometry_id)))
        {
            return Err(Error::Invalid);
        }
        if !self.authorities.is_empty() {
            return Err(Error::Busy);
        }
        let mut commands = vec![command(
            json!({"type":"presence","generation":self.generation,"state":if active{"foreground"}else{"background"}}),
        )?];
        self.foreground = active;
        if self.interactive {
            if active {
                commands.push(self.request_authority(Authority::Input, input_id, now)?);
            } else {
                self.grants.clear();
                commands.push(self.release_authority(Authority::Input, input_id, now)?);
                commands.push(self.release_authority(Authority::Geometry, geometry_id, now)?);
            }
        }
        Ok(commands)
    }
    pub fn input(
        &mut self,
        pane_id: &str,
        expected: &Lifetime,
        input: Input,
        now: u64,
    ) -> Result<Command> {
        if self.paste.is_some() || !self.intents.is_empty() {
            return Err(Error::Busy);
        }
        self.input_chunk(pane_id, expected, input, now)
    }
    pub fn input_submission(
        &mut self,
        pane_id: &str,
        expected: &Lifetime,
        input: Input,
        now: u64,
    ) -> Result<(u32, Command)> {
        let command = self.input(pane_id, expected, input, now)?;
        let sequence = self.sequences.get(pane_id).copied().ok_or(Error::Invalid)?;
        Ok((sequence, command))
    }
    fn input_chunk(
        &mut self,
        pane_id: &str,
        expected: &Lifetime,
        input: Input,
        now: u64,
    ) -> Result<Command> {
        self.check()?;
        if !self.owns(Authority::Input) {
            return Err(Error::Authority);
        }
        if self.lifetimes.get(pane_id) != Some(expected) {
            return Err(Error::Lifetime);
        }
        if self.inputs.len() >= MAX_INPUTS {
            return Err(Error::Full);
        }
        let (kind, data) = match input {
            Input::Text(s)
                if !s.is_empty() && s.encode_utf16().count() <= 1024 && !s.contains('\0') =>
            {
                ("text", s)
            }
            Input::Key(s) if key(&s) => ("key", s),
            Input::Bytes(_) if !self.input_bytes => return Err(Error::Capability),
            Input::Bytes(s) if valid_input_bytes(&s) => ("bytes", s),
            _ => return Err(Error::Invalid),
        };
        let seq = self
            .sequences
            .get(pane_id)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(Error::Sequence)?;
        let command = command(
            json!({"type":"input","pane":pane_id,"seq":seq,"kind":kind,"data":data,"expectedLifetime":expected}),
        )?;
        self.sequences.insert(pane_id.into(), seq);
        self.inputs
            .insert((pane_id.into(), seq), now.saturating_add(TIMEOUT_MS));
        Ok(command)
    }
    /// Each sent viewport retains its exact lease/geometry until its ACK. No supersession.
    pub fn viewport(
        &mut self,
        cols: u16,
        rows: u16,
        window: Option<&str>,
        now: u64,
    ) -> Result<Command> {
        self.check()?;
        if !self.barrier_ready() {
            return Err(Error::Busy);
        }
        if !self.owns(Authority::Geometry) {
            return Err(Error::Authority);
        }
        if !(2..=4096).contains(&cols)
            || !(2..=4096).contains(&rows)
            || window.is_some_and(|s| !pane(s))
        {
            return Err(Error::Invalid);
        }
        if self.viewports.len() >= 16 {
            return Err(Error::Full);
        }
        let lease = self
            .grants
            .get(&Authority::Geometry)
            .ok_or(Error::Authority)?
            .clone();
        let seq = self
            .viewport_sequence
            .checked_add(1)
            .ok_or(Error::Sequence)?;
        let mut value =
            json!({"type":"viewport","seq":seq,"cols":cols,"rows":rows,"authorityLease":lease});
        if let Some(window) = window {
            value["semanticWindowId"] = json!(window);
        }
        let command = command(value)?;
        self.viewport_sequence = seq;
        self.viewports.insert(
            seq,
            PendingViewport {
                cols,
                rows,
                lease,
                deadline: now.saturating_add(TIMEOUT_MS),
            },
        );
        Ok(command)
    }
    pub fn retire(&mut self) -> Vec<InputCompletion> {
        self.paste = None;
        self.retired = true;
        self.ready = false;
        self.grants.clear();
        self.lifetimes.clear();
        self.authorities.clear();
        self.retired_authorities.clear();
        self.viewports.clear();
        self.intents.clear();
        self.split_layout = None;
        self.split_scope = None;
        let keys = self.inputs.keys().cloned().collect();
        self.finish_inputs(keys, InputResult::Retired)
    }
    /// Report per-operation uncertainty without replaying it. Input transaction owners
    /// must interrupt the current gesture/paste on Timeout (the hosted pipeline closes).
    /// Geometry/authority callers can remain connected and explicitly request fresh work.
    pub fn expire(&mut self, now: u64) -> Result<Expiration> {
        self.check()?;
        let keys = self
            .inputs
            .iter()
            .filter(|(_, deadline)| **deadline <= now)
            .map(|(key, _)| key.clone())
            .collect();
        let inputs = self.finish_inputs(keys, InputResult::Timeout);
        let ids: Vec<_> = self
            .authorities
            .iter()
            .filter(|(_, p)| p.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        let mut authorities = Vec::new();
        for id in ids {
            if let Some(pending) = self.authorities.remove(&id) {
                authorities.push((id.clone(), pending.authority));
                self.retired_authorities.push_back((id, pending));
                while self.retired_authorities.len() > 16 {
                    self.retired_authorities.pop_front();
                }
            }
        }
        let viewports: Vec<_> = self
            .viewports
            .iter()
            .filter(|(_, p)| p.deadline <= now)
            .map(|(seq, _)| *seq)
            .collect();
        for seq in &viewports {
            self.viewports.remove(seq);
        }
        Ok(Expiration {
            inputs,
            authorities,
            viewports,
            intents: self.expire_intents(now),
        })
    }
    fn finish_inputs(
        &mut self,
        keys: Vec<(String, u32)>,
        result: InputResult,
    ) -> Vec<InputCompletion> {
        keys.into_iter()
            .map(|(pane, sequence)| {
                self.inputs.remove(&(pane.clone(), sequence));
                self.paste_completion(&pane, sequence, result);
                InputCompletion {
                    pane,
                    sequence,
                    result,
                }
            })
            .collect()
    }
}
fn command(v: serde_json::Value) -> Result<Command> {
    let text = serde_json::to_string(&v)?;
    if text.len() > 4096 {
        return Err(Error::Full);
    }
    Ok(Command(text))
}
fn identity(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.contains(['\0', '\r', '\n'])
}
fn uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok()
}
fn pane(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !s.starts_with("terminal.discovered.")
        && !matches!(s, "__proto__" | "prototype" | "constructor")
}
fn key(mut s: &str) -> bool {
    for _ in 0..3 {
        if s.starts_with("C-") || s.starts_with("M-") || s.starts_with("S-") {
            s = &s[2..];
        } else {
            break;
        }
    }
    (s.len() == 1 && s.as_bytes()[0].is_ascii_alphanumeric())
        || matches!(
            s,
            "F1" | "F2"
                | "F3"
                | "F4"
                | "F5"
                | "F6"
                | "F7"
                | "F8"
                | "F9"
                | "F10"
                | "F11"
                | "F12"
                | "Enter"
                | "Escape"
                | "Space"
                | "Tab"
                | "BTab"
                | "BSpace"
                | "Home"
                | "End"
                | "NPage"
                | "PPage"
                | "PgUp"
                | "PgDn"
                | "DC"
                | "IC"
                | "Up"
                | "Down"
                | "Left"
                | "Right"
        )
}
#[cfg(test)]
mod tests;

/// Wire bytes are hex, not UTF-8 text; preserve every byte including NUL.
pub fn valid_input_bytes(data: &str) -> bool {
    (2..=2048).contains(&data.len())
        && data.len().is_multiple_of(2)
        && data.bytes().all(|b| b.is_ascii_hexdigit())
}
