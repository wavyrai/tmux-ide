//! The Daytona tab of Settings > Cloud Devices. Its account fields save to
//! `[daytona]` in the local config; its API key saves to the credential store.
//! Creating a sandbox hands a job to the main window, which shows progress in
//! the device picker and a toast when it is ready. Account reads and removals
//! run through `cloud::worker`, never on the UI thread.

use super::{
    super::{Section, SettingsWindow},
    follow_config, input,
};
use crate::{
    cloud::{
        CloudProvider, SavedDevice,
        worker::{self, Worker},
    },
    config::{Config, DaytonaFields},
    daytona::{
        Settings,
        setup::{self, AddRequest, Key, Overview},
    },
    github::Store,
    search_input::SearchInput,
};
use gpui::{prelude::*, *};
use secrecy::SecretString;

/// The editable `[daytona]` keys, in display order, with their labels and hints.
const FIELDS: [(&str, &str); 4] = [
    ("API URL", crate::daytona::DEFAULT_API_URL),
    (
        "Organization ID",
        "Optional; the key's default organization if empty",
    ),
    ("Region", "Optional; Daytona's default region if empty"),
    ("Snapshot", "Optional; Daytona's default snapshot if empty"),
];

enum Update {
    Overview(crate::daytona::Result<Overview>),
    Done(crate::daytona::Result<()>),
}

/// The account line, while a job may be changing it.
enum Account {
    Checking,
    Known(Overview),
}

pub(in crate::settings_window) struct DaytonaCard {
    fields: [Entity<SearchInput>; 4],
    /// The config values the fields last loaded; see `follow_config`.
    loaded: DaytonaFields,
    key: Entity<SearchInput>,
    account: Account,
    /// The user's approval to install Herdr in sandboxes created from here.
    install: bool,
    message: Option<String>,
    job: Option<Worker>,
}

impl DaytonaCard {
    fn new(
        config: &Config,
        theme: &crate::config::Theme,
        cx: &mut Context<SettingsWindow>,
    ) -> Self {
        let loaded = loaded(config);
        let texts = texts(&loaded);
        let fields =
            std::array::from_fn(|index| input(FIELDS[index].1, texts[index], config, theme, cx));
        let key = input("dtn_…", "", config, theme, cx);
        key.update(cx, |input, cx| input.set_masked(true, cx));
        Self {
            fields,
            loaded,
            key,
            account: Account::Checking,
            install: true,
            message: None,
            job: None,
        }
    }

    fn values(&self, cx: &App) -> DaytonaFields {
        let text = |index: usize| self.fields[index].read(cx).text().trim().to_owned();
        DaytonaFields {
            api_url: text(0),
            organization_id: text(1),
            target: text(2),
            snapshot: text(3),
        }
    }

    fn devices(&self) -> &[SavedDevice] {
        match &self.account {
            Account::Known(overview) => &overview.devices,
            Account::Checking => &[],
        }
    }
}

/// The values the fields show for `config`. Daytona's own cloud is the usual
/// account, so an unset API URL shows it; saving it sets Daytona up.
fn loaded(config: &Config) -> DaytonaFields {
    let mut values = DaytonaFields::from_config(&config.daytona);
    if values.api_url.is_empty() {
        values.api_url = crate::daytona::DEFAULT_API_URL.into();
    }
    values
}

/// The editable values in `FIELDS` order.
fn texts(values: &DaytonaFields) -> [&str; 4] {
    [
        &values.api_url,
        &values.organization_id,
        &values.target,
        &values.snapshot,
    ]
}

impl SettingsWindow {
    pub(super) fn open_daytona_card(&mut self, cx: &mut Context<Self>) {
        if self.daytona_card.is_none() {
            self.daytona_card = Some(DaytonaCard::new(&self.config, &self.theme, cx));
        }
        self.refresh_daytona(cx);
    }

    fn daytona_settings(&self) -> Option<Settings> {
        self.config.daytona.settings().ok().flatten()
    }

    fn daytona_job(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(&dyn Fn() -> bool, &dyn Fn(Update)) + Send + 'static,
    ) {
        let Some(card) = &mut self.daytona_card else {
            return;
        };
        card.job = None;
        match worker::spawn(
            "herdr-daytona-settings",
            cx,
            work,
            |this: &mut Self, update, cx| this.apply_daytona(update, cx),
        ) {
            Ok(job) => {
                if let Some(card) = &mut self.daytona_card {
                    card.job = Some(job);
                }
            }
            Err(error) => {
                tracing::error!(category = "daytona_worker", error_kind = ?error.kind(), "Could not start Daytona settings worker");
                if let Some(card) = &mut self.daytona_card {
                    card.message = Some(crate::cloud::Error::Worker("settings").to_string());
                }
            }
        }
    }

    fn refresh_daytona(&mut self, cx: &mut Context<Self>) {
        let Some(settings) = self.daytona_settings() else {
            if let Some(card) = &mut self.daytona_card {
                card.job = None;
                card.account = Account::Known(Overview {
                    key: Key::Missing,
                    sandboxes: None,
                    devices: Vec::new(),
                });
            }
            return;
        };
        if let Some(card) = &mut self.daytona_card {
            card.account = Account::Checking;
        }
        self.daytona_job(cx, move |_, send| {
            send(Update::Overview(setup::overview(&settings)));
        });
    }

    fn apply_daytona(&mut self, update: Update, cx: &mut Context<Self>) {
        let Some(card) = &mut self.daytona_card else {
            return;
        };
        match update {
            Update::Overview(Ok(overview)) => card.account = Account::Known(overview),
            Update::Overview(Err(error)) => {
                card.account = Account::Known(Overview {
                    key: Key::Missing,
                    sandboxes: None,
                    devices: Vec::new(),
                });
                card.message = Some(error.to_string());
            }
            Update::Done(result) => {
                card.message = result.err().map(|error| error.to_string());
                self.refresh_daytona(cx);
            }
        }
    }

    fn save_daytona(&mut self, cx: &mut Context<Self>) {
        let Some(card) = &mut self.daytona_card else {
            return;
        };
        let values = card.values(cx);
        let existing = self.config.daytona.clone();
        let key = card.key.read(cx).text().trim().to_owned();
        let key = (!key.is_empty()).then(|| SecretString::from(key));
        let store = Store::for_policy(existing.allow_plaintext_credentials);
        card.key.update(cx, SearchInput::clear);
        card.message = None;
        // Reloading the saved config refreshes the account line.
        self.save_native(
            move || {
                Config::save_daytona(&values, &existing)?;
                if let Some(key) = &key {
                    setup::save_key(store, Some(key))?;
                }
                Ok(())
            },
            cx,
        );
    }

    fn forget_daytona_key(&mut self, cx: &mut Context<Self>) {
        let store = Store::for_policy(self.config.daytona.allow_plaintext_credentials);
        self.daytona_job(cx, move |_, send| {
            send(Update::Done(setup::save_key(store, None)));
        });
    }

    fn forget_daytona_device(&mut self, id: String, cx: &mut Context<Self>) {
        self.daytona_job(cx, move |_, send| {
            send(Update::Done(setup::forget_device(&id)));
        });
    }

    /// Hand a new sandbox to the main window, which runs and reports the job
    /// so it survives this window closing.
    fn create_daytona_sandbox(&mut self, cx: &mut Context<Self>) {
        let Some(settings) = self.daytona_settings() else {
            return;
        };
        let Some(card) = &mut self.daytona_card else {
            return;
        };
        let name = setup::random_name();
        let request = AddRequest {
            settings,
            name: name.clone(),
            install: card.install,
        };
        let started = self.source.update(cx, |window, cx| {
            window.start_cloud_job(
                CloudProvider::Daytona,
                name.clone(),
                move |cancelled, report| setup::add_device(request, cancelled, report),
                cx,
            )
        });
        if let Some(card) = &mut self.daytona_card {
            card.message = Some(match started {
                Ok(Ok(())) => {
                    format!("Creating {name}. The device picker shows its progress.")
                }
                Ok(Err(error)) => error.to_string(),
                Err(_) => "Open a main Herdr window to create a sandbox.".into(),
            });
        }
        cx.notify();
    }

    pub(super) fn daytona_config_changed(&mut self, cx: &mut Context<Self>) {
        if let Some(card) = &mut self.daytona_card {
            let loaded = loaded(&self.config);
            follow_config(&card.fields, texts(&card.loaded), texts(&loaded), cx);
            card.loaded = loaded;
        }
        if self.daytona_card.is_some() && self.section == Section::CloudDevices {
            self.refresh_daytona(cx);
        }
    }

    pub(super) fn render_daytona_card(&self, cx: &mut Context<Self>) -> Div {
        let Some(card) = &self.daytona_card else {
            return div();
        };
        let ready = !self.busy();
        let configured = self.daytona_settings().is_some();
        let (status, key) = match &card.account {
            _ if !configured => (
                "Not configured. Check the API URL, add an API key, then save.".to_owned(),
                Key::Missing,
            ),
            Account::Checking => ("Checking…".to_owned(), Key::Missing),
            Account::Known(overview) => (
                match (&overview.key, &overview.sandboxes) {
                    (Key::Missing, _) => "No API key saved.".to_owned(),
                    (_, Some(Ok(count))) => format!(
                        "Connected. The key sees {count} sandbox{}.",
                        if *count == 1 { "" } else { "es" }
                    ),
                    (_, Some(Err(error))) => format!("The API key could not be used: {error}"),
                    (_, None) => "Checking…".to_owned(),
                },
                overview.key,
            ),
        };
        let usable = matches!(&card.account, Account::Known(overview)
            if matches!(overview.sandboxes, Some(Ok(_))));
        let key_note = match key {
            Key::Environment => "Set by HERDR_DAYTONA_API_KEY, which takes precedence.",
            Key::Saved => "Saved. Type a new key to replace it.",
            Key::Missing => "Not saved yet. Create one in the Daytona dashboard under API Keys.",
        };
        let mut account = self
            .control_card("Daytona")
            .debug_selector(|| "cloud-daytona-card".into())
            .child(self.control_note(
                "Create Daytona sandboxes and use them as devices. Herdr reaches each one through Daytona's SSH gateway with a short-lived token; the API key never leaves this computer.",
            ))
            .child(div().min_w_0().child(status));
        for (index, (label, _)) in FIELDS.iter().enumerate() {
            account = account.child(self.cloud_field(label, card.fields[index].clone().into()));
            if index == 0 {
                account = account
                    .child(self.cloud_field("API key", card.key.clone().into()))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .child(self.control_note(key_note))
                            .when(key == Key::Saved, |row| {
                                row.child(
                                    self.cloud_button(
                                        "cloud-daytona-forget-key",
                                        "Forget key",
                                        ready,
                                    )
                                    .when(ready, |button| {
                                        button.on_click(
                                            cx.listener(|this, _, _, cx| {
                                                this.forget_daytona_key(cx)
                                            }),
                                        )
                                    }),
                                )
                            }),
                    );
            }
        }
        account = account.child(
            div().flex().justify_end().child(
                self.cloud_button("cloud-daytona-save", "Save", ready)
                    .debug_selector(|| "cloud-daytona-save".into())
                    .when(ready, |button| {
                        button.on_click(cx.listener(|this, _, _, cx| this.save_daytona(cx)))
                    }),
            ),
        );
        let create = ready && usable && crate::cloud::unavailable().is_none();
        let mut sandboxes = self
            .control_card("New sandbox")
            .debug_selector(|| "cloud-daytona-new".into())
            .child(self.control_note(
                "Creates a sandbox with a generated name and adds it as a device once it is ready.",
            ))
            .child(
                self.control_switch(
                    "cloud-daytona-install",
                    "Install Herdr in it when missing",
                    card.install,
                    ready,
                )
                .when(ready, |row| {
                    row.on_click(cx.listener(|this, _, _, cx| {
                        if let Some(card) = &mut this.daytona_card {
                            card.install = !card.install;
                        }
                        cx.notify();
                    }))
                }),
            )
            .child(
                div().flex().justify_end().child(
                    self.cloud_button("cloud-daytona-create", "Create sandbox", create)
                        .debug_selector(|| "cloud-daytona-create".into())
                        .when(create, |button| {
                            button.on_click(
                                cx.listener(|this, _, _, cx| this.create_daytona_sandbox(cx)),
                            )
                        }),
                ),
            );
        if let Some(message) = &card.message {
            sandboxes = sandboxes.child(div().min_w_0().child(message.clone()));
        }
        let mut devices = self
            .control_card("Daytona devices")
            .debug_selector(|| "cloud-daytona-devices".into());
        if card.devices().is_empty() {
            devices = devices.child(self.control_note("None yet."));
        }
        for (index, device) in card.devices().iter().enumerate() {
            devices = devices.child(self.cloud_device_row(
                CloudProvider::Daytona,
                index,
                device,
                ready,
                Self::forget_daytona_device,
                cx,
            ));
        }
        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .min_w_0()
            .child(account)
            .child(sandboxes)
            .child(devices)
    }
}

#[cfg(test)]
mod tests;
