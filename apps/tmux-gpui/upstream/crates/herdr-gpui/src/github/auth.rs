//! The window's GitHub session: what is stored, what is in flight, and what a
//! worker thread has finished. Work runs off the UI thread and lands through
//! a single mailbox, so a late reply from a superseded flow is discarded.

#[cfg(any(test, feature = "integration-test"))]
use super::VERIFY_URL;
use super::{
    Account, Device, Profile, Reply, Result, SETUP_MESSAGE, Store, http::oauth, log, profile, save,
    token_reply,
};
use crate::Error;
use secrecy::{ExposeSecret, SecretString};
use std::{
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

pub(super) struct Flow {
    pub(super) copied_until: Option<Instant>,
    pub(super) client: String,
    pub(super) device: Arc<Device>,
    pub(super) interval: u64,
    pub(super) deadline: Instant,
    pub(super) next: Instant,
}

const SESSION_CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub(crate) struct Auth {
    pub(super) flow: Option<Flow>,
    pub(super) incoming: Option<mpsc::Receiver<Result<Reply>>>,
    pub(super) cancelled: bool,
    pub(super) committing: bool,
    pub(super) signout_pending: bool,
    pub(super) initialized: bool,
    pub(super) signed_out: bool,
    pub(super) reload_pending: bool,
    pub(super) store: Store,
    pub(super) account: Account,
    pub(super) profile_incoming: Option<mpsc::Receiver<Result<Option<Profile>>>>,
    pub(super) next_session_check: Option<Instant>,
    pub profile: Option<Profile>,
    pub message: Option<String>,
    pub failed: bool,
    pub(super) credential_cleanup: bool,
}

impl Auth {
    /// A saved host's own sign-in. It starts empty; `initialize` loads it.
    pub(crate) fn for_account(account: Account) -> Self {
        Self {
            account,
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub(crate) fn complete_profile_fixture(&mut self, result: Result<Option<Profile>>) {
        let (tx, rx) = mpsc::sync_channel(1);
        let _ = tx.send(result);
        self.profile_incoming = Some(rx);
    }

    #[cfg(any(test, feature = "integration-test"))]
    pub(crate) fn connected_fixture() -> Self {
        Self {
            initialized: true,
            profile: Some(Profile {
                login: "fixture-user".into(),
                avatar: None,
                token: Arc::new("fixture-token".into()),
                avatar_updates: None,
            }),
            ..Self::default()
        }
    }
    pub fn connected(&self) -> bool {
        self.profile.is_some()
    }
    pub fn loading_profile(&self) -> bool {
        !self.signed_out && (self.reload_pending || self.profile_incoming.is_some())
    }
    pub fn initialize(&mut self, config: &crate::config::Config) -> bool {
        self.initialize_with(Store::select(config))
    }
    pub(super) fn initialize_with(&mut self, store: Store) -> bool {
        let changed = !self.initialized || self.store != store;
        self.store = store;
        self.initialized = true;
        if !changed || self.signed_out {
            return false;
        }
        self.profile = None;
        self.next_session_check = None;
        self.flow = None;
        self.cancelled = true;
        self.reload_pending = true;
        self.failed = false;
        // A host's first load is routine; the main account keeps its notice.
        self.message = (self.account == Account::Main)
            .then(|| "Checking GitHub account under the updated credential policy...".into());
        // Drain old workers before reloading, so rapid policy changes stay bounded.
        // Neither a late profile nor an accepted write can restore the old session.
        true
    }
    pub(super) fn load_profile_with(
        &mut self,
        token: Option<Arc<SecretString>>,
        load: impl FnOnce(Option<Arc<SecretString>>, Store) -> Result<Option<Profile>> + Send + 'static,
    ) {
        self.failed = false;
        let store = self.store;
        let (tx, rx) = mpsc::sync_channel(1);
        match thread::Builder::new()
            .name("herdr-github-profile".into())
            .spawn(move || {
                let _ = tx.send(load(token, store));
            }) {
            Ok(_) => self.profile_incoming = Some(rx),
            Err(error) => {
                tracing::error!(category = "github_worker", error_kind = ?error.kind(), "Could not start GitHub profile worker");
                self.failed = true;
                self.message = Some("Could not start GitHub profile worker.".into());
            }
        }
    }
    #[cfg(any(test, feature = "integration-test"))]
    pub(crate) fn fixture(waiting: bool) -> Self {
        let now = Instant::now();
        Self {
            flow: waiting.then(|| Flow {
                copied_until: None,
                client: "fixture".into(),
                device: Arc::new(Device {
                    device_code: "fixture".into(),
                    user_code: "ABCD-1234".into(),
                    verification_uri: VERIFY_URL.into(),
                    expires_in: 900,
                    interval: 900,
                }),
                interval: 900,
                deadline: now + Duration::from_secs(900),
                next: now + Duration::from_secs(900),
            }),
            message: Some(
                if waiting {
                    "Open GitHub and enter this code. Waiting for authorization..."
                } else {
                    SETUP_MESSAGE
                }
                .into(),
            ),
            ..Self::default()
        }
    }
    #[cfg(any(test, feature = "integration-test"))]
    pub(crate) fn requesting_fixture() -> Self {
        let (_, incoming) = mpsc::sync_channel(1);
        Self {
            incoming: Some(incoming),
            initialized: true,
            message: Some("Requesting GitHub sign-in code...".into()),
            ..Self::default()
        }
    }
    pub fn busy(&self) -> bool {
        self.incoming.is_some() || self.flow.is_some() || self.signout_pending
    }
    pub fn code(&self) -> Option<&str> {
        // The device user code is intentionally displayed, unlike access tokens.
        self.flow
            .as_ref()
            .filter(|f| Instant::now() < f.deadline)
            .map(|f| f.device.user_code.expose_secret())
    }
    pub fn can_sign_out(&self) -> bool {
        self.connected() || self.credential_cleanup
    }
    pub fn copied(&self) -> bool {
        self.flow.as_ref().is_some_and(|flow| {
            flow.copied_until
                .is_some_and(|until| Instant::now() < until)
        })
    }
    pub fn copy_code(&mut self) -> Option<&str> {
        let flow = self.flow.as_mut().filter(|f| Instant::now() < f.deadline)?;
        flow.copied_until = Some(Instant::now() + Duration::from_secs(3));
        Some(flow.device.user_code.expose_secret())
    }
    pub(super) fn launch(&mut self, work: impl FnOnce() -> Result<Reply> + Send + 'static) {
        let (tx, rx) = mpsc::sync_channel(1);
        match thread::Builder::new()
            .name("herdr-github-auth".into())
            .spawn(move || {
                let _ = tx.send(work());
            }) {
            Ok(_) => self.incoming = Some(rx),
            Err(error) => {
                tracing::error!(category = "github_worker", error_kind = ?error.kind(), "Could not start GitHub authentication worker");
                self.flow = None;
                self.committing = false;
                self.failed = true;
                self.message = Some("Could not start GitHub authentication worker.".into());
            }
        }
    }
    pub fn start(&mut self, config: &crate::config::Config) {
        if self.busy() || self.connected() || self.loading_profile() {
            return;
        }
        self.store = Store::select(config);
        self.initialized = true;
        self.failed = false;
        if self.store == Store::Environment {
            tracing::warn!(
                category = "github_signin",
                store = ?self.store,
                "No secure credential store is configured for GitHub sign-in"
            );
            self.failed = true;
            // The plaintext opt-in only exists where a private file can be kept
            // private, so platforms without one must not be told to set it.
            self.message = Some(if super::store::FILE {
                "No secure credential store configured. To accept unencrypted token storage, set [github] allow_plaintext_credentials = true and reload GUI config. Otherwise use GH_TOKEN / GITHUB_TOKEN.".into()
            } else {
                "No GitHub credential store is available on this platform. Sign in by setting GH_TOKEN or GITHUB_TOKEN.".into()
            });
            return;
        }
        let client = match config.github.client_id() {
            Ok(Some(client)) => client,
            Ok(None) => {
                tracing::info!(
                    category = "github_signin",
                    "No GitHub OAuth client ID is configured"
                );
                self.message = Some(SETUP_MESSAGE.into());
                return;
            }
            Err(error) => {
                log::failure("client_id", &error);
                self.failed = true;
                self.message = Some(error.to_string());
                return;
            }
        };
        self.cancelled = false;
        self.signed_out = false;
        self.profile_incoming = None;
        self.message = Some("Requesting GitHub sign-in code...".into());
        tracing::info!(
            category = "github_signin",
            store = ?self.store,
            "Requesting a GitHub device code"
        );
        self.launch(move || {
            let started = Instant::now();
            let device = oauth::<Device>(
                "device/code",
                // OAuth Apps use repo; GitHub Apps ignore scope and use their
                // registered permissions and installation repository access.
                &[("client_id", &client), ("scope", "repo")],
                Duration::from_secs(15),
            )?
            .validate()?;
            Ok(Reply::Device(device, client, started))
        });
    }
    pub fn cancel(&mut self) {
        // A token is persisted only after the UI accepts the completed flow. Once
        // accepted, Keychain writes finish off-thread even if the menu closes.
        if self.committing || self.signout_pending {
            return;
        }
        self.cancelled = true;
        self.failed = false;
        self.flow = None;
        self.message = Some("GitHub sign-in cancelled.".into());
    }
    pub fn sign_out(&mut self) {
        self.credential_cleanup = true;
        self.failed = false;
        self.initialized = true;
        self.signed_out = true;
        self.next_session_check = None;
        self.reload_pending = false;
        self.profile = None;
        self.flow = None;
        // A profile worker can rotate and persist credentials. Drain it before
        // deletion, just like an accepted sign-in write, but suppress its result.
        if !self.committing {
            self.incoming = None;
        }
        self.signout_pending = true;
        self.cancelled = false;
        self.message = Some("Signed out locally. Removing saved GitHub credential...".into());
    }
    pub fn poll(&mut self) -> bool {
        let store = self.store;
        let account = self.account.clone();
        self.poll_with_store(move |token| save(token, store, &account))
    }
    /// Credential backend chosen for this build and configuration.
    pub(crate) fn store(&self) -> Store {
        self.store
    }
    pub(super) fn poll_with_store(
        &mut self,
        persist: impl FnOnce(Option<&SecretString>) -> Result<()> + Send + 'static,
    ) -> bool {
        let account = self.account.clone();
        self.poll_with(persist, move |token, store| match token {
            Some(token) => profile(token).map(Some),
            None => super::store::load_profile(store, &account),
        })
    }
    pub(super) fn poll_with(
        &mut self,
        persist: impl FnOnce(Option<&SecretString>) -> Result<()> + Send + 'static,
        load: impl FnOnce(Option<Arc<SecretString>>, Store) -> Result<Option<Profile>> + Send + 'static,
    ) -> bool {
        self.poll_at(Instant::now(), persist, load)
    }

    pub(super) fn poll_at(
        &mut self,
        now: Instant,
        persist: impl FnOnce(Option<&SecretString>) -> Result<()> + Send + 'static,
        load: impl FnOnce(Option<Arc<SecretString>>, Store) -> Result<Option<Profile>> + Send + 'static,
    ) -> bool {
        if self.signout_pending && !self.committing && self.profile_incoming.is_none() {
            self.signout_pending = false;
            self.committing = true;
            self.launch(move || {
                persist(None)?;
                Ok(Reply::SignedOut)
            });
            return true;
        }
        if self.reload_pending && !self.busy() && self.profile_incoming.is_none() {
            self.reload_pending = false;
            self.cancelled = false;
            self.load_profile_with(None, load);
            return true;
        }
        if self.connected()
            && !self.signed_out
            && !self.busy()
            && self.profile_incoming.is_none()
            && self.next_session_check.is_some_and(|next| now >= next)
        {
            // Resolve the store again under its transaction lock: another window
            // may already have rotated the single-use refresh token or signed out.
            self.next_session_check = Some(now + SESSION_CHECK_INTERVAL);
            self.load_profile_with(None, load);
            return true;
        }
        let mut changed = false;
        if let Some(profile) = &mut self.profile
            && let Some(updates) = &profile.avatar_updates
        {
            match updates.try_recv() {
                Ok(image) => {
                    profile.avatar = Some(image);
                    profile.avatar_updates = None;
                    changed = true;
                }
                Err(mpsc::TryRecvError::Disconnected) => profile.avatar_updates = None,
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if let Some(rx) = &self.profile_incoming {
            let result = match rx.try_recv() {
                Ok(result) => Some(result),
                Err(mpsc::TryRecvError::Empty) => None,
                Err(mpsc::TryRecvError::Disconnected) => Some(Err(Error::GitHubWorker("profile"))),
            };
            if let Some(result) = result {
                self.profile_incoming = None;
                if !self.reload_pending && !self.signed_out {
                    self.next_session_check = Some(now + SESSION_CHECK_INTERVAL);
                    match result {
                        Ok(mut profile) => {
                            if let (Some(old), Some(new)) = (&self.profile, &mut profile)
                                && old.token.expose_secret() == new.token.expose_secret()
                            {
                                // PR caches use token identity to fence workers.
                                new.token = old.token.clone();
                            }
                            self.profile = profile;
                            self.failed = false;
                            self.message = None;
                        }
                        Err(error) => {
                            log::failure("profile", &error);
                            self.credential_cleanup = true;
                            if matches!(
                                error,
                                Error::GitHubAuthentication
                                    | Error::GitHubExpired
                                    | Error::GitHubDenied
                                    | Error::GitHubAuthorization
                            ) {
                                self.profile = None;
                            }
                            self.failed = true;
                            self.message = Some(error.to_string());
                        }
                    }
                }
                changed = true;
            }
        }
        if let Some(rx) = &self.incoming {
            let reply = match rx.try_recv() {
                Ok(reply) => Some(reply),
                Err(mpsc::TryRecvError::Empty) => None,
                Err(mpsc::TryRecvError::Disconnected) => {
                    Some(Err(Error::GitHubWorker("authentication")))
                }
            };
            if let Some(reply) = reply {
                self.incoming = None;
                changed = true;
                if self.signout_pending || self.reload_pending {
                    self.committing = false;
                    return true;
                }
                if !self.cancelled {
                    match reply {
                        Ok(Reply::Device(device, client, started)) => {
                            let now = Instant::now();
                            tracing::info!(
                                category = "github_signin",
                                expires_in = device.expires_in,
                                interval = device.interval,
                                "GitHub device code ready; waiting for authorization"
                            );
                            self.flow = Some(Flow {
                                copied_until: None,
                                client,
                                deadline: started + Duration::from_secs(device.expires_in),
                                next: now + Duration::from_secs(device.interval),
                                interval: device.interval,
                                device: Arc::new(device),
                            });
                            self.message = Some(
                                "Open GitHub and enter this code. Waiting for authorization..."
                                    .into(),
                            );
                        }
                        Ok(Reply::Pending(slow)) => {
                            if let Some(flow) = &mut self.flow {
                                if slow {
                                    flow.interval = flow.interval.saturating_add(5);
                                }
                                flow.next = Instant::now() + Duration::from_secs(flow.interval);
                            }
                        }
                        Ok(Reply::Token(token)) => {
                            if self
                                .flow
                                .as_ref()
                                .is_some_and(|f| Instant::now() < f.deadline)
                            {
                                self.committing = true;
                                self.credential_cleanup = true;
                                self.message = Some("Saving GitHub credential...".into());
                                tracing::info!(
                                    category = "github_signin",
                                    store = ?self.store,
                                    "GitHub authorized; saving the credential"
                                );
                                self.launch(move || {
                                    persist(Some(&token.encode()?))?;
                                    Ok(Reply::Authenticated(Arc::new(token.access_token)))
                                });
                            } else {
                                tracing::warn!(
                                    category = "github_signin",
                                    "GitHub authorized after the device code expired"
                                );
                                self.failed = true;
                                self.message = Some("GitHub code expired. Sign in again.".into());
                            }
                            self.flow = None;
                        }
                        Ok(Reply::SignedOut) => {
                            self.credential_cleanup = false;
                            self.committing = false;
                            self.message = Some(match self.account {
                                Account::Main => "Signed out for this app session. Saved credential removed. Environment tokens are suppressed until app restart; GitHub grants are not revoked.",
                                Account::Host(_) => "Signed out of this device's account. Saved credential removed; GitHub grants are not revoked. Pull requests here use your main account.",
                            }.into());
                        }
                        Ok(Reply::Authenticated(token)) => {
                            self.committing = false;
                            self.message = Some("Loading GitHub profile...".into());
                            self.load_profile_with(Some(token), load);
                        }
                        Err(error) => {
                            log::failure("authentication", &error);
                            self.flow = None;
                            self.committing = false;
                            self.failed = true;
                            self.message = Some(error.to_string());
                        }
                    }
                }
            }
        }
        if let Some(flow) = &mut self.flow
            && flow
                .copied_until
                .is_some_and(|until| Instant::now() >= until)
        {
            flow.copied_until = None;
            changed = true;
        }
        if self.incoming.is_none()
            && let Some(flow) = &self.flow
        {
            let now = Instant::now();
            if now >= flow.deadline {
                tracing::warn!(
                    category = "github_signin",
                    "GitHub device code expired before authorization"
                );
                self.flow = None;
                self.failed = true;
                self.message = Some("GitHub code expired. Sign in again.".into());
                return true;
            }
            if now >= flow.next {
                let client = flow.client.clone();
                // Share secret ownership with the in-flight worker, not plaintext.
                let device = Arc::clone(&flow.device);
                let timeout = (flow.deadline - now).min(Duration::from_secs(15));
                self.launch(move || {
                    token_reply(
                        oauth(
                            "oauth/access_token",
                            &[
                                ("client_id", &client),
                                ("device_code", device.device_code.expose_secret()),
                                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                            ],
                            timeout,
                        )?,
                        &client,
                    )
                });
            }
        }
        changed
    }
}
