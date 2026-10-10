//! Large files travel on an independent SSH stream; the daemon input lane stays
//! responsive. Only completed copies can paste paths, into their captured target.

use super::HerdrWindow;
use crate::{connection::ConnectionBridge, fonts::StyledFont, terminal::InputTarget};
use gpui::{prelude::*, *};
use herdr_client::{ConnectTarget, protocol::ClientPaneInputEvent};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

pub(crate) struct FileTransfer {
    endpoint: String,
    host: String,
    epoch: u64,
    generation: u64,
    boot: String,
    target: InputTarget,
    label: String,
    cancelled: Arc<AtomicBool>,
    sent: Arc<AtomicU64>,
    total: Arc<AtomicU64>,
    shown: (u64, u64, bool),
}

impl FileTransfer {
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl Drop for FileTransfer {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn transfer_progress(sent: u64, total: u64) -> (f32, String) {
    let size = |bytes: u64| {
        let mut value = bytes as f64;
        let mut unit = "B";
        for next in ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] {
            if value < 1024. {
                break;
            }
            value /= 1024.;
            unit = next;
        }
        let number = format!("{value:.1}");
        format!("{} {unit}", number.trim_end_matches(".0"))
    };
    let fraction = if total == 0 {
        0.
    } else {
        (sent as f64 / total as f64).clamp(0., 1.) as f32
    };
    (
        fraction,
        format!("{} / {} ({:.0}%)", size(sent), size(total), fraction * 100.),
    )
}

impl HerdrWindow {
    fn file_transfer_current(&self, transfer: &FileTransfer) -> bool {
        let endpoint = &self.endpoints[self.selected_endpoint];
        transfer.epoch == self.selection_epoch
            && transfer.generation == endpoint.generation
            && transfer.endpoint == endpoint.id
            && matches!(&endpoint.connection.target, ConnectTarget::Ssh { target, .. } if target == &transfer.host)
            && self.live.status.is_connected()
            && self.live.snapshot.as_ref().is_some_and(|snapshot| {
                snapshot.boot_id == transfer.boot
                    && match &transfer.target {
                        InputTarget::Pane(id) => {
                            snapshot.panes.iter().any(|pane| &pane.pane_id == id)
                        }
                        InputTarget::Popup(_) => true,
                    }
            })
            && self
                .live
                .surface
                .as_ref()
                .is_none_or(|surface| match &transfer.target {
                    InputTarget::Pane(id) => {
                        surface.popup.is_none()
                            && surface.panes.iter().any(|pane| &pane.pane_id == id)
                    }
                    InputTarget::Popup(id) => surface
                        .popup
                        .as_ref()
                        .is_some_and(|popup| &popup.terminal_id == id),
                })
    }

    pub(crate) fn poll_file_transfer(&mut self, cx: &mut Context<Self>) {
        let Some(transfer) = &self.file_transfer else {
            return;
        };
        if !self.file_transfer_current(transfer) {
            transfer.cancel();
        }
        let progress = (
            transfer.sent.load(Ordering::Relaxed),
            transfer.total.load(Ordering::Relaxed),
            transfer.cancelled.load(Ordering::Acquire),
        );
        if progress != transfer.shown
            && let Some(transfer) = &mut self.file_transfer
        {
            transfer.shown = progress;
            cx.notify();
        }
    }

    pub(crate) fn start_file_transfer(
        &mut self,
        target: InputTarget,
        paths: Vec<PathBuf>,
        cx: &mut Context<Self>,
    ) {
        self.start_file_transfer_with(
            target,
            paths,
            |host, paths, cancelled, progress| {
                herdr_client::upload_files(host, paths, cancelled, progress)
            },
            herdr_client::remove_uploaded_files,
            cx,
        );
    }

    fn start_file_transfer_with(
        &mut self,
        target: InputTarget,
        paths: Vec<PathBuf>,
        upload: impl FnOnce(
            &str,
            &[PathBuf],
            &AtomicBool,
            &mut dyn FnMut(u64, u64),
        ) -> herdr_client::Result<Vec<String>>
        + Send
        + 'static,
        cleanup: impl FnOnce(&str, &[String]) -> herdr_client::Result<()> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if !self.accepts_remote_images() || paths.is_empty() {
            return;
        }
        if self.file_transfer.is_some() {
            self.local_transfer_notice(
                "Copy not started",
                "Another file copy is still running. Cancel it or wait for it to finish.".into(),
                cx,
            );
            return;
        }
        let endpoint = &self.endpoints[self.selected_endpoint];
        let ConnectTarget::Ssh { target: host, .. } = &endpoint.connection.target else {
            return;
        };
        let Some(snapshot) = &self.live.snapshot else {
            return;
        };
        let host = host.clone();
        let boot = snapshot.boot_id.clone();
        let endpoint_id = endpoint.id.clone();
        let endpoint_label = crate::notifications::safe_text(&endpoint.label, 160);
        let generation = endpoint.generation;
        let label = if paths.len() == 1 {
            paths[0]
                .file_name()
                .map(|name| crate::notifications::safe_text(&name.to_string_lossy(), 160))
                .unwrap_or_else(|| "File".into())
        } else {
            format!("{} files", paths.len())
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let sent = Arc::new(AtomicU64::new(0));
        let total = Arc::new(AtomicU64::new(0));
        let worker_cancel = cancelled.clone();
        let worker_sent = sent.clone();
        let worker_total = total.clone();
        let worker_host = host.clone();
        let executor = cx.background_executor().clone();
        let work = executor.spawn(async move {
            upload(&worker_host, &paths, &worker_cancel, &mut |sent, total| {
                worker_total.store(total, Ordering::Relaxed);
                worker_sent.store(sent, Ordering::Relaxed);
            })
        });
        let cleanup_host = host.clone();
        let task_cancel = cancelled.clone();
        // The weak entity may disappear before SSH returns. Keep awaiting the
        // result so successful but unclaimed files are still cleaned up.
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let accepted = this.update(cx, |this, cx| {
                let Some(transfer) = &this.file_transfer else { return false; };
                if !Arc::ptr_eq(&transfer.cancelled, &task_cancel) {
                    return false;
                }
                let current = this.file_transfer_current(transfer);
                let cancelled = transfer.cancelled.load(Ordering::Acquire) || !current;
                let error = match &result {
                    Ok(paths) if !cancelled && this.menu.page.is_none() && this.input_ready() => {
                        let text = super::file_drop::quote_paths(&paths.iter().map(PathBuf::from).collect::<Vec<_>>());
                        text.and_then(|text| {
                            let handle = this.endpoints[this.selected_endpoint].connection.handle.as_ref().ok_or(crate::Error::NotConnected)?;
                            ConnectionBridge::send_input(handle, &transfer.boot, &transfer.target, ClientPaneInputEvent::Paste(text))?;
                            Ok(())
                        }).err().map(|error: crate::Error| error.to_string())
                    }
                    Ok(_) => Some(herdr_client::Error::UploadCancelled.to_string()),
                    Err(error) => {
                        crate::storage_warning::warn_storage_failure("File transfer", error);
                        Some(error.to_string())
                    }
                };
                let accepted = error.is_none();
                if current && !matches!(&result, Err(herdr_client::Error::UploadCleanup { .. })) {
                    match error {
                        None => this.local_transfer_notice("Copy complete", "Remote file paths pasted. Files remain in the remote temporary directory until removed.".into(), cx),
                        Some(error) => this.local_transfer_notice(if cancelled { "Copy cancelled" } else { "Copy failed" }, error, cx),
                    }
                }
                accepted
            }).unwrap_or(false);
            let cleanup_failed = match result {
                Ok(paths) if !accepted => executor
                    .spawn(async move { cleanup(&cleanup_host, &paths) })
                    .await
                    .is_err(),
                Err(herdr_client::Error::UploadCleanup { .. }) => true,
                _ => false,
            };
            if cleanup_failed {
                let _ = this.update(cx, |this, cx| {
                    this.local_transfer_notice("Remote cleanup failed", format!("No path was pasted. Temporary files may remain on the original host ({endpoint_label})."), cx);
                });
            }
            let _ = this.update(cx, |this, cx| {
                if this.file_transfer.as_ref().is_some_and(|transfer| Arc::ptr_eq(&transfer.cancelled, &task_cancel)) {
                    this.file_transfer = None;
                    cx.notify();
                }
            });
        }).detach();
        self.file_transfer = Some(FileTransfer {
            endpoint: endpoint_id,
            host,
            epoch: self.selection_epoch,
            generation,
            boot,
            target,
            label,
            cancelled,
            sent,
            total,
            shown: (0, 0, false),
        });
        cx.notify();
    }

    pub(super) fn render_file_transfer(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let transfer = self.file_transfer.as_ref()?;
        if self.menu.page.is_some() {
            return None;
        }
        let (sent, total, cancelled) = transfer.shown;
        let (fraction, progress) = transfer_progress(sent, total);
        let title = if cancelled {
            "Cancelling..."
        } else if total > 0 && sent >= total {
            "Finalizing copy..."
        } else {
            "Copying..."
        };
        let accent = self.theme.primary();
        Some(
            div()
                .id("file-transfer")
                .debug_selector(|| "file-transfer".into())
                .absolute()
                .right(px(12.))
                .top(px(72.))
                .w((window.viewport_size().width - px(24.))
                    .max(px(0.))
                    .min(px(340.)))
                .occlude()
                .rounded(px(crate::config::corners::PANEL))
                .border_1()
                .border_color(rgb(accent))
                .bg(rgb(self.theme.surface))
                .text_color(rgb(self.theme.foreground))
                .text_font(&self.config.ui)
                .text_size(px(self.config.ui.size))
                .p(px(12.))
                .flex()
                .flex_col()
                .gap(px(8.))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
                .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                .child(div().child(title))
                .child(div().truncate().child(transfer.label.clone()))
                .child(
                    div()
                        .debug_selector(|| "file-transfer-track".into())
                        .w_full()
                        .h(px(6.))
                        .rounded(px(crate::config::corners::CONTROL))
                        .overflow_hidden()
                        .bg(rgb(self.theme.active))
                        .child(
                            div()
                                .debug_selector(|| "file-transfer-progress".into())
                                .h_full()
                                .w(relative(fraction))
                                .bg(rgb(accent)),
                        ),
                )
                .child(div().text_color(rgb(self.theme.muted)).child(progress))
                .child(
                    div()
                        .id("cancel-file-transfer")
                        .debug_selector(|| "cancel-file-transfer".into())
                        .cursor_pointer()
                        .child(if cancelled { "Cancelling" } else { "Cancel" })
                        .on_click(cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            if let Some(transfer) = &this.file_transfer {
                                transfer.cancel();
                            }
                            this.poll_file_transfer(cx);
                        })),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
pub(crate) mod tests;
