//! Painting a workspace dialog: its header, the body each action asks for,
//! and the footer whose submit button arms only once there is something to send.

use crate::{
    HerdrWindow,
    menu::{WorkspaceAction, WorkspaceMenuAction, danger},
};
use gpui::{prelude::*, *};

impl HerdrWindow {
    /// The checkout the daemon would create for the branch currently drafted.
    /// Only a preview: the daemon derives the path it actually uses.
    pub(in crate::menu) fn checkout_preview(&self) -> String {
        let repo = self
            .menu
            .target
            .as_ref()
            .and_then(|target| target.worktree.as_ref())
            .map(|worktree| worktree.label.as_str());
        let root = self
            .live
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.worktree_directory.as_str())
            .filter(|root| !root.is_empty());
        let branch = self
            .menu
            .input
            .as_ref()
            .map_or("", |input| input.text.trim());
        match (repo, root) {
            _ if branch.is_empty() => "The daemon names the checkout.".to_owned(),
            (Some(repo), Some(root)) => crate::worktree::checkout_preview(root, repo, branch),
            _ => "The daemon chooses the checkout.".to_owned(),
        }
    }

    pub(in crate::menu) fn render_workspace_dialog(
        &self,
        action: WorkspaceAction,
        cx: &mut Context<Self>,
    ) -> Div {
        let Some(target) = &self.menu.target else {
            return div();
        };
        let theme = &self.theme;
        let font = &self.config.ui;
        let danger = danger(theme);
        let deletion = self.menu.deletion.as_ref();
        let force = deletion.is_some_and(|deletion| deletion.force);
        let dispatching = self.dispatch_job.is_some()
            && matches!(
                action,
                WorkspaceAction::NewWorktree | WorkspaceAction::NewWorkspace
            );
        let creating = self.menu.creation.is_some() || dispatching;
        // Another host chosen in the picker, where the new checkout goes.
        let dispatched = self
            .menu
            .dispatch
            .as_ref()
            .and_then(|picker| picker.dispatched());
        // Until the daemon names the checkout there is nothing to confirm, and a
        // request already in flight leaves nothing to press either.
        let armed = (action != WorkspaceAction::DeleteWorktree
            || deletion.is_some_and(|deletion| deletion.ready()))
            && (action != WorkspaceAction::OpenWorktree
                || self.menu.worktree_open.as_ref().is_some_and(|picker| {
                    picker.pending.is_none()
                        && !picker.filtered.is_empty()
                        && !picker.search.read(cx).is_composing()
                }))
            && (action != WorkspaceAction::Close
                || self.menu.close_check.as_ref().is_some_and(|check| {
                    check.ready(
                        self.menu
                            .input
                            .as_ref()
                            .map_or("", |input| input.text.as_str()),
                    )
                }))
            && !creating;
        let destructive = matches!(
            action,
            WorkspaceAction::Close | WorkspaceAction::DeleteWorktree
        );
        let (title, submit): (&str, SharedString) = match action {
            WorkspaceAction::Rename => ("Rename workspace", "Rename".into()),
            WorkspaceAction::Close => (target.close_label(), target.close_label().into()),
            WorkspaceAction::NewWorktree => ("New worktree", create_label(dispatched)),
            WorkspaceAction::OpenWorktree => ("Open worktree", "Open".into()),
            WorkspaceAction::NewTab => ("New tab", "Create".into()),
            WorkspaceAction::NewWorkspace => ("New workspace", create_label(dispatched)),
            WorkspaceAction::Note => ("Note", "Save".into()),
            WorkspaceAction::DeleteWorktree if force => {
                ("Force delete checkout?", "Force remove".into())
            }
            WorkspaceAction::DeleteWorktree => ("Delete worktree checkout?", "Remove".into()),
        };
        let mut body = div().flex().flex_col().gap(px(10.)).px(px(16.)).py(px(12.));
        body = match action {
            WorkspaceAction::OpenWorktree => body,
            WorkspaceAction::Rename => {
                body.child(div().text_color(rgb(theme.subtext())).child("Edit the workspace label."))
            }
            WorkspaceAction::Note => body.child(div().text_color(rgb(theme.subtext())).child(
                "A reminder kept only in this app, on this checkout and branch. Save it empty to remove it.",
            )),
            WorkspaceAction::NewTab => body.child(
                div()
                    .text_color(rgb(theme.subtext()))
                    .child("Name the tab, or leave the suggestion for Herdr to number it."),
            ),
            WorkspaceAction::NewWorkspace => body
                .child(
                    div()
                        .text_color(rgb(theme.subtext()))
                        .child("Name the workspace, or leave the suggestion for Herdr to name it."),
                )
                .children(self.menu.dispatch.as_ref().map(|picker| {
                    let caption = |caption: &'static str, field: AnyElement| {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .child(div().flex_none().text_color(rgb(theme.muted)).child(caption))
                            .child(div().flex_1().min_w_0().child(field))
                    };
                    self.render_host_picker(picker, caption, cx)
                }))
                .children(dispatched.map(|host| {
                    div().text_color(rgb(theme.subtext())).child(format!(
                        "Opens the repository's main checkout on {}{}.",
                        host.label,
                        clone_note(host)
                    ))
                })),
            WorkspaceAction::Close => body.child(div().text_color(rgb(theme.subtext())).child(format!(
                "Closes {} workspace(s) and terminates their running terminals. Checkout files and branches are not deleted.",
                target.close_members.len()
            ))),
            WorkspaceAction::NewWorktree => {
                // Captions share a column so both fields start at the same edge.
                let row = |caption: &'static str, field: AnyElement| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            div()
                                .flex_none()
                                .w(px(font.size * 4.5))
                                .text_color(rgb(theme.muted))
                                .child(caption),
                        )
                        .child(div().flex_1().min_w_0().child(field))
                };
                body.children(self.menu.worktree.as_ref().map(|source| {
                    row(
                        "Name",
                        div()
                            .debug_selector(|| "worktree-name".into())
                            .child(source.name.clone())
                            .into_any_element(),
                    )
                }))
                .child(row("Branch", self.render_dialog_input(cx).into_any_element()))
                .children(
                    self.menu
                        .dispatch
                        .as_ref()
                        .map(|picker| self.render_host_picker(picker, row, cx)),
                )
                .child(match dispatched {
                    Some(host) => format!(
                        "Creates a worktree from {} on {}{}, without granting repository trust:",
                        target.base_label(),
                        host.label,
                        clone_note(host)
                    ),
                    None => format!(
                        "Creates this folder from {}, without granting repository trust:",
                        target.base_label()
                    ),
                })
                .child(
                    div()
                        .debug_selector(|| "dialog-checkout".into())
                        .rounded(px(crate::config::corners::CONTROL))
                        .bg(rgb(theme.active))
                        .px(px(10.))
                        .py(px(6.))
                        .child(match dispatched {
                            Some(host) => format!("{}'s daemon chooses the checkout.", host.label),
                            None => self.checkout_preview(),
                        }),
                )
            }
            WorkspaceAction::DeleteWorktree => body
                .child(if force {
                    "This force removes the checkout folder:"
                } else {
                    "This removes the checkout folder:"
                })
                .child(
                    div()
                        .debug_selector(|| "dialog-path".into())
                        .rounded(px(crate::config::corners::CONTROL))
                        .bg(rgb(theme.active))
                        .px(px(10.))
                        .py(px(6.))
                        .child(
                            deletion
                                .and_then(|deletion| deletion.path.as_deref())
                                .unwrap_or("Waiting for the daemon to name the checkout...")
                                .to_owned(),
                        ),
                )
                .child(div().text_color(rgb(theme.subtext())).child(if force {
                    "Modified and untracked files, including submodule contents, are discarded. The branch is not deleted. The Herdr workspace will close."
                } else {
                    "The branch is not deleted. The Herdr workspace will close."
                }))
                .children(deletion.and_then(|deletion| {
                    self.archive_note(target, deletion, cx)
                })),
        };
        if action == WorkspaceAction::Close {
            body = body.child(div().debug_selector(|| "close-git-status".into()).text_color(danger).child(
                match self.menu.close_check.as_ref().and_then(|check| check.report.as_ref()) {
                    None => "Checking for uncommitted files and unpushed commits...".to_owned(),
                    Some(report) => {
                        let mut warnings = Vec::new();
                        if report.dirty { warnings.push("Uncommitted files are present."); }
                        if report.unpushed { warnings.push("Unpushed commits are present."); }
                        if report.unknown { warnings.push("Git status could not be verified for every checkout."); }
                        if report.needs_consent() { warnings.push("Type close to consent to closing anyway, or Cancel to keep working."); }
                        else { warnings.push("No uncommitted files or unpushed commits found (using local remote-tracking refs)."); }
                        warnings.join(" ")
                    }
                }
            ));
        }
        if self.menu.input.is_some() && action != WorkspaceAction::NewWorktree {
            body = body.child(self.render_dialog_input(cx));
        }
        if let Some(error) = &self.menu.error {
            body = body.child(
                div()
                    .debug_selector(|| "dialog-error".into())
                    .rounded(px(crate::config::corners::CONTROL))
                    .bg(rgb(theme.active))
                    .px(px(10.))
                    .py(px(6.))
                    .text_color(danger)
                    .child(error.clone()),
            );
        }
        if creating {
            // Dismissing only closes the panel; the daemon keeps the queued work.
            let waiting = match self.dispatch_job.as_ref().filter(|_| dispatching) {
                Some(job) => format!("{} Dismissing does not cancel it.", job.status()),
                None => "Waiting for the daemon. Dismissing does not cancel it.".to_owned(),
            };
            body = body.child(
                div()
                    .debug_selector(|| "dialog-waiting".into())
                    .text_color(rgb(theme.subtext()))
                    .child(waiting),
            );
        }
        let button = |id: &'static str| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .px(px(12.))
                .py(px(6.))
                .rounded(px(crate::config::corners::CONTROL))
                .border_1()
                .cursor_pointer()
        };
        // A picker owns the panel's height, so its list scrolls inside the
        // dialog instead of growing it past the window.
        let listing = action == WorkspaceAction::OpenWorktree || self.worktree_listing();
        div()
            .flex()
            .flex_col()
            .when(
                listing || action == WorkspaceAction::NewWorktree,
                |dialog| dialog.size_full().min_h_0(),
            )
            .child(
                div()
                    .debug_selector(|| "dialog-header".into())
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(16.))
                    .py(px(12.))
                    .border_b_1()
                    .border_color(rgb(theme.active))
                    .when_some(
                        WorkspaceMenuAction::Dialog(action).icon(),
                        |header, icon| {
                            header.child(svg().path(icon).size(px(16.)).flex_none().text_color(
                                if destructive {
                                    danger
                                } else {
                                    rgb(theme.muted)
                                },
                            ))
                        },
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .debug_selector(|| "dialog-title".into())
                                    .when(action == WorkspaceAction::OpenWorktree, |title| {
                                        title.truncate()
                                    })
                                    .text_size(px(font.size * 1.35))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(title),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_color(rgb(theme.muted))
                                    .child(target.label.clone()),
                            ),
                    )
                    .when(action == WorkspaceAction::OpenWorktree, |header| {
                        header.child(
                            div()
                                .id("open-worktree-escape")
                                .debug_selector(|| "open-worktree-escape".into())
                                .flex_none()
                                .px_2()
                                .py_1()
                                .rounded(px(crate::config::corners::CONTROL))
                                .cursor_pointer()
                                .text_color(rgb(theme.muted))
                                .hover(|button| {
                                    button
                                        .bg(rgb(theme.active))
                                        .text_color(rgb(theme.foreground))
                                })
                                .child("ESC")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.dismiss_menu(window, cx);
                                })),
                        )
                    }),
            )
            .when(action == WorkspaceAction::NewWorktree, |dialog| {
                dialog.child(self.render_worktree_tabs(cx))
            })
            .child(if action == WorkspaceAction::OpenWorktree {
                self.render_existing_worktrees(cx)
                    .when(creating || self.menu.error.is_some(), |picker| {
                        picker.child(
                            div()
                                .id("open-worktree-status")
                                .debug_selector(|| "open-worktree-status".into())
                                .flex_none()
                                .h(px(font.line_height() * 3. + 20.))
                                .overflow_y_scroll()
                                .child(body),
                        )
                    })
                    .into_any_element()
            } else if listing {
                self.render_worktree_items(cx).into_any_element()
            } else if action == WorkspaceAction::NewWorktree {
                // The branch form shares the listings' settled height, so it
                // fills the space above the footer and scrolls within it.
                div()
                    .id("new-worktree-form")
                    .debug_selector(|| "new-worktree-form".into())
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body)
                    .into_any_element()
            } else {
                body.into_any_element()
            })
            .child(
                div()
                    .debug_selector(|| "dialog-footer".into())
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .px(px(16.))
                    .py(px(12.))
                    .border_t_1()
                    .border_color(rgb(theme.active))
                    .child(
                        button("dialog-cancel")
                            .border_color(rgb(theme.active))
                            .hover(|button| button.bg(rgb(theme.active)))
                            .child("Cancel")
                            .on_click(cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.dismiss_menu(window, cx);
                            })),
                    )
                    // GitHub rows create their own checkouts without a submit button.
                    .when(
                        !listing || action == WorkspaceAction::OpenWorktree,
                        |footer| {
                            footer.child(
                                button("dialog-submit")
                                    // The primary action carries the fill; a
                                    // destructive one also carries the warning hue.
                                    .border_color(if !armed {
                                        rgb(theme.active)
                                    } else if destructive {
                                        danger
                                    } else {
                                        rgb(theme.foreground)
                                    })
                                    .when(armed, |button| button.bg(rgb(theme.active)))
                                    .text_color(if !armed {
                                        rgb(theme.muted)
                                    } else if destructive {
                                        danger
                                    } else {
                                        rgb(theme.foreground)
                                    })
                                    .child(if creating {
                                        "Waiting...".into()
                                    } else {
                                        submit
                                    })
                                    // Faded and inert until there is something
                                    // to submit, so it never reads as pressable.
                                    .when(!armed, |button| {
                                        button.opacity(0.4).cursor(CursorStyle::OperationNotAllowed)
                                    })
                                    .when(armed, |button| {
                                        button
                                            .hover(|button| button.bg(rgb(theme.active)))
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                cx.stop_propagation();
                                                this.submit_workspace_dialog(window, cx);
                                            }))
                                    }),
                            )
                        },
                    ),
            )
    }
}

/// The submit button of a dialog that may create on another host.
fn create_label(dispatched: Option<&crate::dispatch::Candidate>) -> SharedString {
    match dispatched {
        Some(host) => format!("Create on {}", host.label).into(),
        None => "Create".into(),
    }
}

/// What choosing a host without the repository adds to the dialog's text.
fn clone_note(host: &crate::dispatch::Candidate) -> &'static str {
    if host.repository == crate::dispatch::Repository::Missing {
        ", cloning the repository there first"
    } else {
        ""
    }
}
