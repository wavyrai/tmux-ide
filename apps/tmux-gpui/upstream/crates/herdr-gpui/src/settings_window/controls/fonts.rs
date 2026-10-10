//! Compact per-role controls and a root-level, transient family chooser.
use super::*;
use crate::{config::FontConfig, fonts::StyledFont};

#[cfg(all(feature = "integration-test", target_os = "macos"))]
#[derive(Default)]
struct NativeBounds(std::collections::HashMap<String, Bounds<Pixels>>);
#[cfg(all(feature = "integration-test", target_os = "macos"))]
impl Global for NativeBounds {}

#[cfg(all(feature = "integration-test", target_os = "macos"))]
fn native_probe(id: impl Into<String>) -> impl IntoElement {
    let id = id.into();
    canvas(
        |_, _, _| (),
        move |bounds, _, _, cx| {
            cx.default_global::<NativeBounds>()
                .0
                .insert(id.clone(), bounds);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

#[cfg(all(feature = "integration-test", target_os = "macos"))]
impl SettingsWindow {
    pub(in crate::settings_window) fn native_font_bounds(
        &self,
        id: &str,
        cx: &App,
    ) -> Option<Bounds<Pixels>> {
        cx.try_global::<NativeBounds>()?.0.get(id).copied()
    }

    pub(in crate::settings_window) fn native_font_search(
        &self,
        cx: &App,
    ) -> (FocusHandle, String, usize, usize, bool) {
        let input = self.controls.search.read(cx);
        (
            input.focus.clone(),
            input.text().to_owned(),
            self.controls.filtered.len(),
            self.controls.names.len(),
            self.controls.discovering,
        )
    }

    pub(in crate::settings_window) fn native_font_selection(
        &self,
    ) -> (Option<FontTarget>, FontFace, FontConfig) {
        (
            self.controls.picker,
            self.controls.active_face,
            self.control_specimen_font(),
        )
    }

    pub(in crate::settings_window) fn native_font_editor(
        &self,
        cx: &App,
    ) -> Option<(FocusHandle, String)> {
        let input = self.controls.size_editor.as_ref()?.input.read(cx);
        Some((input.focus.clone(), input.text().to_owned()))
    }

    pub(in crate::settings_window) fn native_font_sizes_idle(&self) -> bool {
        self.controls.pending_sizes.is_empty() && self.controls.saving_sizes.is_empty()
    }
}

#[cfg(test)]
type FamilyWriter = dyn Fn(FontTarget, Option<String>) -> crate::Result<()> + Send + Sync;

#[cfg(test)]
#[derive(Clone)]
pub(super) struct FamilyIo {
    write: std::sync::Arc<FamilyWriter>,
    load: std::sync::Arc<dyn Fn() -> crate::Result<super::super::Loaded> + Send + Sync>,
}

fn face_font(config: &Config, face: FontFace) -> &FontConfig {
    match face {
        FontFace::Terminal => &config.terminal,
        FontFace::Sidebar => &config.sidebar,
        FontFace::Tabs => &config.tabs,
        FontFace::Ui => &config.ui,
    }
}

fn family_label(family: &str) -> &str {
    if family == ".SystemUIFont" {
        "System font"
    } else {
        family
    }
}

fn role_label(face: FontFace) -> &'static str {
    match face {
        FontFace::Terminal => "Terminal",
        FontFace::Sidebar => "Sidebar",
        FontFace::Tabs => "Tabs",
        FontFace::Ui => "Interface",
    }
}

impl SettingsWindow {
    pub(in crate::settings_window) fn open_control_font_picker(
        &mut self,
        target: FontTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.finish_control_size_edit(true, cx) {
            self.finish_control_size_edit(false, cx);
        }
        if let FontTarget::Face(face) = target {
            self.controls.active_face = face;
        }
        self.controls.picker = Some(target);
        self.controls.search.update(cx, |input, cx| input.clear(cx));
        self.controls.filtered = filter_fonts(&self.controls.names, "");
        self.controls.selected = 0;
        self.controls.scroll.scroll_to_item(0, ScrollStrategy::Top);
        window.focus(&self.controls.search.read(cx).focus.clone(), cx);
        cx.notify();
    }

    pub(in crate::settings_window) fn dismiss_control_font_picker(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.controls.picker.take().is_some() {
            window.focus(&self.focus, cx);
            cx.notify();
        }
    }

    fn commit_control_family(
        &mut self,
        target: FontTarget,
        family: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Rendered callbacks own their target, never a later row's mutable selection.
        if self.busy() || self.controls.picker != Some(target) {
            return;
        }
        self.dismiss_control_font_picker(window, cx);
        #[cfg(test)]
        if let Some(io) = self.controls.family_io.clone() {
            self.save_with(
                move || (io.write)(target, family),
                move || (io.load)(),
                false,
                cx,
            );
            return;
        }
        self.save_native(
            move || match target {
                FontTarget::All => Config::save_all_font_families(family.as_deref()),
                FontTarget::Face(face) => Config::save_font_family(face, family.as_deref()),
            },
            cx,
        );
    }

    fn control_font_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(target) = self.controls.picker else {
            return;
        };
        let key = event.keystroke.key.as_str();
        if !matches!(key, "up" | "down" | "enter" | "escape") {
            return;
        }
        cx.stop_propagation();
        if self.controls.search.read(cx).is_composing() {
            return;
        }
        window.prevent_default();
        match key {
            "escape" => self.dismiss_control_font_picker(window, cx),
            "enter" => {
                if let Some(index) = self.controls.filtered.get(self.controls.selected) {
                    self.commit_control_family(
                        target,
                        Some(self.controls.names[*index].clone()),
                        window,
                        cx,
                    );
                }
            }
            _ => {
                self.controls.selected = if key == "up" {
                    self.controls.selected.saturating_sub(1)
                } else {
                    (self.controls.selected + 1).min(self.controls.filtered.len().saturating_sub(1))
                };
                self.controls
                    .scroll
                    .scroll_to_item(self.controls.selected, ScrollStrategy::Top);
                cx.notify();
            }
        }
    }

    fn font_button(&self, id: String, label: impl Into<SharedString>) -> Stateful<Div> {
        let selector = id.clone();
        #[cfg(all(feature = "integration-test", target_os = "macos"))]
        let probe = native_probe(id.clone());
        div()
            .id(id)
            .debug_selector(move || selector.clone())
            .flex()
            .items_center()
            .justify_center()
            .h(px(28.))
            .px(px(8.))
            .min_w_0()
            .rounded(px(corners::CONTROL))
            .cursor_pointer()
            .hover(|style| style.bg(rgb(self.theme.active)))
            .child(label.into())
            .map(|button| {
                #[cfg(all(feature = "integration-test", target_os = "macos"))]
                let button = button.child(probe);
                button
            })
    }

    fn render_font_stepper(&self, face: FontFace, cx: &Context<Self>) -> Div {
        let size = self.controls.size(face, &self.config);
        let mut buttons = div()
            .flex()
            .items_center()
            .flex_none()
            .w(px(104.))
            .h(px(32.))
            .border_1()
            .border_color(rgb(self.theme.active))
            .rounded(px(corners::CONTROL));
        for (symbol, step, enabled) in [("-", -1., size > 8.), ("+", 1., size < 48.)] {
            if step > 0. {
                buttons = buttons.child(match &self.controls.size_editor {
                    Some(editor) if editor.face == face => div()
                        .flex_1()
                        .min_w_0()
                        .on_key_down(cx.listener(Self::control_size_key))
                        .when(editor.invalid, |field| {
                            field.border_b_1().border_color(rgb(self.theme.primary()))
                        })
                        .child(editor.input.clone())
                        .into_any_element(),
                    _ => div()
                        .id(format!("settings-size-value-{}", face.name()))
                        .debug_selector(move || format!("settings-size-value-{}", face.name()))
                        .flex_1()
                        .min_w_0()
                        .text_center()
                        .cursor_pointer()
                        .child(size.to_string())
                        .map(|value| {
                            #[cfg(all(feature = "integration-test", target_os = "macos"))]
                            let value = value.child(native_probe(format!(
                                "settings-size-value-{}",
                                face.name()
                            )));
                            value
                        })
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.begin_control_size_edit(face, window, cx);
                        }))
                        .into_any_element(),
                });
            }
            buttons = buttons.child(
                self.font_button(format!("settings-size-{}-{symbol}", face.name()), symbol)
                    .w(px(28.))
                    .px_0()
                    .flex_none()
                    .when(!enabled, |button| button.opacity(0.5))
                    .when(enabled, |button| {
                        button.on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            if !this.finish_control_size_edit(true, cx) {
                                this.finish_control_size_edit(false, cx);
                            }
                            window.focus(&this.focus, cx);
                            this.step_control_size(face, step, cx);
                        }))
                    }),
            );
        }
        #[cfg(all(feature = "integration-test", target_os = "macos"))]
        let buttons = buttons.child(native_probe(format!("settings-size-{}", face.name())));
        buttons
    }

    fn control_specimen_font(&self) -> FontConfig {
        let face = self.controls.active_face;
        let mut font = face_font(&self.config, face).clone();
        font.size = self.controls.size(face, &self.config);
        font
    }

    pub(super) fn render_font_controls(&self, cx: &mut Context<Self>) -> Div {
        #[cfg(all(feature = "integration-test", target_os = "macos"))]
        cx.default_global::<NativeBounds>().0.clear();
        let mut rows = div()
            .debug_selector(|| "settings-font-rows".into())
            .flex()
            .flex_col()
            .min_w_0()
            .gap(px(8.))
            .child(
                div().flex().justify_end().child(
                    self.font_button("settings-font-all".into(), "Set all fonts...")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_control_font_picker(FontTarget::All, window, cx)
                        })),
                ),
            );
        for (face, label) in FACES {
            rows = rows.child(
                div()
                    .id(format!("settings-font-row-{}", face.name()))
                    .map(|row| {
                        #[cfg(all(feature = "integration-test", target_os = "macos"))]
                        let row =
                            row.child(native_probe(format!("settings-font-row-{}", face.name())));
                        row
                    })
                    .debug_selector(move || format!("settings-font-row-{}", face.name()))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .h(px(52.))
                    .flex_none()
                    .px(px(8.))
                    .min_w_0()
                    .rounded(px(corners::CONTROL))
                    .border_1()
                    .border_color(rgb(if face == self.controls.active_face {
                        self.theme.primary()
                    } else {
                        self.theme.active
                    }))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.controls.active_face = face;
                        cx.notify();
                    }))
                    .child(div().w(px(64.)).flex_none().child(label))
                    .child(
                        self.font_button(format!("settings-font-family-{}", face.name()), "")
                            .flex_1()
                            .justify_between()
                            .gap(px(6.))
                            .border_1()
                            .border_color(rgb(self.theme.active))
                            .bg(rgb(self.theme.background))
                            .child(div().min_w_0().flex_1().truncate().child(
                                family_label(&face_font(&self.config, face).family).to_owned(),
                            ))
                            .child(
                                svg()
                                    .path("icons/chevron-down.svg")
                                    .size(px(12.))
                                    .flex_none()
                                    .text_color(rgb(self.theme.muted)),
                            )
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.open_control_font_picker(FontTarget::Face(face), window, cx);
                            })),
                    )
                    .child(self.render_font_stepper(face, cx)),
            );
        }
        let font = self.control_specimen_font();
        let sample = match self.controls.active_face {
            FontFace::Terminal => "let answer = 42;\nif answer != 0 {\n    println!(\"ready\");\n}",
            FontFace::Sidebar => {
                "herdr-gpui / workspace\n  claude  Working\n  codex   Ready for review"
            }
            FontFace::Tabs => "main.rs   agent / review\nChanges   Terminal   Preview",
            FontFace::Ui => "Make room for focused work.\nYour preferences, your workspace.",
        };
        rows.child(
            div()
                .debug_selector(|| "settings-font-specimen".into())
                .map(|specimen| {
                    #[cfg(all(feature = "integration-test", target_os = "macos"))]
                    let specimen = specimen.child(native_probe("settings-font-specimen"));
                    specimen
                })
                .mt(px(16.))
                .flex()
                .flex_col()
                .min_w_0()
                .overflow_hidden()
                .gap(px(20.))
                .p(px(20.))
                .rounded(px(corners::CONTROL))
                .bg(rgb(self.theme.surface))
                .child(self.control_note(format!(
                    "{} / {} px",
                    role_label(self.controls.active_face),
                    font.size
                )))
                .child(
                    div()
                        .text_font(&font)
                        .text_size(px(font.size))
                        .line_height(px(font.line_height()))
                        .child(sample),
                )
                .child(
                    div()
                        .text_font(&font)
                        .text_size(px(font.size))
                        .line_height(px(font.line_height()))
                        .child("0O 1lI {} [] != <="),
                ),
        )
    }

    pub(in crate::settings_window) fn render_control_font_picker(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        if self.section != Section::Fonts {
            return None;
        }
        let target = self.controls.picker?;
        let label = match target {
            FontTarget::All => "All roles",
            FontTarget::Face(face) => role_label(face),
        };
        let list_height = (f32::from(window.viewport_size().height) - 340.).clamp(84., 336.);
        Some(
            div()
                .absolute()
                .top(px(36.))
                .bottom(px(36.))
                .left(px(184.))
                .right_0()
                .occlude()
                .bg(rgb(self.theme.background).opacity(0.75))
                .child(
                    div()
                        .id("settings-font-backdrop")
                        .absolute()
                        .inset_0()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.dismiss_control_font_picker(window, cx);
                            }),
                        ),
                )
                .child(
                    div()
                        .absolute()
                        .top(px(64.))
                        .left(px(20.))
                        .right(px(20.))
                        .occlude()
                        .id("settings-font-picker")
                        .debug_selector(|| "settings-font-picker".into())
                        .map(|picker| {
                            #[cfg(all(feature = "integration-test", target_os = "macos"))]
                            let picker = picker.child(native_probe("settings-font-picker"));
                            picker
                        })
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_key_down(cx.listener(Self::control_font_key))
                        .p(px(16.))
                        .flex()
                        .flex_col()
                        .min_w_0()
                        .gap(px(12.))
                        .rounded(px(corners::PANEL))
                        .border_1()
                        .border_color(rgb(self.theme.active))
                        .bg(rgb(self.theme.surface))
                        .shadow_lg()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .child(format!("Font family / {label}"))
                                .child(
                                    self.font_button("settings-font-picker-close".into(), "Close")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.dismiss_control_font_picker(window, cx)
                                        })),
                                ),
                        )
                        .child(
                            div()
                                .debug_selector(|| "settings-font-search".into())
                                .map(|search| {
                                    #[cfg(all(feature = "integration-test", target_os = "macos"))]
                                    let search = search.child(native_probe("settings-font-search"));
                                    search
                                })
                                .child(self.controls.search.clone()),
                        )
                        .child(self.control_note(if self.controls.discovering {
                            "Loading installed fonts...".into()
                        } else {
                            format!(
                                "{} of {} installed families",
                                self.controls.filtered.len(),
                                self.controls.names.len()
                            )
                        }))
                        .child(
                            uniform_list(
                                "settings-font-results",
                                self.controls.filtered.len(),
                                cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                                    range
                                        .map(|index| {
                                            let family = this.controls.names
                                                [this.controls.filtered[index]]
                                                .clone();
                                            this.font_button(
                                                format!("settings-font-result-{index}"),
                                                "",
                                            )
                                            .w_full()
                                            .h(px(28.))
                                            .justify_start()
                                            .overflow_hidden()
                                            .when(index == this.controls.selected, |row| {
                                                row.bg(rgb(this.theme.active))
                                            })
                                            .child(
                                                div()
                                                    .min_w_0()
                                                    .truncate()
                                                    .child(family_label(&family).to_owned()),
                                            )
                                            .on_click(
                                                cx.listener(move |this, _, window, cx| {
                                                    this.commit_control_family(
                                                        target,
                                                        Some(family.clone()),
                                                        window,
                                                        cx,
                                                    );
                                                }),
                                            )
                                        })
                                        .collect()
                                }),
                            )
                            .debug_selector(|| "settings-font-results".into())
                            .h(px(list_height))
                            .track_scroll(&self.controls.scroll)
                            .map(|list| {
                                #[cfg(all(feature = "integration-test", target_os = "macos"))]
                                let list = div()
                                    .h(px(list_height))
                                    .child(native_probe("settings-font-results"))
                                    .child(list);
                                list
                            }),
                        )
                        .when(
                            !self.controls.discovering && self.controls.filtered.is_empty(),
                            |panel| panel.child(self.control_note("No matching fonts.")),
                        )
                        .child(
                            self.font_button(
                                "settings-font-default".into(),
                                format!("Use platform default family / {label}"),
                            )
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.commit_control_family(target, None, window, cx)
                                },
                            )),
                        ),
                ),
        )
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
