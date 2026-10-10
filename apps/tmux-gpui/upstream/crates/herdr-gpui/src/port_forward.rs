//! Remote ports this window forwards to this machine, each through its own
//! `ssh -N -L` child (see [`herdr_client::PortForward`]), keyed by the saved
//! host's SSH target and the remote port. The UI thread only starts and stops
//! forwards and takes their reports on later ticks. Nothing reconnects: a
//! forward ends when the user stops it, its host leaves the window or is
//! disabled, the window closes, or the app quits, and stays ended until the
//! user starts it again. Ports are named by the caller, never discovered here.

use crate::{Error, Result};
use herdr_client::{ForwardEvent, PortForward};
use std::num::NonZeroU16;

/// Each forward is a process; a window never runs more than this many.
const LIMIT: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum State {
    /// SSH is connecting; the local port is not chosen or not listening yet.
    Starting,
    Listening {
        local_port: u16,
    },
    /// Why it ended, for display. The entry stays until dismissed or restarted.
    Ended(String),
}

pub(crate) struct Forward {
    target: String,
    remote_port: NonZeroU16,
    state: State,
    /// None once ended, and in tests that drive the state by hand.
    handle: Option<PortForward>,
}

impl Forward {
    pub fn remote_port(&self) -> NonZeroU16 {
        self.remote_port
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    /// The page to open for a listening forward. The address, not
    /// `localhost`: SSH listens on IPv4 loopback only, and a browser trying
    /// `::1` first would reach whatever else listens there.
    pub fn url(&self) -> Option<crate::browser::WebUrl> {
        let State::Listening { local_port } = self.state else {
            return None;
        };
        crate::browser::WebUrl::try_from(format!("http://127.0.0.1:{local_port}/").as_str()).ok()
    }

    /// Applies one worker report, returning what the user should be told.
    fn apply(&mut self, event: ForwardEvent) -> Notice {
        let remote_port = self.remote_port.get();
        match event {
            ForwardEvent::Listening { local_port } => {
                self.state = State::Listening { local_port };
                Notice::Listening {
                    remote_port,
                    local_port,
                }
            }
            ForwardEvent::Ended(error) => {
                self.handle = None;
                let reason = display(&error);
                self.state = State::Ended(reason.clone());
                Notice::Ended {
                    remote_port,
                    reason,
                }
            }
        }
    }
}

/// The display boundary: the message, then each cause.
fn display(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// A change the user did not just ask for, worth a flash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Notice {
    Listening { remote_port: u16, local_port: u16 },
    Ended { remote_port: u16, reason: String },
}

impl Notice {
    pub fn text(&self) -> String {
        match self {
            Self::Listening {
                remote_port,
                local_port,
            } => format!("Forwarding port {remote_port} to 127.0.0.1:{local_port}"),
            Self::Ended {
                remote_port,
                reason,
            } => format!("Port {remote_port} forward ended: {reason}"),
        }
    }
}

/// What the user typed as a remote port.
pub(crate) fn parse_port(text: &str) -> Result<NonZeroU16> {
    let text = text.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::ForwardPort);
    }
    text.parse().map_err(|_| Error::ForwardPort)
}

#[derive(Default)]
pub(crate) struct PortForwards {
    forwards: Vec<Forward>,
}

impl PortForwards {
    pub fn for_host<'a>(&'a self, target: &'a str) -> impl Iterator<Item = &'a Forward> + 'a {
        self.forwards
            .iter()
            .filter(move |forward| forward.target == target)
    }

    /// Starts forwarding `remote_port` on `target`. An ended forward of the
    /// same port is replaced; a running one is left alone.
    pub fn start(&mut self, target: &str, remote_port: NonZeroU16) -> Result<()> {
        self.insert(target, remote_port, || {
            PortForward::start(target, remote_port).map_err(Error::from)
        })
    }

    fn insert(
        &mut self,
        target: &str,
        remote_port: NonZeroU16,
        start: impl FnOnce() -> Result<PortForward>,
    ) -> Result<()> {
        let same =
            |forward: &Forward| forward.target == target && forward.remote_port == remote_port;
        if self
            .forwards
            .iter()
            .any(|forward| same(forward) && !matches!(forward.state, State::Ended(_)))
        {
            return Err(Error::ForwardDuplicate(remote_port.get()));
        }
        self.forwards.retain(|forward| !same(forward));
        if self.forwards.len() >= LIMIT {
            return Err(Error::ForwardLimit(LIMIT));
        }
        let handle = start()?;
        self.forwards.push(Forward {
            target: target.to_owned(),
            remote_port,
            state: State::Starting,
            handle: Some(handle),
        });
        Ok(())
    }

    /// Stops the forward, or dismisses an ended one. Dropping it kills SSH.
    pub fn stop(&mut self, target: &str, remote_port: NonZeroU16) -> bool {
        let before = self.forwards.len();
        self.forwards
            .retain(|forward| forward.target != target || forward.remote_port != remote_port);
        self.forwards.len() != before
    }

    /// Stops forwards of hosts `keep` rejects. Returns whether any stopped.
    pub fn retain_hosts(&mut self, keep: impl Fn(&str) -> bool) -> bool {
        let before = self.forwards.len();
        self.forwards.retain(|forward| keep(&forward.target));
        self.forwards.len() != before
    }

    /// Kills every child at once, without waiting for any.
    pub fn stop_all(&mut self) {
        self.forwards.clear();
    }

    /// A forward driven by hand, as its worker's reports would drive it.
    #[cfg(test)]
    pub fn fixture(&mut self, target: &str, remote_port: u16, state: State) {
        self.forwards.push(Forward {
            target: target.into(),
            remote_port: NonZeroU16::new(remote_port).unwrap_or(NonZeroU16::MIN),
            state,
            handle: None,
        });
    }

    /// Takes the workers' reports, oldest first.
    pub fn poll(&mut self) -> Vec<Notice> {
        let mut notices = Vec::new();
        for forward in &mut self.forwards {
            while let Some(event) = forward.handle.as_ref().and_then(PortForward::try_event) {
                notices.push(forward.apply(event));
            }
        }
        notices
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
