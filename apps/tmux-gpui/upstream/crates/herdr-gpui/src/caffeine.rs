//! Keeps the display and the machine awake on request, like the Caffeine
//! menu-bar app.
//!
//! The hold is a `keepawake` guard: IOKit power assertions on macOS, the
//! thread execution state on Windows, and ScreenSaver plus logind inhibitors
//! over D-Bus on Linux. The unsafe FFI stays inside that crate. Each platform
//! drops the hold when the process exits, so a crash or quit releases it
//! without cleanup here. The state is app-wide, so every window's status bar
//! shows the same cup.
//!
//! One dedicated thread owns the guard. Windows ties the execution state to
//! the thread that set it and restores it on drop from that same thread, and
//! Linux makes blocking D-Bus calls that must stay off the UI thread.

use crate::{Error, Result};
use gpui::{App, Global};
use std::sync::mpsc::{Receiver, SyncSender};

/// What the status bar draws for the cup.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Cup {
    #[default]
    Off,
    /// A hold or release is in flight; clicks wait for it.
    Pending,
    On,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    Hold,
    Release,
}

struct Request {
    command: Command,
    reply: SyncSender<keepawake::Result<()>>,
}

#[derive(Default)]
struct Caffeine {
    cup: Cup,
    /// Dropping it ends the worker, which releases any hold on its own thread.
    worker: Option<SyncSender<Request>>,
}

impl Global for Caffeine {}

pub(crate) fn cup(cx: &App) -> Cup {
    cx.try_global::<Caffeine>()
        .map_or(Cup::Off, |caffeine| caffeine.cup)
}

/// Starts or stops keeping the display awake, and redraws every window.
/// Failures arrive later through `report`, never during this call.
pub(crate) fn toggle(cx: &mut App, report: impl FnOnce(Error, &mut App) + 'static) {
    toggle_with(cx, hold, report);
}

/// `start` makes the hold on the worker thread; it is used only when that
/// thread is first spawned, so tests can stand in for the real power APIs.
fn toggle_with<G>(
    cx: &mut App,
    start: impl FnMut() -> keepawake::Result<G> + Send + 'static,
    report: impl FnOnce(Error, &mut App) + 'static,
) {
    let caffeine = cx.default_global::<Caffeine>();
    let command = match caffeine.cup {
        Cup::Pending => return,
        Cup::Off => Command::Hold,
        Cup::On => Command::Release,
    };
    let (reply, replies) = std::sync::mpsc::sync_channel(1);
    let sent = match caffeine.worker.take() {
        Some(worker) => Ok(worker),
        None => spawn(start),
    }
    .and_then(|worker| {
        // Never blocks: `Pending` keeps at most one request in the slot.
        worker
            .send(Request { command, reply })
            .map(|()| worker)
            .map_err(|_| Error::CaffeineWorkerStopped)
    });
    match sent {
        Ok(worker) => caffeine.worker = Some(worker),
        Err(error) => {
            cx.defer(move |cx| report(error, cx));
            return;
        }
    }
    caffeine.cup = Cup::Pending;
    cx.refresh_windows();
    let wait = cx
        .background_executor()
        .spawn(async move { replies.recv() });
    cx.spawn(async move |cx| {
        // A dropped reply means the worker died, e.g. a panicking release.
        let result = match wait.await {
            Ok(result) => result.map_err(Error::Caffeine),
            Err(_) => Err(Error::CaffeineWorkerStopped),
        };
        cx.update(|cx| finish(cx, command, result, report));
    })
    .detach();
}

fn finish(
    cx: &mut App,
    command: Command,
    result: Result<()>,
    report: impl FnOnce(Error, &mut App),
) {
    let caffeine = cx.default_global::<Caffeine>();
    caffeine.cup = match (command, &result) {
        (Command::Hold, Ok(())) => Cup::On,
        // A failed hold holds nothing, and a worker that died mid-release
        // took its guard with it.
        (Command::Hold, Err(_)) | (Command::Release, _) => Cup::Off,
    };
    if matches!(result, Err(Error::CaffeineWorkerStopped)) {
        caffeine.worker = None;
    }
    cx.refresh_windows();
    if let Err(error) = result {
        report(error, cx);
    }
}

fn spawn<G>(
    start: impl FnMut() -> keepawake::Result<G> + Send + 'static,
) -> Result<SyncSender<Request>> {
    let (worker, requests) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("herdr-keepawake".into())
        .spawn(move || run(&requests, start))
        .map_err(Error::CaffeineThread)?;
    Ok(worker)
}

/// Serves requests until the app drops its sender, then drops any hold here.
fn run<G>(requests: &Receiver<Request>, mut start: impl FnMut() -> keepawake::Result<G>) {
    let mut guard = None;
    for Request { command, reply } in requests {
        let result = match command {
            Command::Hold if guard.is_some() => Ok(()),
            Command::Hold => start().map(|held| guard = Some(held)),
            Command::Release => {
                guard = None;
                Ok(())
            }
        };
        // The waiting task outlives the request unless the app is quitting.
        let _ = reply.send(result);
    }
}

fn hold() -> keepawake::Result<keepawake::KeepAwake> {
    // Display and idle, not `sleep`: that one needs AC power and does nothing
    // under Windows Modern Standby, and the lid closing should still sleep.
    keepawake::Builder::default()
        .display(true)
        .idle(true)
        .reason("Herdr keeps the display awake")
        .app_name("Herdr")
        .app_reverse_domain(crate::constants::APP_ID)
        .create()
}

#[cfg(test)]
mod tests;
