//! A saved device can opt into its server's keybindings, as
//! `herdr --remote --remote-keybindings server` does for the TUI. The keymap
//! then follows the selected endpoint: that host's published `[keys]` profile,
//! with this GUI's own `[keybindings]` still layered on top. Everything else,
//! themes and sidebar included, stays local by upstream design.

use super::HerdrWindow;
use crate::{
    Result,
    config::KeybindingSource,
    keymap::{Binding, DaemonKeys, Keymap, PaneKeys},
};
use gpui::{App, Context, Global};
use std::collections::BTreeMap;

/// The keymap a window built from its selected endpoint's server profile, and
/// what it was built from, so a new snapshot only rebuilds it when the profile
/// or the GUI overrides actually changed.
pub(crate) struct ServerKeymap {
    endpoint: String,
    profile: Option<String>,
    overrides: BTreeMap<String, Binding>,
    pane_keys: PaneKeys,
    /// An error leaves the window on its local keymap, as Herdr keeps the
    /// bindings it had when a profile cannot be applied.
    keymap: Result<Keymap>,
}

impl ServerKeymap {
    fn build(
        endpoint: &str,
        profile: Option<&str>,
        overrides: &BTreeMap<String, Binding>,
        pane_keys: &PaneKeys,
    ) -> Self {
        let keymap = DaemonKeys::from_profile(profile)
            .and_then(|keys| Keymap::with_overrides(overrides, pane_keys, &keys));
        if let Err(error) = &keymap {
            tracing::warn!(endpoint, %error, "Using local keybindings for this device");
        }
        Self {
            endpoint: endpoint.to_owned(),
            profile: profile.map(str::to_owned),
            overrides: overrides.clone(),
            pane_keys: pane_keys.clone(),
            keymap,
        }
    }

    fn built_from(
        &self,
        endpoint: &str,
        profile: Option<&str>,
        overrides: &BTreeMap<String, Binding>,
        pane_keys: &PaneKeys,
    ) -> bool {
        self.endpoint == endpoint
            && self.profile.as_deref() == profile
            && self.overrides == *overrides
            && self.pane_keys == *pane_keys
    }
}

/// The server keymap of the active window's endpoint, when it uses one. GPUI
/// bindings are app-wide, so the active window decides which direct keys are
/// bound; every window answers its own prefix chords.
#[derive(Default)]
pub(crate) struct ActiveServerKeymap(pub(crate) Option<Keymap>);

impl Global for ActiveServerKeymap {}

impl HerdrWindow {
    /// The keymap this window's keys and labels follow.
    pub(crate) fn keymap(&self) -> &Keymap {
        self.server_keymap().unwrap_or(&self.config.keybindings)
    }

    fn server_keymap(&self) -> Option<&Keymap> {
        self.server_keys
            .as_ref()
            .and_then(|keys| keys.keymap.as_ref().ok())
    }

    /// Why the endpoint is on local keybindings although it asked for its
    /// server's, while it is the selected one.
    pub(crate) fn server_keybindings_error(&self, endpoint: &str) -> Option<String> {
        self.server_keys
            .as_ref()
            .filter(|keys| keys.endpoint == endpoint)
            .and_then(|keys| keys.keymap.as_ref().err())
            .map(ToString::to_string)
    }

    /// Rebuilds the server keymap when the selection, its published profile,
    /// or the opt-in changed. Until the first snapshot arrives there is no
    /// profile to judge, so the local keymap applies without a diagnostic.
    pub(crate) fn sync_server_keymap(&mut self, cx: &mut Context<Self>) {
        let endpoint = &self.endpoints[self.selected_endpoint].id;
        let wanted = self.config.keybinding_source(endpoint) == KeybindingSource::Server;
        let next =
            match (wanted, &self.live.snapshot) {
                (true, Some(snapshot)) => {
                    let profile = snapshot.server_keybindings_toml.as_deref();
                    let overrides = &self.config.keybinding_overrides;
                    let pane_keys = &self.config.pane_keys;
                    if self.server_keys.as_ref().is_some_and(|keys| {
                        keys.built_from(endpoint, profile, overrides, pane_keys)
                    }) {
                        return;
                    }
                    Some(ServerKeymap::build(endpoint, profile, overrides, pane_keys))
                }
                _ if self.server_keys.is_none() => return,
                _ => None,
            };
        let before = self.server_keymap().cloned();
        self.server_keys = next;
        if self.server_keymap() == before.as_ref() {
            // A diagnostic may still have changed.
            cx.notify();
            return;
        }
        // A chord armed under the old prefix must not complete under the new one.
        self.disarm_prefix();
        if self.active {
            self.publish_server_keymap(cx);
        }
        cx.notify();
    }

    /// Makes this window's direct keys the bound ones. Called when it becomes
    /// the active window and when its keymap changes while active.
    pub(super) fn publish_server_keymap(&self, cx: &mut App) {
        let keymap = self.server_keymap().cloned();
        if cx
            .try_global::<ActiveServerKeymap>()
            .map_or(keymap.is_none(), |active| active.0 == keymap)
        {
            return;
        }
        cx.set_global(ActiveServerKeymap(keymap));
        crate::actions::rebind_keys(cx);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
