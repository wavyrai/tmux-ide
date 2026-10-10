//! The workspace menu's side of worktree scripts: running one from the menu,
//! the delete dialog's archive script, and the setup a new checkout runs.
//! The scripts themselves are `crate::worktree_scripts`.

use super::super::{Removal, WorkspaceTarget, danger, state::Deletion};
use crate::HerdrWindow;
use gpui::{prelude::*, *};
use herdr_client::Method;

impl HerdrWindow {
    /// Runs one of the menu workspace's scripts in a new tab of its checkout,
    /// once the daemon has named the checkout and the file is trusted.
    pub(super) fn run_workspace_script(
        &mut self,
        kind: crate::worktree_scripts::ScriptKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let launch = self.menu.target.as_ref().map(|target| {
            let tree = target.worktree.as_ref();
            crate::worktree_scripts::Launch {
                kind,
                endpoint: self.menu.endpoint_target,
                endpoint_id: self.endpoints[self.selected_endpoint].id.clone(),
                boot: target.boot_id.clone(),
                workspace: target.id.clone(),
                repo: tree.map_or_else(|| target.label.clone(), |tree| tree.label.clone()),
                repo_key: tree.map(|tree| tree.key.clone()).unwrap_or_default(),
                checkout: None,
                force: false,
                requested: true,
            }
        });
        let started = match launch {
            Some(launch) if launch.repo_key.is_empty() => Err(crate::Error::WorktreeScriptsNotGit),
            Some(_) if !self.menu_target_current() || !self.live.status.is_connected() => {
                Err(crate::Error::StaleConnection)
            }
            Some(launch) => self.start_worktree_script(launch, cx),
            None => Err(crate::Error::StaleWorkspace),
        };
        self.dismiss_menu(window, cx);
        if let Err(error) = started {
            self.show_flash(crate::window::Flash::warning(error.to_string()), cx);
        }
    }

    /// Queues `worktree.remove` for `workspace` on the selected endpoint and
    /// tracks its answer on the window, as the delete dialog does.
    pub(crate) fn queue_worktree_removal(
        &mut self,
        boot_id: &str,
        workspace: &str,
        force: bool,
    ) -> crate::Result<()> {
        let pending = self.endpoints[self.selected_endpoint]
            .connection
            .request_dialog(
                boot_id,
                Method::WorktreeRemove,
                serde_json::json!({"workspace_id": workspace, "force": force, "trust_repository": false}),
            )?;
        self.removal = Some(Removal {
            endpoint: (
                self.selection_epoch,
                self.endpoints[self.selected_endpoint].generation,
            ),
            boot_id: boot_id.to_owned(),
            workspace: workspace.to_owned(),
            pending: Some(pending),
            force,
        });
        Ok(())
    }

    /// What the delete dialog says about the checkout's archive script, if anything.
    pub(super) fn archive_note(
        &self,
        target: &WorkspaceTarget,
        deletion: &Deletion,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        use crate::worktree_scripts::{ArchiveCheck, Grant, Trust};
        let theme = &self.theme;
        let note = |text: String| {
            div()
                .debug_selector(|| "dialog-archive-script".into())
                .text_color(rgb(theme.muted))
                .child(text)
        };
        Some(match &deletion.archive {
            // Every deletion there would say so; asking is where it is reported.
            ArchiveCheck::Unread
            | ArchiveCheck::Failed(crate::Error::WorktreeScriptsUnsupportedHost) => {
                return None;
            }
            ArchiveCheck::Reading => note("Checking for an archive script...".into()),
            ArchiveCheck::Failed(error) => {
                note(format!("The archive script cannot run: {error}")).text_color(danger(theme))
            }
            ArchiveCheck::Read(_) => {
                let config = deletion.archive.script()?;
                let trusted = cx.default_global::<Trust>().trusts(&Grant {
                    endpoint: self.endpoints[self.selected_endpoint].id.clone(),
                    repo_key: target
                        .worktree
                        .as_ref()
                        .map(|tree| tree.key.clone())
                        .unwrap_or_default(),
                    digest: config.digest.clone(),
                });
                note(if trusted {
                    "The repository's archive script runs first, in a new tab. The checkout is removed only if it succeeds.".into()
                } else {
                    "The repository has an archive script. You can review it before anything runs."
                        .into()
                })
            }
        })
    }

    /// Reads the archive script of the checkout the delete dialog names, once
    /// the daemon has named it, so confirming knows whether one runs first.
    pub(in crate::menu) fn read_archive_script(&mut self, cx: &mut Context<Self>) {
        use crate::worktree_scripts::ArchiveCheck;
        let Some(deletion) = &mut self.menu.deletion else {
            return;
        };
        let (Some(path), ArchiveCheck::Unread) = (&deletion.path, &deletion.archive) else {
            return;
        };
        deletion.archive = ArchiveCheck::Reading;
        let target = self.endpoints[self.selected_endpoint]
            .connection
            .target
            .clone();
        let (checkout, expected) = (path.clone(), path.clone());
        let read = cx.background_executor().spawn(async move {
            crate::worktree_scripts::read_config(
                &target,
                &checkout,
                &std::sync::atomic::AtomicBool::new(false),
            )
        });
        cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |this, cx| {
                let Some(deletion) = &mut this.menu.deletion else {
                    return;
                };
                if deletion.path.as_deref() == Some(expected.as_str())
                    && matches!(deletion.archive, ArchiveCheck::Reading)
                {
                    deletion.archive = match result {
                        Ok(config) => ArchiveCheck::Read(config),
                        Err(error) => ArchiveCheck::Failed(error),
                    };
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// The setup script a created checkout runs, from the daemon's answer:
    /// it names the checkout and the repository's main checkout.
    pub(super) fn setup_launch(
        &self,
        result: &serde_json::Value,
        workspace: &str,
    ) -> Option<crate::worktree_scripts::Launch> {
        let target = self.menu.target.as_ref()?;
        let tree = &result["workspace"]["worktree"];
        let text = |value: &serde_json::Value| {
            value
                .as_str()
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        let path = text(&tree["checkout_path"])?;
        let known = target.worktree.as_ref();
        Some(crate::worktree_scripts::Launch {
            kind: crate::worktree_scripts::ScriptKind::Setup,
            endpoint: self.menu.endpoint_target,
            endpoint_id: self.endpoints[self.selected_endpoint].id.clone(),
            boot: target.boot_id.clone(),
            workspace: workspace.to_owned(),
            repo: known
                .map(|tree| tree.label.clone())
                .or_else(|| text(&tree["repo_name"]))
                .unwrap_or_else(|| target.label.clone()),
            repo_key: known
                .map(|tree| tree.key.clone())
                .or_else(|| text(&tree["repo_key"]))?,
            checkout: Some(crate::worktree_scripts::Checkout {
                path,
                root: text(&tree["repo_root"]),
            }),
            force: false,
            requested: false,
        })
    }
}
