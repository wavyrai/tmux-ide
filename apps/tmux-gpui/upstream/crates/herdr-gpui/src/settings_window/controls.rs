//! Prepared controls for the standalone window; persistence belongs to its serial save path.
mod fonts;
mod preferences;
mod status_bar;

use super::{Section, SettingsWindow, remote_history::HostState};
use crate::{
    agent_skill::{AgentSkill, Choice},
    config::{Config, FONT_SIZE_RANGE, FontFace, LayoutMode, corners},
    font_picker::FontTarget,
    herdr_settings::{Edit, IndicatorStyle, TabBarPosition, ToastDelivery},
    search_input::{Changed, SearchInput},
};
use gpui::{prelude::*, *};

const FACES: [(FontFace, &str); 4] = [
    (FontFace::Terminal, "Terminal"),
    (FontFace::Sidebar, "Sidebar"),
    (FontFace::Tabs, "Tabs"),
    (FontFace::Ui, "Interface"),
];

pub(super) struct Controls {
    #[cfg(test)]
    preference_io: Option<preferences::PreferenceIo>,
    sidebar_preview: crate::sidebar::preview::Preview,
    search: Entity<SearchInput>,
    integration_search: Entity<SearchInput>,
    _integration_changed: Subscription,
    picker: Option<FontTarget>,
    active_face: FontFace,
    selected: usize,
    #[cfg(test)]
    family_io: Option<fonts::FamilyIo>,
    names: Vec<String>,
    filtered: Vec<usize>,
    scroll: UniformListScrollHandle,
    discovering: bool,
    initialized: bool,
    pending_sizes: Vec<(FontFace, f32)>,
    saving_sizes: Vec<(FontFace, f32)>,
    size_editor: Option<SizeEditor>,
    local_path: String,
    _search_changed: Subscription,
}

struct SizeEditor {
    face: FontFace,
    input: Entity<SearchInput>,
    invalid: bool,
    _blur: Subscription,
}

fn parse_size(text: &str) -> Option<f32> {
    let text = text.trim();
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value = f32::from(text.parse::<u8>().ok()?);
    FONT_SIZE_RANGE.contains(&value).then_some(value)
}

impl Controls {
    pub(super) fn new(cx: &mut Context<SettingsWindow>) -> Self {
        let search = cx.new(SearchInput::new);
        search.update(cx, |input, cx| {
            input.set_placeholder("Search installed fonts...", cx)
        });
        let subscription = cx.subscribe(&search, |this, search, _: &Changed, cx| {
            this.controls.filtered = filter_fonts(&this.controls.names, search.read(cx).text());
            this.controls.selected = 0;
            this.controls.scroll.scroll_to_item(0, ScrollStrategy::Top);
            cx.notify();
        });
        let integration_search = cx.new(SearchInput::new);
        integration_search.update(cx, |input, cx| {
            input.set_placeholder("Search integrations by name or ID...", cx)
        });
        let integration_changed = cx.subscribe(&integration_search, |this, _, _: &Changed, cx| {
            this.body_scroll.set_offset(Point::default());
            cx.notify();
        });
        Self {
            #[cfg(test)]
            preference_io: None,
            integration_search,
            _integration_changed: integration_changed,
            sidebar_preview: Default::default(),
            search,
            picker: None,
            active_face: FontFace::Terminal,
            selected: 0,
            #[cfg(test)]
            family_io: None,
            names: Vec::new(),
            filtered: Vec::new(),
            scroll: UniformListScrollHandle::new(),
            discovering: true,
            initialized: false,
            pending_sizes: Vec::new(),
            saving_sizes: Vec::new(),
            size_editor: None,
            local_path: Config::local_path()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|error| format!("Unavailable ({error})")),
            _search_changed: subscription,
        }
    }

    fn size(&self, face: FontFace, config: &Config) -> f32 {
        self.pending_sizes
            .iter()
            .chain(&self.saving_sizes)
            .find_map(|(candidate, size)| (*candidate == face).then_some(*size))
            .unwrap_or_else(|| face.size(config))
    }
}

fn filter_fonts(names: &[String], query: &str) -> Vec<usize> {
    let query = query.trim().to_lowercase();
    names
        .iter()
        .enumerate()
        .filter_map(|(index, name)| name.to_lowercase().contains(&query).then_some(index))
        .collect()
}

fn stepped_size(size: f32, step: f32) -> Option<f32> {
    if !size.is_finite() || !step.is_finite() {
        return None;
    }
    Some((size.round() + step.round()).clamp(*FONT_SIZE_RANGE.start(), *FONT_SIZE_RANGE.end()))
}

fn queue_size(pending: &mut Vec<(FontFace, f32)>, face: FontFace, size: f32) {
    if let Some((_, desired)) = pending.iter_mut().find(|(candidate, _)| *candidate == face) {
        *desired = size;
    } else {
        pending.push((face, size));
    }
}

impl SettingsWindow {
    pub(super) fn initialize_controls(&mut self, cx: &mut Context<Self>) {
        self.sync_controls(cx);
        if self.controls.initialized {
            return;
        }
        self.controls.initialized = true;
        let text_system = cx.text_system().clone();
        let installed = self.installed_fonts.clone();
        let discovery = cx.background_executor().spawn(async move {
            let mut names: Vec<_> = installed
                .get_or_init(|| text_system.all_font_names())
                .iter()
                .filter(|name| !name.trim().is_empty())
                .cloned()
                .collect();
            names.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
            names.dedup();
            names
        });
        cx.spawn(async move |this, cx| {
            let names = discovery.await;
            let _ = this.update(cx, |this, cx| {
                this.controls.filtered = filter_fonts(&names, this.controls.search.read(cx).text());
                this.controls.names = names;
                this.controls.discovering = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// Called after a root load/save completes, with its busy flag already cleared.
    pub(super) fn sync_controls(&mut self, cx: &mut Context<Self>) {
        self.refresh_control_appearance(cx);
        if !self.busy() {
            self.controls.saving_sizes.clear();
            self.flush_control_sizes(cx);
        }
    }

    pub(super) fn refresh_control_appearance(&mut self, cx: &mut Context<Self>) {
        self.controls.integration_search.update(cx, |input, cx| {
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
        });
        self.controls.search.update(cx, |input, cx| {
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
        });
        if let Some(editor) = &self.controls.size_editor {
            editor.input.update(cx, |input, cx| {
                input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
            });
        }
    }

    fn flush_control_sizes(&mut self, cx: &mut Context<Self>) {
        if self.busy() || self.controls.pending_sizes.is_empty() {
            return;
        }
        // Only touched faces are written. A reload cannot erase later clicks, and
        // we never persist a stale copy of the other faces' configuration.
        let sizes = std::mem::take(&mut self.controls.pending_sizes);
        self.controls.saving_sizes = sizes.clone();
        self.save_control_sizes(sizes, cx);
    }

    pub(super) fn take_pending_control_sizes(&mut self) -> Vec<(FontFace, f32)> {
        std::mem::take(&mut self.controls.pending_sizes)
    }

    fn step_control_size(&mut self, face: FontFace, step: f32, cx: &mut Context<Self>) {
        self.controls.active_face = face;
        cx.notify();
        if self.quitting {
            return;
        }
        let current = self.controls.size(face, &self.config);
        if let Some(size) = stepped_size(current, step)
            && size != current
        {
            self.accept_control_size(face, size, cx);
        }
    }

    pub(super) fn accept_control_size(
        &mut self,
        face: FontFace,
        size: f32,
        cx: &mut Context<Self>,
    ) {
        self.controls.active_face = face;
        if self.quitting || !FONT_SIZE_RANGE.contains(&size) || size.fract() != 0. {
            return;
        }
        if self.controls.size(face, &self.config) == size {
            return;
        }
        queue_size(&mut self.controls.pending_sizes, face, size);
        self.flush_control_sizes(cx);
        cx.notify();
    }

    fn begin_control_size_edit(
        &mut self,
        face: FontFace,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.controls.active_face = face;
        if self.quitting {
            return;
        }
        if !self.finish_control_size_edit(true, cx) {
            self.finish_control_size_edit(false, cx);
        }
        let size = self.controls.size(face, &self.config);
        let input = cx.new(SearchInput::new);
        input.update(cx, |input, cx| {
            input.set_text_selected(&size.to_string(), cx);
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
        });
        let focus = input.read(cx).focus.clone();
        let blur = cx.on_blur(&focus, window, |this, _, cx| {
            if !this.finish_control_size_edit(true, cx) {
                this.finish_control_size_edit(false, cx);
            }
        });
        self.controls.size_editor = Some(SizeEditor {
            face,
            input,
            invalid: false,
            _blur: blur,
        });
        window.focus(&focus, cx);
        cx.notify();
    }

    pub(super) fn finish_control_size_edit(&mut self, save: bool, cx: &mut Context<Self>) -> bool {
        let Some(editor) = &mut self.controls.size_editor else {
            return true;
        };
        let size = if save {
            if editor.input.read(cx).is_composing() {
                return false;
            }
            let Some(size) = parse_size(editor.input.read(cx).text()) else {
                editor.invalid = true;
                cx.notify();
                return false;
            };
            Some(size)
        } else {
            None
        };
        let face = editor.face;
        self.controls.size_editor = None;
        if let Some(size) = size {
            self.accept_control_size(face, size, cx);
        }
        cx.notify();
        true
    }

    fn control_size_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !matches!(event.keystroke.key.as_str(), "enter" | "escape") {
            return;
        }
        let Some(editor) = &self.controls.size_editor else {
            return;
        };
        cx.stop_propagation();
        if editor.input.read(cx).is_composing() {
            return;
        }
        window.prevent_default();
        if self.finish_control_size_edit(event.keystroke.key == "enter", cx) {
            window.focus(&self.focus, cx);
        }
    }

    pub(super) fn control_card(&self, title: &'static str) -> Div {
        div()
            .flex()
            .flex_col()
            .gap(px(18.))
            .min_w_0()
            .p(px(24.))
            .rounded(px(corners::PANEL))
            .border_1()
            .border_color(rgb(self.theme.active))
            .bg(rgb(self.theme.surface))
            .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
    }

    pub(super) fn control_note(&self, text: impl Into<SharedString>) -> Div {
        div()
            .min_w_0()
            .text_color(rgb(self.theme.muted))
            .child(text.into())
    }

    fn control_row(&self, label: &'static str, value: impl Into<SharedString>) -> Div {
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .child(div().text_color(rgb(self.theme.muted)).child(label))
            .child(div().min_w_0().child(value.into()))
    }

    pub(super) fn control_choice(
        &self,
        id: impl Into<SharedString>,
        label: impl IntoElement,
        selected: bool,
        enabled: bool,
    ) -> Stateful<Div> {
        div()
            .id(id.into())
            .px(px(14.))
            .py(px(10.))
            .min_w_0()
            .rounded(px(corners::CONTROL))
            .border_1()
            .border_color(if selected {
                crate::menu::accent(&self.theme)
            } else {
                rgb(self.theme.active)
            })
            .bg(rgb(if selected {
                self.theme.active
            } else {
                self.theme.background
            }))
            .when(enabled, |item| {
                item.cursor_pointer()
                    .hover(|style| style.bg(rgb(self.theme.active)))
            })
            .when(!enabled, |item| item.opacity(0.5))
            .child(label)
    }

    /// Whether Herdr's shared settings can be edited at all. Busy is not part
    /// of it: saves and loads refuse overlapping work themselves, and a control
    /// that changes look for their few milliseconds flickers.
    fn controls_shared_ready(&self) -> bool {
        cfg!(unix) && self.shared.is_some() && self.error.is_none()
    }

    pub(super) fn render_controls(&self, _window: &mut Window, cx: &mut Context<Self>) -> Div {
        let content = match self.section {
            Section::Fonts => self.render_font_controls(cx),
            Section::Indicators => self.render_indicator_controls(cx),
            Section::Sound => self.render_sound_controls(cx),
            Section::Notifications => self.render_notification_controls(cx),
            Section::StatusBar => self.render_status_bar_controls(cx),
            Section::General => self.render_general_controls(cx),
            Section::Appearance | Section::Integrations => div(),
            #[cfg(feature = "cloud")]
            Section::CloudDevices => div(),
        };
        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .min_w_0()
            .when(
                !cfg!(unix)
                    && matches!(
                        self.section,
                        Section::Indicators | Section::Sound | Section::Notifications
                    ),
                |body| {
                    body.child(
                        self.control_note("Shared Herdr settings are read-only on this platform."),
                    )
                },
            )
            .when(
                self.shared.is_none()
                    && matches!(
                        self.section,
                        Section::Indicators | Section::Sound | Section::Notifications
                    ),
                |body| {
                    body.child(self.control_note(
                        "Shared settings are unavailable. Reload from General to retry.",
                    ))
                },
            )
            .child(content)
    }

    fn render_indicator_controls(&self, cx: &mut Context<Self>) -> Div {
        use herdr_client::protocol::AgentStatus;
        let mut card = self.control_card("Agent status indicators");
        let ready = self.controls_shared_ready();
        let light = matches!(
            cx.window_appearance(),
            WindowAppearance::Light | WindowAppearance::VibrantLight
        );
        for (label, style) in [
            ("Dots", IndicatorStyle::Dots),
            ("Symbols", IndicatorStyle::Symbols),
        ] {
            let selected = self
                .shared
                .as_ref()
                .is_some_and(|shared| shared.indicators == style);
            let mut choice = self
                .control_choice(
                    format!("settings-indicators-{label}"),
                    label,
                    selected,
                    ready,
                )
                .flex()
                .flex_col()
                .gap(px(18.))
                .when(ready, |choice| {
                    choice.on_click(cx.listener(move |this, _, _, cx| {
                        this.save_shared(Edit::Indicators(style), cx)
                    }))
                });
            if let Some(shared) = &self.shared {
                let mut preview = div().flex().flex_wrap().gap(px(20.));
                for (status, name, symbol) in [
                    (AgentStatus::Working, "Working", "\u{25d0}"),
                    (AgentStatus::Blocked, "Blocked", "\u{d7}"),
                    (AgentStatus::Done, "Done", "\u{2713}"),
                    (AgentStatus::Idle, "Idle", "\u{25cb}"),
                    (AgentStatus::Unknown, "Unknown", "\u{b7}"),
                ] {
                    let color = rgb(self.theme.ink(shared.status_color(status, light)));
                    let mark = div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .w(px(self.config.ui.size))
                        .h(px(self.config.ui.line_height()))
                        .when(style == IndicatorStyle::Symbols, |mark| {
                            mark.text_color(color).child(symbol)
                        })
                        .when(style == IndicatorStyle::Dots, |mark| {
                            mark.child(
                                div()
                                    .size(px(if status == AgentStatus::Unknown {
                                        3.
                                    } else {
                                        7.
                                    }))
                                    .rounded_full()
                                    .border_1()
                                    .border_color(color)
                                    .when(status != AgentStatus::Idle, |dot| dot.bg(color)),
                            )
                        });
                    preview = preview.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(mark)
                            .child(name),
                    );
                }
                choice = choice.child(preview);
            }
            card = card.child(choice);
        }
        card
    }

    fn render_sound_controls(&self, cx: &mut Context<Self>) -> Div {
        let ready = self.controls_shared_ready();
        let enabled = self
            .shared
            .as_ref()
            .is_some_and(|shared| shared.sound_enabled);
        let choices = self
            .control_switch("settings-sound", "Play agent sounds", enabled, ready)
            .when(ready, |button| {
                button.on_click(cx.listener(move |this, _, _, cx| {
                    this.save_shared(Edit::Sound(!enabled), cx);
                }))
            });
        let source_alive = self.source.upgrade().is_some();
        self.control_card("Agent sounds").child(choices)
            .child(self.control_note("Uses shared sound paths and per-agent overrides. Missing custom sounds fall back to bundled sounds."))
            .child(self.control_choice("settings-sound-preview", "Play test sound", false, source_alive)
                .when(source_alive, |button| button.on_click(cx.listener(|this, _, _, cx| {
                    if let Some(source) = this.source.upgrade() {
                        source.read(cx).sound.preview();
                    }
                }))))
            .child(self.control_note(if source_alive { "Preview plays only when requested, even when sounds are off." } else { "Open a main Herdr window to preview audio." }))
    }

    fn render_notification_controls(&self, cx: &mut Context<Self>) -> Div {
        let ready = self.controls_shared_ready();
        let mut delivery = self.control_card("Notification delivery");
        for (label, mode, note) in [
            ("Off", ToastDelivery::Off, "Disable shared notifications"),
            ("Herdr", ToastDelivery::Herdr, "In-app notifications"),
            (
                "Terminal",
                ToastDelivery::Terminal,
                "Other clients only; not delivered by this GUI",
            ),
            (
                "System",
                ToastDelivery::System,
                "OS notifications; clicking one opens its pane",
            ),
        ] {
            let selected = self
                .shared
                .as_ref()
                .is_some_and(|shared| shared.toast_delivery == mode);
            delivery = delivery.child(
                self.control_choice(
                    format!("settings-delivery-{label}"),
                    div()
                        .debug_selector(move || format!("delivery-label-{label}"))
                        .w(px(self.config.ui.size * 5.))
                        .flex_none()
                        .child(label),
                    selected,
                    ready,
                )
                .debug_selector(move || format!("settings-delivery-{label}"))
                .flex()
                .items_center()
                .gap(px(12.))
                .child(
                    div()
                        .debug_selector(move || format!("delivery-radio-{label}"))
                        .size(px(14.))
                        .flex_none()
                        .rounded_full()
                        .border_1()
                        .border_color(rgb(self.theme.muted))
                        .when(selected, |radio| radio.bg(crate::menu::accent(&self.theme))),
                )
                .child(
                    self.control_note(note)
                        .flex_1()
                        .debug_selector(move || format!("delivery-note-{label}")),
                )
                .when(ready, |button| {
                    button.on_click(
                        cx.listener(move |this, _, _, cx| this.save_shared(Edit::Toasts(mode), cx)),
                    )
                }),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .child(delivery)
            .child(self.native_notification_controls(cx))
    }

    fn save_skill(&mut self, choice: Choice, cx: &mut Context<Self>) {
        self.save_skill_with(
            choice,
            move || {
                let home = crate::config::home()?;
                match choice {
                    Choice::Installed => {
                        let text =
                            crate::agent_skill::text(std::env::current_exe().ok().as_deref());
                        crate::agent_skill::install(&home, &text)?;
                    }
                    Choice::Declined => {
                        crate::agent_skill::remove(&home)?;
                    }
                }
                Ok(())
            },
            self.loader(cx),
            cx,
        );
    }

    fn save_skill_with(
        &mut self,
        choice: Choice,
        operation: impl FnOnce() -> crate::Result<()> + Send + 'static,
        load: impl FnOnce() -> crate::Result<super::Loaded> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        self.save_with_completion(
            operation,
            load,
            false,
            move |cx| AgentSkill::choose(choice, cx),
            cx,
        );
    }

    fn render_skill_controls(&self, cx: &mut Context<Self>) -> Div {
        let installed = AgentSkill::choice(cx) == Some(Choice::Installed);
        let (id, label, choice) = if installed {
            (
                "settings-remove-browser-skill",
                "Remove browser skill",
                Choice::Declined,
            )
        } else {
            (
                "settings-install-browser-skill",
                "Install browser skill",
                Choice::Installed,
            )
        };
        self.control_card("Browser skill")
            .child(self.control_row("Status", if installed { "Installed, kept up to date" } else { "Not installed" }))
            .child(self.control_note("Teaches local agents to use browser tabs and page notes. Installs in existing ~/.claude and ~/.agents directories; removal deletes only app-managed copies."))
            .child(self.control_choice(id, label, false, true)
                .debug_selector(move || id.into())
                .on_click(cx.listener(move |this, _, _, cx| this.save_skill(choice, cx))))
    }

    fn render_general_controls(&self, cx: &mut Context<Self>) -> Div {
        let general = self
            .control_card("Interface")
            .child(self.preference_switch(
                "settings-agent-checkpoints",
                "Checkpoint agent turns",
                self.config.agent_checkpoints,
                crate::config::preferences::Preference::AgentCheckpoints(
                    !self.config.agent_checkpoints,
                ),
                cx,
            ))
            .child(self.preference_switch(
                "settings-listening-ports",
                "Show listening ports",
                self.config.show_listening_ports,
                crate::config::preferences::Preference::ShowListeningPorts(
                    !self.config.show_listening_ports,
                ),
                cx,
            ))
            .child(self.preference_switch(
                "settings-confirm-close",
                "Confirm tab close",
                self.config.confirm_close_tab,
                crate::config::preferences::Preference::ConfirmCloseTab(
                    !self.config.confirm_close_tab,
                ),
                cx,
            ))
            .child(self.preference_switch(
                "settings-confirm-close-pane",
                "Confirm pane close",
                self.config.confirm_close_pane,
                crate::config::preferences::Preference::ConfirmClosePane(
                    !self.config.confirm_close_pane,
                ),
                cx,
            ));
        div().flex().flex_col().gap(px(24.)).child(general)
            .child(self.render_tab_bar_controls(cx))
            .child(self.render_session_controls(cx))
            .child(self.render_skill_controls(cx))
            .child(self.clipboard_controls(cx))
            .child(self.control_card("Configuration")
                .child(self.control_note("GUI local overrides"))
                .child(div().min_w_0().child(self.controls.local_path.clone()))
                .child(self.control_note("Shared Herdr configuration"))
                .child(div().min_w_0().child(self.shared.as_ref().map(|shared| shared.path.display().to_string()).unwrap_or_else(|| "Unavailable".into())))
                .child(self.control_choice("settings-reload", "Reload configuration", false, true)
                    .on_click(cx.listener(|this, _, _, cx| this.reload(cx))))
                .child(self.control_note("Saved file edits reload automatically. Reloading GUI settings does not reload the daemon.")))
    }

    /// Herdr's shared tab row and selection settings, which this GUI and
    /// the TUI both follow.
    fn render_tab_bar_controls(&self, cx: &mut Context<Self>) -> Div {
        let ready = self.controls_shared_ready();
        let shared = self.shared.as_ref();
        let position = shared.map(|shared| shared.tab_bar_position);
        let hide = shared.is_some_and(|shared| shared.hide_tab_bar_when_single_tab);
        let copy = shared.is_none_or(|shared| shared.copy_on_select);
        let mut positions = div().flex().flex_wrap().gap(px(8.));
        for (id, label, choice) in [
            ("settings-tab-bar-top", "Top", TabBarPosition::Top),
            ("settings-tab-bar-bottom", "Bottom", TabBarPosition::Bottom),
        ] {
            positions = positions.child(
                self.control_choice(id, label, position == Some(choice), ready)
                    .debug_selector(move || id.into())
                    .when(ready && position != Some(choice), |button| {
                        button.on_click(cx.listener(move |this, _, _, cx| {
                            this.save_shared(Edit::TabBarPosition(choice), cx);
                        }))
                    }),
            );
        }
        self.control_card("Tabs and selection")
            .child(self.control_note("Tab bar position"))
            .child(positions)
            .child(
                self.control_switch(
                    "settings-hide-single-tab-bar",
                    "Hide tab bar with one tab",
                    hide,
                    ready,
                )
                .when(ready, |button| {
                    button.on_click(cx.listener(move |this, _, _, cx| {
                        this.save_shared(Edit::HideSingleTabBar(!hide), cx);
                    }))
                }),
            )
            .child(
                self.control_switch("settings-copy-on-select", "Copy on select", copy, ready)
                    .when(ready, |button| {
                        button.on_click(cx.listener(move |this, _, _, cx| {
                            this.save_shared(Edit::CopyOnSelect(!copy), cx);
                        }))
                    }),
            )
            .child(self.control_note(if cfg!(unix) {
                "Shared with Herdr. With copy on select off, Cmd-C or Ctrl-C copies the highlighted selection."
            } else {
                "Shared with Herdr and read-only on this platform. With copy on select off, Ctrl-C copies the highlighted selection."
            }))
    }

    /// Herdr's opt-in pane history. The daemon owns the terminals, so it
    /// alone can save their scrollback and seed it back into the restored
    /// panes; these switches only edit each daemon's own setting.
    fn render_session_controls(&self, cx: &mut Context<Self>) -> Div {
        let ready = self.controls_shared_ready();
        let enabled = self
            .shared
            .as_ref()
            .is_some_and(|shared| shared.pane_history);
        let mut card = self
            .control_card("Session restore")
            .child(
                self.control_switch(
                    "settings-pane-history",
                    "Restore scrollback after Herdr restarts (experimental)",
                    enabled,
                    ready,
                )
                .when(ready, |button| {
                    button.on_click(cx.listener(move |this, _, _, cx| {
                        this.save_shared(Edit::PaneHistory(!enabled), cx);
                    }))
                }),
            )
            .child(self.control_note(
                "Reopening this app always keeps scrollback while Herdr runs. With this on, Herdr also saves pane output to session-history.json and replays it when the daemon restarts, so that file holds terminal history.",
            ))
            .when(!cfg!(unix), |card| {
                card.child(self.control_note("Shared with Herdr and read-only on this platform."))
            });
        let hosts = self.remote_history.hosts();
        if hosts.is_empty() {
            return card;
        }
        card = card.child(self.control_note(
            "Each connected SSH host's Herdr keeps its own setting, saved in that host's config.",
        ));
        let open = !self.quitting && self.closing.is_none();
        for (index, host) in hosts.iter().enumerate() {
            let (checked, settled) = match &host.state {
                HostState::Ready(history) => (history.enabled, true),
                HostState::Saving(history) => (history.enabled, false),
                HostState::Loading | HostState::Failed(_) => (false, false),
            };
            let ready = open && settled;
            let target = host.target.clone();
            card = card.child(
                self.control_switch(
                    format!("settings-pane-history-host-{index}"),
                    host.label.clone(),
                    checked,
                    ready,
                )
                .when(ready, |button| {
                    button.on_click(cx.listener(move |this, _, _, cx| {
                        this.save_remote_history(&target, !checked, cx);
                    }))
                }),
            );
            let note = match &host.state {
                HostState::Loading => Some("Reading host config...".to_owned()),
                HostState::Saving(_) => Some("Saving host config...".to_owned()),
                HostState::Failed(error) => {
                    Some(format!("{error}. Reload configuration to try again."))
                }
                HostState::Ready(_) => None,
            };
            if let Some(note) = note {
                card = card.child(self.control_note(note));
            }
        }
        card
    }

    pub(super) fn render_sidebar_layout_controls(&self, cx: &mut Context<Self>) -> Div {
        let ready = !self.quitting && self.closing.is_none();
        let mode = self.config.layout.mode;
        let mut layouts = div().flex().flex_col().gap(px(4.));
        for mode in LayoutMode::ALL {
            layouts = layouts.child(
                self.control_choice(
                    format!("settings-layout-{}", mode.name()),
                    mode.label(),
                    self.config.layout.mode == mode,
                    ready,
                )
                .debug_selector(move || format!("settings-layout-{}", mode.name()))
                .py(px(5.))
                .when(ready, |button| {
                    button.on_click(cx.listener(move |this, _, _, cx| {
                        this.accept_layout_choice(mode, cx);
                    }))
                }),
            );
        }
        let widths = div().flex().gap_1().children(
            crate::sidebar::preview::Preview::WIDTHS
                .into_iter()
                .map(|width| {
                    self.control_choice(
                        format!("preview-width-{width}"),
                        width.to_string(),
                        self.controls.sidebar_preview.width() == width,
                        true,
                    )
                    .debug_selector(move || format!("preview-width-{width}"))
                    .px_2()
                    .py_1()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.controls.sidebar_preview.set_width(width);
                        cx.notify();
                    }))
                }),
        );
        let mut font = self.config.sidebar.clone();
        font.size = self.controls.size(FontFace::Sidebar, &self.config);
        let light = matches!(
            cx.window_appearance(),
            WindowAppearance::Light | WindowAppearance::VibrantLight
        );
        let preview = self.controls.sidebar_preview.render(
            mode,
            &font,
            &self.theme,
            crate::sidebar::Indicators::new(self.shared.as_ref(), light, &self.theme),
            cx.listener(|this, _, _, cx| {
                this.controls.sidebar_preview.toggle_fold();
                cx.notify();
            }),
            |target| {
                Box::new(cx.listener(move |this, _, _, cx| {
                    this.controls.sidebar_preview.select(target);
                    cx.notify();
                }))
            },
        );
        let chooser = div()
            .flex()
            .flex_wrap()
            .gap_4()
            .child(
                div()
                    .w(px(174.))
                    .flex_none()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(self.control_note("Choose a layout"))
                    .child(layouts)
                    .child(self.control_note("Preview width (px)"))
                    .child(widths),
            )
            .child(
                div()
                    .flex_none()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(mode.label())
                    .child(preview),
            );
        self.control_card("Sidebar layout")
            .mt(px(24.))
            .relative()
            .debug_selector(|| "settings-sidebar-layout".into())
            .map(|card| {
                #[cfg(all(feature = "integration-test", target_os = "macos"))]
                let card = card.child(super::native::probe(7));
                card
            })
            .child(chooser)
            .child(
                self.control_switch(
                    "settings-show-agents",
                    "Show agents",
                    self.config.show_agents,
                    true,
                )
                .debug_selector(|| "settings-show-agents".into())
                .on_click(cx.listener(|this, _, _, cx| {
                    let show = !this.config.show_agents;
                    this.save_native(move || Config::save_show_agents(show), cx);
                })),
            )
            .child(self.sidebar_gap_control(cx))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
