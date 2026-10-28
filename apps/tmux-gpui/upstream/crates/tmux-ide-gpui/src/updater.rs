//! GUI-local update service. Workers own all transport, staging, and process waits.
mod error;
pub use error::UpdateError;
use error::{Result, UpdateError as Error};
#[cfg(unix)]
mod brew;
#[cfg(unix)]
mod install;
mod release;
#[cfg(not(unix))]
mod unsupported;
#[cfg(not(unix))]
use unsupported::{brew, install};

use std::{
    ffi::OsString,
    process::ExitCode,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum State {
    Disabled(String),
    Idle,
    Checking,
    Current,
    Available {
        version: String,
    },
    Downloading {
        received: u64,
        total: u64,
    },
    Ready {
        version: String,
    },
    Installing,
    /// Homebrew owns this installation, so Homebrew performs the upgrade.
    Homebrew {
        version: String,
    },
    Upgrading {
        detail: String,
    },
    Restart {
        version: String,
    },
    Restarting,
    Cancelling,
    Error(String),
}

impl State {
    fn busy(&self) -> bool {
        matches!(
            self,
            Self::Checking
                | Self::Downloading { .. }
                | Self::Installing
                | Self::Upgrading { .. }
                | Self::Restarting
                | Self::Cancelling
        )
    }
}

#[derive(Clone, Copy)]
enum Operation {
    Check,
    Download,
    Install,
    Upgrade,
    Restart,
    Cancel,
}

struct Command {
    generation: u64,
    operation: Operation,
}

struct Mailbox {
    generation: u64,
    state: State,
    restart: Option<install::RestartGuard>,
    /// The upgraded app is already starting; this one only has to quit.
    relaunched: bool,
}

pub(super) struct Updater {
    state: State,
    commands: Option<SyncSender<Command>>,
    cancelled: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    mailbox: Arc<Mutex<Option<Mailbox>>>,
    generation: u64,
    restart: Option<install::RestartGuard>,
    relaunched: bool,
    committed: bool,
    next_check: Instant,
}

impl Default for Updater {
    fn default() -> Self {
        Self {
            state: State::Disabled("In-app updates require a release build with an embedded update verification key. Local builds and test fixtures never check automatically.".into()),
            commands: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(AtomicBool::new(false)),
            mailbox: Arc::new(Mutex::new(None)),
            generation: 0,
            restart: None,
            relaunched: false,
            committed: false,
            next_check: Instant::now() + CHECK_INTERVAL,
        }
    }
}

impl Updater {
    /// Additional windows never run a second update worker: two workers could
    /// stage and restart the same installation at once.
    pub(super) fn secondary() -> Self {
        let mut updater = Self::default();
        updater.state = State::Disabled(
            "another window owns app updates in this process. Use the window that was open first."
                .into(),
        );
        updater
    }

    pub(super) fn start() -> Self {
        let mut updater = Self::default();
        let Some(key) = option_env!("HERDR_UPDATE_PUBLIC_KEY") else {
            return updater;
        };
        if release::parse_version(crate::APP_VERSION).is_none() || key.is_empty() {
            return updater;
        }
        if release::target().is_none() {
            updater.state = State::Disabled("No standalone updater is available for this platform. Use your package manager or download a supported release.".into());
            return updater;
        }
        // At most one operation and its cancellation acknowledgement are queued.
        let (sender, receiver) = mpsc::sync_channel(2);
        let mailbox = updater.mailbox.clone();
        let cancelled = updater.cancelled.clone();
        let stopped = updater.stopped.clone();
        match thread::Builder::new()
            .name("herdr-updates".into())
            .spawn(move || worker(receiver, mailbox, cancelled, stopped, key))
        {
            Ok(_) => {
                updater.commands = Some(sender);
                updater.state = State::Idle;
                updater.check();
            }
            Err(error) => {
                updater.state = State::Disabled(format!("Could not start updater: {error}"))
            }
        }
        updater
    }

    pub(super) fn state(&self) -> &State {
        &self.state
    }

    /// A newer release is waiting for the user, either still to download or
    /// already staged. Transient checking/downloading states are not a result.
    pub(super) fn update_available(&self) -> bool {
        matches!(
            self.state,
            State::Available { .. }
                | State::Ready { .. }
                | State::Homebrew { .. }
                | State::Restart { .. }
        )
    }

    fn send(&mut self, operation: Operation, state: State) {
        let Some(sender) = &self.commands else { return };
        if self.state.busy() || self.restart.is_some() {
            return;
        }
        let generation = self.generation.wrapping_add(1);
        self.cancelled.store(false, Ordering::Release);
        match sender.try_send(Command {
            generation,
            operation,
        }) {
            Ok(()) => {
                self.generation = generation;
                self.state = state;
                self.next_check = Instant::now() + CHECK_INTERVAL;
            }
            Err(mpsc::TrySendError::Full(_)) => (),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.state = State::Error("Update worker stopped".into());
            }
        }
    }

    pub(super) fn check(&mut self) {
        if !matches!(self.state, State::Ready { .. }) {
            self.send(Operation::Check, State::Checking);
        }
    }

    pub(super) fn download(&mut self) {
        if matches!(self.state, State::Available { .. }) {
            self.send(
                Operation::Download,
                State::Downloading {
                    received: 0,
                    total: 0,
                },
            );
        }
    }

    pub(super) fn install(&mut self) {
        if matches!(self.state, State::Ready { .. }) {
            self.send(Operation::Install, State::Installing);
        }
    }

    pub(super) fn upgrade(&mut self) {
        if matches!(self.state, State::Homebrew { .. }) {
            self.send(
                Operation::Upgrade,
                State::Upgrading {
                    detail: "Starting Homebrew...".into(),
                },
            );
        }
    }

    pub(super) fn restart(&mut self) {
        if matches!(self.state, State::Restart { .. }) {
            self.send(Operation::Restart, State::Restarting);
        }
    }

    /// Homebrew is never interrupted: killing it while it moves the bundle can
    /// leave no installed app at all.
    fn interruptible(&self) -> bool {
        self.state.busy()
            && !matches!(
                self.state,
                State::Cancelling | State::Upgrading { .. } | State::Restarting
            )
    }

    pub(super) fn cancel(&mut self) {
        if self.interruptible() && !self.committed {
            self.cancelled.store(true, Ordering::Release);
            let Some(sender) = &self.commands else { return };
            let generation = self.generation.wrapping_add(1);
            match sender.try_send(Command {
                generation,
                operation: Operation::Cancel,
            }) {
                Ok(()) => {
                    self.generation = generation;
                    self.restart = None;
                    self.state = State::Cancelling;
                }
                Err(_) => {
                    self.state =
                        State::Error("Update worker could not acknowledge cancellation".into())
                }
            }
        }
    }

    pub(super) fn poll(&mut self) -> bool {
        // Scheduling shares the UI-side generation/cancellation path with manual checks.
        let scheduled = if self.commands.is_some() && Instant::now() >= self.next_check {
            let before = self.state.clone();
            self.check();
            before != self.state
        } else {
            false
        };
        let Ok(mut mailbox) = self.mailbox.try_lock() else {
            return scheduled;
        };
        let Some(message) = mailbox.take() else {
            return scheduled;
        };
        if message.generation != self.generation {
            return scheduled;
        }
        let changed =
            self.state != message.state || message.restart.is_some() || message.relaunched;
        self.state = message.state;
        self.restart = message.restart;
        self.relaunched |= message.relaunched;
        changed || scheduled
    }

    pub(super) fn commit_restart(&mut self) -> Result<bool> {
        if self.committed {
            return Ok(false);
        }
        // Homebrew installations restart by launching the upgraded bundle, so
        // there is no staged helper to hand over to: just quit.
        if self.relaunched {
            self.committed = true;
            return Ok(true);
        }
        let Some(guard) = &mut self.restart else {
            return Ok(false);
        };
        if self.cancelled.load(Ordering::Acquire) {
            self.restart = None;
            self.state = State::Idle;
            return Ok(false);
        }
        if let Err(error) = guard.commit() {
            self.state = State::Error(error.to_string());
            self.restart = None;
            return Err(error);
        }
        self.committed = true;
        Ok(true)
    }
}

impl Drop for Updater {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.cancelled.store(true, Ordering::Release);
        // Disconnect, never join. Workers clean up only their own private staging.
        self.commands = None;
    }
}

fn publish(
    mailbox: &Mutex<Option<Mailbox>>,
    generation: u64,
    state: State,
    restart: Option<install::RestartGuard>,
) {
    publish_relaunch(mailbox, generation, state, restart, false);
}

fn publish_relaunch(
    mailbox: &Mutex<Option<Mailbox>>,
    generation: u64,
    state: State,
    restart: Option<install::RestartGuard>,
    relaunched: bool,
) {
    if let Ok(mut slot) = mailbox.lock() {
        *slot = Some(Mailbox {
            generation,
            state,
            restart,
            relaunched,
        });
    }
}

/// The Homebrew cask that owns this installation, re-proved on every use: the
/// user may have moved, reinstalled, or removed it since the last check.
fn cask() -> Option<brew::Cask> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let executable = std::env::current_exe().ok()?;
    let bundle = install::mac_bundle(&executable).ok()?;
    brew::detect(&bundle, install::effective_uid().ok()?)
}

fn worker(
    commands: Receiver<Command>,
    mailbox: Arc<Mutex<Option<Mailbox>>>,
    cancelled: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    key: &'static str,
) {
    let mut offer: Option<release::Offer> = None;
    let mut prepared = None;
    while let Ok(command) = commands.recv() {
        if stopped.load(Ordering::Acquire) {
            break;
        }
        let generation = command.generation;
        let result: Result<State> = match command.operation {
            Operation::Check => {
                publish(&mailbox, generation, State::Checking, None);
                release::check(crate::APP_VERSION, key, &cancelled).map(|found| {
                    offer = found;
                    match (&offer, cask().is_some()) {
                        (Some(offer), true) => State::Homebrew {
                            version: offer.manifest.version.clone(),
                        },
                        (Some(offer), false) => State::Available {
                            version: offer.manifest.version.clone(),
                        },
                        (None, _) => State::Current,
                    }
                })
            }
            Operation::Download => match &offer {
                Some(offer) => install::prepare(offer, &cancelled, |received, total| {
                    publish(
                        &mailbox,
                        generation,
                        State::Downloading { received, total },
                        None,
                    );
                })
                .map(|candidate| {
                    prepared = Some(candidate);
                    State::Ready {
                        version: offer.manifest.version.clone(),
                    }
                }),
                None => Err(Error::MissingOffer),
            },
            Operation::Install => match prepared.take() {
                Some(candidate) => match install::install_and_restart(candidate, &cancelled) {
                    Ok(guard) => {
                        publish(&mailbox, generation, State::Installing, Some(guard));
                        // Keep receiving commands: cancellation/commit failure may leave
                        // this app alive even after the helper becomes ready.
                        continue;
                    }
                    Err(error) => Err(error),
                },
                None => Err(Error::MissingPrepared),
            },
            Operation::Upgrade => match (&offer, cask()) {
                (Some(offer), Some(cask)) => brew::upgrade(
                    &cask,
                    crate::APP_VERSION,
                    &offer.manifest.version,
                    &cancelled,
                    |detail| {
                        publish(&mailbox, generation, State::Upgrading { detail }, None);
                    },
                )
                .map(|version| State::Restart { version }),
                (None, _) => Err(Error::MissingOffer),
                (_, None) => Err(Error::MissingCask),
            },
            Operation::Restart => match cask()
                .ok_or(Error::MissingCask)
                .and_then(|cask| brew::relaunch(&cask))
            {
                Ok(()) => {
                    // The upgraded app is starting, so this one must quit. The
                    // mailbox keeps only the latest message: publishing the
                    // relaunch last is what keeps it from being overwritten.
                    publish_relaunch(&mailbox, generation, State::Restarting, None, true);
                    continue;
                }
                Err(error) => Err(error),
            },
            Operation::Cancel => {
                prepared = None;
                Ok(State::Idle)
            }
        };
        if stopped.load(Ordering::Acquire) {
            break;
        }
        let state = if cancelled.load(Ordering::Acquire) {
            prepared = None;
            State::Idle
        } else {
            result.unwrap_or_else(|error| State::Error(error.to_string()))
        };
        publish(&mailbox, generation, state, None);
    }
}

pub(super) fn run_helper(args: &[OsString]) -> Option<ExitCode> {
    install::run_helper(args)
}

#[cfg(test)]
mod tests;
