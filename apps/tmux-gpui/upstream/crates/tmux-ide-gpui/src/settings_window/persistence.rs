//! Loading and saving preferences off the UI thread, then reconciling the result,
//! including the config watcher and the saves that finish when the app quits.
use super::{Section, SettingsWindow, layouts, themes};
use crate::{
    config::{Config, FontFace, Theme},
    herdr_settings::{self, Edit},
};
use gpui::*;

pub(super) struct Loaded {
    pub(super) config: Config,
    pub(super) theme: Theme,
    pub(super) shared: Option<herdr_settings::Settings>,
    pub(super) error: Option<String>,
}

pub(super) type SaveCompletion =
    std::result::Result<Option<herdr_settings::Settings>, std::sync::Arc<crate::Error>>;

/// The watched GUI-local and daemon config files, read together.
pub(super) type Sample = [crate::config::watch::Fingerprint; 2];

fn watched_paths() -> Option<[std::path::PathBuf; 2]> {
    let local = Config::local_path().ok()?;
    Some([
        local,
        crate::config::daemon_config_path(|key| std::env::var_os(key)),
    ])
}

fn sample(paths: &[std::path::PathBuf; 2]) -> Sample {
    paths
        .each_ref()
        .map(|path| crate::config::watch::fingerprint(path))
}

/// Decides when the watched files need a reload, acknowledging both the
/// watcher's own completed reloads and this window's saves.
#[derive(Default)]
pub(super) struct ConfigWatch {
    watch: crate::config::watch::Watch<Sample>,
    /// The sample a started reload will reflect, and the load revision then.
    pending: Option<(Sample, u64)>,
}

impl ConfigWatch {
    /// `saved` is the state this window's last save wrote and reloaded, and
    /// `revision` the window's current load revision. `true` means reload now.
    pub(super) fn observe(
        &mut self,
        sample: Sample,
        saved: Option<Sample>,
        revision: u64,
        busy: bool,
    ) -> bool {
        if let Some((pending, started)) = self.pending
            && started != revision
        {
            self.watch.accept(pending);
            self.pending = None;
        }
        // After `pending`: a save always follows the watcher reload it waited
        // on, so its sample is the newer one.
        if let Some(saved) = saved {
            self.watch.accept(saved);
        }
        let due = self.watch.observe(sample) && !busy;
        if due {
            self.pending = Some((sample, revision));
        }
        due
    }
}

#[cfg(test)]
type SizeWriter = dyn Fn(Vec<(FontFace, f32)>) -> crate::Result<()> + Send + Sync;

#[cfg(test)]
#[derive(Clone)]
pub(super) struct SizeIo {
    pub(super) write: std::sync::Arc<SizeWriter>,
    pub(super) load: fn() -> crate::Result<Loaded>,
}

impl SettingsWindow {
    pub(super) fn watch_config(&mut self, cx: &mut Context<Self>) {
        let Some(paths) = watched_paths() else {
            return;
        };
        self._watch = Some(cx.spawn(async move |this, cx| {
            let mut watch = ConfigWatch::default();
            loop {
                let paths = paths.clone();
                let sample = cx
                    .background_executor()
                    .spawn(async move { sample(&paths) })
                    .await;
                if this
                    .update(cx, |this, cx| {
                        let saved = this.saved_sample.take();
                        if watch.observe(sample, saved, this.load_revision, this.busy()) {
                            this.reload(cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(250))
                    .await;
            }
        }));
    }

    pub(super) fn shutdown(&mut self, cx: &mut Context<Self>) -> Task<crate::Result<()>> {
        #[cfg(test)]
        if let Some(io) = self.size_io.clone() {
            return self.shutdown_with(move |sizes| (io.write)(sizes), cx);
        }
        self.shutdown_with(|sizes| Config::save_font_sizes(&sizes), cx)
    }

    pub(super) fn shutdown_with(
        &mut self,
        write: impl FnOnce(Vec<(FontFace, f32)>) -> crate::Result<()> + Send + 'static,
        cx: &mut Context<Self>,
    ) -> Task<crate::Result<()>> {
        self.quitting = true;
        self._watch = None;
        let pending = self.take_pending_control_sizes();
        let theme = self.take_shutdown_theme();
        let layout = self
            .layout_intent
            .take()
            .filter(|_| !self.layout_saving)
            .map(|mode| self.layout_operation(mode));
        let completion = self.save_completion.take();
        let executor = cx.background_executor().clone();
        cx.background_executor().spawn(async move {
            let mut shared = None;
            let mut preceding = Ok(());
            if let Some(completion) = completion {
                // Yield rather than occupying the executor thread needed by
                // the preceding save, including single-threaded test workers.
                loop {
                    match completion.try_recv() {
                        Ok(result) => {
                            match result {
                                Ok(snapshot) => shared = snapshot,
                                Err(error) => preceding = Err(crate::Error::SettingsSave(error)),
                            }
                            break;
                        }
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                        Err(std::sync::mpsc::TryRecvError::Empty) => {
                            executor.timer(std::time::Duration::from_millis(10)).await;
                        }
                    }
                }
            }
            let sizes = if pending.is_empty() {
                Ok(())
            } else {
                write(pending)
            };
            let theme = theme.map_or(Ok(()), |theme| theme(shared));
            let layout = layout.map_or(Ok(()), |write| write());
            preceding.and(sizes).and(theme).and(layout)
        })
    }

    pub(super) fn save_control_sizes(
        &mut self,
        sizes: Vec<(FontFace, f32)>,
        cx: &mut Context<Self>,
    ) {
        #[cfg(test)]
        if let Some(io) = self.size_io.clone() {
            self.save_with(move || (io.write)(sizes), io.load, false, cx);
            return;
        }
        self.save_native(move || Config::save_font_sizes(&sizes), cx);
    }

    pub(super) fn loader(
        &self,
        cx: &App,
    ) -> impl FnOnce() -> crate::Result<Loaded> + Send + 'static + use<> {
        let light = matches!(
            cx.window_appearance(),
            WindowAppearance::Light | WindowAppearance::VibrantLight
        );
        let text_system = cx.text_system().clone();
        let installed = self.installed_fonts.clone();
        move || {
            let mut config = Config::load()?;
            config.resolve_fonts(|| {
                installed
                    .get_or_init(|| text_system.all_font_names())
                    .iter()
                    .cloned()
            });
            let (shared, error, theme) = match herdr_settings::Settings::load() {
                Ok(shared) => {
                    config.apply_shared_notifications(&shared);
                    let theme = if config.theme == "Follow Herdr" {
                        shared.theme(light)?.with_contrast(config.contrast)
                    } else {
                        config.theme(light)?
                    };
                    (Some(shared), None, theme)
                }
                Err(error) if config.theme == "Follow Herdr" => return Err(error),
                Err(error) => (
                    None,
                    Some(format!("Load shared settings: {error}")),
                    config.theme(light)?,
                ),
            };
            Ok(Loaded {
                config,
                theme,
                shared,
                error,
            })
        }
    }

    pub(super) fn apply_loaded(&mut self, loaded: crate::Result<Loaded>, cx: &mut Context<Self>) {
        self.load_revision = self.load_revision.wrapping_add(1);
        let valid = loaded.is_ok();
        match loaded {
            Ok(loaded) => {
                let live = self
                    .theme_intent
                    .as_ref()
                    .map(|_| (self.config.theme.clone(), self.theme.clone()));
                self.config = loaded.config;
                if let Some(mode) = self.layout_intent {
                    self.config.layout.mode = mode;
                }
                self.theme = loaded.theme;
                if let Some((name, theme)) = live {
                    self.config.theme = name;
                    self.theme = theme;
                }
                self.shared = loaded.shared;
                self.error = loaded.error;
            }
            Err(error) => {
                self.error = Some(format!(
                    "Could not reload settings; keeping current preferences: {error}"
                ))
            }
        }
        // Appearance may have changed while the loader was running. Resolve
        // Follow Herdr from the prepared snapshot against the current OS mode.
        self.sync_appearance(cx);
        self.drive_theme_intent(cx);
        if valid {
            self.publish_appearance(cx);
            #[cfg(feature = "cloud")]
            self.cloud_config_changed(cx);
        }
        cx.notify();
    }

    pub(super) fn reload(&mut self, cx: &mut Context<Self>) {
        // Buttons stay clickable while busy; the remote re-read must not start
        // for a reload `reload_with` would then refuse.
        if self.busy() {
            return;
        }
        if self.section == Section::General {
            self.sync_remote_history(true, cx);
        }
        self.reload_with(self.loader(cx), cx);
    }

    pub(super) fn reload_with(
        &mut self,
        load: impl FnOnce() -> crate::Result<Loaded> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.busy() {
            return;
        }
        self.loading = true;
        self.error = None;
        // Size intents can arrive while this read is running. Keep the model
        // alive until reconciliation has transferred them to the save worker.
        let retained = cx.entity();
        let load = cx.background_executor().spawn(async move { load() });
        cx.spawn(async move |_, cx| {
            let loaded = load.await;
            retained.update(cx, |this, cx| {
                this.loading = false;
                if this.quitting {
                    return;
                }
                this.apply_loaded(loaded, cx);
                this.finish_close(cx);
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn save_native(
        &mut self,
        operation: impl FnOnce() -> crate::Result<()> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        self.save_with(operation, self.loader(cx), false, cx);
    }

    pub(super) fn save_shared(&mut self, edit: Edit, cx: &mut Context<Self>) {
        let Some(shared) = self.shared.clone() else {
            return;
        };
        self.save_with(
            move || shared.save(edit).map(|_| ()),
            self.loader(cx),
            true,
            cx,
        );
    }

    pub(super) fn save_with(
        &mut self,
        operation: impl FnOnce() -> crate::Result<()> + Send + 'static,
        load: impl FnOnce() -> crate::Result<Loaded> + Send + 'static,
        shared: bool,
        cx: &mut Context<Self>,
    ) {
        self.save_with_completion(operation, load, shared, |_| {}, cx);
    }

    pub(super) fn save_with_completion(
        &mut self,
        operation: impl FnOnce() -> crate::Result<()> + Send + 'static,
        load: impl FnOnce() -> crate::Result<Loaded> + Send + 'static,
        shared: bool,
        on_saved: impl FnOnce(&mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.busy() {
            return;
        }
        self.saving = true;
        self.error = None;
        let retained = cx.entity();
        let (finished, completion) = std::sync::mpsc::sync_channel(1);
        self.save_completion = Some(completion);
        // Only a watched window needs its own write fingerprinted.
        let watched = self._watch.is_some().then(watched_paths).flatten();
        let work = cx.background_executor().spawn(async move {
            let saved = operation().map_err(std::sync::Arc::new);
            // Fingerprint before loading: the load then reflects at least this
            // state, and any later edit still differs for the watcher.
            let written = watched.as_ref().map(sample);
            // A persistence error can occur after replacement. Always reconcile.
            let loaded = load();
            // Only our successful, reconciled write may advance the queued
            // shared edit's optimistic-concurrency snapshot during shutdown.
            let shared = if saved.is_ok() {
                loaded
                    .as_ref()
                    .ok()
                    .and_then(|loaded| loaded.shared.clone())
            } else {
                None
            };
            let _ = finished.send(saved.clone().map(|()| shared));
            (saved, loaded, written)
        });
        cx.spawn(async move |_, cx| {
            let (saved, loaded, written) = work.await;
            retained.update(cx, |this, cx| {
                this.saving = false;
                this.save_completion = None;
                this.saved_sample = written;
                if saved.is_ok() {
                    on_saved(cx);
                }
                if this.quitting {
                    return;
                }
                let reloaded = loaded.is_ok();
                let theme_save = std::mem::take(&mut this.theme_saving);
                let layout_save = std::mem::take(&mut this.layout_saving);
                if saved.is_err() {
                    this.closing = None;
                }
                if theme_save && saved.is_ok() {
                    this.theme_intent = None;
                    themes::clear_theme_draft(cx);
                }
                if layout_save && saved.is_ok() {
                    this.layout_intent = None;
                    layouts::clear_layout_draft(cx);
                }
                this.apply_loaded(loaded, cx);
                if theme_save && saved.is_ok() {
                    this.broadcast_theme(cx);
                }
                if layout_save && saved.is_ok() {
                    this.broadcast_layout(cx);
                }
                this.finish_close(cx);
                // Success is visible in the controls themselves; only problems
                // earn a footer line.
                if !this.saving {
                    this.status = match (saved.is_ok(), reloaded) {
                        (true, true) => None,
                        (true, false) => Some("Saved; could not reload current preferences".into()),
                        (false, true) => Some("Save failed; reloaded current preferences".into()),
                        (false, false) => Some("Save failed; reload before editing again".into()),
                    };
                }
                if let Err(error) = &saved {
                    this.error = Some(format!("Save settings: {error}"));
                }
                let _ = this.source.update(cx, |source, _| {
                    // The source's guarded file watcher owns applying changes.
                    // Direct loads here can overwrite its active picker preview.
                    if shared && saved.is_ok() {
                        // Use the existing connection, without stealing its response lane.
                        if let Some(endpoint) = source
                            .endpoints
                            .iter()
                            .find(|endpoint| !endpoint.connection.target.is_remote())
                            && let (Some(handle), Some(snapshot)) =
                                (&endpoint.connection.handle, &endpoint.live.snapshot)
                            && endpoint.live.status.is_connected()
                            && let Err(error) = handle.request(
                                &snapshot.boot_id,
                                herdr_client::Method::ServerReloadConfig,
                                serde_json::json!({}),
                            )
                            && !this.saving
                        {
                            this.status = Some(format!("Saved; daemon reload not queued: {error}"));
                        }
                    }
                });
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
