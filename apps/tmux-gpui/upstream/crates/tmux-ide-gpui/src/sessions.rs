//! The sessions this window can attach to: the named local sessions and, since
//! a saved device's own sessions need a round trip to its host to list, the devices
//! themselves. Only the sessions popup asks for either: probing is I/O, so it
//! runs on a worker thread and an idle window never touches the disk or a host.
use crate::Error;
use herdr_client::{ConnectTarget, LocalSession, RemoteHost, RemoteSession, list_local_sessions};
use std::{
    collections::HashMap,
    sync::mpsc,
    time::{Duration, Instant},
};

/// How long an open popup shows probe results before refreshing them. Session
/// sockets outlive their daemon, so the state is a probe, not a fact.
const REFRESH: Duration = Duration::from_secs(5);

/// How long one saved device's answer stands before its host is asked again. A
/// device's list only changes when a session starts or stops there, and each
/// answer costs an SSH connection, so the popup does not redial at the local
/// probe's rate.
const DEVICE_REFRESH: Duration = Duration::from_secs(30);

pub(super) const DELETION_ANIMATION: Duration = Duration::from_millis(260);

pub(super) struct Departure {
    pub(super) target: ConnectTarget,
    started: Instant,
}

impl Departure {
    pub(super) fn new(target: ConnectTarget, now: Instant) -> Self {
        Self {
            target,
            started: now,
        }
    }

    /// Fade without changing layout, driven by the window's existing frame poll.
    pub(super) fn remaining(&self, now: Instant) -> f32 {
        let progress = (now.saturating_duration_since(self.started).as_secs_f32()
            / DELETION_ANIMATION.as_secs_f32())
        .clamp(0., 1.);
        1. - progress
    }
}

/// What the last probe of one saved device found.
pub(super) enum DeviceScan {
    /// The sessions that host reported.
    Sessions(Vec<RemoteSession>),
    /// Why they could not be listed, in the popup's own words.
    Failed(String),
}

/// Named sessions on this machine, the saved devices' own sessions, and the
/// scans that keep both current.
#[derive(Default)]
pub(super) struct Sessions {
    /// Last successfully scanned sessions, kept across popup opens.
    pub(super) entries: Vec<LocalSession>,
    /// The saved devices' sessions, which need a probe each.
    pub(super) devices: Devices,
    /// Set while a scan is outstanding, so the popup can say the list may be
    /// about to change.
    pub(super) scanning: bool,
    pub(super) error: Option<String>,
    pub(super) mutation: Option<gpui::Task<()>>,
    pub(super) mutation_error: Option<String>,
    pub(super) mutation_target: Option<ConnectTarget>,
    pub(super) departure: Option<Departure>,
    refresh_after_scan: bool,
    pending: Option<mpsc::Receiver<Result<Vec<LocalSession>, Error>>>,
    /// `None` means the next open scans immediately.
    next_scan: Option<Instant>,
}

/// Every saved device's sessions, and the probes that keep them current. Each
/// device ages out on its own, so one host answering slowly never holds up
/// another host's list.
#[derive(Default)]
pub(super) struct Devices {
    /// Last answer per endpoint id, kept across popup opens. Keyed by id rather
    /// than index, so a catalog reorder cannot move an answer to another host.
    pub(super) answers: HashMap<String, DeviceScan>,
    /// Answers on their way back, each naming the host it is about.
    pending: Option<mpsc::Receiver<Vec<(String, RemoteHost, DeviceScan)>>>,
    /// What the outstanding pass is asking, host included, so a worker that dies
    /// fails only the devices whose answers are actually unknown.
    asking: Vec<(String, RemoteHost)>,
    /// When each device was last asked and of which host, successful or not: a
    /// host that cannot answer is not redialled on every refresh, and a device
    /// whose host changed is asked again rather than answered for the old one.
    asked: HashMap<String, (RemoteHost, Instant)>,
    discard_pending: bool,
}

impl Sessions {
    pub(super) fn finish_departure(&mut self) {
        let Some(departure) = self.departure.take() else {
            return;
        };
        match departure.target {
            ConnectTarget::Session { name, .. } => {
                self.entries.retain(|session| session.name != name)
            }
            target => {
                let (Some(host), Some(session)) = (target.remote_host(), target.remote_session())
                else {
                    return;
                };
                for (id, answer) in &mut self.devices.answers {
                    if self
                        .devices
                        .asked
                        .get(id)
                        .is_some_and(|(asked, _)| *asked == host)
                        && let DeviceScan::Sessions(sessions) = answer
                    {
                        sessions.retain(|entry| entry.name != session);
                    }
                }
            }
        }
    }
    /// Probe again as soon as the popup is on screen, including when a scan is
    /// still running: the newest answer is the one worth showing.
    pub(super) fn refresh(&mut self) {
        self.next_scan = None;
        self.refresh_after_scan = self.pending.is_some();
    }
}

impl Devices {
    pub(super) fn refresh(&mut self) {
        // Keep the visible catalog while refreshing, but never accept an answer
        // started before the mutation. Track old workers until they finish.
        self.discard_pending = self.pending.is_some();
        let stale_at = Instant::now() - DEVICE_REFRESH;
        for (_, asked_at) in self.asked.values_mut() {
            *asked_at = stale_at;
        }
    }
    /// Apply a finished pass, and start one for every device whose answer has
    /// aged out. `targets` is the endpoint id and host of each device this
    /// window may ask. Reports whether the popup should repaint. Opening the
    /// popup does not reset these ages: a host asked a moment ago is still
    /// inside its own interval.
    pub(super) fn poll(
        &mut self,
        targets: &[(String, RemoteHost)],
        open: bool,
        now: Instant,
    ) -> bool {
        self.poll_with(targets, open, now, RemoteHost::list_sessions)
    }

    fn poll_with(
        &mut self,
        targets: &[(String, RemoteHost)],
        open: bool,
        now: Instant,
        probe: impl Fn(&RemoteHost) -> Result<Vec<RemoteSession>, herdr_client::Error>
        + Send
        + Sync
        + 'static,
    ) -> bool {
        let mut changed = false;
        // A device that is gone, or whose host changed under the same id, must not
        // keep painting what the previous host said.
        self.forget_replaced(targets);
        match self.pending.as_ref().map(|rx| rx.try_recv()) {
            Some(Ok(answers)) => {
                self.pending = None;
                self.asking.clear();
                let discard = std::mem::take(&mut self.discard_pending);
                for (id, host, answer) in answers {
                    // A device replaced while its probe was in flight keeps what
                    // its new host says, not what the old one said.
                    if !discard && self.asked.get(&id).is_some_and(|(asked, _)| *asked == host) {
                        self.answers.insert(id, answer);
                    }
                }
                changed = true;
            }
            // A worker that died without reporting leaves only the devices it was
            // asking unknown: an answer already in hand still stands.
            Some(Err(mpsc::TryRecvError::Disconnected)) => {
                self.pending = None;
                let discard = std::mem::take(&mut self.discard_pending);
                for (id, host) in std::mem::take(&mut self.asking) {
                    if !discard && self.asked.get(&id).is_some_and(|(asked, _)| *asked == host) {
                        self.answers.insert(
                            id,
                            DeviceScan::Failed("the device scan stopped unexpectedly".to_owned()),
                        );
                    }
                }
                changed = true;
            }
            Some(Err(mpsc::TryRecvError::Empty)) | None => {}
        }
        if open
            && self.pending.is_none()
            && targets
                .iter()
                .any(|(id, host)| stale(&self.asked, id, host, now))
        {
            let stale: Vec<(String, RemoteHost)> = targets
                .iter()
                .filter(|(id, host)| stale(&self.asked, id, host, now))
                .cloned()
                .collect();
            self.start(stale, now, probe);
            changed = true;
        }
        changed
    }

    /// Forget a device's answer and its age when it is no longer one of this
    /// window's devices, or when its host changed under the same id.
    pub(super) fn forget_replaced(&mut self, targets: &[(String, RemoteHost)]) {
        let still_here = |id: &String, host: &RemoteHost| {
            targets
                .iter()
                .any(|(device, target)| device == id && target == host)
        };
        self.asking.retain(|(id, host)| still_here(id, host));
        self.asked.retain(|id, (host, _)| still_here(id, host));
        self.answers.retain(|id, _| self.asked.contains_key(id));
    }

    fn start(
        &mut self,
        stale: Vec<(String, RemoteHost)>,
        now: Instant,
        probe: impl Fn(&RemoteHost) -> Result<Vec<RemoteSession>, herdr_client::Error>
        + Send
        + Sync
        + 'static,
    ) {
        let ids: Vec<String> = stale.iter().map(|(id, _)| id.clone()).collect();
        let (tx, rx) = mpsc::sync_channel(1);
        // Stamp the pass before it runs, so a host that cannot answer waits out
        // the interval like one that can, and remember which hosts it is asking.
        self.asking = stale.clone();
        for (id, host) in &stale {
            self.asked.insert(id.clone(), (host.clone(), now));
        }
        match std::thread::Builder::new()
            .name("herdr-gui-devices".into())
            .spawn(move || {
                let _ = tx.send(probe_all(&stale, &probe));
            }) {
            Ok(_) => self.pending = Some(rx),
            Err(error) => {
                // A worker that cannot start must not leave the devices
                // checking: the popup says what went wrong on each of them.
                self.asking.clear();
                let message = Error::from(error).to_string();
                for id in ids {
                    self.answers.insert(id, DeviceScan::Failed(message.clone()));
                }
            }
        }
    }
}

/// Whether a device is due to be asked. One that was never asked, or whose host
/// changed under the same id, is due however recently the old host answered.
fn stale(
    asked: &HashMap<String, (RemoteHost, Instant)>,
    id: &str,
    host: &RemoteHost,
    now: Instant,
) -> bool {
    asked.get(id).is_none_or(|(asked_host, at)| {
        asked_host != host || now.duration_since(*at) >= DEVICE_REFRESH
    })
}

/// One device probe: the sessions that host reports, or why it could not.
type Probe = dyn Fn(&RemoteHost) -> Result<Vec<RemoteSession>, herdr_client::Error> + Send + Sync;

/// Ask every stale device at once: one unreachable host must not hold up the
/// rest of the list, and each probe carries its own deadline.
fn probe_all(
    stale: &[(String, RemoteHost)],
    probe: &Probe,
) -> Vec<(String, RemoteHost, DeviceScan)> {
    let mut answers = Vec::with_capacity(stale.len());
    std::thread::scope(|scope| {
        let handles: Vec<_> = stale
            .iter()
            .map(|(_, target)| scope.spawn(|| probe(target)))
            .collect();
        for ((id, host), handle) in stale.iter().zip(handles) {
            // A probe that panicked still reports for its own device, so its row
            // never sits on "Checking…" waiting for a thread that is already gone.
            let answer = match handle.join() {
                Ok(Ok(sessions)) => DeviceScan::Sessions(sessions),
                Ok(Err(error)) => DeviceScan::Failed(error.to_string()),
                Err(_) => DeviceScan::Failed("the device probe stopped unexpectedly".to_owned()),
            };
            answers.push((id.clone(), host.clone(), answer));
        }
    });
    answers
}

impl Sessions {
    /// Apply a finished scan, and start one when the popup is open and its
    /// results have aged out. Reports whether the popup should repaint.
    pub(super) fn poll(&mut self, development: bool, open: bool, now: Instant) -> bool {
        self.poll_with(open, now, move || {
            list_local_sessions(development).map_err(Error::from)
        })
    }

    fn poll_with(
        &mut self,
        open: bool,
        now: Instant,
        scan: impl FnOnce() -> Result<Vec<LocalSession>, Error> + Send + 'static,
    ) -> bool {
        let mut changed = false;
        let finished = self.pending.as_ref().map(|rx| rx.try_recv());
        match finished {
            Some(Ok(result)) => {
                self.pending = None;
                self.scanning = false;
                let discard = std::mem::take(&mut self.refresh_after_scan);
                self.next_scan = if discard { None } else { Some(now + REFRESH) };
                match result {
                    _ if discard => {}
                    Ok(entries) => {
                        self.entries = entries;
                        self.error = None;
                    }
                    // A failed scan keeps the last list: names that were right a
                    // moment ago beat an empty popup.
                    Err(error) => {
                        crate::storage_warning::warn_storage_failure("Session scan", &error);
                        self.error = Some(error.to_string());
                    }
                }
                changed = true;
            }
            // A worker that died without reporting must not leave the popup
            // scanning forever, exactly as one that could not start.
            Some(Err(mpsc::TryRecvError::Disconnected)) => {
                self.pending = None;
                self.scanning = false;
                self.next_scan = if std::mem::take(&mut self.refresh_after_scan) {
                    None
                } else {
                    Some(now + REFRESH)
                };
                self.error = Some("the session scan stopped unexpectedly".to_owned());
                changed = true;
            }
            Some(Err(mpsc::TryRecvError::Empty)) | None => {}
        }
        if open && self.pending.is_none() && self.next_scan.is_none_or(|at| now >= at) {
            self.start(now, scan);
            changed = true;
        }
        changed
    }

    fn start(
        &mut self,
        now: Instant,
        scan: impl FnOnce() -> Result<Vec<LocalSession>, Error> + Send + 'static,
    ) {
        let (tx, rx) = mpsc::sync_channel(1);
        self.scanning = true;
        match std::thread::Builder::new()
            .name("herdr-gui-sessions".into())
            .spawn(move || {
                let _ = tx.send(scan());
            }) {
            Ok(_) => self.pending = Some(rx),
            Err(error) => {
                // A worker that cannot start must not leave the popup scanning.
                self.scanning = false;
                self.error = Some(Error::from(error).to_string());
                self.next_scan = Some(now + REFRESH);
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
