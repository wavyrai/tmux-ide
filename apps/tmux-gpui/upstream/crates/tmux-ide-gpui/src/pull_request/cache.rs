//! Bounded, per-checkout PR cache with refresh and error backoff. Entries are
//! capped in number so a long session cannot grow it without limit.

use super::{Input, Lookup, Origin, PullRequest};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) const CACHE_LIMIT: usize = 128;
pub(super) const REFRESH: Duration = Duration::from_secs(90);
pub(super) const ERROR_BACKOFF: Duration = Duration::from_secs(300);

pub(super) struct Entry {
    pub(super) input: Input,
    pub(super) value: Option<PullRequest>,
    pub(super) message: Option<String>,
    pub(super) checked: Instant,
    pub(super) due: Instant,
    pub(super) used: Instant,
}

/// The scope includes selection epoch, connection generation and daemon boot.
/// Token allocation identity is an additional auth generation, never token text.
#[derive(Default)]
pub(crate) struct Cache {
    pub(super) lookup: Lookup,
    pub(super) entries: Vec<Entry>,
    pub(super) queue: std::collections::VecDeque<Input>,
    pub(super) active: Option<Input>,
    pub(super) scope: Option<(u64, u64, String)>,
    pub(super) token: Option<Arc<secrecy::SecretString>>,
    pub(super) origin: Origin,
    pub(super) next_scan: Option<Instant>,
    pub(super) paused_until: Option<Instant>,
    pub cursor: usize,
}

impl Cache {
    #[cfg(any(test, all(feature = "integration-test", target_os = "macos")))]
    pub fn seed(&mut self, input: Input, value: PullRequest, now: Instant) {
        self.entries.retain(|entry| entry.input != input);
        if self.entries.len() == CACHE_LIMIT {
            self.entries.remove(0);
        }
        self.entries.push(Entry {
            input,
            value: Some(value),
            message: None,
            checked: now,
            due: now + REFRESH,
            used: now,
        });
    }

    pub fn clear(&mut self) {
        self.lookup.clear();
        self.entries.clear();
        self.queue.clear();
        self.active = None;
        self.scope = None;
        self.token = None;
        self.origin = Origin::Local;
        self.next_scan = None;
        self.paused_until = None;
        self.cursor = 0;
    }

    /// A different device, daemon boot, account, or origin starts over.
    pub fn scope(
        &mut self,
        scope: (u64, u64, String),
        token: Arc<secrecy::SecretString>,
        origin: Origin,
    ) {
        if self.scope.as_ref() != Some(&scope)
            || self.origin != origin
            || self
                .token
                .as_ref()
                .is_none_or(|old| !Arc::ptr_eq(old, &token))
        {
            self.clear();
            self.scope = Some(scope);
            self.token = Some(token);
            self.origin = origin;
        }
    }

    pub fn retain(&mut self, current: impl Fn(&Input) -> bool) {
        self.entries.retain(|entry| current(&entry.input));
        self.queue.retain(&current);
        if self.active.as_ref().is_some_and(|input| !current(input)) {
            self.lookup.clear();
            self.active = None;
        }
    }

    pub fn scan_due(&self, now: Instant) -> bool {
        self.next_scan.is_none_or(|next| now >= next)
    }

    /// Request fresh details without discarding the visible value or interrupting
    /// an in-flight lookup. The poll task still owns dispatch and account backoff.
    pub fn refresh(&mut self, input: Input, now: Instant) {
        if self.active.as_ref() == Some(&input) {
            return;
        }
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.input == input) {
            entry.due = now;
        }
        self.queue.retain(|queued| queued != &input);
        self.queue.truncate(CACHE_LIMIT - 1);
        self.queue.push_front(input);
        // Let the next poll dispatch this priority request before a routine scan
        // replaces the queue with the snapshot's round-robin order.
        self.next_scan = Some(now + Duration::from_secs(1));
    }

    pub fn schedule(&mut self, inputs: impl IntoIterator<Item = Input>, now: Instant) {
        self.next_scan = Some(now + Duration::from_secs(1));
        // Replace queued metadata, not an unbounded history of snapshot changes.
        self.queue.clear();
        for input in inputs {
            if self.queue.len() == CACHE_LIMIT {
                break;
            }
            if self.active.as_ref() != Some(&input)
                && !self.queue.contains(&input)
                && self
                    .entries
                    .iter()
                    .find(|entry| entry.input == input)
                    .is_none_or(|entry| now >= entry.due)
            {
                self.queue.push_back(input);
            }
        }
    }

    pub fn poll(&mut self, now: Instant) -> bool {
        let mut changed = self.lookup.poll();
        if !self.lookup.loading
            && let Some(input) = self.active.take()
        {
            let failed = self.lookup.message.is_some();
            // Rate/auth failures pause the account; a bad local repo must not
            // prevent the remaining workspaces from being prefetched.
            if let Some(cooldown) = self.lookup.cooldown.take() {
                self.paused_until = Some(now + cooldown);
            }
            if let Some(entry) = self.entries.iter_mut().find(|entry| entry.input == input) {
                if !failed {
                    entry.value = self.lookup.value.take();
                }
                entry.message = self.lookup.message.take();
                entry.checked = now;
                entry.due = now + if failed { ERROR_BACKOFF } else { REFRESH };
            } else {
                if self.entries.len() == CACHE_LIMIT
                    && let Some((index, _)) = self
                        .entries
                        .iter()
                        .enumerate()
                        .filter(|(_, e)| now >= e.due)
                        .min_by_key(|(_, e)| e.used)
                {
                    self.entries.remove(index);
                }
                self.entries.push(Entry {
                    input,
                    value: self.lookup.value.take(),
                    message: self.lookup.message.take(),
                    checked: now,
                    due: now + if failed { ERROR_BACKOFF } else { REFRESH },
                    used: now,
                });
            }
            changed = true;
        }
        if self.active.is_none()
            && self.paused_until.is_none_or(|until| now >= until)
            && let Some(token) = &self.token
        {
            while let Some(input) = self.queue.pop_front() {
                let existing = self.entries.iter().find(|entry| entry.input == input);
                if existing.is_some_and(|entry| now < entry.due)
                    || (existing.is_none()
                        && self.entries.len() == CACHE_LIMIT
                        && self.entries.iter().all(|entry| now < entry.due))
                {
                    continue;
                }
                self.lookup.clear();
                self.lookup
                    .request(input.clone(), self.origin.clone(), token.clone());
                self.active = Some(input);
                self.cursor = self.cursor.wrapping_add(1);
                self.lookup.poll();
                changed = true;
                break;
            }
        }
        changed
    }

    /// Whether a lookup for `input` is in flight or queued to dispatch, so the
    /// chrome can say it is waiting on GitHub. A paused account is not loading.
    pub fn loading(&self, input: &Input, now: Instant) -> bool {
        self.active.as_ref() == Some(input)
            || (self.token.is_some()
                && self.paused_until.is_none_or(|until| now >= until)
                && self.queue.contains(input))
    }

    /// Pure cache read for chrome painted every frame: never schedules work and
    /// never reorders the cache, so rendering cannot start a request.
    pub fn peek(&self, repo_key: &str, branch: &str) -> Option<&PullRequest> {
        self.entries
            .iter()
            .find(|entry| {
                entry.input.checkout.is_none()
                    && entry.input.repo_key.as_deref() == Some(repo_key)
                    && entry.input.branch == branch
            })
            .and_then(|entry| entry.value.as_ref())
    }

    /// Pure cache read: opening a menu cannot launch Git, HTTPS or daemon requests.
    pub fn present(&mut self, input: &Input, view: &mut Lookup, now: Instant) {
        view.clear();
        if let Some(entry) = self.entries.iter_mut().find(|entry| &entry.input == input) {
            entry.used = now;
            view.value = entry.value.clone();
            view.message = entry.message.clone();
            view.checked = Some(entry.checked);
        } else {
            if self.paused_until.is_some_and(|until| now < until) {
                view.message = Some("GitHub requests paused after an authentication or rate-limit error; retrying automatically.".into());
            } else {
                view.loading = true;
            }
        }
        if view.value.is_some() && view.message.is_some() {
            view.message = Some("Refresh unavailable; retrying automatically.".into());
        }
    }
}
