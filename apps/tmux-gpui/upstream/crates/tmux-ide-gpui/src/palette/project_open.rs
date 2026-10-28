//! Project opening retains the local connection and palette identities through
//! background validation and the correlated daemon response.

use super::{LocalTarget, ProjectOperation, projects};
use crate::{Error, HerdrWindow, NavigationTarget, Result};
use gpui::{Context, Window};
use herdr_client::{Method, protocol::ClientShellSnapshot};
use serde_json::{Value, json};
use std::sync::Arc;

impl HerdrWindow {
    pub(super) fn load_palette_projects(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(palette) = &mut self.menu.palette else {
            return;
        };
        if !palette.loading_projects {
            return;
        }
        let token = palette.search.clone();
        let config = self.config.palette.clone();
        let roots = config.project_roots.clone();
        let cancelled = palette._scan.0.clone();
        let load = cx
            .background_executor()
            .spawn(async move { projects::collect(&roots, &cancelled) });
        palette.project_task = Some(cx.spawn_in(window, async move |this, cx| {
            let collection = load.await;
            let _ = this.update_in(cx, |this, _, cx| {
                if this.config.palette != config {
                    return;
                }
                let Some(mut palette) = this.menu.palette.take() else {
                    return;
                };
                if palette.search != token {
                    this.menu.palette = Some(palette);
                    return;
                }
                palette.project_task = None;
                palette.loading_projects = false;
                palette.projects = collection;
                this.prepare_palette_entries(&mut palette, crate::worktree_notes::Notes::of(cx));
                this.menu.palette = Some(palette);
                this.rank_palette(super::Selection::Keep, cx);
                cx.notify();
            });
        }));
    }

    fn local_project_connection(
        &self,
        target: &LocalTarget,
    ) -> Result<(usize, Arc<ClientShellSnapshot>)> {
        let index = self
            .endpoints
            .iter()
            .position(|endpoint| endpoint.id == crate::endpoint::LOCAL && endpoint.enabled)
            .ok_or(Error::PaletteHostUnavailable)?;
        let endpoint = &self.endpoints[index];
        // An explicitly supplied SSH launch target may occupy endpoint zero.
        if endpoint.connection.target.is_remote() {
            return Err(Error::PaletteHostUnavailable);
        }
        let live = if index == self.selected_endpoint {
            &self.live
        } else {
            &endpoint.live
        };
        if endpoint.generation != target.generation {
            return Err(Error::PaletteLocalChanged);
        }
        let snapshot = live
            .snapshot
            .as_ref()
            .ok_or(Error::PaletteHostUnavailable)?;
        if snapshot.boot_id != target.boot {
            return Err(Error::PaletteLocalChanged);
        }
        if !live.status.is_connected() || endpoint.connection.handle.is_none() {
            return Err(Error::PaletteConnectionNotReady);
        }
        Ok((index, snapshot.clone()))
    }

    fn palette_project_error(&mut self, error: Error, cx: &mut Context<Self>) {
        if let Some(palette) = &mut self.menu.palette {
            palette.project_operation = ProjectOperation::Idle;
            palette.error = Some(error.to_string());
        }
        cx.notify();
    }

    pub(super) fn activate_project(
        &mut self,
        project: projects::Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(palette) = &self.menu.palette else {
            return;
        };
        let Some(target) = palette.local_target.clone() else {
            self.palette_project_error(Error::PaletteHostUnavailable, cx);
            return;
        };
        let snapshot = match self.local_project_connection(&target) {
            Ok((_, snapshot)) => snapshot,
            Err(error) => return self.palette_project_error(error, cx),
        };
        let roots = projects::workspace_roots(&snapshot);
        let token = palette.search.clone();
        let config = self.config.palette.clone();
        let validation = cx.background_executor().spawn(async move {
            projects::validate(&project)?;
            let existing = projects::workspace_for_path(&snapshot, &project.path);
            Ok::<_, Error>((project, existing, roots))
        });
        if let Some(palette) = &mut self.menu.palette {
            palette.error = None;
        }
        let task = cx.spawn_in(window, async move |this, cx| {
            let result = validation.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this.menu.palette.as_ref().is_none_or(|palette| palette.search != token)
                    || this.config.palette != config { return; }
                if !this.menu_target_current() {
                    this.palette_project_error(Error::PaletteSessionChanged, cx);
                    return;
                }
                let (index, current) = match this.local_project_connection(&target) {
                    Ok(current) => current,
                    Err(error) => return this.palette_project_error(error, cx),
                };
                let (project, existing, roots) = match result {
                    Ok(result) => result,
                    Err(error) => return this.palette_project_error(error, cx),
                };
                // Metadata can change while disk I/O is running. Compare only
                // launch roots, not agent status or transient focus flags.
                if roots != projects::workspace_roots(&current) {
                    this.palette_project_error(Error::PaletteProjectStateChanged, cx);
                    return;
                }
                if let Some(workspace) = existing {
                    this.dismiss_menu(window, cx);
                    this.navigate_endpoint(crate::endpoint::LOCAL, NavigationTarget::Workspace(&workspace), cx);
                    return;
                }
                let request = this.endpoints[index].connection.request_dialog(
                    &target.boot, Method::WorkspaceCreate,
                    json!({"cwd": project.path, "label": project.label, "focus": true, "trust_repository": false}),
                );
                match request {
                    Ok(id) => {
                        if index == this.selected_endpoint {
                            this.fence_focus_change(None);
                        }
                        if let Some(palette) = &mut this.menu.palette {
                            palette.project_operation = ProjectOperation::Awaiting(id);
                        }
                        cx.notify();
                    }
                    Err(error) => this.palette_project_error(error, cx),
                }
            });
        });
        if let Some(palette) = &mut self.menu.palette {
            palette.project_operation = ProjectOperation::Validating { _task: task };
        }
        cx.notify();
    }

    pub(super) fn update_palette_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(palette) = &self.menu.palette else {
            return;
        };
        let ProjectOperation::Awaiting(pending) = &palette.project_operation else {
            return;
        };
        let Some(target) = palette.local_target.as_ref() else {
            return;
        };
        let (index, _) = match self.local_project_connection(target) {
            Ok(current) if self.menu_target_current() => current,
            Ok(_) => {
                return self.palette_project_error(Error::PaletteSessionChanged, cx);
            }
            Err(error) => {
                return self.palette_project_error(error, cx);
            }
        };
        let live = if index == self.selected_endpoint {
            &self.live
        } else {
            &self.endpoints[index].live
        };
        let Some((id, Some(result))) = &live.dialog_response else {
            return;
        };
        if id != pending {
            return;
        }
        let result = result.clone();
        self.clear_project_pending();
        match result {
            Ok(response) => match created_workspace(&response) {
                Ok(workspace) => {
                    self.dismiss_menu(window, cx);
                    self.navigate_endpoint(
                        crate::endpoint::LOCAL,
                        NavigationTarget::Workspace(&workspace),
                        cx,
                    );
                }
                Err(error) => self.palette_project_error(error, cx),
            },
            Err(error) => {
                if let Some(palette) = &mut self.menu.palette {
                    palette.error = Some(error.to_string());
                }
                cx.notify();
            }
        }
    }

    fn clear_project_pending(&mut self) {
        if let Some(palette) = &mut self.menu.palette {
            palette.project_operation = ProjectOperation::Idle;
        }
    }
}

fn created_workspace(response: &Value) -> Result<String> {
    if let Some(error) = response.get("error") {
        return Err(Error::DaemonResponse(error.clone()));
    }
    let result = &response["result"];
    (result["type"] == "workspace_created")
        .then(|| result["workspace"]["workspace_id"].as_str())
        .flatten()
        .filter(|id| !id.is_empty() && id.len() <= 8192 && !id.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or(Error::PaletteProjectResponse)
}

#[cfg(test)]
mod tests;
