//! State one window's menu owns: which page is open, what it targets, and the
//! daemon answers still outstanding. Every modal action is fenced by the
//! selection epoch and connection generation it was started under, so a reply
//! from a replaced connection can never be applied to the current one.

use super::endpoint_error;
use super::{Page, WorkspaceMenuAction, WorkspaceTarget, git, github};
use crate::dialog_input::DialogInput;
use gpui::{App, Entity, FocusHandle, Pixels, Point, ScrollHandle, Subscription};
use herdr_client::protocol::ClientShellSnapshot;

/// What an open menu covers, as its last frame laid it out: the window's
/// native pages above GPUI would hide it, so the ones it covers step aside.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) enum Cover {
    /// Not laid out yet.
    #[default]
    Unknown,
    /// A dialog dims the whole window.
    All,
    /// A popover or menu covers only its own panel.
    Panel(gpui::Bounds<Pixels>),
}

#[cfg(any(target_os = "macos", windows, test))]
impl Cover {
    /// Whether a page drawn at `page` would hide this menu. Before the menu
    /// is laid out nothing is, so pages keep showing for that one frame.
    pub(crate) fn covers(self, page: Option<gpui::Bounds<Pixels>>) -> bool {
        match self {
            Self::Unknown => false,
            Self::All => true,
            Self::Panel(panel) => page.is_some_and(|page| page.intersects(&panel)),
        }
    }
}

pub(crate) struct MenuState {
    pub page: Option<Page>,
    /// Written by the menu's layout, read when presenting pages.
    pub(crate) cover: std::rc::Rc<std::cell::Cell<Cover>>,
    pub(super) device_setup: Option<super::devices::Setup>,
    pub(super) wsl_setup: Option<super::devices::WslSetup>,
    /// The saved distribution the removal confirmation names.
    pub(super) wsl_remove: Option<String>,
    pub(super) session_edit: Option<super::sessions::Edit>,
    #[cfg(feature = "coder")]
    pub(super) coder: Option<super::devices::coder::Wizard>,
    pub(super) devices_scroll: ScrollHandle,
    /// The sessions list scrolls its own way; the two popups never share one.
    pub(crate) sessions_scroll: ScrollHandle,
    pub(crate) usage_scroll: ScrollHandle,
    // Selection epoch and connection generation fence captured modal actions.
    pub(super) endpoint_target: (u64, u64),
    pub anchor: Point<Pixels>,
    /// Ignore repeated right presses until the opening gesture is released.
    pub(crate) opening_right_click: bool,
    pub focus: FocusHandle,
    pub(super) selected: Option<usize>,
    pub(super) workspace_selected: Option<WorkspaceMenuAction>,
    pub(super) git_selected: Option<git::Row>,
    /// The merge dialog's method, and the pull request (with its head) it
    /// was opened for: a branch that moved since must be reviewed again.
    pub(super) merge_method: Option<crate::pull_request::MergeMethod>,
    pub(super) merge_target: Option<crate::pr_actions::Target>,
    pub(super) target: Option<WorkspaceTarget>,
    pub input: Option<DialogInput>,
    pub(crate) error: Option<String>,
    pub(super) deletion: Option<Deletion>,
    pub(super) close_check: Option<super::workspace_close::CloseCheck>,
    /// The correlated `worktree.create` or `worktree.open` request, so the dialog
    /// can report the daemon's answer and follow the returned workspace.
    pub(super) creation: Option<String>,
    /// The name a new tab or workspace dialog proposed. Submitting it
    /// unchanged, or nothing, leaves naming to the daemon, as Herdr does.
    pub(super) suggested_name: Option<String>,
    pub(super) worktree_open: Option<super::worktree_open::Picker>,
    pub(super) keybinds_scroll: ScrollHandle,
    pub(crate) keybinds_search: Option<Entity<crate::search_input::SearchInput>>,
    pub(super) _keybinds_subscription: Option<Subscription>,
    pub(crate) preferences_scroll: ScrollHandle,
    pub(crate) font_size_editor: Option<crate::preferences::FontSizeEditor>,
    pub(crate) themes: Option<crate::theme_picker::ThemePicker>,
    pub(crate) fonts: Option<crate::font_picker::FontPicker>,
    pub(crate) palette: Option<crate::palette::Palette>,
    pub(crate) close: Option<crate::close_modal::CloseConfirmation>,
    pub(crate) tab: Option<crate::tab_menu::TabMenu>,
    pub(crate) group: Option<crate::group_menu::GroupMenu>,
    pub(crate) host: Option<super::devices::HostMenu>,
    pub(crate) pane: Option<crate::pane_menu::PaneMenu>,
    /// The new worktree dialog's tabs and the GitHub listing behind them.
    pub(crate) worktree: Option<super::WorktreeSource>,
    /// The host a new worktree or workspace goes to, when another one could.
    pub(crate) dispatch: Option<crate::dispatch::Picker>,
    pub(crate) pr: crate::pull_request::Lookup,
    /// Also read by the sidebar, which paints each worktree's cached PR badge.
    pub(crate) pr_cache: crate::pull_request::Cache,
    pub(super) pr_cache_connection:
        Option<std::sync::Weak<std::sync::Mutex<crate::state::LiveState>>>,
    pub(super) pr_snapshot: Option<std::sync::Weak<ClientShellSnapshot>>,
    pub(crate) github: crate::github::Auth,
    /// Saved SSH devices' own accounts, keyed by endpoint ID. A device without
    /// one signed in looks up pull requests with `github`.
    pub(crate) github_hosts: std::collections::HashMap<String, crate::github::Auth>,
    /// Saved devices whose removal is running, by endpoint ID. Kept after
    /// success until the catalog drops the device, so its header pulses
    /// until it disappears; the confirmation closes as soon as it starts.
    pub(crate) removing_devices: std::collections::HashSet<String>,
    pub(super) github_selected: Option<github::Action>,
    pub(super) github_scroll: ScrollHandle,
    pub(super) pr_connection: Option<std::sync::Weak<std::sync::Mutex<crate::state::LiveState>>>,
    pub(crate) version_notice: Option<super::VersionNotice>,
}

pub(super) struct Deletion {
    pub(super) pending: Option<String>,
    pub(super) path: Option<String>,
    /// The repository's main checkout, for the archive script's environment.
    pub(super) root: Option<String>,
    pub(super) force: bool,
    /// Whether the checkout has an archive script to run first.
    pub(super) archive: crate::worktree_scripts::ArchiveCheck,
}

impl Deletion {
    pub(super) fn new(pending: Option<String>, force: bool) -> Self {
        Self {
            pending,
            path: None,
            root: None,
            force,
            archive: crate::worktree_scripts::ArchiveCheck::Unread,
        }
    }

    /// Confirming is a single keypress, so the dialog may only submit once the
    /// daemon has named the checkout, its lookup is no longer in flight, and
    /// the checkout is known to have an archive script or not.
    pub(super) fn ready(&self) -> bool {
        self.pending.is_none() && self.path.is_some() && self.archive.settled()
    }
}

/// A queued `worktree.remove`. The dialog closes as soon as the request is
/// queued, because the daemon's own snapshot drops the workspace once the
/// removal lands; holding the popover open adds nothing. What still needs a
/// home is sidebar progress and a refusal, which becomes the window's local
/// error. A dirty checkout arms the next dialog with force.
pub(crate) struct Removal {
    /// Same fence as the menu target: a response from a replaced connection is
    /// not this removal's.
    pub(super) endpoint: (u64, u64),
    pub(super) boot_id: String,
    pub(super) workspace: String,
    /// The request id, until the daemon answers.
    pub(super) pending: Option<String>,
    /// Set once the daemon refused the checkout as dirty.
    pub(super) force: bool,
}

impl Removal {
    pub(crate) fn pending_for(&self, endpoint: (u64, u64), boot_id: &str, workspace: &str) -> bool {
        self.pending.is_some()
            && self.endpoint == endpoint
            && self.boot_id == boot_id
            && self.workspace == workspace
    }
}

/// What a submitted dialog did, which decides whether it stays open.
pub(super) enum Submission {
    /// The request is queued and the dialog has nothing left to wait for.
    Queued { focus_changed: bool },
    /// The dialog stays open for a daemon answer it still needs: the checkout a
    /// removal must confirm, or the one a creation produced.
    Awaiting { focus_changed: bool },
}

impl Submission {
    pub(super) fn focus_changed(&self) -> bool {
        let (Submission::Queued { focus_changed } | Submission::Awaiting { focus_changed }) = self;
        *focus_changed
    }
}

impl MenuState {
    /// The repository the open dialog's host picker ranks hosts for.
    pub(crate) fn dispatch_repo(&self) -> Option<String> {
        self.target
            .as_ref()?
            .worktree
            .as_ref()
            .map(|tree| tree.label.clone())
    }

    pub(super) fn apply_deletion_response(
        &mut self,
        id: &str,
        result: crate::state::DialogResponse,
    ) {
        let Some(deletion) = &mut self.deletion else {
            return;
        };
        if deletion.pending.as_deref() != Some(id) {
            return;
        }
        deletion.pending = None;
        let response = match result {
            Ok(response) => response,
            Err(error) => {
                self.error = Some(error.to_string());
                return;
            }
        };
        if let Some(error) = response.get("error") {
            let (code, message) = endpoint_error(error);
            self.error = Some(format!("{code}: {message}"));
            return;
        }
        let result = &response["result"];
        let Some(target) = &self.target else {
            return;
        };
        if result["type"] == "worktree_list" {
            let entry = result["worktrees"].as_array().and_then(|entries| {
                let mut matches = entries
                    .iter()
                    .filter(|entry| entry["open_workspace_id"] == target.id);
                let entry = matches.next()?;
                (matches.next().is_none()
                    && entry["is_linked_worktree"] == true
                    && entry["is_bare"] == false)
                    .then_some(entry)
            });
            deletion.path = entry
                .and_then(|entry| entry["path"].as_str())
                .filter(|path| !path.is_empty())
                .map(str::to_owned);
            deletion.root = crate::worktree_scripts::main_checkout(result);
            if deletion.path.is_none() {
                self.error = Some("Daemon did not identify a unique linked checkout. Dismiss and reopen the menu.".into());
            }
        } else {
            self.error = Some(
                "Unexpected daemon response. Review current workspace state before retrying."
                    .into(),
            );
        }
    }

    pub fn new(cx: &App) -> Self {
        Self {
            page: None,
            cover: Default::default(),
            device_setup: None,
            wsl_setup: None,
            wsl_remove: None,
            session_edit: None,
            #[cfg(feature = "coder")]
            coder: None,
            devices_scroll: ScrollHandle::new(),
            sessions_scroll: ScrollHandle::new(),
            usage_scroll: ScrollHandle::new(),
            endpoint_target: (0, 0),
            anchor: Point::default(),
            opening_right_click: false,
            focus: cx.focus_handle(),
            selected: None,
            workspace_selected: None,
            git_selected: None,
            merge_method: None,
            merge_target: None,
            target: None,
            input: None,
            error: None,
            deletion: None,
            close_check: None,
            creation: None,
            suggested_name: None,
            worktree_open: None,
            keybinds_scroll: ScrollHandle::new(),
            keybinds_search: None,
            _keybinds_subscription: None,
            preferences_scroll: ScrollHandle::new(),
            font_size_editor: None,
            themes: None,
            fonts: None,
            palette: None,
            close: None,
            pr: Default::default(),
            pr_cache: Default::default(),
            pr_cache_connection: None,
            pr_snapshot: None,
            github: Default::default(),
            github_hosts: Default::default(),
            removing_devices: Default::default(),
            github_selected: None,
            github_scroll: ScrollHandle::new(),
            pr_connection: None,
            version_notice: None,
            tab: None,
            group: None,
            host: None,
            pane: None,
            worktree: None,
            dispatch: None,
        }
    }

    pub fn reset(&mut self) {
        self.cover.set(Cover::Unknown);
        self.device_setup = None;
        self.wsl_setup = None;
        self.wsl_remove = None;
        self.session_edit = None;
        #[cfg(feature = "coder")]
        {
            self.coder = None;
        }
        self.devices_scroll.set_offset(Point::default());
        self.sessions_scroll.set_offset(Point::default());
        self.usage_scroll.set_offset(Point::default());
        self.opening_right_click = false;
        self.tab = None;
        self.group = None;
        self.host = None;
        self.pane = None;
        self.github_selected = None;
        self.github_scroll.set_offset(Point::default());
        if self.github.busy() {
            self.github.cancel();
        }
        self.page = None;
        self.palette = None;
        self.fonts = None;
        self.font_size_editor = None;
        self.selected = None;
        self.workspace_selected = None;
        self.git_selected = None;
        self.merge_method = None;
        self.merge_target = None;
        self.target = None;
        self.input = None;
        self.error = None;
        self.deletion = None;
        self.version_notice = None;
        self.close_check = None;
        self.creation = None;
        self.suggested_name = None;
        self.worktree_open = None;
        self.close = None;
        self.worktree = None;
        self.dispatch = None;
        self.pr.clear();
        self.pr_connection = None;
    }
}

#[cfg(test)]
mod cover_tests {
    use super::Cover;
    use gpui::{Bounds, point, px, size};

    #[test]
    fn only_pages_under_a_menu_step_aside() {
        let at = |x: f32, width: f32| Bounds::new(point(px(x), px(0.)), size(px(width), px(400.)));
        // A sessions popover on the left, a page on the right.
        let popover = Cover::Panel(at(40., 300.));
        assert!(!popover.covers(Some(at(900., 700.))));
        assert!(popover.covers(Some(at(200., 700.))));
        // A dimmed dialog covers every page; an unlaid menu none yet.
        assert!(Cover::All.covers(Some(at(900., 700.))));
        assert!(!Cover::Unknown.covers(Some(at(0., 1900.))));
        // A page not drawn yet is under nothing.
        assert!(!popover.covers(None));
    }
}
