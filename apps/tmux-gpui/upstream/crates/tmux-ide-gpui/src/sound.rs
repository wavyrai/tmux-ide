//! Local TUI sound settings and endpoint-scoped semantic notification policy.
//! Policy adapted from Herdr; see SOUND-NOTICE.md.
mod config;
mod playback;
#[cfg(test)]
mod tests;

use crate::state::LiveState;
use config::Settings;
use herdr_client::protocol::{AgentStatus, SemanticNotification, SemanticNotificationKind as Kind};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

pub(crate) const MAX_PENDING: usize = 32;
/// How close together two identical notifications from one daemon boot must be
/// to play once. Herdr sends each event to every attached client, so windows
/// that share a daemon all hand the same event to the one worker.
const REPEAT_WINDOW: Duration = Duration::from_secs(2);

struct Pending {
    event: SemanticNotification,
    deadline: Instant,
    expires: Instant,
    validate: bool,
}

#[derive(Default)]
pub(crate) struct Policy {
    cancel: Option<Arc<AtomicBool>>,
    pending: VecDeque<Pending>,
    incoming: VecDeque<(Instant, SemanticNotification)>,
}

impl Policy {
    fn poll(
        &mut self,
        live: &mut LiveState,
        delay: Option<u64>,
        focused: bool,
        now: Instant,
        mut emit: impl FnMut(SemanticNotification),
    ) {
        if self
            .cancel
            .as_ref()
            .is_none_or(|old| !Arc::ptr_eq(old, &live.sound_cancel))
        {
            self.pending.clear();
            self.incoming.clear();
            self.cancel = Some(live.sound_cancel.clone());
        }
        if live.sound_cancel.load(Ordering::Acquire)
            || live.sound_connection_cancel.load(Ordering::Acquire)
            || !live.status.is_connected()
        {
            self.pending.clear();
            self.incoming.clear();
            live.sound_events.clear();
            return;
        }
        for event in live.sound_events.drain(..) {
            if self.incoming.len() == MAX_PENDING {
                self.incoming.pop_front();
            }
            self.incoming.push_back(event);
        }
        let Some(delay) = delay else {
            return;
        };
        for (received, event) in std::mem::take(&mut self.incoming) {
            if let Some(pane) = &event.pane_id {
                self.pending
                    .retain(|p| p.event.pane_id.as_ref() != Some(pane));
            }
            let delay = if event.kind == Kind::Custom { 0 } else { delay };
            if self.pending.len() == MAX_PENDING {
                self.pending.pop_front();
            }
            self.pending.push_back(Pending {
                validate: delay > 0 || event.kind == Kind::Finished,
                event,
                deadline: received + Duration::from_secs(delay),
                expires: received + Duration::from_secs(1),
            });
            self.tick(live, focused, received, &mut emit);
        }
        self.tick(live, focused, now, emit);
    }

    fn tick(
        &mut self,
        live: &LiveState,
        focused: bool,
        now: Instant,
        mut emit: impl FnMut(SemanticNotification),
    ) {
        let snapshot = live.snapshot.as_deref();
        for mut pending in std::mem::take(&mut self.pending) {
            if pending.deadline > now {
                self.pending.push_back(pending);
                continue;
            }
            let event = &pending.event;
            if pending.validate {
                let status = event
                    .pane_id
                    .as_ref()
                    .and_then(|pane| snapshot?.agents.iter().find(|a| &a.pane_id == pane))
                    .map(|a| a.agent_status);
                let awaiting = event.pane_id.is_some()
                    && (status.is_none()
                        || (event.kind == Kind::Finished && status == Some(AgentStatus::Working)));
                if awaiting && now < pending.expires {
                    pending.deadline = (now + Duration::from_millis(50)).min(pending.expires);
                    self.pending.push_back(pending);
                    continue;
                }
                let valid = match event.kind {
                    Kind::Finished => status == Some(AgentStatus::Done),
                    Kind::NeedsAttention => {
                        event.pane_id.is_none() || status == Some(AgentStatus::Blocked)
                    }
                    Kind::Custom | Kind::UpdateInstalled => !awaiting,
                };
                if !valid {
                    continue;
                }
            }
            let target_active = snapshot.is_some_and(|s| {
                if let Some(tab) = &event.tab_id {
                    s.focused_tab_id.as_ref() == Some(tab)
                } else {
                    event
                        .workspace_id
                        .as_ref()
                        .is_some_and(|workspace| s.focused_workspace_id.as_ref() == Some(workspace))
                }
            });
            if event.sound.is_some() && !(event.kind == Kind::Finished && focused && target_active)
            {
                emit(pending.event);
            }
        }
    }
}

enum PlaybackRequest {
    Notification {
        boot: Option<String>,
        event: SemanticNotification,
    },
    Preview,
}

/// Notifications the worker recently accepted, compared as complete values.
#[derive(Default)]
struct Recent(VecDeque<(Instant, Option<String>, SemanticNotification)>);

impl Recent {
    /// Whether this is the first time `event` from `boot` arrives within
    /// [`REPEAT_WINDOW`]. Windows poll in any order, so `at` may precede an
    /// entry recorded earlier.
    fn first(&mut self, boot: Option<&str>, event: &SemanticNotification, at: Instant) -> bool {
        let near = |then: Instant| at.max(then).duration_since(at.min(then)) < REPEAT_WINDOW;
        self.0.retain(|(then, ..)| near(*then));
        if self
            .0
            .iter()
            .any(|(_, seen, heard)| seen.as_deref() == boot && heard == event)
        {
            return false;
        }
        if self.0.len() == MAX_PENDING {
            self.0.pop_front();
        }
        self.0
            .push_back((at, boot.map(str::to_owned), event.clone()));
        true
    }
}

struct Job {
    request: PlaybackRequest,
    cancel: Arc<AtomicBool>,
    connection_cancel: Arc<AtomicBool>,
    queued: Instant,
}

#[derive(Default)]
pub(crate) struct Service {
    sender: Option<mpsc::SyncSender<Job>>,
    settings: Arc<Mutex<Option<Arc<Settings>>>>,
    reload: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

impl Service {
    pub(crate) fn reload(&self) {
        self.reload.store(true, Ordering::Release);
    }

    pub(crate) fn new() -> Self {
        // Test/native fixtures must never touch personal configuration or audio.
        if cfg!(test) || playback::muted() {
            return Self::default();
        }
        Self::start(Settings::load, playback::play)
    }

    /// Starts the worker with an injectable playback backend, called serially and
    /// only on that worker. `play` blocks until completion or error, observing
    /// boot/connection cancellation flags and service shutdown.
    /// It must release per-job audio/device resources before returning; no player
    /// or device objects cross this boundary. Return typed errors with their
    /// sources intact: the worker logs failures without replaying or stopping.
    fn start(
        mut load: impl FnMut() -> crate::Result<Settings> + Send + 'static,
        mut play: impl FnMut(
            herdr_client::protocol::SemanticNotificationSound,
            Option<&std::path::Path>,
            &[&AtomicBool],
            &AtomicBool,
        ) -> crate::Result<()>
        + Send
        + 'static,
    ) -> Self {
        let mut service = Self::default();
        let (sender, receiver) = mpsc::sync_channel::<Job>(8);
        let settings = service.settings.clone();
        let reload = service.reload.clone();
        let stop = service.stop.clone();
        let result = std::thread::Builder::new()
            .name("herdr-sound".into())
            .spawn(move || {
                let mut current = Arc::new(Settings::default());
                let mut recent = Recent::default();
                reload.store(true, Ordering::Release);
                while !stop.load(Ordering::Acquire) {
                    let job = match receiver.recv_timeout(Duration::from_millis(50)) {
                        Ok(job) => Some(job),
                        Err(mpsc::RecvTimeoutError::Timeout) => None,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    if reload.swap(false, Ordering::AcqRel) {
                        match load() {
                            Ok(value) => current = Arc::new(value),
                            Err(error) => {
                                tracing::warn!(%error, "Could not load local TUI sound settings; retaining settings");
                            }
                        }
                        if let Ok(mut value) = settings.lock() {
                            *value = Some(current.clone());
                        }
                    }
                    let Some(job) = job else {
                        continue;
                    };
                    if job.cancel.load(Ordering::Acquire)
                        || job.connection_cancel.load(Ordering::Acquire)
                        || job.queued.elapsed() >= Duration::from_secs(1)
                    {
                        continue;
                    }
                    let (sound, path) = match job.request {
                        PlaybackRequest::Notification { boot, event } => {
                            if !recent.first(boot.as_deref(), &event, job.queued)
                                || !current.sound.allows(event.agent.as_deref())
                            {
                                continue;
                            }
                            let Some(sound) = event.sound else {
                                continue;
                            };
                            (sound, current.path_for(sound))
                        }
                        PlaybackRequest::Preview => {
                            (herdr_client::protocol::SemanticNotificationSound::Done, None)
                        }
                    };
                    if let Err(error) = play(
                        sound,
                        path.as_deref(),
                        &[&job.cancel, &job.connection_cancel],
                        &stop,
                    ) {
                        tracing::debug!(%error, "Sound not played");
                    }
                }
            });
        match result {
            Ok(_) => service.sender = Some(sender),
            Err(error) => tracing::warn!(%error, "Could not start sound worker"),
        }
        service
    }

    /// Explicit local test, independent of endpoint state and notification settings.
    pub(crate) fn preview(&self) {
        if let Some(sender) = &self.sender {
            let _ = sender.try_send(Job {
                request: PlaybackRequest::Preview,
                cancel: self.stop.clone(),
                connection_cancel: self.stop.clone(),
                queued: Instant::now(),
            });
        }
    }

    #[cfg(test)]
    pub(crate) fn recording() -> (
        Self,
        mpsc::Receiver<herdr_client::protocol::SemanticNotificationSound>,
    ) {
        let (sender, receiver) = mpsc::sync_channel(8);
        (
            Self::start(
                || Ok(Settings::default()),
                move |sound, _, _, _| {
                    let _ = sender.try_send(sound);
                    Ok(())
                },
            ),
            receiver,
        )
    }

    pub(crate) fn poll(
        &self,
        policy: &mut Policy,
        live: &mut LiveState,
        focused: bool,
        now: Instant,
    ) {
        if std::mem::take(&mut live.reload_sound) {
            self.reload();
        }
        let settings = self
            .settings
            .try_lock()
            .ok()
            .and_then(|value| value.clone());
        let cancel = live.sound_cancel.clone();
        let connection_cancel = live.sound_connection_cancel.clone();
        let snapshot = live.snapshot.clone();
        policy.poll(
            live,
            settings.map(|s| s.ui_delay()),
            focused,
            now,
            |event| {
                if let Some(sender) = &self.sender {
                    let _ = sender.try_send(Job {
                        request: PlaybackRequest::Notification {
                            boot: snapshot.as_ref().map(|s| s.boot_id.clone()),
                            event,
                        },
                        cancel: cancel.clone(),
                        connection_cancel: connection_cancel.clone(),
                        queued: now,
                    });
                }
            },
        );
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
