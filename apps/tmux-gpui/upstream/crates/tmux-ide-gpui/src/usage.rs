//! Plan usage of the AI services signed in on the selected host, for the
//! status bar and its panel. One worker thread reads one host at a time and
//! reports each provider as it answers; the UI thread only queues a host and
//! takes answers on later ticks. Each host keeps its last answers, so
//! switching back shows them at once and a failed refresh keeps the numbers it
//! had, marked stale, rather than blanking them.

mod access;
mod cookies;
mod icons;
mod model;
mod panel;
mod probe;
mod providers;
mod registry;
mod render;
mod service;
mod settings;
mod ui;
mod values;

#[cfg(test)]
mod tests;

pub(crate) use access::KeychainGrants;
pub(crate) use model::{Host, Provider};
pub(crate) use panel::PANEL_WIDTH;
pub(crate) use probe::Shell;
pub(crate) use render::Hint;
pub use settings::UsageConfig;

use cookies::CookieJar;
use model::Report;
use probe::{Consent, Exec, Probe};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant, SystemTime},
};

/// The services rate limit these endpoints, and the numbers move slowly.
const REFRESH: Duration = Duration::from_secs(10 * 60);
const RATE_LIMITED: Duration = Duration::from_secs(30 * 60);
/// A host that could not be reached is retried sooner than a full refresh.
const ERROR_BACKOFF: Duration = Duration::from_secs(5 * 60);
/// A click cannot queue reads back to back.
const MANUAL_SPACING: Duration = Duration::from_secs(10);
/// Hosts are few; an unbounded catalog still cannot grow the cache past this.
const HOST_LIMIT: usize = 16;

pub(crate) fn icon(path: &str) -> Option<&'static [u8]> {
    icons::PROVIDER_ICONS
        .iter()
        .find(|(name, _)| *name == path)
        .map(|(_, bytes)| *bytes)
}

pub(crate) fn icon_paths() -> impl Iterator<Item = &'static str> {
    icons::PROVIDER_ICONS.iter().map(|(name, _)| *name)
}

/// One provider on the shown host: its last good report, and why the latest
/// refresh failed if it did.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Reading {
    pub provider: Provider,
    pub report: Option<Report>,
    pub error: Option<String>,
    /// Set when the sign-in sits behind a Keychain prompt the user has not
    /// allowed, or denied, so the panel can offer to allow it.
    pub access: Option<Access>,
}

/// Where a provider stands on a read that makes macOS ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    /// Waiting for the user to press Allow.
    Needed,
    /// Allowed, then denied in the macOS prompt.
    Denied,
}

#[derive(Default)]
pub(crate) struct Entry {
    pub readings: Vec<Reading>,
    /// Why the host itself could not be read, such as SSH failing.
    pub error: Option<String>,
    pub updated: Option<SystemTime>,
    due: Option<Instant>,
    requested: Option<Instant>,
    /// Providers heard from in the read under way, so ones that went
    /// silent (signed out) can be dropped when it ends.
    round: HashSet<Provider>,
    rate_limited: bool,
}

/// How many providers the status bar has room for; the panel lists all.
pub(crate) const HEADLINE: usize = 2;

impl Entry {
    /// The providers the status bar shows: those with numbers to show, the
    /// one chosen in the panel first, then the ones closest to a limit, at
    /// most `limit` of them. A provider that has no report yet, or no windows
    /// or balances, waits in the panel.
    pub fn headline(&self, limit: usize, chosen: Option<Provider>) -> Vec<&Reading> {
        let mut shown: Vec<&Reading> = self
            .readings
            .iter()
            .filter(|reading| has_numbers(reading) || reading.access.is_some())
            .collect();
        // Stable: equally used providers keep the registry's order.
        shown.sort_by(|a, b| urgency(b).total_cmp(&urgency(a)));
        if let Some(index) = shown
            .iter()
            .position(|reading| Some(reading.provider) == chosen)
        {
            let reading = shown.remove(index);
            shown.insert(0, reading);
        }
        shown.truncate(limit);
        shown
    }
}

impl Entry {
    /// The providers the panel offers as tabs: those with numbers to show,
    /// and those the config asked for, whose panel then says what to set up.
    /// A detected sign-in that yields nothing, such as an account without a
    /// plan, is left out.
    pub fn tabs(&self, config: &UsageConfig) -> Vec<&Reading> {
        self.readings
            .iter()
            .filter(|reading| has_numbers(reading) || config.shown(reading.provider))
            .collect()
    }
}

fn has_numbers(reading: &Reading) -> bool {
    reading
        .report
        .as_ref()
        .is_some_and(|report| !report.windows.is_empty() || !report.balances.is_empty())
}

fn urgency(reading: &Reading) -> f32 {
    reading
        .report
        .as_ref()
        .and_then(|report| report.tightest())
        .map_or(0., |window| window.used)
}

enum Message {
    Reading(Host, Provider, crate::Result<Report>),
    Done(Host, crate::Result<()>),
}

/// One read of one host.
struct Job {
    host: Host,
    config: Arc<UsageConfig>,
    granted: HashSet<Provider>,
    retry: HashSet<Provider>,
}

struct Worker {
    requests: mpsc::SyncSender<Job>,
    results: mpsc::Receiver<Message>,
}

#[derive(Default)]
pub(crate) struct Usage {
    host: Option<Host>,
    entries: HashMap<Host, Entry>,
    worker: Option<Worker>,
    busy: Option<Host>,
    minute: u64,
    revision: Option<u64>,
    /// The provider last picked in the panel, which leads the status bar on
    /// any host that has numbers for it.
    chosen: Option<Provider>,
    /// Providers just allowed, whose remembered refusals the next read
    /// forgets so macOS asks again.
    retry: HashSet<Provider>,
    /// Providers denied in a macOS prompt, for the window to take back the
    /// saved grant.
    denied: Vec<Provider>,
}

impl Usage {
    /// What the status bar shows for the tracked host.
    pub fn current(&self) -> Option<&Entry> {
        self.entries.get(self.host.as_ref()?)
    }

    /// The provider picked in the panel to lead the status bar.
    pub fn chosen(&self) -> Option<Provider> {
        self.chosen
    }

    /// Leads the status bar with `provider`, without reading anything again.
    pub fn choose(&mut self, provider: Provider) {
        self.chosen = Some(provider);
    }

    /// Whether the tracked host is being read right now.
    pub fn busy(&self) -> bool {
        self.host.is_some() && self.busy == self.host
    }

    /// The user pressed Allow for `provider`: read the tracked host on the
    /// next poll, even if it was just read, so macOS asks right away.
    pub fn allow(&mut self, provider: Provider, now: Instant) {
        self.retry.insert(provider);
        if let Some(host) = self.host.clone() {
            self.entries.entry(host).or_default().due = Some(now);
        }
    }

    /// Providers denied since the last call, whose grants should be dropped.
    pub fn take_denied(&mut self) -> Vec<Provider> {
        std::mem::take(&mut self.denied)
    }

    /// Reads the tracked host on the next poll, unless it was just read.
    pub fn refresh(&mut self, now: Instant) {
        let Some(host) = self.host.clone() else {
            return;
        };
        let entry = self.entries.entry(host).or_default();
        if entry
            .requested
            .is_none_or(|requested| now.duration_since(requested) >= MANUAL_SPACING)
        {
            entry.due = Some(now);
        }
    }

    /// Follows `host` (None hides usage), takes finished answers, and starts
    /// the next read when it is due. Reads only start while `active`, so a
    /// background window costs no requests; a new config `revision` makes
    /// every host due. `granted` lists the providers allowed to make macOS
    /// ask. Returns whether anything shown changed, including the minute the
    /// reset countdowns count from.
    pub fn poll(
        &mut self,
        host: Option<Host>,
        config: &UsageConfig,
        granted: &HashSet<Provider>,
        revision: u64,
        active: bool,
        now: Instant,
    ) -> bool {
        let mut changed = self.host != host;
        self.host = host;
        if self
            .revision
            .replace(revision)
            .is_some_and(|last| last != revision)
        {
            for entry in self.entries.values_mut() {
                entry.due = Some(now);
            }
        }
        while let Some(worker) = &self.worker {
            match worker.results.try_recv() {
                Ok(message) => {
                    self.apply(message, now);
                    changed = true;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.worker = None;
                    self.busy = None;
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }
        let minute = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            / 60;
        if minute != self.minute {
            self.minute = minute;
            changed |= self
                .current()
                .is_some_and(|entry| !entry.readings.is_empty());
        }
        if active && self.busy.is_none() {
            changed |= self.dispatch(config, granted, now);
        }
        changed
    }

    fn dispatch(
        &mut self,
        config: &UsageConfig,
        granted: &HashSet<Provider>,
        now: Instant,
    ) -> bool {
        let Some(host) = self.host.clone() else {
            return false;
        };
        if self
            .entries
            .get(&host)
            .and_then(|entry| entry.due)
            .is_some_and(|due| due > now)
        {
            return false;
        }
        if self.worker.is_none() {
            self.worker = spawn();
        }
        let Some(worker) = &self.worker else {
            self.entries.entry(host).or_default().due = Some(now + ERROR_BACKOFF);
            return false;
        };
        let job = Job {
            host: host.clone(),
            config: Arc::new(config.clone()),
            granted: granted.clone(),
            retry: self.retry.clone(),
        };
        match worker.requests.try_send(job) {
            Ok(()) => {
                self.retry.clear();
                self.begin(host, now);
                true
            }
            Err(mpsc::TrySendError::Full(_)) => false,
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.worker = None;
                false
            }
        }
    }

    /// Marks `host` as being read, making room for it in the cache.
    fn begin(&mut self, host: Host, now: Instant) {
        if self.entries.len() >= HOST_LIMIT && !self.entries.contains_key(&host) {
            let shown = self.host.clone();
            self.entries
                .retain(|kept, _| *kept == host || Some(kept) == shown.as_ref());
        }
        let entry = self.entries.entry(host.clone()).or_default();
        entry.requested = Some(now);
        entry.round.clear();
        entry.rate_limited = false;
        // Due again only once this read answers.
        entry.due = Some(now + REFRESH);
        self.busy = Some(host);
    }

    fn apply(&mut self, message: Message, now: Instant) {
        match message {
            Message::Reading(host, provider, report) => {
                let Some(entry) = self.entries.get_mut(&host) else {
                    return;
                };
                entry.round.insert(provider);
                let previous = entry
                    .readings
                    .iter()
                    .position(|reading| reading.provider == provider);
                let reading = match report {
                    Ok(report) => Reading {
                        provider,
                        report: Some(report),
                        error: None,
                        access: None,
                    },
                    Err(error) => {
                        entry.rate_limited |= matches!(error, crate::Error::UsageRateLimited);
                        let access = match error {
                            crate::Error::UsageKeychainAccess => Some(Access::Needed),
                            crate::Error::UsageKeychainDenied => Some(Access::Denied),
                            _ => None,
                        };
                        if access == Some(Access::Denied) {
                            self.denied.push(provider);
                        }
                        Reading {
                            provider,
                            report: previous.and_then(|index| entry.readings[index].report.clone()),
                            error: Some(error.to_string()),
                            access,
                        }
                    }
                };
                match previous {
                    Some(index) => entry.readings[index] = reading,
                    None => {
                        entry.readings.push(reading);
                        entry
                            .readings
                            .sort_by_key(|reading| registry::position(reading.provider));
                    }
                }
            }
            Message::Done(host, result) => {
                if self.busy.as_ref() == Some(&host) {
                    self.busy = None;
                }
                let Some(entry) = self.entries.get_mut(&host) else {
                    return;
                };
                match result {
                    Ok(()) => {
                        let heard = std::mem::take(&mut entry.round);
                        // A provider that stopped answering has been signed out.
                        entry
                            .readings
                            .retain(|reading| heard.contains(&reading.provider));
                        entry.error = None;
                        entry.updated = Some(SystemTime::now());
                        entry.due = Some(
                            now + if entry.rate_limited {
                                RATE_LIMITED
                            } else {
                                REFRESH
                            },
                        );
                    }
                    Err(error) => {
                        entry.round.clear();
                        entry.error = Some(error.to_string());
                        entry.due = Some(now + ERROR_BACKOFF);
                    }
                }
            }
        }
    }
}

fn spawn() -> Option<Worker> {
    let (requests, incoming) = mpsc::sync_channel::<Job>(1);
    let (outgoing, results) = mpsc::sync_channel(256);
    let spawned = thread::Builder::new()
        .name("herdr-usage".into())
        .spawn(move || {
            // Browser cookie keys are kept for the worker's life, so a
            // browser asks for Keychain access once.
            let mut cookies = CookieJar::default();
            for job in incoming {
                for provider in &job.retry {
                    cookies.forgive(*provider);
                }
                let host = job.host;
                let done = read(
                    &host,
                    &job.config,
                    &job.granted,
                    &mut cookies,
                    |provider, report| {
                        outgoing
                            .send(Message::Reading(host.clone(), provider, report))
                            .is_ok()
                    },
                );
                if outgoing.send(Message::Done(host, done)).is_err() {
                    break;
                }
            }
        });
    match spawned {
        Ok(_) => Some(Worker { requests, results }),
        Err(error) => {
            tracing::warn!(category = "usage", %error, "could not start the usage worker");
            None
        }
    }
}

/// Reads every provider on `host`, reporting each through `report` as it
/// answers. A provider the config lists but the host has no sign-in for
/// answers with what to set up, or that it waits on Keychain access.
fn read(
    host: &Host,
    config: &UsageConfig,
    granted: &HashSet<Provider>,
    cookies: &mut CookieJar,
    mut report: impl FnMut(Provider, crate::Result<Report>) -> bool,
) -> crate::Result<()> {
    let mut exec = match host {
        Host::Local => Exec::Local,
        Host::Ssh(target) => Exec::Remote(Shell::connect(target)?),
        Host::Wsl(_) => return Err(crate::Error::WslHostUnsupported),
    };
    for provider in registry::all() {
        if config.hidden(provider) {
            continue;
        }
        let requested = config.shown(provider);
        let consent = match (
            requested,
            granted.contains(&provider),
            config.browser_cookies,
        ) {
            (false, _, _) => Consent::Quiet,
            (true, false, browsers) => Consent::Ask { browsers },
            (true, true, false) => Consent::Keychain,
            (true, true, true) => Consent::Browsers,
        };
        let mut probe = Probe::new(
            &mut exec,
            provider,
            config.settings(provider),
            cookies,
            consent,
        );
        let answer = match provider.service().fetch(&mut probe) {
            Some(answer) => answer,
            None if requested => Err(probe.missing()),
            None => continue,
        };
        if !report(provider, answer) {
            break;
        }
    }
    Ok(())
}
