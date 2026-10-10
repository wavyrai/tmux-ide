//! Per-repository setup, run, and archive scripts for worktrees.
//!
//! A repository commits its scripts in `.herdr/worktree.toml` (see
//! [`config`]); this client keeps which of those files the user trusts (see
//! [`trust`]). The setup script runs when a new worktree is created, the run
//! script from the workspace menu, and the archive script before a checkout is
//! removed. Every script runs in a new, focused tab of its checkout (see
//! [`launch`]), never in the background, and only once the user has reviewed
//! and trusted that exact file for that repository on that host.
//!
//! One script starts at a time. Its job is fenced by the selection epoch and
//! connection generation it began under, like a menu action, so a reply from
//! a replaced connection never opens a tab or types into one.

mod config;
mod launch;
mod trust;

pub(crate) use config::{Config, read as read_config};
pub(crate) use launch::{Checkout, main_checkout};
pub(crate) use trust::{Grant, Trust};

use crate::{HerdrWindow, NavigationTarget, menu::Page, window::Flash};
use gpui::{prelude::*, *};
use herdr_client::{Method, protocol::ClientPaneInputEvent};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// The scripts a repository can define.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScriptKind {
    /// Prepares a new worktree: installs dependencies, copies `.env`, links.
    Setup,
    /// Starts the project, on request.
    Run,
    /// Cleans up before the checkout is removed.
    Archive,
}

impl ScriptKind {
    pub(crate) const ALL: [Self; 3] = [Self::Setup, Self::Run, Self::Archive];

    /// The key in `[scripts]`, also the label of the tab it runs in.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Run => "run",
            Self::Archive => "archive",
        }
    }
}

/// What a script job runs, and where.
#[derive(Debug, Clone)]
pub(crate) struct Launch {
    pub(crate) kind: ScriptKind,
    /// Selection epoch and connection generation, as menu actions are fenced.
    pub(crate) endpoint: (u64, u64),
    pub(crate) endpoint_id: String,
    pub(crate) boot: String,
    pub(crate) workspace: String,
    /// The repository's name, for the trust question.
    pub(crate) repo: String,
    pub(crate) repo_key: String,
    /// Asked of the daemon first when unknown.
    pub(crate) checkout: Option<Checkout>,
    /// An archive removes its checkout with `--force`.
    pub(crate) force: bool,
    /// Asked for by the user, so a repository without this script says so.
    /// A setup that follows a creation stays quiet instead.
    pub(crate) requested: bool,
}

impl Launch {
    fn grant(&self, config: &Config) -> Grant {
        Grant {
            endpoint: self.endpoint_id.clone(),
            repo_key: self.repo_key.clone(),
            digest: config.digest.clone(),
        }
    }
}

enum Step {
    /// The `worktree.list` that names the checkout.
    Locating(String),
    /// The file is being read on a background executor.
    Reading,
    /// Waiting for the user to trust the file; `shown` when the page opened.
    Asking {
        config: Config,
        shown: Option<std::time::Instant>,
    },
    /// The `tab.create` the script will be typed into.
    Opening(String),
}

pub(crate) struct Job {
    launch: Launch,
    step: Step,
    /// Stops a remote read once nothing waits for it; also the job's identity.
    cancel: Arc<AtomicBool>,
}

impl Drop for Job {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

/// Where the delete dialog's archive script lookup stands.
pub(crate) enum ArchiveCheck {
    Unread,
    Reading,
    Read(Option<Config>),
    Failed(crate::Error),
}

impl ArchiveCheck {
    pub(crate) fn settled(&self) -> bool {
        matches!(self, Self::Read(_) | Self::Failed(_))
    }

    /// The file, when it has an archive script to run.
    pub(crate) fn script(&self) -> Option<&Config> {
        match self {
            Self::Read(Some(config)) if config.scripts.get(ScriptKind::Archive).is_some() => {
                Some(config)
            }
            _ => None,
        }
    }
}

impl HerdrWindow {
    /// Begin `launch`: locate its checkout if need be, read its file, then run
    /// it if trusted or ask. Refused while another script is starting.
    pub(crate) fn start_worktree_script(
        &mut self,
        launch: Launch,
        cx: &mut Context<Self>,
    ) -> crate::Result<()> {
        if self.worktree_script.is_some() {
            return Err(crate::Error::WorktreeScriptsBusy);
        }
        let located = launch.checkout.is_some();
        let step = if located {
            Step::Reading
        } else {
            Step::Locating(self.endpoints[self.selected_endpoint].connection.request_script(
                &launch.boot,
                Method::WorktreeList,
                serde_json::json!({"workspace_id": launch.workspace, "trust_repository": false}),
            )?)
        };
        self.worktree_script = Some(Job {
            launch,
            step,
            cancel: Arc::new(AtomicBool::new(false)),
        });
        if located {
            self.read_worktree_scripts(cx);
        }
        Ok(())
    }

    /// Begin an archive whose file the delete dialog already read: run it if
    /// trusted, else ask, and remove the checkout only through the script.
    pub(crate) fn start_archive_script(
        &mut self,
        launch: Launch,
        config: Config,
        cx: &mut Context<Self>,
    ) -> crate::Result<()> {
        if self.worktree_script.is_some() {
            return Err(crate::Error::WorktreeScriptsBusy);
        }
        self.worktree_script = Some(Job {
            launch,
            step: Step::Reading,
            cancel: Arc::new(AtomicBool::new(false)),
        });
        let offered = self.offer_worktree_script(config, cx);
        if offered.is_err() {
            self.worktree_script = None;
        }
        offered
    }

    fn read_worktree_scripts(&mut self, cx: &mut Context<Self>) {
        let Some(job) = &self.worktree_script else {
            return;
        };
        let Some(checkout) = job.launch.checkout.as_ref().map(|c| c.path.clone()) else {
            return;
        };
        let target = self.endpoints[self.selected_endpoint]
            .connection
            .target
            .clone();
        let token = job.cancel.clone();
        let cancel = job.cancel.clone();
        let read = cx
            .background_executor()
            .spawn(async move { config::read(&target, &checkout, &cancel) });
        cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |this, cx| {
                let current = this
                    .worktree_script
                    .as_ref()
                    .is_some_and(|job| Arc::ptr_eq(&job.cancel, &token));
                if current {
                    this.worktree_scripts_read(result, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn worktree_scripts_read(
        &mut self,
        result: crate::Result<Option<Config>>,
        cx: &mut Context<Self>,
    ) {
        let Some(job) = &self.worktree_script else {
            return;
        };
        let (kind, requested) = (job.launch.kind, job.launch.requested);
        let config = match result {
            Ok(config) => config.filter(|config| config.scripts.get(kind).is_some()),
            // A setup nobody asked for stays quiet where no file can be read,
            // or every worktree on that host would report it.
            Err(crate::Error::WorktreeScriptsUnsupportedHost) if !requested => {
                self.worktree_script = None;
                return;
            }
            Err(error) => return self.fail_worktree_script(error, cx),
        };
        let Some(config) = config else {
            self.worktree_script = None;
            if requested {
                self.show_flash(
                    Flash::warning(format!("No {} script in {}", kind.name(), config::PATH)),
                    cx,
                );
            }
            return;
        };
        if let Err(error) = self.offer_worktree_script(config, cx) {
            self.fail_worktree_script(error, cx);
        }
    }

    /// Run a file the user already trusts, or ask about it.
    fn offer_worktree_script(
        &mut self,
        config: Config,
        cx: &mut Context<Self>,
    ) -> crate::Result<()> {
        let Some(job) = &mut self.worktree_script else {
            return Ok(());
        };
        let grant = job.launch.grant(&config);
        if cx.default_global::<Trust>().trusts(&grant) {
            return self.open_worktree_script_tab(&config);
        }
        job.step = Step::Asking {
            config,
            shown: None,
        };
        cx.notify();
        Ok(())
    }

    fn open_worktree_script_tab(&mut self, config: &Config) -> crate::Result<()> {
        let Some(job) = &mut self.worktree_script else {
            return Ok(());
        };
        let kind = job.launch.kind;
        let (Some(script), Some(checkout)) = (config.scripts.get(kind), &job.launch.checkout)
        else {
            return Err(crate::Error::WorktreeScriptsCheckout);
        };
        let request = self.endpoints[self.selected_endpoint]
            .connection
            .request_script(
                &job.launch.boot,
                Method::TabCreate,
                launch::tab_params(&job.launch.workspace, checkout, kind, script),
            )?;
        job.step = Step::Opening(request);
        Ok(())
    }

    fn fail_worktree_script(&mut self, error: crate::Error, cx: &mut Context<Self>) {
        let Some(job) = self.worktree_script.take() else {
            return;
        };
        // Kept on screen rather than flashed: a broken file needs reading.
        self.local_error = Some(format!(
            "The {} script did not start: {error}",
            job.launch.kind.name()
        ));
        cx.notify();
    }

    fn worktree_script_current(&self) -> bool {
        self.worktree_script.as_ref().is_some_and(|job| {
            job.launch.endpoint
                == (
                    self.selection_epoch,
                    self.endpoints[self.selected_endpoint].generation,
                )
                && self.live.status.is_connected()
                && self
                    .live
                    .snapshot
                    .as_ref()
                    .is_some_and(|snapshot| snapshot.boot_id == job.launch.boot)
        })
    }

    /// Advance the script job on every frame: apply the daemon's answers,
    /// open the trust question once no other page is up, and notice it closing.
    pub(crate) fn poll_worktree_script(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.worktree_script.is_none() {
            return;
        }
        if !self.worktree_script_current() {
            if self.menu.page == Some(Page::WorktreeScript) {
                self.dismiss_menu(window, cx);
            }
            return self.fail_worktree_script(crate::Error::StaleConnection, cx);
        }
        let page = self.menu.page;
        let request = match self.worktree_script.as_mut().map(|job| &mut job.step) {
            Some(Step::Locating(request) | Step::Opening(request)) => request.clone(),
            Some(Step::Asking { shown, .. }) => {
                let open = shown.is_none() && page.is_none();
                let dismissed = shown.is_some() && page != Some(Page::WorktreeScript);
                if open {
                    *shown = Some(std::time::Instant::now());
                }
                if open && self.open_menu(window, cx) {
                    self.menu.page = Some(Page::WorktreeScript);
                }
                if dismissed {
                    // Nothing runs, and an archive removes nothing.
                    self.worktree_script = None;
                }
                return;
            }
            Some(Step::Reading) | None => return,
        };
        let Some((id, Some(result))) = &self.live.script_response else {
            return;
        };
        if *id != request {
            return;
        }
        let result = result.clone();
        self.live.script_response = None;
        // Not cloned into every later update once read; a newer request's
        // slot is left alone.
        if let Ok(mut inbox) = self.endpoints[self.selected_endpoint]
            .connection
            .inbox
            .try_lock()
            && inbox
                .script_response
                .as_ref()
                .is_some_and(|(id, _)| *id == request)
        {
            inbox.script_response = None;
        }
        let response = match result {
            Ok(response) => response,
            Err(error) => {
                let error = crate::Error::WorktreeScriptsRequest(error);
                return self.fail_worktree_script(error, cx);
            }
        };
        let Some(job) = &mut self.worktree_script else {
            return;
        };
        if matches!(job.step, Step::Locating(_)) {
            match launch::locate(&response, &job.launch.workspace) {
                Ok(checkout) => {
                    job.launch.checkout = Some(checkout);
                    job.step = Step::Reading;
                    self.read_worktree_scripts(cx);
                }
                Err(error) => self.fail_worktree_script(error, cx),
            }
            return;
        }
        let (tab, pane) = match launch::created_tab(&response) {
            Ok(created) => created,
            Err(error) => return self.fail_worktree_script(error, cx),
        };
        let line = launch::command_line(job.launch.kind, job.launch.force);
        let typed = self.endpoints[self.selected_endpoint]
            .connection
            .handle
            .as_ref()
            .ok_or(crate::Error::NotConnected)
            .and_then(|handle| {
                Ok(handle.send_input(
                    &job.launch.boot,
                    &pane,
                    [
                        ClientPaneInputEvent::TextCommit(line.into()),
                        crate::menu::enter_key(),
                    ],
                )?)
            });
        if let Err(error) = typed {
            return self.fail_worktree_script(error, cx);
        }
        let endpoint = job.launch.endpoint_id.clone();
        self.worktree_script = None;
        self.navigate_endpoint(&endpoint, NavigationTarget::Tab(&tab), cx);
    }

    /// Whether the trust question has been up long enough for a click on it
    /// to be meant for it, not one aimed at what was there before it opened.
    fn worktree_script_armed(&self, now: std::time::Instant) -> bool {
        matches!(
            self.worktree_script.as_ref().map(|job| &job.step),
            Some(Step::Asking { shown: Some(shown), .. })
                if now.duration_since(*shown) >= ARMING_DELAY
        )
    }

    /// Ages an open trust question past its arming delay.
    #[cfg(test)]
    pub(crate) fn arm_worktree_script(&mut self) {
        if let Some(Job {
            step: Step::Asking { shown, .. },
            ..
        }) = &mut self.worktree_script
        {
            *shown = std::time::Instant::now().checked_sub(ARMING_DELAY);
        }
    }

    /// The trust question's primary answer: remember this file and run it.
    pub(crate) fn trust_worktree_script(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.worktree_script_armed(std::time::Instant::now()) {
            return;
        }
        let Some(Job {
            launch,
            step: Step::Asking { config, .. },
            ..
        }) = &self.worktree_script
        else {
            return;
        };
        let (grant, config) = (launch.grant(config), config.clone());
        let opened = if self.worktree_script_current() {
            cx.default_global::<Trust>().grant(grant);
            self.open_worktree_script_tab(&config)
        } else {
            Err(crate::Error::StaleConnection)
        };
        self.dismiss_menu(window, cx);
        if let Err(error) = opened {
            self.fail_worktree_script(error, cx);
        }
    }

    /// The trust question's other answer: run nothing. An archive goes on to
    /// remove the checkout without its script, as the button says.
    pub(crate) fn skip_worktree_script(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Removing without the script is consequential too.
        if !self.worktree_script_armed(std::time::Instant::now()) {
            return;
        }
        let current = self.worktree_script_current();
        let Some(job) = self.worktree_script.take() else {
            return;
        };
        self.dismiss_menu(window, cx);
        if job.launch.kind != ScriptKind::Archive {
            return;
        }
        let removed = if current {
            self.queue_worktree_removal(&job.launch.boot, &job.launch.workspace, job.launch.force)
        } else {
            Err(crate::Error::StaleConnection)
        };
        if let Err(error) = removed {
            self.local_error = Some(format!("Remove worktree: {error}"));
            cx.notify();
        }
    }

    pub(crate) fn render_worktree_script(&self, cx: &mut Context<Self>) -> Div {
        use crate::fonts::StyledFont;
        let theme = &self.theme;
        let Some(Job {
            launch,
            step: Step::Asking { config, .. },
            ..
        }) = &self.worktree_script
        else {
            return div();
        };
        let kind = launch.kind;
        let button = |id: &'static str, label: &'static str, primary: bool| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .p(px(8.))
                .rounded(px(crate::config::corners::CONTROL))
                .when(primary, |button| button.bg(rgb(theme.active)))
                .when(!primary, |button| button.hover(|s| s.bg(rgb(theme.active))))
                .cursor_pointer()
                .child(label)
        };
        let script_block = |kind: ScriptKind, script: &str| {
            div()
                .debug_selector(move || format!("worktree-script-{}", kind.name()))
                .flex()
                .flex_col()
                .rounded(px(crate::config::corners::CONTROL))
                .bg(rgb(theme.active))
                .px(px(10.))
                .py(px(6.))
                .text_font(&self.config.terminal)
                .children(script_lines(script).into_iter().map(|line| {
                    // An empty line still takes its height.
                    div().child(if line.is_empty() {
                        " ".to_owned()
                    } else {
                        line
                    })
                }))
        };
        let (title, skip) = match kind {
            ScriptKind::Setup => ("Run this worktree's setup script?", "Don't run"),
            ScriptKind::Run => ("Run this worktree's run script?", "Don't run"),
            ScriptKind::Archive => (
                "Run the archive script before removing?",
                "Remove without running",
            ),
        };
        let others: Vec<_> = ScriptKind::ALL
            .into_iter()
            .filter(|other| *other != kind)
            .filter_map(|other| Some((other, config.scripts.get(other)?)))
            .collect();
        let host = &self.endpoints[self.selected_endpoint].label;
        // No key confirms: this page can open by itself while the user is
        // typing, and a stray Enter must not grant trust. Only a click does.
        div()
            .debug_selector(|| "worktree-script-trust".into())
            .child(div().p(px(8.)).font_weight(FontWeight::SEMIBOLD).child(title))
            .child(div().p(px(8.)).child(format!(
                "{} asks to run this from {}, in a new \u{201c}{}\u{201d} tab of its checkout:",
                launch.repo,
                config::PATH,
                kind.name()
            )))
            .when_some(config.scripts.get(kind), |page, script| {
                page.child(div().px(px(8.)).child(script_block(kind, script)))
            })
            .when(!others.is_empty(), |page| {
                page.child(
                    div()
                        .p(px(8.))
                        .child("Trusting the file also trusts its other scripts:"),
                )
                .children(others.into_iter().map(|(other, script)| {
                    div()
                        .px(px(8.))
                        .pb(px(8.))
                        .child(div().text_color(rgb(theme.muted)).child(other.name()))
                        .child(script_block(other, script))
                }))
            })
            .child(div().p(px(8.)).text_color(rgb(theme.muted)).child(format!(
                "Scripts run with sh on {host}, the daemon's host. Trust is remembered for {} there until the file changes.",
                launch.repo
            )))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .p(px(8.))
                    .child(button("worktree-script-trust-run", "Trust and run", true).on_click(
                        cx.listener(|this, _, window, cx| {
                            cx.stop_propagation();
                            this.trust_worktree_script(window, cx);
                        }),
                    ))
                    .child(button("worktree-script-skip", skip, false).on_click(cx.listener(
                        |this, _, window, cx| {
                            cx.stop_propagation();
                            this.skip_worktree_script(window, cx);
                        },
                    ))),
            )
    }
}

/// How long the trust question ignores clicks after it opens by itself.
const ARMING_DELAY: std::time::Duration = std::time::Duration::from_millis(600);

/// A script as the trust question shows it: every line, since trusting
/// covers all of it (the file is bounded by `config::MAX_BYTES`), with
/// controls and invisible formatting characters made visible, so what is
/// reviewed is what runs (bidirectional overrides cannot reorder it on screen).
fn script_lines(script: &str) -> Vec<String> {
    let visible = |c: char| match c {
        '\t' => c,
        '\u{200b}'..='\u{200f}'
        | '\u{202a}'..='\u{202e}'
        | '\u{2060}'..='\u{2069}'
        | '\u{feff}' => '\u{fffd}',
        c if c.is_control() => '\u{fffd}',
        c => c,
    };
    script
        .trim_end_matches('\n')
        .split('\n')
        .map(|line| line.chars().map(visible).collect())
        .collect()
}

#[cfg(test)]
pub(crate) mod tests;
