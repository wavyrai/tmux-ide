//! The pane menu's process list: every process under the pane with its CPU
//! and memory, refreshed while open, and ending the chosen ones after a
//! confirmation. The worker does the listing and signalling; this side only
//! keeps what it last reported and what the user chose.

use super::PaneMenu;
use crate::{
    HerdrWindow,
    menu::Page,
    processes::{Identity, Listing, Outcome, Refusal, Update, Watch},
};
use gpui::{prelude::*, *};
use std::collections::BTreeSet;

pub(crate) struct PaneProcesses {
    /// None once the list stopped updating.
    watch: Option<Watch>,
    listing: Option<Listing>,
    /// Exactly the processes the user chose, pid and start time.
    chosen: BTreeSet<Identity>,
    /// The keyboard's row, kept in view.
    cursor: Option<usize>,
    scroll: ScrollHandle,
    error: Option<String>,
    /// What the last kill did.
    report: Option<String>,
    /// A kill is with the worker.
    ending: bool,
}

impl PaneProcesses {
    pub(super) fn new(watch: Watch) -> Self {
        Self {
            watch: Some(watch),
            listing: None,
            chosen: BTreeSet::new(),
            cursor: None,
            scroll: ScrollHandle::new(),
            error: None,
            report: None,
            ending: false,
        }
    }

    fn stop(&mut self, error: &crate::Error) {
        self.watch = None;
        self.ending = false;
        self.error = Some(describe(error));
    }

    fn apply(&mut self, update: Update) {
        match update {
            Update::Listing(Ok(listing)) => {
                // A chosen process that exited, or whose pid now names
                // another, is no longer offered for ending.
                self.chosen.retain(|identity| listing.contains(*identity));
                self.cursor = self
                    .cursor
                    .map(|cursor| cursor.min(listing.rows.len().saturating_sub(1)));
                self.listing = Some(listing);
                self.error = None;
            }
            Update::Listing(Err(error)) => self.error = Some(describe(&error)),
            Update::Killed(outcomes) => {
                self.ending = false;
                for (identity, outcome) in &outcomes {
                    if *outcome == Outcome::Signalled {
                        self.chosen.remove(identity);
                    }
                }
                self.report = Some(report(&outcomes));
            }
        }
    }

    /// Whether `identity` can be chosen: listed, and not the pane's own process.
    fn choosable(&self, identity: Identity) -> bool {
        self.listing
            .as_ref()
            .is_some_and(|listing| listing.root() != Some(identity) && listing.contains(identity))
    }

    fn toggle(&mut self, identity: Identity) {
        if !self.chosen.remove(&identity) && self.choosable(identity) {
            self.chosen.insert(identity);
        }
    }

    /// The chosen rows, in the tree's order, for the confirmation.
    fn chosen_rows(&self) -> impl Iterator<Item = &crate::processes::Row> {
        self.listing
            .iter()
            .flat_map(|listing| &listing.rows)
            .filter(|row| self.chosen.contains(&row.entry.identity))
    }
}

/// The display boundary: the message, then each cause.
fn describe(error: &crate::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        text.push(' ');
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

fn report(outcomes: &[(Identity, Outcome)]) -> String {
    let count = |wanted: fn(&Outcome) -> bool| outcomes.iter().filter(|(_, o)| wanted(o)).count();
    let plural = |n: usize| if n == 1 { "process" } else { "processes" };
    let mut parts = Vec::new();
    let signalled = count(|o| *o == Outcome::Signalled);
    if signalled > 0 {
        parts.push(format!("Asked {signalled} {} to quit.", plural(signalled)));
    }
    let exited = count(|o| *o == Outcome::Refused(Refusal::Exited));
    if exited > 0 {
        parts.push(format!("{exited} had already exited."));
    }
    let moved = count(|o| {
        matches!(
            o,
            Outcome::Refused(Refusal::Elsewhere | Refusal::Root | Refusal::RootExited)
        )
    });
    if moved > 0 {
        parts.push(format!("{moved} no longer under this pane, left running."));
    }
    let failed = count(|o| *o == Outcome::Failed);
    if failed > 0 {
        parts.push(format!("{failed} could not be signalled."));
    }
    parts.join(" ")
}

/// Share of one core: whole percents once they are large.
pub(super) fn cpu_text(cpu: Option<f32>) -> String {
    match cpu {
        None => "–".into(),
        Some(cpu) if cpu < 9.95 => format!("{cpu:.1}%"),
        Some(cpu) => format!("{cpu:.0}%"),
    }
}

pub(super) fn memory_text(bytes: u64) -> String {
    const MIB: f64 = (1u64 << 20) as f64;
    let mib = bytes as f64 / MIB;
    if mib >= 1024. {
        format!("{:.1} GB", mib / 1024.)
    } else if mib >= 10. {
        format!("{mib:.0} MB")
    } else {
        format!("{mib:.1} MB")
    }
}

impl HerdrWindow {
    pub(super) fn open_pane_processes(&mut self, cx: &mut Context<Self>) {
        let Some(pane) = &mut self.menu.pane else {
            return;
        };
        let Some(daemon) = pane.daemon.clone() else {
            return;
        };
        match Watch::start(daemon, pane.target.pane.clone()) {
            Ok(watch) => self.show_pane_processes(watch, cx),
            Err(error) => {
                pane.error = Some(describe(&error));
                cx.notify();
            }
        }
    }

    pub(super) fn show_pane_processes(&mut self, watch: Watch, cx: &mut Context<Self>) {
        let Some(pane) = &mut self.menu.pane else {
            return;
        };
        pane.processes = Some(PaneProcesses::new(watch));
        pane.error = None;
        self.menu.page = Some(Page::PaneProcesses);
        cx.notify();
    }

    /// Takes the worker's answers, and stops it once the pane or the
    /// connection it belongs to is gone.
    pub(crate) fn poll_pane_processes(&mut self, cx: &mut Context<Self>) {
        if self
            .menu
            .pane
            .as_ref()
            .and_then(|pane| pane.processes.as_ref())
            .is_none_or(|processes| processes.watch.is_none())
        {
            return;
        }
        let current = self.validate_pane_target().map(drop);
        let Some(processes) = self
            .menu
            .pane
            .as_mut()
            .and_then(|pane| pane.processes.as_mut())
        else {
            return;
        };
        if let Err(error) = current {
            processes.stop(&error);
            self.leave_kill_confirmation();
            cx.notify();
            return;
        }
        let mut changed = false;
        while let Some(watch) = &processes.watch {
            match watch.try_update() {
                Ok(Some(update)) => {
                    let killed = matches!(update, Update::Killed(_));
                    processes.apply(update);
                    changed = true;
                    if killed {
                        self.leave_kill_confirmation();
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    processes.stop(&error);
                    changed = true;
                }
            }
        }
        if changed {
            cx.notify();
        }
    }

    fn leave_kill_confirmation(&mut self) {
        if self.menu.page == Some(Page::KillProcesses) {
            self.menu.page = Some(Page::PaneProcesses);
        }
    }

    fn pane_processes(&mut self) -> Option<&mut PaneProcesses> {
        self.menu.pane.as_mut()?.processes.as_mut()
    }

    fn toggle_pane_process(&mut self, identity: Identity, cx: &mut Context<Self>) {
        if let Some(processes) = self.pane_processes() {
            processes.toggle(identity);
            cx.notify();
        }
    }

    fn confirm_pane_processes(&mut self, cx: &mut Context<Self>) {
        if self
            .pane_processes()
            .is_some_and(|processes| !processes.chosen.is_empty() && !processes.ending)
        {
            self.menu.page = Some(Page::KillProcesses);
            cx.notify();
        }
    }

    fn end_pane_processes(&mut self, cx: &mut Context<Self>) {
        let current = self.validate_pane_target().map(drop);
        let Some(processes) = self.pane_processes() else {
            return;
        };
        if processes.ending || processes.chosen.is_empty() {
            return;
        }
        let sent = current.and_then(|()| {
            processes
                .watch
                .as_ref()
                .ok_or(crate::Error::ProcessesStopped)?
                .kill(processes.chosen.iter().copied().collect())
        });
        match sent {
            Ok(()) => {
                processes.ending = true;
                processes.report = None;
            }
            Err(error) => processes.error = Some(describe(&error)),
        }
        self.leave_kill_confirmation();
        cx.notify();
    }

    /// Keys on the process pages; false for keys they leave alone.
    pub(super) fn pane_processes_key(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let confirming = self.menu.page == Some(Page::KillProcesses);
        let Some(processes) = self.pane_processes() else {
            return false;
        };
        match key {
            "escape" if confirming => self.leave_kill_confirmation(),
            "enter" if confirming => self.end_pane_processes(cx),
            "enter" => self.confirm_pane_processes(cx),
            "up" | "down" if !confirming => {
                let count = processes.listing.as_ref().map_or(0, |l| l.rows.len());
                if count == 0 {
                    return true;
                }
                processes.cursor = Some(match (processes.cursor, key) {
                    (None, "up") => count - 1,
                    (None, _) => 0,
                    (Some(i), "up") => (i + count - 1) % count,
                    (Some(i), _) => (i + 1) % count,
                });
                if let Some(cursor) = processes.cursor {
                    processes.scroll.scroll_to_item(cursor);
                }
            }
            "space" if !confirming => {
                if let Some(identity) = processes.cursor.and_then(|cursor| {
                    processes
                        .listing
                        .as_ref()?
                        .rows
                        .get(cursor)
                        .map(|row| row.entry.identity)
                }) {
                    processes.toggle(identity);
                }
            }
            _ => return false,
        }
        cx.notify();
        true
    }

    pub(super) fn render_pane_processes(&self, pane: &PaneMenu, cx: &mut Context<Self>) -> Div {
        let Some(processes) = &pane.processes else {
            return div();
        };
        let theme = &self.theme;
        let muted = rgb(theme.muted);
        let title = if pane.target.label.is_empty() {
            "Processes".to_owned()
        } else {
            format!("Processes in {}", pane.target.label)
        };
        let mut body = div().p(px(8.)).flex().flex_col().gap(px(8.)).child(
            div()
                .flex()
                .items_baseline()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title),
                )
                .when_some(processes.listing.as_ref(), |header, listing| {
                    header.child(
                        div()
                            .debug_selector(|| "pane-processes-total".into())
                            .flex_none()
                            .text_color(muted)
                            .child(format!(
                                "{} · {}",
                                cpu_text(Some(listing.cpu)),
                                memory_text(listing.memory)
                            )),
                    )
                }),
        );
        let mut list = div()
            .id("pane-processes-list")
            .flex()
            .flex_col()
            .max_h(px(360.))
            .overflow_y_scroll()
            .track_scroll(&processes.scroll);
        match &processes.listing {
            None if processes.error.is_none() => {
                list = list.child(div().text_color(muted).child("Listing processes…"));
            }
            None => {}
            Some(listing) => {
                let root = listing.root();
                for (index, row) in listing.rows.iter().enumerate() {
                    let identity = row.entry.identity;
                    let chosen = processes.chosen.contains(&identity);
                    let choosable = Some(identity) != root;
                    list = list.child(
                        div()
                            .id(("pane-process", index))
                            .debug_selector(move || format!("pane-process-{index}"))
                            .min_h(px(self.config.ui.line_height() + 8.))
                            .px(px(6.))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .rounded(px(crate::config::corners::CONTROL))
                            .when(processes.cursor == Some(index), |row| {
                                row.bg(rgb(theme.active))
                            })
                            .when(choosable, |row| {
                                row.cursor_pointer()
                                    .hover(|row| row.bg(rgb(theme.active)))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.toggle_pane_process(identity, cx)
                                    }))
                            })
                            .child(
                                // The pane's own process ends with the pane.
                                div()
                                    .size(px(12.))
                                    .flex_none()
                                    .rounded(px(3.))
                                    .when(choosable, |mark| {
                                        mark.border_1().border_color(if chosen {
                                            crate::menu::danger(theme)
                                        } else {
                                            muted
                                        })
                                    })
                                    .when(chosen, |mark| mark.bg(crate::menu::danger(theme))),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .pl(px(12. * row.depth.min(8) as f32))
                                    .flex()
                                    .gap(px(6.))
                                    .overflow_hidden()
                                    .child(div().flex_none().child(row.entry.name.clone()))
                                    .when(row.foreground, |line| {
                                        line.child(
                                            div()
                                                .flex_none()
                                                .text_color(crate::menu::accent(theme))
                                                .child("foreground"),
                                        )
                                    })
                                    .child(
                                        div()
                                            .min_w_0()
                                            .truncate()
                                            .text_color(muted)
                                            .child(row.entry.command.clone()),
                                    ),
                            )
                            .child(
                                div()
                                    .w(px(44.))
                                    .flex_none()
                                    .text_right()
                                    .text_color(muted)
                                    .child(identity.pid.to_string()),
                            )
                            .child(
                                div()
                                    .w(px(48.))
                                    .flex_none()
                                    .text_right()
                                    .child(cpu_text(row.entry.cpu)),
                            )
                            .child(
                                div()
                                    .w(px(64.))
                                    .flex_none()
                                    .text_right()
                                    .child(memory_text(row.entry.memory)),
                            ),
                    );
                }
                if listing.hidden > 0 {
                    list = list.child(
                        div()
                            .px(px(6.))
                            .text_color(muted)
                            .child(format!("{} more not shown", listing.hidden)),
                    );
                }
            }
        }
        body = body.child(list);
        let status = processes
            .error
            .clone()
            .or_else(|| processes.ending.then(|| "Ending processes…".to_owned()))
            .or_else(|| processes.report.clone());
        let count = processes.chosen.len();
        body.when_some(status, |body, status| {
            body.child(
                div()
                    .debug_selector(|| "pane-processes-status".into())
                    .text_color(muted)
                    .child(status),
            )
        })
        .child(
            div().flex().justify_end().child(
                div()
                    .id("pane-processes-end")
                    .debug_selector(|| "pane-processes-end".into())
                    .px(px(12.))
                    .py(px(6.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .when(count > 0 && !processes.ending, |button| {
                        button
                            .bg(rgb(theme.active))
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, _, cx| this.confirm_pane_processes(cx)))
                    })
                    .when(count == 0 || processes.ending, |button| {
                        button.text_color(muted)
                    })
                    .child(match count {
                        0 => "End Process…".to_owned(),
                        1 => "End 1 Process…".to_owned(),
                        n => format!("End {n} Processes…"),
                    }),
            ),
        )
    }

    pub(super) fn render_kill_processes(&self, pane: &PaneMenu, cx: &mut Context<Self>) -> Div {
        let Some(processes) = &pane.processes else {
            return div();
        };
        let theme = &self.theme;
        let count = processes.chosen.len();
        let noun = if count == 1 { "process" } else { "processes" };
        div()
            .p(px(12.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .text_size(px(self.config.ui.size * 1.35))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(format!("End {count} {noun}?")),
            )
            .child(div().flex().flex_col().children(processes.chosen_rows().map(
                |row| {
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(div().flex_none().child(row.entry.name.clone()))
                        .child(
                            div()
                                .flex_none()
                                .text_color(rgb(theme.muted))
                                .child(format!("pid {}", row.entry.identity.pid)),
                        )
                },
            )))
            .child(div().text_color(rgb(theme.subtext())).child(
                "Each is asked to quit (SIGTERM), and may lose unsaved work. Processes they started keep running unless chosen too.",
            ))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("pane-processes-cancel")
                            .debug_selector(|| "pane-processes-cancel".into())
                            .px(px(12.))
                            .py(px(6.))
                            .rounded(px(crate::config::corners::CONTROL))
                            .border_1()
                            .border_color(rgb(theme.active))
                            .cursor_pointer()
                            .hover(|s| s.bg(rgb(theme.active)))
                            .child("Cancel")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.leave_kill_confirmation();
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("pane-processes-confirm")
                            .debug_selector(|| "pane-processes-confirm".into())
                            .px(px(12.))
                            .py(px(6.))
                            .rounded(px(crate::config::corners::CONTROL))
                            .bg(rgb(theme.active))
                            .text_color(crate::menu::danger(theme))
                            .cursor_pointer()
                            .child(if count == 1 {
                                "End Process".to_owned()
                            } else {
                                format!("End {count} Processes")
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.end_pane_processes(cx))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests;
