use crate::{
    HerdrWindow,
    config::{Config, FONT_SIZE_RANGE, Features, FontFace},
    contrast::Contrast,
    font_picker::{FontTarget, shared_family},
    search_input::SearchInput,
};
use gpui::{prelude::*, *};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread::{self, JoinHandle};

/// Debug selector, label, and state of each feature flag, in display order.
/// Flags are turned on in the config file, so Preferences only reports them.
pub(crate) fn feature_rows(features: &Features) -> [(&'static str, &'static str, bool); 1] {
    [(
        "preferences-feature-sidebar-hover-menu",
        "Sidebar hover menu",
        features.sidebar_hover_menu,
    )]
}

pub(crate) struct FontSizeEditor {
    face: FontFace,
    pub(crate) input: Entity<SearchInput>,
    _blur: Subscription,
}

fn parse_font_size(text: &str) -> Option<f32> {
    let text = text.trim();
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value = text.parse::<u8>().ok()?;
    FONT_SIZE_RANGE
        .contains(&f32::from(value))
        .then_some(f32::from(value))
}

impl HerdrWindow {
    fn begin_font_size_edit(
        &mut self,
        face: FontFace,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = cx.new(SearchInput::new);
        input.update(cx, |input, cx| {
            input.set_text_selected(&format!("{}", face.size(&self.config)), cx);
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
        });
        let focus = input.read(cx).focus.clone();
        let blur = cx.on_blur(&focus, window, |this, _, cx| {
            this.finish_font_size_edit(true, cx);
        });
        self.menu.font_size_editor = Some(FontSizeEditor {
            face,
            input: input.clone(),
            _blur: blur,
        });
        window.focus(&focus, cx);
        cx.notify();
    }

    pub(super) fn finish_font_size_edit(&mut self, save: bool, cx: &mut Context<Self>) {
        let Some(editor) = self.menu.font_size_editor.take() else {
            return;
        };
        if save
            && !editor.input.read(cx).is_composing()
            && let Some(size) = parse_font_size(editor.input.read(cx).text())
        {
            self.set_font_size(editor.face, size, cx);
        }
        cx.notify();
    }

    /// Write one setting off the UI thread, then reload so the window shows
    /// what the file now says rather than what was clicked.
    pub(crate) fn save_preference(
        &mut self,
        save: impl FnOnce() -> crate::Result<()> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.native_settings_save_in_flight() || self.theme_save_in_flight() {
            return;
        }
        if self.config_load.is_some() || self.font_size_saves.is_busy() {
            // A combined write and reload would be refused here, discarding
            // the click. The config lock serializes the write with other
            // saves, and the config watcher reloads once the busy load ends.
            self.write_preference(save, cx);
            return;
        }
        let light = crate::app::light_appearance(cx);
        let text_system = cx.text_system().clone();
        self.load_gui_config_with(
            move || {
                save()?;
                let mut config = Config::load()?;
                config.resolve_fonts(|| text_system.all_font_names());
                let theme = if config.theme == "Follow Herdr" {
                    Default::default()
                } else {
                    config.theme(light)?
                };
                Ok((config, theme))
            },
            cx,
        );
    }

    fn write_preference(
        &mut self,
        save: impl FnOnce() -> crate::Result<()> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let saved = cx.background_executor().spawn(async move { save() });
        cx.spawn(async move |this, cx| {
            let result = saved.await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(()) => this.load_gui_config(cx),
                Err(error) => {
                    tracing::warn!(%error, "Could not save GUI preference");
                    this.local_error = Some(format!("Save GUI config: {error}"));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(crate) fn render_native_preferences(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = &self.theme;
        let font = &self.config.ui;
        let accent = crate::menu::accent(theme);
        let section = |title: &'static str| {
            div()
                .pt(px(12.))
                .pb(px(6.))
                .text_size(px(font.size * 0.85))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(accent)
                .child(title)
        };
        let row = |id: &'static str, label: &'static str, value: String| {
            div()
                .debug_selector(move || id.into())
                .flex()
                .min_w_0()
                .gap(px(12.))
                .py(px(7.))
                .border_b_1()
                .border_color(rgb(theme.active))
                .child(
                    div()
                        .w(relative(0.3))
                        .flex_none()
                        .min_w_0()
                        .text_color(rgb(theme.muted))
                        .child(label),
                )
                .child(div().flex_1().min_w_0().text_right().child(value))
        };
        // A row that flips a setting when clicked, with a switch showing its state.
        let toggle = |id: &'static str, label: &'static str, on: bool| {
            row(id, label, if on { "On" } else { "Off" }.into())
                .id(id)
                .items_center()
                .cursor_pointer()
                .hover(|style| style.bg(rgb(theme.active)))
                .child(crate::toggles::switch(theme, 18., on))
        };
        let note = |text: &'static str| {
            div()
                .min_w_0()
                .py(px(10.))
                .text_color(rgb(theme.muted))
                .child(text)
        };
        let button = |id: &'static str, label: &'static str| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .min_w_0()
                .px(px(8.))
                .py(px(6.))
                .rounded(px(crate::config::corners::CONTROL))
                .border_1()
                .border_color(rgb(theme.active))
                .bg(rgb(theme.background))
                .text_color(accent)
                .cursor_pointer()
                .hover(|style| style.bg(rgb(theme.active)))
                .child(label)
        };
        let mut body = div()
            .id("preferences-body")
            .debug_selector(|| "preferences-body".into())
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_y_scroll()
            .track_scroll(&self.menu.preferences_scroll)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    if this.menu.font_size_editor.is_some() {
                        this.finish_font_size_edit(true, cx);
                        window.focus(&this.menu.focus, cx);
                    }
                }),
            )
            .px(px(16.))
            .py(px(8.));
        if self.settings.tab == crate::settings_panel::Tab::General {
            body = body.child(section("GENERAL"))
            .child(
                toggle(
                    "preferences-show-usage",
                    "Show usage",
                    self.config.usage.show,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    cx.stop_propagation();
                    let show = !this.config.usage.show;
                    this.save_preference(move || Config::save_usage_visibility(show), cx);
                })),
            )
            .child(
                toggle(
                    "preferences-show-system-load",
                    "Show CPU and memory",
                    self.config.show_system_load,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    cx.stop_propagation();
                    let show = !this.config.show_system_load;
                    this.save_preference(
                        move || {
                            Config::save_preference(
                                crate::config::preferences::Preference::ShowSystemLoad(show),
                            )
                        },
                        cx,
                    );
                })),
            )
            .child(
                toggle(
                    "preferences-show-listening-ports",
                    "Show listening ports",
                    self.config.show_listening_ports,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    cx.stop_propagation();
                    let show = !this.config.show_listening_ports;
                    this.save_preference(
                        move || {
                            Config::save_preference(
                                crate::config::preferences::Preference::ShowListeningPorts(show),
                            )
                        },
                        cx,
                    );
                })),
            )
            .child(
                toggle(
                    "preferences-high-contrast",
                    "High contrast",
                    self.config.contrast == Contrast::High,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    cx.stop_propagation();
                    let contrast = match this.config.contrast {
                        Contrast::Standard => Contrast::High,
                        Contrast::High => Contrast::Standard,
                    };
                    this.save_preference(move || Config::save_contrast(contrast), cx);
                })),
            )
            .child(row(
                "preferences-confirm-close-tab",
                "Confirm tab close",
                self.config.confirm_close_tab.to_string(),
            ))
            .child(row(
                "preferences-confirm-close-pane",
                "Confirm pane close",
                self.config.confirm_close_pane.to_string(),
            ))
            .child(row(
                "preferences-layout",
                "Layout",
                self.config.layout.mode.to_string(),
            ))
            .child(row(
                "preferences-sidebar-gap",
                "Sidebar gap",
                format!("{} px", self.config.layout.sidebar_gap),
            ))
            .child(row(
                "preferences-sidebar-style",
                "Sidebar style",
                sidebar_style_summary(&self.config.sidebar_style),
            ))
            .child(note("Edit [layout] mode and sidebar_gap (0-64 logical pixels), and [sidebar] indent, row_padding, gap, host_gap, select, and hosts, in the local override file below; saved changes reload automatically."));
        }
        if self.settings.tab == crate::settings_panel::Tab::Font {
            body = body.child(section("FONTS"));
            body = body.child(
                div()
                    .debug_selector(|| "preferences-font-all".into())
                    .flex()
                    .items_center()
                    .min_w_0()
                    .gap(px(12.))
                    .py(px(7.))
                    .border_b_1()
                    .border_color(rgb(theme.active))
                    .child(
                        div()
                            .w(relative(0.3))
                            .flex_none()
                            .text_color(rgb(theme.muted))
                            .child("All fonts"),
                    )
                    .child(
                        div()
                            .id("preferences-font-all-choose")
                            .debug_selector(|| "preferences-font-all-choose".into())
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_right()
                            .cursor_pointer()
                            .hover(|style| style.bg(rgb(theme.active)))
                            .child(format!(
                                "{} ▾",
                                shared_family(&self.config).unwrap_or("Mixed")
                            ))
                            .on_click(cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.open_font_picker(FontTarget::All, window, cx);
                            })),
                    ),
            );
            for (face, id, label, value) in [
                (
                    FontFace::Sidebar,
                    "preferences-font-sidebar",
                    "Sidebar",
                    &self.config.sidebar,
                ),
                (
                    FontFace::Tabs,
                    "preferences-font-tabs",
                    "Tabs",
                    &self.config.tabs,
                ),
                (
                    FontFace::Terminal,
                    "preferences-font-terminal",
                    "Terminal",
                    &self.config.terminal,
                ),
                (FontFace::Ui, "preferences-font-ui", "UI", &self.config.ui),
            ] {
                let control =
                    |suffix: &'static str, symbol: &'static str, direction: f32, enabled: bool| {
                        div()
                            .id(format!("{id}-{suffix}"))
                            .debug_selector(move || format!("{id}-{suffix}"))
                            .px(px(8.))
                            .py(px(3.))
                            .rounded(px(crate::config::corners::CONTROL))
                            .border_1()
                            .border_color(rgb(theme.active))
                            .bg(rgb(theme.background))
                            .when(enabled, |button| {
                                button
                                    .cursor_pointer()
                                    .hover(|style| style.bg(rgb(theme.active)))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.change_font_size(face, direction, cx);
                                    }))
                            })
                            .when(!enabled, |button| button.text_color(rgb(theme.muted)))
                            .child(symbol)
                    };
                body = body.child(
                    div()
                        .debug_selector(move || id.into())
                        .flex()
                        .items_center()
                        .min_w_0()
                        .gap(px(12.))
                        .py(px(7.))
                        .border_b_1()
                        .border_color(rgb(theme.active))
                        .child(
                            div()
                                .w(relative(0.3))
                                .flex_none()
                                .min_w_0()
                                .text_color(rgb(theme.muted))
                                .child(label),
                        )
                        .child(
                            div()
                                .id(format!("{id}-choose"))
                                .debug_selector(move || format!("{id}-choose"))
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_right()
                                .cursor_pointer()
                                .hover(|style| style.bg(rgb(theme.active)))
                                .child(format!("{} ▾", value.family))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.open_font_picker(FontTarget::Face(face), window, cx);
                                })),
                        )
                        .child(control(
                            "decrease",
                            "−",
                            -1.,
                            value.size > *FONT_SIZE_RANGE.start(),
                        ))
                        .child(
                            if let Some(editor) = &self.menu.font_size_editor
                                && editor.face == face
                            {
                                div()
                                    .w(px(55.))
                                    .flex_none()
                                    .child(editor.input.clone())
                                    .into_any_element()
                            } else {
                                div()
                                    .id(format!("{id}-size"))
                                    .debug_selector(move || format!("{id}-size"))
                                    .flex_none()
                                    .cursor_pointer()
                                    .hover(|style| style.bg(rgb(theme.active)))
                                    .child(format!("{} px", value.size))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        cx.stop_propagation();
                                        this.begin_font_size_edit(face, window, cx);
                                    }))
                                    .into_any_element()
                            },
                        )
                        .child(control(
                            "increase",
                            "+",
                            1.,
                            value.size < *FONT_SIZE_RANGE.end(),
                        )),
                );
            }
            return body.child(note(
                "Font families and sizes save to local GUI overrides and reload in every window. Click a size to type 8–48; Enter or leaving the field saves, Escape cancels. Sizes are logical pixels.",
            ));
        }
        body = body.child(section("FEATURES"));
        for (id, label, enabled) in feature_rows(&self.config.features) {
            body = body.child(row(id, label, if enabled { "On" } else { "Off" }.into()));
        }
        body = body
            .child(note(
                "Optional behaviors, off by default. Turn one on in the [features] table of the local GUI config file; saved changes reload automatically.",
            ))
            .child(section("AGENTS"));
        let installed = crate::agent_skill::AgentSkill::choice(cx)
            == Some(crate::agent_skill::Choice::Installed);
        body = body
            .child(row(
                "preferences-browser-skill",
                "Browser skill",
                if installed { "Installed, kept up to date" } else { "Not installed" }.into(),
            ))
            .child(div().py(px(10.)).child(if installed {
                button("preferences-remove-browser-skill", "Remove browser skill").on_click(
                    cx.listener(|this, _, _, cx| {
                        cx.stop_propagation();
                        this.remove_browser_skill(cx);
                    }),
                )
            } else {
                button("preferences-install-browser-skill", "Install browser skill").on_click(
                    cx.listener(|this, _, window, cx| {
                        cx.stop_propagation();
                        this.install_browser_skill(window, cx);
                    }),
                )
            }))
            .child(note(
                "Teaches Claude Code and other agents to show you pages in browser tabs and read the notes you send. Lives in ~/.claude/skills and ~/.agents/skills. Remove deletes only the copies this app wrote.",
            ))
            .child(section("CONFIGURATION"))
            .child(note("Theme, indicators, sound, and toasts share this computer's Herdr configuration, not a remote daemon's settings."))
            .child(
                div()
                    .debug_selector(|| "preferences-shared-path".into())
                    .py(px(7.))
                    .child(
                        self.settings.shared.as_ref()
                            .map(|settings| settings.path.display().to_string())
                            .unwrap_or_else(|| "Shared config path unavailable".into()),
                    ),
            )
            .child(
                button("preferences-reload-shared", "Reload shared settings")
                    .when(self.settings.task.is_some(), |button| button.opacity(0.5))
                    .on_click(cx.listener(|this, _, _, cx| this.load_shared_settings(cx))),
            )
            .child(
                div()
                    .text_color(rgb(theme.muted))
                    .py(px(7.))
                    .child("GUI local overrides"),
            )
            .child(
                div()
                    .debug_selector(|| "preferences-config-path".into())
                    .w_full()
                    .min_w_0()
                    .p(px(10.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .border_1()
                    .border_color(rgb(theme.active))
                    .bg(rgb(theme.background))
                    .child(
                        Config::local_path()
                            .map(|path| path.display().to_string())
                            .unwrap_or_else(|error| format!("Unavailable ({error})")),
                    ),
            )
            .child(note(
                "Edit this local file; saved changes reload automatically. Unset keys inherit config-gpui.toml, which is overwritten with current defaults on startup and reload. Invalid overrides leave the current appearance unchanged.",
            ))
            .child(
                button("preferences-reload-config", "Reload GUI config").on_click(cx.listener(
                    |this, _, window, cx| {
                        cx.stop_propagation();
                        this.reload_gui_config(window, cx);
                    },
                )),
            )
            .child(note(
                "Daemon configuration is separate. Reloading GUI config does not reload daemon settings.",
            ))
            .child(section("CONNECTION"))
            .child(row(
                "preferences-connection-status",
                "Status",
                self.live.status_text(self.local_error.as_deref()),
            ))
            .child(row(
                "preferences-connection-target",
                "Target",
                format!("{:?}", self.endpoints[self.selected_endpoint].connection.target),
            ));

        body
    }
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Asynchronous, endpoint-local preferences. Dropping lets the worker drain queued
/// saves without waiting; process exit may interrupt pending writes.
/// How the agents panel orders its rows, as in the terminal client: grouped
/// keeps the daemon's workspace order, priority floats the agents that want
/// attention. Herdr's `ui.agent_panel_sort` seeds it until the user toggles
/// it, which deserializes upstream's spellings ("spaces", alias "workspaces").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
pub enum AgentSort {
    #[default]
    #[serde(rename = "spaces", alias = "workspaces")]
    Grouped,
    #[serde(rename = "priority")]
    Priority,
}

impl std::fmt::Display for AgentSort {
    /// Also the stored spelling, which `AgentSort::parse` reads back.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Grouped => "grouped",
            Self::Priority => "priority",
        })
    }
}

impl AgentSort {
    pub fn toggled(self) -> Self {
        match self {
            Self::Grouped => Self::Priority,
            Self::Priority => Self::Grouped,
        }
    }

    /// An unreadable or unknown stored value is no override at all, so the
    /// daemon's setting applies rather than a guessed sort.
    fn parse(value: Option<&serde_json::Value>) -> Option<Self> {
        match value.and_then(serde_json::Value::as_str)? {
            "grouped" => Some(Self::Grouped),
            "priority" => Some(Self::Priority),
            _ => None,
        }
    }
}

/// The window chrome this endpoint remembers between runs.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Chrome {
    pub sidebar_width: Option<f32>,
    pub sidebar_split: Option<f32>,
    /// The sort the user picked with the panel toggle, like upstream's
    /// `agent_panel_sort` preference. `None` follows the daemon's config.
    pub agent_sort: Option<AgentSort>,
    /// The notes panel's width, once dragged; `None` is its default.
    pub notes_width: Option<f32>,
    /// The review's file list's width, once dragged.
    pub review_files_width: Option<f32>,
}

pub struct Preferences {
    saves: Option<Sender<Chrome>>,
    loaded: Option<Receiver<Chrome>>,
    worker: Option<JoinHandle<()>>,
}

impl Preferences {
    pub fn new(socket: &Path) -> Self {
        Self::start(
            state_dir()
                .map(|dir| endpoint_path(&dir, socket))
                .ok_or(crate::Error::MissingStateRoot),
        )
    }

    fn start(path: crate::Result<PathBuf>) -> Self {
        let (saves, requests) = mpsc::channel();
        let (loaded_tx, loaded) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("gpui-preferences".into())
            .spawn(move || {
                let path = match path {
                    Ok(path) => path,
                    Err(_) => {
                        tracing::warn!(
                            category = "preferences_location",
                            "Cannot locate GPUI preferences"
                        );
                        let _ = loaded_tx.send(Chrome::default());
                        return;
                    }
                };
                let chrome = match read_chrome(&path) {
                    Ok(chrome) => chrome,
                    Err(_) => {
                        tracing::warn!(
                            category = "preferences_read",
                            "Cannot read GPUI preferences"
                        );
                        Chrome::default()
                    }
                };
                let _ = loaded_tx.send(chrome);
                for chrome in requests {
                    if write_chrome(&path, chrome).is_err() {
                        tracing::warn!(
                            category = "preferences_write",
                            "Cannot save GPUI preferences"
                        );
                    }
                }
            });
        let worker = match worker {
            Ok(worker) => Some(worker),
            Err(error) => {
                tracing::warn!(category = "preferences_worker_start", error_kind = ?error.kind(), "Cannot start GPUI preferences worker");
                None
            }
        };
        Self {
            saves: Some(saves),
            loaded: Some(loaded),
            worker,
        }
    }

    /// Takes the initial result once; `None` means pending or already taken.
    /// Defaults stand in for a failed initial load.
    pub fn loaded(&mut self) -> Option<Chrome> {
        let result = match self.loaded.as_ref()?.try_recv() {
            Ok(chrome) => Some(chrome),
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => Some(Chrome::default()),
        };
        self.loaded = None;
        result
    }

    /// Queues the whole chrome, so saving one field never drops the others.
    pub fn save(&self, chrome: Chrome) {
        if let Some(saves) = &self.saves
            && saves.send(chrome).is_err()
        {
            tracing::warn!(
                category = "preferences_worker_disconnected",
                "Cannot queue GPUI preferences save"
            );
        }
    }
}

impl Drop for Preferences {
    fn drop(&mut self) {
        // Disconnect and detach: the worker drains queued saves while the process
        // remains alive, without making the UI wait for disk I/O.
        self.saves.take();
        drop(self.worker.take());
    }
}

/// The GPUI client's own state directory, shared by preferences and logs.
pub(crate) fn state_dir() -> Option<PathBuf> {
    state_dir_with(|name| env::var_os(name))
}

fn state_dir_with(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    let var = |name| var(name).filter(|value| !value.is_empty());
    let root = var("XDG_STATE_HOME").map(PathBuf::from).or_else(|| {
        // Existing Windows installations with HOME already store preferences
        // here. Keep selecting the same directory after an upgrade.
        if let Some(home) = var("HOME") {
            return Some(PathBuf::from(home).join(".local").join("state"));
        }
        #[cfg(windows)]
        {
            if let Some(local) = var("LOCALAPPDATA") {
                return Some(PathBuf::from(local));
            }
            if let Some(profile) = var("USERPROFILE") {
                return Some(PathBuf::from(profile).join("AppData").join("Local"));
            }
        }
        None
    });
    root.map(|root| root.join("herdr").join("gpui"))
}

fn endpoint_path(dir: &Path, socket: &Path) -> PathBuf {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in socket.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    dir.join(format!("local-{hash:016x}.json"))
}

fn read_chrome(path: &Path) -> crate::Result<Chrome> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Chrome::default()),
        Err(error) => return Err(error.into()),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    let object = value
        .as_object()
        .ok_or(crate::Error::PreferencesNotObject)?;
    // Earlier builds always wrote `agent_sort`, so its default value cannot be
    // told from a choice; only "priority" proves the user toggled it.
    let agent_sort = AgentSort::parse(object.get("agent_sort_manual")).or_else(|| {
        AgentSort::parse(object.get("agent_sort")).filter(|sort| *sort == AgentSort::Priority)
    });
    let sidebar_width = match object.get("sidebar_width_px") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let width = value.as_f64().map(|width| width as f32);
            match width {
                Some(width) if width.is_finite() && width > 0.0 => Some(width),
                _ => return Err(crate::Error::InvalidStoredWidth),
            }
        }
    };
    let sidebar_split = object
        .get("sidebar_split")
        .and_then(serde_json::Value::as_f64)
        .map(|split| split as f32)
        .filter(|split| split.is_finite() && (0.1..=0.9).contains(split));
    // A damaged panel width is forgotten rather than failing the whole file.
    let notes_width = object
        .get("notes_width_px")
        .and_then(serde_json::Value::as_f64)
        .map(|width| width as f32)
        .filter(|width| width.is_finite() && *width > 0.0);
    let review_files_width = object
        .get("review_files_width_px")
        .and_then(serde_json::Value::as_f64)
        .map(|width| width as f32)
        .filter(|width| width.is_finite() && *width > 0.0);
    Ok(Chrome {
        sidebar_width,
        sidebar_split,
        agent_sort,
        notes_width,
        review_files_width,
    })
}

fn write_chrome(path: &Path, chrome: Chrome) -> crate::Result<()> {
    let width = chrome.sidebar_width;
    if width.is_some_and(|width| !width.is_finite() || width <= 0.0) {
        return Err(crate::Error::InvalidSidebarWidth);
    }
    let parent = path.parent().ok_or(crate::Error::PreferencesPath)?;
    fs::create_dir_all(parent)?;
    let (temporary, mut file) = loop {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(
            ".preferences-{}-{sequence}.tmp",
            std::process::id()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    };
    let result = (|| -> crate::Result<()> {
        serde_json::to_writer(
            &mut file,
            &serde_json::json!({
                "sidebar_width_px": width,
                "sidebar_split": chrome.sidebar_split.filter(|split| {
                    split.is_finite() && (0.1..=0.9).contains(split)
                }),
                "agent_sort_manual": chrome.agent_sort.map(|sort| sort.to_string()),
                "notes_width_px": chrome.notes_width.filter(|width| width.is_finite() && *width > 0.0),
                "review_files_width_px": chrome
                    .review_files_width
                    .filter(|width| width.is_finite() && *width > 0.0),
            }),
        )?;
        file.write_all(b"\n")?;
        Ok(file.sync_all()?)
    })();
    drop(file);
    let result = result.and_then(|()| fs::rename(&temporary, path).map_err(crate::Error::from));
    if result.is_err()
        && let Err(error) = fs::remove_file(&temporary)
    {
        tracing::warn!(category = "preferences_cleanup", error_kind = ?error.kind(), "Cannot clean up GPUI preferences");
    }
    result
}

#[cfg(test)]
mod tests;

// A sibling of `tests`: its glob import shadows `#[test]` with GPUI's macro.
/// One line for the Preferences panel: the spacing keys the file set, the
/// selection mode, and how many hosts have a colour.
fn sidebar_style_summary(style: &crate::config::SidebarStyle) -> String {
    let overrides = style.overrides;
    let mut parts: Vec<String> = crate::config::SidebarOverrides::BANDS
        .into_iter()
        .map(|(key, _)| key)
        .zip([
            overrides.indent,
            overrides.row_padding,
            overrides.gap,
            overrides.host_gap,
        ])
        .filter_map(|(key, value)| value.map(|value| format!("{key} {value} px")))
        .collect();
    parts.push(format!(
        "select {}",
        match style.select {
            crate::config::SelectMode::Row => "row",
            crate::config::SelectMode::Group => "group",
            crate::config::SelectMode::GroupDim => "group-dim",
        }
    ));
    match style.hosts.len() {
        0 => {}
        1 => parts.push("1 host colour".into()),
        n => parts.push(format!("{n} host colours")),
    }
    parts.join(", ")
}

#[cfg(test)]
mod busy_load_tests {
    #[gpui::test]
    #[allow(clippy::unwrap_used)]
    fn preference_clicked_during_a_config_load_is_still_written(cx: &mut gpui::TestAppContext) {
        let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
        let written = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        view.update(cx, |view, cx| {
            // A load that never finishes, such as one the watcher started.
            view.config_load = Some(cx.spawn(async |_, _| std::future::pending::<()>().await));
            let written = written.clone();
            view.save_preference(
                move || {
                    written.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
                cx,
            );
        });
        cx.run_until_parked();
        assert_eq!(written.load(std::sync::atomic::Ordering::SeqCst), 1);

        view.update(cx, |view, cx| {
            view.save_preference(|| Err(crate::Error::InvalidSidebarGap), cx);
        });
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            let error = view.local_error.as_deref().unwrap();
            assert!(error.starts_with("Save GUI config:"), "{error}");
            // The busy load is left alone; the watcher applies the write.
            assert!(view.config_load.is_some());
        });
    }
}
