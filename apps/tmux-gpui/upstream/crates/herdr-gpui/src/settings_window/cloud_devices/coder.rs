//! The Coder card of Settings > Cloud Devices. Its connection fields save to
//! `[coder]` in the local config; its OAuth client secret saves to the
//! credential store. Sign-in, status, and device removal run through
//! `cloud::worker`, never on the UI thread.

use super::{
    super::{Section, SettingsWindow},
    follow_config, input,
};
use crate::{
    cloud::{
        SavedDevice,
        worker::{self, Worker},
    },
    coder::{
        Settings,
        setup::{self, Overview, Session},
    },
    config::{CoderConfig, CoderFields, Config},
    github::Store,
    search_input::SearchInput,
};
use gpui::{prelude::*, *};
use secrecy::SecretString;

const SECRET_VARIABLE: &str = "HERDR_CODER_OAUTH_CLIENT_SECRET";

/// The editable `[coder]` keys, in display order, with their labels and hints.
const FIELDS: [(&str, &str); 6] = [
    ("Deployment URL", "https://coder.example.com"),
    ("OAuth client ID", "The OAuth2 app's client ID"),
    ("Redirect URI", "http://127.0.0.1:47823/callback"),
    (
        "Organization",
        "Optional; your default organization if empty",
    ),
    ("Workspace name prefix", "Optional; herdr if empty"),
    ("coder CLI", "Optional; found on PATH if empty"),
];

enum Update {
    Overview(crate::coder::Result<Overview>),
    Opened(String),
    SignedIn(crate::coder::Result<()>),
    Done(crate::coder::Result<()>),
}

/// The account line, while a job may be changing it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Account {
    Checking,
    Known(Session),
    SigningIn,
}

pub(in crate::settings_window) struct CoderCard {
    fields: [Entity<SearchInput>; 6],
    /// The config values the fields last loaded; see `follow_config`.
    loaded: CoderFields,
    secret: Entity<SearchInput>,
    account: Account,
    secret_saved: bool,
    devices: Vec<SavedDevice>,
    message: Option<String>,
    job: Option<Worker>,
}

impl CoderCard {
    fn new(
        config: &Config,
        theme: &crate::config::Theme,
        cx: &mut Context<SettingsWindow>,
    ) -> Self {
        let loaded = CoderFields::from_config(&config.coder);
        let texts = texts(&loaded);
        let fields =
            std::array::from_fn(|index| input(FIELDS[index].1, texts[index], config, theme, cx));
        let secret = input("", "", config, theme, cx);
        secret.update(cx, |input, cx| input.set_masked(true, cx));
        Self {
            fields,
            loaded,
            secret,
            account: Account::Checking,
            secret_saved: false,
            devices: Vec::new(),
            message: None,
            job: None,
        }
    }

    fn values(&self, cx: &App) -> CoderFields {
        let text = |index: usize| self.fields[index].read(cx).text().trim().to_owned();
        CoderFields {
            url: text(0),
            oauth_client_id: text(1),
            oauth_redirect_uri: text(2),
            organization: text(3),
            workspace_prefix: text(4),
            cli: text(5),
        }
    }
}

/// The editable values in `FIELDS` order.
fn texts(values: &CoderFields) -> [&str; 6] {
    [
        &values.url,
        &values.oauth_client_id,
        &values.oauth_redirect_uri,
        &values.organization,
        &values.workspace_prefix,
        &values.cli,
    ]
}

/// Where the client secret in use comes from, before Settings' own store.
fn configured_secret(config: &CoderConfig) -> Option<&'static str> {
    if std::env::var_os(SECRET_VARIABLE).is_some() {
        Some("Set by HERDR_CODER_OAUTH_CLIENT_SECRET, which takes precedence.")
    } else if config.oauth_client_secret.is_some() {
        Some("Set by [coder] oauth_client_secret in the config file, which takes precedence.")
    } else {
        None
    }
}

impl SettingsWindow {
    /// Build the section on first view, then refresh what it reads from disk
    /// and the deployment.
    pub(super) fn open_coder_card(&mut self, cx: &mut Context<Self>) {
        if self.coder_card.is_none() {
            self.coder_card = Some(CoderCard::new(&self.config, &self.theme, cx));
        }
        self.refresh_cloud(cx);
    }

    fn coder_settings(&self) -> Option<Settings> {
        self.config.coder.settings().ok().flatten()
    }

    fn cloud_job(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(&dyn Fn() -> bool, &dyn Fn(Update)) + Send + 'static,
    ) {
        let Some(cloud) = &mut self.coder_card else {
            return;
        };
        cloud.job = None;
        match worker::spawn(
            "herdr-coder-settings",
            cx,
            work,
            |this: &mut Self, update, cx| this.apply_cloud(update, cx),
        ) {
            Ok(job) => {
                if let Some(cloud) = &mut self.coder_card {
                    cloud.job = Some(job);
                }
            }
            Err(error) => {
                tracing::error!(category = "coder_worker", error_kind = ?error.kind(), "Could not start Coder settings worker");
                if let Some(cloud) = &mut self.coder_card {
                    cloud.message = Some(crate::coder::Error::Worker("settings").to_string());
                }
            }
        }
    }

    fn refresh_cloud(&mut self, cx: &mut Context<Self>) {
        let Some(settings) = self.coder_settings() else {
            if let Some(cloud) = &mut self.coder_card {
                cloud.job = None;
                cloud.account = Account::Known(Session::SignedOut);
                cloud.devices.clear();
                cloud.secret_saved = false;
            }
            return;
        };
        if let Some(cloud) = &mut self.coder_card {
            cloud.account = Account::Checking;
        }
        self.cloud_job(cx, move |_, send| {
            send(Update::Overview(setup::overview(&settings)));
        });
    }

    fn apply_cloud(&mut self, update: Update, cx: &mut Context<Self>) {
        let mut refresh = false;
        let Some(cloud) = &mut self.coder_card else {
            return;
        };
        match update {
            Update::Overview(Ok(overview)) => {
                cloud.account = Account::Known(overview.session);
                cloud.secret_saved = overview.secret_saved;
                cloud.devices = overview.devices;
            }
            Update::Overview(Err(error)) => {
                cloud.account = Account::Known(Session::SignedOut);
                cloud.message = Some(error.to_string());
            }
            Update::Opened(url) => {
                cloud.message = Some("Finish signing in in your browser…".into());
                cx.open_url(&url);
            }
            Update::SignedIn(result) | Update::Done(result) => {
                cloud.message = result.err().map(|error| error.to_string());
                refresh = true;
            }
        }
        if refresh {
            self.refresh_cloud(cx);
        }
    }

    fn save_cloud(&mut self, cx: &mut Context<Self>) {
        let Some(cloud) = &mut self.coder_card else {
            return;
        };
        let values = cloud.values(cx);
        let existing = self.config.coder.clone();
        let secret = cloud.secret.read(cx).text().trim().to_owned();
        let secret = (!secret.is_empty()).then(|| SecretString::from(secret));
        let store = Store::for_policy(existing.allow_plaintext_credentials);
        cloud.secret.update(cx, SearchInput::clear);
        cloud.message = None;
        // Reloading the saved config refreshes the account line through `config_changed`.
        self.save_native(
            move || {
                Config::save_coder(&values, &existing)?;
                if let Some(secret) = &secret {
                    setup::save_client_secret(store, Some(secret))?;
                }
                Ok(())
            },
            cx,
        );
    }

    fn clear_cloud_secret(&mut self, cx: &mut Context<Self>) {
        let store = Store::for_policy(self.config.coder.allow_plaintext_credentials);
        self.cloud_job(cx, move |_, send| {
            send(Update::Done(setup::save_client_secret(store, None)));
        });
    }

    fn cloud_sign_in(&mut self, cx: &mut Context<Self>) {
        let Some(settings) = self.coder_settings() else {
            return;
        };
        if let Some(cloud) = &mut self.coder_card {
            cloud.account = Account::SigningIn;
            cloud.message = None;
        }
        self.cloud_job(cx, move |cancelled, send| {
            let result = setup::begin_sign_in(&settings).and_then(|pending| {
                send(Update::Opened(pending.url.clone()));
                setup::finish_sign_in(&settings, pending, cancelled).map(drop)
            });
            send(Update::SignedIn(result));
        });
    }

    fn cloud_sign_out(&mut self, cx: &mut Context<Self>) {
        let Some(settings) = self.coder_settings() else {
            return;
        };
        self.cloud_job(cx, move |_, send| {
            send(Update::Done(setup::sign_out(&settings)));
        });
    }

    fn cloud_forget(&mut self, id: String, cx: &mut Context<Self>) {
        self.cloud_job(cx, move |_, send| {
            send(Update::Done(setup::forget_device(&id)));
        });
    }

    /// Called after the config file reloads, or a cloud job may have saved a
    /// device, so the account line and device list follow. Reading the card
    /// again replaces its job, which would cancel a sign-in waiting on the
    /// browser; that sign-in reads the card again itself when it finishes.
    pub(super) fn coder_config_changed(&mut self, cx: &mut Context<Self>) {
        let Some(card) = &mut self.coder_card else {
            return;
        };
        let loaded = CoderFields::from_config(&self.config.coder);
        follow_config(&card.fields, texts(&card.loaded), texts(&loaded), cx);
        card.loaded = loaded;
        if card.account != Account::SigningIn && self.section == Section::CloudDevices {
            self.refresh_cloud(cx);
        }
    }

    pub(super) fn render_coder_card(&self, cx: &mut Context<Self>) -> Div {
        let Some(cloud) = &self.coder_card else {
            return div();
        };
        let theme = &self.theme;
        let ready = !self.busy();
        let configured = self.coder_settings().is_some();
        let (account, action) = match &cloud.account {
            _ if !configured => (
                "Not configured. Enter the deployment and its OAuth app, then save.".to_owned(),
                None,
            ),
            Account::Checking => ("Checking…".to_owned(), None),
            Account::SigningIn => ("Waiting for the browser…".to_owned(), None),
            Account::Known(Session::SignedOut) => ("Not signed in".to_owned(), Some(true)),
            Account::Known(Session::SignedIn { user }) => {
                (format!("Signed in as {user}"), Some(false))
            }
            Account::Known(Session::Unreadable { reason }) => (
                format!("Signed in; the account could not be read: {reason}"),
                Some(false),
            ),
        };
        let secret_note = configured_secret(&self.config.coder)
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if cloud.secret_saved {
                    "Saved. Type a new secret to replace it.".into()
                } else {
                    "Not saved yet. Coder requires it to sign in.".into()
                }
            });
        let mut card = self
            .control_card("Coder")
            .debug_selector(|| "cloud-coder-card".into())
            .child(self.control_note(
                "Create Coder workspaces from the device picker and use them as devices. Register an OAuth2 app in Coder with the redirect URI below; the deployment must enable the oauth2 experiment.",
            ))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child(div().min_w_0().child(account))
                    .when_some(action, |row, sign_in| {
                        // Only a settled account line offers an action.
                        let enabled = ready && matches!(cloud.account, Account::Known(_));
                        row.child(if sign_in {
                            self.cloud_button("cloud-coder-sign-in", "Sign in", enabled)
                                .debug_selector(|| "cloud-coder-sign-in".into())
                                .when(enabled, |button| {
                                    button.on_click(cx.listener(|this, _, _, cx| this.cloud_sign_in(cx)))
                                })
                        } else {
                            self.cloud_button("cloud-coder-sign-out", "Sign out", enabled)
                                .debug_selector(|| "cloud-coder-sign-out".into())
                                .when(enabled, |button| {
                                    button.on_click(cx.listener(|this, _, _, cx| this.cloud_sign_out(cx)))
                                })
                        })
                    }),
            );
        for (index, (label, _)) in FIELDS.iter().enumerate() {
            card = card.child(self.cloud_field(label, cloud.fields[index].clone().into()));
            if index == 1 {
                card = card
                    .child(self.cloud_field("OAuth client secret", cloud.secret.clone().into()))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .child(self.control_note(secret_note.clone()))
                            .when(cloud.secret_saved, |row| {
                                row.child(
                                    self.cloud_button(
                                        "cloud-coder-clear-secret",
                                        "Forget secret",
                                        ready,
                                    )
                                    .when(ready, |button| {
                                        button.on_click(
                                            cx.listener(|this, _, _, cx| {
                                                this.clear_cloud_secret(cx)
                                            }),
                                        )
                                    }),
                                )
                            }),
                    );
            }
        }
        card = card.child(
            div().flex().justify_end().child(
                self.cloud_button("cloud-coder-save", "Save", ready)
                    .debug_selector(|| "cloud-coder-save".into())
                    .when(ready, |button| {
                        button.on_click(cx.listener(|this, _, _, cx| this.save_cloud(cx)))
                    }),
            ),
        );
        if let Some(message) = &cloud.message {
            card = card.child(
                div()
                    .text_color(crate::menu::danger(theme))
                    .child(message.clone()),
            );
        }
        let mut devices = self
            .control_card("Coder devices")
            .debug_selector(|| "cloud-coder-devices".into());
        if cloud.devices.is_empty() {
            devices =
                devices.child(self.control_note(
                    "None yet. Add one with Add Coder Workspace… in the device picker.",
                ));
        }
        for (index, device) in cloud.devices.iter().enumerate() {
            devices = devices.child(self.cloud_device_row(
                crate::cloud::CloudProvider::Coder,
                index,
                device,
                ready,
                Self::cloud_forget,
                cx,
            ));
        }
        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .min_w_0()
            .child(card)
            .child(devices)
    }
}

#[cfg(test)]
mod tests;
