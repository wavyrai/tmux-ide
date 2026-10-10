//! Settings > Cloud Devices: one tab per cloud provider whose machines this
//! app uses as devices. Each provider's card keeps its own fields and account
//! state; this section only switches between them, so another provider adds a
//! tab and a card.

#[cfg(feature = "coder")]
mod coder;
#[cfg(feature = "daytona")]
mod daytona;

#[cfg(feature = "coder")]
pub(super) use coder::CoderCard;
#[cfg(feature = "daytona")]
pub(super) use daytona::DaytonaCard;

use super::SettingsWindow;
use crate::{
    cloud::CloudProvider,
    config::{Config, corners},
    search_input::SearchInput,
};
use gpui::{prelude::*, *};

/// Open Settings on `provider`'s tab, for the device picker's row that sets
/// that provider up.
#[cfg(feature = "daytona")]
pub(crate) fn open(source: WeakEntity<crate::HerdrWindow>, provider: CloudProvider, cx: &mut App) {
    super::open(source, cx);
    // Queued after `open`'s own deferred work, so the window exists by now.
    cx.defer(move |cx| {
        let Some(handle) = cx.default_global::<super::SettingsWindowHandle>().window else {
            return;
        };
        let _ = handle.update(cx, |view, window, cx| {
            view.cloud_tab = provider;
            view.select_section(super::Section::CloudDevices, window, cx);
        });
    });
}

/// The provider whose tab shows first.
pub(super) fn first_tab() -> CloudProvider {
    // `cloud` builds always have a provider; see `main.rs`.
    CloudProvider::ALL[0]
}

/// A card's text input, styled like the rest of Settings.
fn input(
    placeholder: &str,
    text: &str,
    config: &Config,
    theme: &crate::config::Theme,
    cx: &mut Context<SettingsWindow>,
) -> Entity<SearchInput> {
    let input = cx.new(SearchInput::new);
    input.update(cx, |input, cx| {
        input.set_appearance(config.ui.clone(), theme.clone(), cx);
        input.set_placeholder(placeholder, cx);
        if !text.is_empty() {
            input.set_text_selected(text, cx);
        }
    });
    input
}

/// Follow a reloaded config in a card's inputs: a field still showing what
/// was loaded last takes the new value, and one the user has edited keeps the
/// edit, so a later Save neither writes stale values back nor drops typing.
fn follow_config<const N: usize>(
    inputs: &[Entity<SearchInput>; N],
    previous: [&str; N],
    loaded: [&str; N],
    cx: &mut App,
) {
    for ((input, previous), loaded) in inputs.iter().zip(previous).zip(loaded) {
        if previous != loaded && input.read(cx).text().trim() == previous {
            input.update(cx, |input, cx| {
                if loaded.is_empty() {
                    input.clear(cx);
                } else {
                    input.set_text_selected(loaded, cx);
                }
            });
        }
    }
}

impl SettingsWindow {
    /// Build each provider's card on first view, then refresh what it reads.
    pub(super) fn open_cloud_devices(&mut self, cx: &mut Context<Self>) {
        for &provider in CloudProvider::ALL {
            match provider {
                #[cfg(feature = "coder")]
                CloudProvider::Coder => self.open_coder_card(cx),
                #[cfg(feature = "daytona")]
                CloudProvider::Daytona => self.open_daytona_card(cx),
            }
        }
    }

    /// Called after the config file reloads, so each card follows an account
    /// that was just saved or edited by hand.
    pub(super) fn cloud_config_changed(&mut self, cx: &mut Context<Self>) {
        for &provider in CloudProvider::ALL {
            match provider {
                #[cfg(feature = "coder")]
                CloudProvider::Coder => self.coder_config_changed(cx),
                #[cfg(feature = "daytona")]
                CloudProvider::Daytona => self.daytona_config_changed(cx),
            }
        }
    }

    /// A cloud job finishing in the main window may have saved a device, so
    /// the cards read the device list and account again.
    pub(super) fn cloud_source_changed(
        &mut self,
        source: &Entity<crate::HerdrWindow>,
        cx: &mut Context<Self>,
    ) {
        let finished = source.read(cx).cloud_jobs.finished();
        if finished == self.cloud_jobs_seen {
            return;
        }
        self.cloud_jobs_seen = finished;
        self.cloud_config_changed(cx);
    }

    fn cloud_tabs(&self, cx: &mut Context<Self>) -> Div {
        let mut tabs = div().flex().flex_wrap().gap(px(8.));
        for &provider in CloudProvider::ALL {
            let key = provider.key();
            tabs = tabs.child(
                self.control_choice(
                    format!("cloud-tab-{key}"),
                    crate::cloud::name(provider),
                    self.cloud_tab == provider,
                    true,
                )
                .debug_selector(move || format!("cloud-tab-{key}"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.cloud_tab = provider;
                    cx.notify();
                })),
            );
        }
        tabs
    }

    pub(super) fn render_cloud_devices(&self, cx: &mut Context<Self>) -> Div {
        let card = match self.cloud_tab {
            #[cfg(feature = "coder")]
            CloudProvider::Coder => self.render_coder_card(cx),
            #[cfg(feature = "daytona")]
            CloudProvider::Daytona => self.render_daytona_card(cx),
        };
        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .min_w_0()
            .when_some(crate::cloud::unavailable(), |section, reason| {
                section.child(self.control_note(format!(
                    "{reason} Accounts can still be edited here for other systems."
                )))
            })
            .when(CloudProvider::ALL.len() > 1, |section| {
                section.child(self.cloud_tabs(cx))
            })
            .child(card)
    }

    fn cloud_button(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        enabled: bool,
    ) -> Stateful<Div> {
        let theme = &self.theme;
        div()
            .id(id.into())
            .flex_none()
            .px(px(12.))
            .py(px(6.))
            .rounded(px(corners::CONTROL))
            .border_1()
            .border_color(rgb(theme.active))
            .bg(rgb(theme.background))
            .when(enabled, |button| {
                button
                    .cursor_pointer()
                    .hover(|style| style.bg(rgb(theme.active)))
            })
            .when(!enabled, |button| button.opacity(0.5))
            .child(label.into())
    }

    /// A label over its input; the input draws its own field.
    fn cloud_field(&self, label: &'static str, input: AnyView) -> Div {
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .min_w_0()
            .child(div().text_color(rgb(self.theme.muted)).child(label))
            .child(input)
    }

    /// A saved device with its Remove button; removal leaves the machine
    /// itself untouched at the provider.
    fn cloud_device_row(
        &self,
        provider: CloudProvider,
        index: usize,
        device: &crate::cloud::SavedDevice,
        ready: bool,
        forget: impl Fn(&mut Self, String, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> Div {
        let key = provider.key();
        let id = device.id.clone();
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .child(
                div()
                    .min_w_0()
                    .child(div().truncate().child(device.label.clone()))
                    .child(
                        div()
                            .truncate()
                            .text_color(rgb(self.theme.muted))
                            .child(format!("{} · {}", device.machine, device.session)),
                    ),
            )
            .child(
                self.cloud_button(
                    SharedString::from(format!("cloud-{key}-remove-{index}")),
                    "Remove",
                    ready,
                )
                .debug_selector(move || format!("cloud-{key}-remove-{index}"))
                .when(ready, |button| {
                    button.on_click(cx.listener(move |this, _, _, cx| forget(this, id.clone(), cx)))
                }),
            )
    }
}
