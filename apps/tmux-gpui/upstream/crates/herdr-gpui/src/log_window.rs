use crate::{
    config::{Config, FontConfig, Theme},
    diagnostics::{self, Record},
    fonts::StyledFont,
    search_input::{Changed, SearchInput},
};
use gpui::{prelude::*, *};
use std::{sync::Arc, time::Duration};
use tracing::Level;

const LEVELS: [Level; 5] = [
    Level::TRACE,
    Level::DEBUG,
    Level::INFO,
    Level::WARN,
    Level::ERROR,
];

actions!(log_window, [Close, FocusSearch, FocusLevel]);

/// The console's own keys, scoped to its window. They are bound with the app
/// keymap so a config reload, which replaces every binding, keeps them.
pub(crate) fn key_bindings() -> [KeyBinding; 5] {
    [
        KeyBinding::new("cmd-w", Close, Some("LogWindow")),
        KeyBinding::new("cmd-f", FocusSearch, Some("LogWindow")),
        KeyBinding::new("cmd-l", FocusLevel, Some("LogWindow")),
        KeyBinding::new("tab", FocusLevel, Some("LogWindow")),
        KeyBinding::new("shift-tab", FocusSearch, Some("LogWindow")),
    ]
}

#[derive(Default)]
struct LogWindowHandle(Option<WindowHandle<LogWindow>>);
impl Global for LogWindowHandle {}

#[derive(Clone, Default)]
struct Appearance {
    config: Config,
    theme: Theme,
}
impl Global for Appearance {}

// Follow the rendered appearance, including previews; the console never reloads files itself.
pub(super) fn set_appearance(config: &Config, theme: &Theme, cx: &mut App) {
    cx.set_global(Appearance {
        config: config.clone(),
        theme: theme.clone(),
    });
}

fn palette_color(theme: &Theme, index: usize) -> Rgba {
    // Terminal ANSI colors can have very low contrast against UI backgrounds.
    crate::menu::tint(theme, index)
}

fn severity_color(theme: &Theme, level: Level) -> Rgba {
    palette_color(
        theme,
        match level {
            Level::ERROR => 1,
            Level::WARN => 3,
            Level::INFO => 2,
            Level::DEBUG => 4,
            Level::TRACE => 5,
        },
    )
}

pub(super) fn open(cx: &mut App) {
    // Global menu actions can run inside the existing window's update.
    cx.defer(open_deferred);
}

fn open_deferred(cx: &mut App) {
    if let Some(handle) = cx.default_global::<LogWindowHandle>().0
        && handle
            .update(cx, |_, window, _| window.activate_window())
            .is_ok()
    {
        return;
    }
    let bounds = Bounds::centered(None, size(px(1100.), px(650.)), cx);
    match cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(620.), px(360.))),
            titlebar: Some(crate::titlebar::options("Logs")),
            app_owns_titlebar_drag: cfg!(target_os = "macos"),
            ..Default::default()
        },
        |window, cx| cx.new(|cx| LogWindow::new(window, cx)),
    ) {
        Ok(handle) => cx.set_global(LogWindowHandle(Some(handle))),
        Err(_) => tracing::error!("Unable to open log window"),
    }
}

struct LogWindow {
    appearance: Appearance,
    _appearance: Subscription,
    focus: FocusHandle,
    search: Entity<SearchInput>,
    minimum: Level,
    level_focus: FocusHandle,
    menu_focus: FocusHandle,
    level_menu: Option<usize>,
    rows: Vec<Arc<Record>>,
    retained: Vec<Arc<Record>>,
    generation: Option<u64>,
    dropped: u64,
    following: bool,
    scroll: ListState,
    selected: Option<Arc<Record>>,
    status: String,
    exporting: bool,
    _search: Subscription,
    _poll: Task<()>,
}

fn filtered(records: Vec<Arc<Record>>, query: &str, minimum: Level) -> Vec<Arc<Record>> {
    let query = query.to_lowercase();
    records
        .into_iter()
        .filter(|record| {
            // tracing orders ERROR < WARN < INFO < DEBUG < TRACE.
            if record.level > minimum {
                return false;
            }
            let mut text = None;
            query.split_whitespace().all(|term| {
                if let Some(namespace) = term.strip_prefix("namespace:") {
                    record.namespace.eq_ignore_ascii_case(namespace)
                } else if let Some(target) = term.strip_prefix("target:") {
                    record.target.to_lowercase().contains(target)
                } else {
                    text.get_or_insert_with(|| record.line().to_lowercase())
                        .contains(term)
                }
            })
        })
        .collect()
}

fn export_text(rows: &[Arc<Record>], dropped: u64) -> serde_json::Result<String> {
    let mut text = serde_json::to_string(&serde_json::json!({
        "type": "metadata", "schema_version": 1,
        "app_version": crate::APP_VERSION,
        "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
        "dropped": dropped, "timestamp_format": "local [YYYY-MM-DD HH:MM:SS]"
    }))?;
    text.push('\n');
    for row in rows {
        text.push_str(&serde_json::to_string(row.as_ref())?);
        text.push('\n');
    }
    Ok(text)
}

impl LogWindow {
    fn open_levels(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.level_menu = LEVELS.iter().position(|level| *level == self.minimum);
        window.focus(&self.menu_focus, cx);
        cx.notify();
    }

    fn close_levels(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.level_menu = None;
        window.focus(&self.level_focus, cx);
        cx.notify();
    }

    fn level_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.level_menu else { return };
        cx.stop_propagation();
        window.prevent_default();
        match event.keystroke.key.as_str() {
            "escape" | "tab" => self.close_levels(window, cx),
            "up" => self.level_menu = Some((index + LEVELS.len() - 1) % LEVELS.len()),
            "down" => self.level_menu = Some((index + 1) % LEVELS.len()),
            "home" => self.level_menu = Some(0),
            "end" => self.level_menu = Some(LEVELS.len() - 1),
            "enter" | "space" => {
                self.minimum = LEVELS[index];
                self.generation = None;
                self.close_levels(window, cx);
            }
            _ => {}
        }
        cx.notify();
    }

    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(SearchInput::new);
        let appearance = cx.default_global::<Appearance>().clone();
        search.update(cx, |input, cx| {
            input.set_appearance(appearance.config.ui.clone(), appearance.theme.clone(), cx);
            input.set_placeholder("Search, namespace:herdr_gpui target:terminal_painter", cx);
            window.focus(&input.focus, cx);
        });
        let appearance_subscription = cx.observe_global::<Appearance>(|this, cx| {
            if row_metrics_changed(
                &this.appearance.config.terminal,
                &cx.global::<Appearance>().config.terminal,
            ) {
                // Width changes are handled by GPUI; font changes need explicit invalidation.
                let offset = this.scroll.logical_scroll_top();
                this.scroll.reset(this.rows.len());
                this.scroll.scroll_to(offset);
            }
            this.appearance = cx.global::<Appearance>().clone();
            this.search.update(cx, |input, cx| {
                input.set_appearance(
                    this.appearance.config.ui.clone(),
                    this.appearance.theme.clone(),
                    cx,
                );
            });
            cx.notify();
        });
        let subscription = cx.subscribe(&search, |this, _, _: &Changed, cx| {
            this.generation = None;
            cx.notify();
        });
        let poll = cx.spawn(async move |this, cx| {
            // The reader lives in this task; a background read borrows it by value.
            let mut tail = diagnostics::path().map(diagnostics::Tail::new);
            loop {
                let request = this.update(cx, |this, cx| {
                    (this.generation.is_none()
                        || (this.following && this.generation != Some(diagnostics::generation())))
                    .then(|| {
                        (
                            this.search.read(cx).text().to_owned(),
                            this.minimum,
                            this.following,
                            (!this.following).then(|| (this.retained.clone(), this.dropped)),
                        )
                    })
                });
                let Ok(request) = request else { break };
                if let Some((query, minimum, following, frozen)) = request {
                    let filter_query = query.clone();
                    // Read the hint first so a write racing the read triggers another one.
                    let generation = diagnostics::generation();
                    let (returned, snapshot) = cx
                        .background_executor()
                        .spawn(async move {
                            let snapshot = match frozen {
                                Some((retained, dropped)) => Ok((retained, dropped)),
                                None => tail.as_mut().map_or(Ok(()), diagnostics::Tail::read).map(
                                    |()| {
                                        (
                                            tail.as_ref()
                                                .map_or_else(Vec::new, diagnostics::Tail::records),
                                            diagnostics::dropped(),
                                        )
                                    },
                                ),
                            }
                            .map(|(retained, dropped)| {
                                (
                                    filtered(retained.clone(), &filter_query, minimum),
                                    retained,
                                    dropped,
                                )
                            });
                            (tail, snapshot)
                        })
                        .await;
                    tail = returned;
                    if this
                        .update(cx, |this, cx| {
                            if this.search.read(cx).text() != query
                                || this.minimum != minimum
                                || this.following != following
                            {
                                return;
                            }
                            this.generation = Some(generation);
                            match snapshot {
                                Ok((rows, retained, dropped)) => {
                                    if rows.len() != this.rows.len()
                                        || !rows
                                            .iter()
                                            .zip(&this.rows)
                                            .all(|(a, b)| Arc::ptr_eq(a, b))
                                    {
                                        this.scroll.reset(rows.len());
                                    }
                                    this.rows = rows;
                                    this.retained = retained;
                                    this.dropped = dropped;
                                }
                                // Not logged: a failing read would log on every change.
                                Err(error) => {
                                    this.status = format!("Unable to read logs: {}", error.kind())
                                }
                            }
                            cx.notify();
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                cx.background_executor()
                    .timer(Duration::from_millis(250))
                    .await;
            }
        });
        Self {
            appearance,
            _appearance: appearance_subscription,
            focus: cx.focus_handle(),
            search,
            minimum: Level::TRACE,
            level_focus: cx.focus_handle(),
            menu_focus: cx.focus_handle(),
            level_menu: None,
            rows: Vec::new(),
            retained: Vec::new(),
            generation: None,
            dropped: 0,
            following: true,
            scroll: ListState::new(0, ListAlignment::Top, px(100.)),
            selected: None,
            status: match diagnostics::path() {
                Some(path) => format!("Saved to {}. Review before sharing.", path.display()),
                None => "Not saved: no state directory. Review before sharing.".into(),
            },
            exporting: false,
            _search: subscription,
            _poll: poll,
        }
    }

    fn share(&mut self, save: bool, cx: &mut Context<Self>) {
        if self.exporting {
            return;
        }
        self.exporting = true;
        self.status = if save {
            "Choose an export destination..."
        } else {
            "Preparing clipboard..."
        }
        .into();
        let records = self.retained.clone();
        let query = self.search.read(cx).text().to_owned();
        let minimum = self.minimum;
        let dropped = self.dropped;
        let picker = save
            .then(|| cx.prompt_for_new_path(std::path::Path::new("."), Some("herdr-gpui.jsonl")));
        cx.spawn(async move |this, cx| {
            let path = match picker {
                Some(picker) => match picker.await {
                    Ok(Ok(Some(path))) => Some(path),
                    result => {
                        let cancelled = matches!(result, Ok(Ok(None)));
                        let _ = this.update(cx, |this, cx| {
                            this.exporting = false;
                            this.status = if cancelled {
                                "Export cancelled."
                            } else {
                                "Unable to open save dialog."
                            }
                            .into();
                            cx.notify();
                        });
                        return;
                    }
                },
                None => None,
            };
            let result = cx
                .background_executor()
                .spawn(async move {
                    let text = export_text(&filtered(records, &query, minimum), dropped)
                        .map_err(std::io::Error::other)?;
                    if let Some(path) = path {
                        std::fs::write(path, text).map(|()| None)
                    } else {
                        Ok(Some(text))
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.exporting = false;
                match result {
                    Ok(Some(text)) => {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                        this.status = "Filtered logs copied. Review before sharing.".into();
                    }
                    Ok(None) => {
                        this.status = "Filtered logs exported. Review before sharing.".into()
                    }
                    Err(error) => {
                        tracing::warn!(kind = ?error.kind(), "Log export failed");
                        this.status = format!("Export failed: {}", error.kind());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

fn button(id: &'static str, label: impl Into<SharedString>, theme: &Theme) -> Stateful<Div> {
    let active = theme.active;
    div()
        .id(id)
        .debug_selector(move || id.into())
        .px_2()
        .py_1()
        .rounded(px(crate::config::corners::CONTROL))
        .bg(rgb(theme.surface))
        .cursor_pointer()
        .hover(move |style| style.bg(rgb(active)))
        .child(label.into())
}

fn styled_body(record: &Record, theme: &Theme) -> StyledText {
    use std::fmt::Write;
    let mut text = record.target.clone();
    let target_end = text.len();
    for span in &record.spans {
        let _ = write!(text, " [{span}]");
    }
    let spans_end = text.len();
    if !record.message.is_empty() {
        let _ = write!(text, " {}", record.message);
    }
    let fields_start = text.len();
    for (key, value) in &record.fields {
        let _ = write!(text, " {key}={value}");
    }
    if record.truncated {
        text.push_str(" [truncated]");
    }
    let end = text.len();
    StyledText::new(text).with_highlights(
        [
            (
                0..target_end,
                HighlightStyle {
                    color: Some(palette_color(theme, 6).into()),
                    ..Default::default()
                },
            ),
            (
                target_end..spans_end,
                HighlightStyle {
                    color: Some(rgb(theme.muted).into()),
                    ..Default::default()
                },
            ),
            (
                fields_start..end,
                HighlightStyle {
                    color: Some(palette_color(theme, 4).into()),
                    ..Default::default()
                },
            ),
        ]
        .into_iter()
        .filter(|(range, _)| !range.is_empty()),
    )
}

impl Render for LogWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.following {
            self.scroll.scroll_to(ListOffset {
                item_ix: self.rows.len(),
                offset_in_item: px(0.),
            });
        }
        let header = crate::titlebar::header(&self.appearance.theme, window, |window, _| {
            window.remove_window();
        });
        let Appearance { config, theme } = &self.appearance;
        let root = div()
            .key_context("LogWindow")
            .track_focus(&self.focus)
            .on_action(cx.listener(|_, _: &Close, window, _| window.remove_window()))
            .on_action(cx.listener(|_, action: &crate::RunCommand, window, cx| {
                crate::window::run_window_command(action.command, window, cx);
            }))
            .on_action(cx.listener(|this, _: &FocusSearch, window, cx| {
                this.level_menu = None;
                window.focus(&this.search.read(cx).focus.clone(), cx);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &FocusLevel, window, cx| {
                this.level_menu = None;
                window.focus(&this.level_focus, cx);
                cx.notify();
            }))
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(theme.background))
            .text_color(rgb(theme.foreground))
            .text_font(&config.ui)
            .text_size(px(config.ui.size))
            .line_height(px(config.ui.line_height()))
            .children(header)
            .child(
                div()
                    .flex_none()
                    .p_3()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .text_size(px(config.ui.size + 4.))
                            .child("Logs"),
                    )
                    .child(self.search.clone())
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap_2()
                            .child(
                                button("minimum-level", format!("Minimum: {} v", self.minimum), theme)
                                    .track_focus(&self.level_focus)
                                    .border_1()
                                    .border_color(if self.level_focus.is_focused(window) { palette_color(theme, 4) } else { rgb(theme.active) })
                                    .on_click(cx.listener(|this, _, window, cx| this.open_levels(window, cx)))
                                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                                        if matches!(event.keystroke.key.as_str(), "enter" | "space" | "down" | "up") {
                                            cx.stop_propagation();
                                            window.prevent_default();
                                            this.open_levels(window, cx);
                                        }
                                    }))
                                    .when_some(self.level_menu, |el, selected| el.child(
                                        deferred(
                                            anchored().child(
                                                div().id("level-menu").debug_selector(|| "level-menu".into())
                                                    .absolute().top_full().left_0().w(px(180.))
                                                    .p_1().bg(rgb(theme.surface)).border_1().border_color(rgb(theme.active))
                                                    .occlude().track_focus(&self.menu_focus)
                                                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                                    .on_click(|_, _, cx| cx.stop_propagation())
                                                    .on_mouse_down_out(cx.listener(|this, _, window, cx| this.close_levels(window, cx)))
                                                    .on_key_down(cx.listener(Self::level_key))
                                                    .children(LEVELS.iter().enumerate().map(|(index, level)| {
                                                        let level = *level;
                                                        div().id(("level-option", index)).debug_selector(move || format!("level-option-{index}"))
                                                            .px_2().py_1().cursor_pointer()
                                                            .when(index == selected, |el| el.bg(rgb(theme.active)))
                                                            .child(format!("{} {}", if self.minimum == level { "*" } else { " " }, level))
                                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                                cx.stop_propagation();
                                                                this.minimum = level;
                                                                this.generation = None;
                                                                this.close_levels(window, cx);
                                                            }))
                                                    }))
                                            )
                                        ).with_priority(1)
                                    )),
                            )
                            .child(div().flex_1())
                            .child(
                                button(
                                    "follow",
                                    if self.following {
                                        "Pause"
                                    } else {
                                        "Resume tail"
                                    },
                                    theme,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.following = !this.following;
                                        this.generation = None;
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                button("copy", "Copy", theme)
                                    .on_click(cx.listener(|this, _, _, cx| this.share(false, cx))),
                            )
                            .child(
                                button(
                                    "export",
                                    if self.exporting {
                                        "Working..."
                                    } else {
                                        "Export..."
                                    },
                                    theme,
                                )
                                .on_click(cx.listener(|this, _, _, cx| this.share(true, cx))),
                            ),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .on_scroll_wheel(cx.listener(|this, _, _, cx| {
                        this.following = false;
                        cx.notify();
                    }))
                    .when(self.rows.is_empty(), |el| {
                        el.child(div().p_3().child("No matching logs."))
                    })
                    .when(!self.rows.is_empty(), |el| {
                        el.child(
                            list(
                                self.scroll.clone(),
                                cx.processor(|this, index: usize, _, cx| {
                                    let record = this.rows[index].clone();
                                    let theme = &this.appearance.theme;
                                    let font = &this.appearance.config.terminal;
                                    let active = theme.active;
                                    div()
                                        .id(index)
                                        .debug_selector(move || format!("log-row-{index}"))
                                        .flex()
                                        .w_full()
                                        .py(px(1.))
                                        .px_3()
                                        .text_color(rgb(theme.foreground))
                                        .text_font(font)
                                        .text_size(px(font.size))
                                        .line_height(px(font.line_height()))
                                        .child(
                                            div()
                                                .flex_none()
                                                .whitespace_nowrap()
                                                .text_color(rgb(theme.muted))
                                                .child(format!("{} ", record.timestamp)),
                                        )
                                        .child(
                                            div()
                                                .flex_none()
                                                .whitespace_nowrap()
                                                .text_color(severity_color(
                                                    theme,
                                                    record.level,
                                                ))
                                                .child(format!("{:<5} ", record.level.as_str())),
                                        )
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .whitespace_normal()
                                                .debug_selector(move || format!("log-body-{index}"))
                                                .child(styled_body(&record, theme)),
                                        )
                                        .cursor_pointer()
                                        .hover(move |style| style.bg(rgb(active)))
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.selected = Some(record.clone());
                                            cx.notify();
                                        }))
                                        .into_any_element()
                                }),
                            )
                            .size_full(),
                        )
                    }),
            )
            .when_some(self.selected.clone(), |el, record| {
                el.child(
                    div()
                        .id("log-detail")
                        .debug_selector(|| "log-detail".into())
                        .flex_none()
                        .h((window.viewport_size().height * 0.2).min(px(100.)))
                        .overflow_y_scroll()
                        .p_3()
                        .bg(rgb(theme.surface))
                        .text_color(severity_color(theme, record.level))
                        .text_font(&config.terminal)
                        .text_size(px(config.terminal.size))
                        .line_height(px(config.terminal.line_height()))
                        .child(record.line()),
                )
            })
            .child(
                div()
                    .flex_none()
                    .p_3()
                    .border_t_1()
                    .border_color(rgb(theme.active))
                    .truncate()
                    .child(format!(
                        "{} shown | {} dropped | {} | {}",
                        self.rows.len(),
                        self.dropped,
                        if self.following { "LIVE" } else { "PAUSED" },
                        self.status
                    )),
            );
        let border = theme.active;
        crate::titlebar::frame(window, border, root)
    }
}

/// GPUI re-measures only the rows it lays out, so rows outside the viewport
/// keep stale heights unless the list is reset when the row font changes.
fn row_metrics_changed(previous: &FontConfig, font: &FontConfig) -> bool {
    font.family != previous.family
        || font.size != previous.size
        || font.line_height() != previous.line_height()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
