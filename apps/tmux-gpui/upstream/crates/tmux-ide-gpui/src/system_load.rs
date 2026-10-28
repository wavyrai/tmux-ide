//! CPU and memory of each host the window lists, for the status bar and the
//! sidebar's host rows. Every host has its own worker thread sampling it every
//! couple of seconds: this machine through `sysinfo`, a remote host over one
//! SSH shell kept open between samples. The UI thread only starts and stops
//! workers and takes their samples on later ticks, so a slow or unreachable
//! host never blocks rendering or delays another host.

mod render;
mod sample;

#[cfg(test)]
mod tests;

use crate::{
    Error, Result,
    usage::{Host, Shell},
};
pub(crate) use render::{gauges, line, tooltip};
use sample::{Memory, Os, Sample, Ticks};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Condvar, Mutex, PoisonError, mpsc},
    thread,
    time::{Duration, Instant},
};

const INTERVAL: Duration = Duration::from_secs(2);
/// A host that could not be reached is tried again after this long.
const RETRY: Duration = Duration::from_secs(30);
/// macOS hosts spend one second of this measuring CPU.
const STEP_TIMEOUT: Duration = Duration::from_secs(10);
/// CPU samples kept for the sparklines.
pub(crate) const HISTORY: usize = 16;
/// Hosts are few; an unbounded endpoint list still cannot start more workers.
const HOST_LIMIT: usize = 16;

/// Where samples come from.
enum Source {
    Local {
        /// Boxed: far larger than a remote shell's state.
        system: Box<sysinfo::System>,
        /// CPU usage is measured between two refreshes, so the first has none.
        primed: bool,
    },
    Remote {
        shell: Shell,
        os: Os,
        ticks: Option<Ticks>,
    },
}

impl Source {
    fn open(host: &Host) -> Result<Self> {
        match host {
            Host::Local => Ok(Self::Local {
                system: Box::new(sysinfo::System::new()),
                primed: false,
            }),
            Host::Ssh(target) => {
                let mut shell = Shell::connect(target).map_err(remote)?;
                let uname = shell.run("uname -s", STEP_TIMEOUT).map_err(remote)?;
                let os = Os::from_uname(&uname.stdout).ok_or_else(|| {
                    Error::SystemLoadUnsupported(uname.stdout.trim().chars().take(32).collect())
                })?;
                Ok(Self::Remote {
                    shell,
                    os,
                    ticks: None,
                })
            }
            Host::Wsl(_) => Err(Error::WslHostUnsupported),
        }
    }

    fn sample(&mut self) -> Result<Sample> {
        match self {
            Self::Local { system, primed } => {
                system.refresh_cpu_usage();
                system.refresh_memory();
                let cpu = std::mem::replace(primed, true)
                    .then(|| system.global_cpu_usage().clamp(0., 100.));
                let load = sysinfo::System::load_average();
                Ok(Sample {
                    cpu,
                    memory: Some(Memory {
                        used: system.used_memory(),
                        total: system.total_memory(),
                    })
                    .filter(|memory| memory.total > 0),
                    cores: u32::try_from(system.cpus().len())
                        .ok()
                        .filter(|cores| *cores > 0),
                    // Windows keeps no load average; sysinfo reports zeros.
                    load: (!cfg!(windows)).then_some([
                        load.one as f32,
                        load.five as f32,
                        load.fifteen as f32,
                    ]),
                })
            }
            Self::Remote { shell, os, ticks } => {
                let output = shell.run(os.command(), STEP_TIMEOUT).map_err(remote)?;
                let answer = sample::parse(&output.stdout, *ticks)?;
                *ticks = answer.ticks;
                Ok(answer.sample)
            }
        }
    }
}

fn remote(error: Error) -> Error {
    Error::SystemLoadRemote(Box::new(error))
}

/// Tells a worker to stop, waking it from its wait between samples. The
/// listening-port scanners stop the same way.
#[derive(Default)]
pub(crate) struct Stop {
    stopped: Mutex<bool>,
    changed: Condvar,
}

impl Stop {
    pub(crate) fn stop(&self) {
        *self.stopped.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.changed.notify_all();
    }

    /// Waits until `due`; false once stopped.
    pub(crate) fn wait(&self, due: Instant) -> bool {
        let mut stopped = self.stopped.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if *stopped {
                return false;
            }
            let now = Instant::now();
            if now >= due {
                return true;
            }
            stopped = self
                .changed
                .wait_timeout(stopped, due - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

struct Worker {
    stop: Arc<Stop>,
    results: mpsc::Receiver<Result<Sample>>,
}

impl Drop for Worker {
    /// The thread ends after its current sample; nothing waits for it here.
    fn drop(&mut self) {
        self.stop.stop();
    }
}

fn spawn(host: Host) -> Option<Worker> {
    let stop = Arc::new(Stop::default());
    let (sender, results) = mpsc::sync_channel(4);
    let shared = stop.clone();
    let spawned = thread::Builder::new()
        .name("herdr-system-load".into())
        .spawn(move || run(&host, &shared, &sender));
    match spawned {
        Ok(_) => Some(Worker { stop, results }),
        Err(error) => {
            tracing::warn!(category = "system-load", %error, "could not start a CPU and memory worker");
            None
        }
    }
}

fn run(host: &Host, stop: &Stop, results: &mpsc::SyncSender<Result<Sample>>) {
    let mut source: Option<Source> = None;
    loop {
        let opened = match source.take() {
            Some(source) => Ok(source),
            None => Source::open(host),
        };
        let result = opened.and_then(|mut opened| {
            let sample = opened.sample();
            // A failed remote step leaves the shell unusable; reconnect.
            if sample.is_ok() || matches!(opened, Source::Local { .. }) {
                source = Some(opened);
            }
            sample
        });
        let due = Instant::now() + if result.is_ok() { INTERVAL } else { RETRY };
        match results.try_send(result) {
            // The UI is behind; it will take the next one.
            Ok(()) | Err(mpsc::TrySendError::Full(_)) => {}
            Err(mpsc::TrySendError::Disconnected(_)) => return,
        }
        if !stop.wait(due) {
            return;
        }
    }
}

/// One host's samples: the latest, and recent CPU usage for a sparkline.
#[derive(Default)]
pub(crate) struct Reading {
    latest: Option<Sample>,
    /// Recent CPU usage, oldest first.
    history: VecDeque<f32>,
    /// Why the latest sample failed; the last good one stays shown.
    error: Option<String>,
}

impl Reading {
    pub fn latest(&self) -> Option<&Sample> {
        self.latest.as_ref()
    }

    pub fn history(&self) -> impl ExactSizeIterator<Item = f32> + '_ {
        self.history.iter().copied()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    fn apply(&mut self, result: Result<Sample>) {
        match result {
            Ok(sample) => {
                if let Some(cpu) = sample.cpu {
                    if self.history.len() == HISTORY {
                        self.history.pop_front();
                    }
                    self.history.push_back(cpu);
                }
                self.latest = Some(sample);
                self.error = None;
            }
            Err(error) => {
                // The display boundary: the cause says what went wrong remotely.
                let mut text = error.to_string();
                let mut source = std::error::Error::source(&error);
                while let Some(cause) = source {
                    text.push(' ');
                    text.push_str(&cause.to_string());
                    source = cause.source();
                }
                self.error = Some(text);
            }
        }
    }
}

#[derive(Default)]
struct Monitor {
    /// None once its thread could not start or has ended.
    worker: Option<Worker>,
    reading: Reading,
}

/// Every sampled host's reading, keyed by host.
#[derive(Default)]
pub(crate) struct SystemLoad {
    monitors: HashMap<Host, Monitor>,
}

impl SystemLoad {
    pub fn get(&self, host: &Host) -> Option<&Reading> {
        self.monitors.get(host).map(|monitor| &monitor.reading)
    }

    /// Samples exactly `hosts` (at most [`HOST_LIMIT`]): starts workers for
    /// new ones, stops and forgets the rest, and takes finished samples.
    /// Returns whether anything shown changed.
    pub fn poll(&mut self, hosts: impl IntoIterator<Item = Host>) -> bool {
        let wanted: Vec<Host> = hosts.into_iter().take(HOST_LIMIT).collect();
        let before = self.monitors.len();
        self.monitors.retain(|host, _| wanted.contains(host));
        let mut changed = self.monitors.len() != before;
        for host in wanted {
            self.monitors
                .entry(host)
                .or_insert_with_key(|host| Monitor {
                    worker: spawn(host.clone()),
                    reading: Reading::default(),
                });
        }
        for monitor in self.monitors.values_mut() {
            while let Some(worker) = &monitor.worker {
                match worker.results.try_recv() {
                    Ok(result) => {
                        monitor.reading.apply(result);
                        changed = true;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => monitor.worker = None,
                }
            }
        }
        changed
    }
}
