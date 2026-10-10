//! Clipboard and remote images use the daemon's temporary-file bridge, not an
//! agent-specific attachment API. Reserve FIFO order before background file
//! reads/encoding.

use super::{
    HerdrWindow,
    image_source::{self, PreparedImage, Source},
};
use crate::{Error, terminal::InputTarget};
use gpui::{ClipboardEntry, ClipboardItem, Context, Task};
use herdr_client::{
    ClipboardImageCancellation,
    protocol::{ClientClipboardImageTarget, ClientPaneInputEvent},
};
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Eq)]
enum PreparationKind {
    Image,
    Input,
}

pub(crate) struct PendingImage {
    token: Arc<()>,
    kind: PreparationKind,
    endpoint: String,
    epoch: u64,
    generation: u64,
    boot: String,
    remote: bool,
    target: InputTarget,
    cancellation: ClipboardImageCancellation,
    preparing: bool,
    _task: Task<()>,
}

impl PendingImage {
    pub(crate) fn cancel(&self) {
        self.cancellation.cancel();
    }
}

impl Drop for PendingImage {
    fn drop(&mut self) {
        self.cancel();
    }
}

impl HerdrWindow {
    fn report_image_error(&mut self, error: &Error, cx: &mut Context<Self>) {
        self.local_error = Some(format!("Image not sent: {error}"));
        self.local_transfer_notice(
            "Image discarded",
            format!("{error} Nothing was uploaded or pasted."),
            cx,
        );
    }

    pub(crate) fn local_transfer_notice(
        &mut self,
        title: &str,
        body: String,
        cx: &mut Context<Self>,
    ) {
        use herdr_client::protocol::{SemanticNotification, SemanticNotificationKind};
        let now = std::time::Instant::now();
        let notice = crate::notifications::Notice::local_feedback(
            SemanticNotification {
                kind: SemanticNotificationKind::Custom,
                title: title.into(),
                body: Some(body),
                sound: None,
                agent: None,
                workspace_id: None,
                tab_id: None,
                pane_id: None,
                position: Some(self.config.notifications.position),
            },
            now,
        )
        .with_snapshot(self.live.snapshot.as_deref());
        self.endpoints[self.selected_endpoint]
            .toasts
            .receive([notice]);
        self.tick_toasts(self.menu.page.is_some() || self.toasts_hidden, now);
        cx.notify();
    }

    fn accepts_image_input(&self) -> bool {
        self.menu.page.is_none()
            && self.live.status.is_connected()
            && self.input_ready()
            && !self.mouse_focus_pending()
    }

    /// The daemon stages clipboard images beside the pane's processes, so the
    /// bridge serves local endpoints too: GUI text paste cannot carry an image.
    /// Only macOS and Linux have a bounded background clipboard reader.
    pub(crate) fn accepts_clipboard_images(&self) -> bool {
        cfg!(any(target_os = "macos", target_os = "linux")) && self.accepts_image_input()
    }

    /// Dropped files and pasted image paths need bridging only when the pane
    /// runs on another host; a local pane can already read the original path.
    /// File drops do not read the clipboard, so this has no platform gate.
    pub(crate) fn accepts_remote_images(&self) -> bool {
        self.selected_is_remote() && self.accepts_image_input()
    }

    pub(super) fn selected_is_remote(&self) -> bool {
        self.endpoints[self.selected_endpoint]
            .connection
            .target
            .is_remote()
    }

    pub(crate) fn focused_input_target(&self) -> Option<InputTarget> {
        let surface = self.live.surface.as_ref()?;
        if let Some(popup) = &surface.popup {
            Some(InputTarget::Popup(popup.terminal_id.clone()))
        } else {
            self.live
                .snapshot
                .as_ref()?
                .focused_pane_id
                .clone()
                .map(InputTarget::Pane)
        }
    }

    fn image_target_current(&self, image: &PendingImage) -> bool {
        let endpoint = &self.endpoints[self.selected_endpoint];
        if self.selected_is_remote() != image.remote
            || self.menu.page.is_some()
            || !self.live.status.is_connected()
            || self.pending_navigation.is_some()
            || self.live.activation_pending()
            || image.epoch != self.selection_epoch
            || image.generation != endpoint.generation
            || image.endpoint != endpoint.id
            || self
                .live
                .snapshot
                .as_ref()
                .is_none_or(|snapshot| snapshot.boot_id != image.boot)
        {
            return false;
        }
        // Snapshot delivery can briefly invalidate the surface without changing
        // the target. Missing cells are not evidence that a pane disappeared.
        if let InputTarget::Pane(id) = &image.target
            && self
                .live
                .snapshot
                .as_ref()
                .is_none_or(|snapshot| !snapshot.panes.iter().any(|pane| &pane.pane_id == id))
        {
            return false;
        }
        self.live
            .surface
            .as_ref()
            .is_none_or(|surface| match &image.target {
                InputTarget::Pane(id) => {
                    surface.popup.is_none() && surface.panes.iter().any(|pane| &pane.pane_id == id)
                }
                InputTarget::Popup(id) => surface
                    .popup
                    .as_ref()
                    .is_some_and(|popup| &popup.terminal_id == id),
            })
    }

    pub(crate) fn cancel_stale_image(&mut self) {
        for image in &self.pending_images {
            if !self.image_target_current(image) {
                image.cancel();
            }
        }
        self.pending_images
            .retain(|image| image.preparing || !image.cancellation.is_finished());
    }

    pub(crate) fn paste_terminal_clipboard(
        &mut self,
        item: ClipboardItem,
        image_only: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.menu.page.is_some() || !self.input_ready() || self.mouse_focus_pending() {
            return false;
        }
        // Normal paste retains text precedence. Ctrl-V only intercepts images,
        // leaving its ordinary terminal meaning intact when no image exists.
        if !image_only && let Some(text) = item.text().filter(|text| !text.is_empty()) {
            if self.accepts_remote_images()
                && let Some(source) = image_source::from_paste(&text)
                && let Some(target) = self.focused_input_target()
            {
                self.start_remote_image(target, source, Some(text), cx);
            } else {
                self.send(ClientPaneInputEvent::Paste(text), cx);
            }
            return true;
        }
        if self.accepts_clipboard_images()
            && let Some(image) = item.into_entries().find_map(|entry| match entry {
                ClipboardEntry::Image(image) => Some(image),
                _ => None,
            })
            && let Some(target) = self.focused_input_target()
        {
            self.start_remote_image(target, Source::Clipboard(image), None, cx);
            return true;
        }
        false
    }

    pub(super) fn start_remote_image(
        &mut self,
        target: InputTarget,
        source: Source,
        fallback: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.start_image_preparation(
            target,
            PreparationKind::Image,
            move || Prepared::image(source.prepare(), fallback),
            cx,
        );
    }

    pub(crate) fn paste_native_clipboard(
        &mut self,
        image_only: bool,
        fallback: Option<ClientPaneInputEvent>,
        cx: &mut Context<Self>,
    ) {
        let Some(target) = self.focused_input_target() else {
            return;
        };
        let bridge_paths = self.accepts_remote_images();
        // GPUI's native reader copies and hashes whole images synchronously.
        // Only its in-memory test clipboard is read on the foreground thread.
        let read = super::clipboard::read;
        #[cfg(test)]
        let item = cx.read_from_clipboard();
        self.start_image_preparation(
            target,
            PreparationKind::Input,
            move || {
                #[cfg(test)]
                let item = {
                    let _ = read;
                    item
                };
                #[cfg(not(test))]
                let item = read(image_only)?;
                let Some(item) = item else {
                    return Ok(fallback.map_or(Prepared::Empty, Prepared::Input));
                };
                if !image_only && let Some(text) = item.text().filter(|text| !text.is_empty()) {
                    if bridge_paths && let Some(source) = image_source::from_paste(&text) {
                        return Prepared::image(source.prepare(), Some(text));
                    }
                    return Ok(Prepared::Input(ClientPaneInputEvent::Paste(text)));
                }
                if let Some(image) = item.into_entries().find_map(|entry| match entry {
                    ClipboardEntry::Image(image) => Some(image),
                    _ => None,
                }) {
                    return Source::Clipboard(image).prepare().map(Prepared::Image);
                }
                Ok(fallback.map_or(Prepared::Empty, Prepared::Input))
            },
            cx,
        );
    }

    fn start_image_preparation(
        &mut self,
        target: InputTarget,
        kind: PreparationKind,
        prepare: impl FnOnce() -> crate::Result<Prepared> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        // Callers choose clipboard or remote eligibility. Unsupported platforms
        // still report the client's typed reservation error below.
        if !self.accepts_image_input() {
            return;
        }
        // Keep a cancelled preparation until it actually exits. Reconnecting or
        // repeated drops cannot build up background readers holding large images.
        self.cancel_stale_image();
        if self.pending_images.len() >= 4
            || (kind == PreparationKind::Image
                && self
                    .pending_images
                    .iter()
                    .any(|image| image.kind == PreparationKind::Image && image.preparing))
        {
            self.local_error = Some(format!(
                "Image not sent: {}",
                herdr_client::Error::ClipboardImageBusy
            ));
            cx.notify();
            return;
        }
        let endpoint = &self.endpoints[self.selected_endpoint];
        let (Some(handle), Some(snapshot)) = (&endpoint.connection.handle, &self.live.snapshot)
        else {
            return;
        };
        let wire_target = match &target {
            InputTarget::Pane(id) => ClientClipboardImageTarget::Pane(id.clone()),
            InputTarget::Popup(id) => ClientClipboardImageTarget::Popup(id.clone()),
        };
        let upload = match match kind {
            PreparationKind::Image => {
                handle.reserve_clipboard_image(&snapshot.boot_id, wire_target)
            }
            PreparationKind::Input => {
                handle.reserve_clipboard_input(&snapshot.boot_id, wire_target)
            }
        } {
            Ok(upload) => upload,
            Err(error) => {
                self.local_error = Some(format!("Image not sent: {error}"));
                cx.notify();
                return;
            }
        };
        let cancellation = upload.cancellation_handle();
        let endpoint = endpoint.id.clone();
        let generation = self.endpoints[self.selected_endpoint].generation;
        let boot = snapshot.boot_id.clone();
        let executor = cx.background_executor().clone();
        let prepare = executor.spawn(async move {
            let result = if upload.is_cancelled() {
                Err(Error::Client(herdr_client::Error::ClipboardImageCancelled))
            } else {
                prepare()
            };
            (upload, result)
        });
        let token = Arc::new(());
        let task_token = token.clone();
        let task = cx.spawn(async move |this, cx| {
            let (upload, prepared) = prepare.await;
            let current = this
                .update(cx, |this, cx| {
                    let Some(index) = this
                        .pending_images
                        .iter()
                        .position(|image| Arc::ptr_eq(&image.token, &task_token))
                    else {
                        return false;
                    };
                    let current = this.image_target_current(&this.pending_images[index])
                        && !upload.is_cancelled();
                    if !current {
                        let pending = &mut this.pending_images[index];
                        pending.preparing = false;
                        pending.cancel();
                        this.cancel_stale_image();
                    } else if let Err(error) = &prepared {
                        this.report_image_error(error, cx);
                    }
                    current
                })
                .unwrap_or(false);
            if !current {
                return;
            }
            let result = executor
                .spawn(async move {
                    match prepared {
                        Ok(Prepared::Image(image)) => upload
                            .complete(image.extension, image.bytes)
                            .map(|()| image.resized),
                        Ok(Prepared::Input(event)) => upload.complete_input(event).map(|()| false),
                        Ok(Prepared::Empty) | Err(_) => Ok(false),
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                let Some(index) = this
                    .pending_images
                    .iter()
                    .position(|image| Arc::ptr_eq(&image.token, &task_token))
                else {
                    return;
                };
                let current = this.image_target_current(&this.pending_images[index]);
                let pending = &mut this.pending_images[index];
                pending.preparing = false;
                if !current {
                    pending.cancel();
                }
                if current {
                    match result {
                        Err(error) => this.report_image_error(&Error::Client(error), cx),
                        Ok(true) => this.local_transfer_notice(
                            "Image resized for upload",
                            "The image was recompressed or downscaled to 16 MiB or less and queued for upload. The original is unchanged.".into(),
                            cx,
                        ),
                        Ok(false) => {}
                    }
                }
                this.cancel_stale_image();
            });
        });
        self.pending_images.push(PendingImage {
            token,
            kind,
            endpoint,
            epoch: self.selection_epoch,
            generation,
            boot,
            remote: self.selected_is_remote(),
            target,
            cancellation,
            preparing: true,
            _task: task,
        });
    }
}

enum Prepared {
    Image(PreparedImage),
    Input(ClientPaneInputEvent),
    Empty,
}

impl Prepared {
    fn image(image: crate::Result<PreparedImage>, fallback: Option<String>) -> crate::Result<Self> {
        match image {
            Ok(image) => Ok(Self::Image(image)),
            Err(error @ (Error::ImageFile { .. } | Error::ImageFileType | Error::ImageSize)) => {
                match fallback {
                    Some(text) => Ok(Self::Input(ClientPaneInputEvent::Paste(text))),
                    None => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use herdr_client::ConnectTarget;
    use std::io;

    fn processing_errors() -> Vec<Error> {
        vec![
            Error::ImageInputTooLarge {
                limit: image_source::MAX_IMAGE_INPUT_BYTES,
            },
            Error::ImageTooLarge {
                limit: herdr_client::protocol::MAX_CLIPBOARD_IMAGE_PAYLOAD,
            },
            Error::ImageDecodeLimit,
            Error::ImageAnimationResize,
            Error::ImageDecode(image::ImageError::IoError(io::Error::other(
                "/private/image.png secret decoder diagnostic",
            ))),
            Error::ImageEncode(image::ImageError::IoError(io::Error::other(
                "/private/image.png secret encoder diagnostic",
            ))),
            Error::ImageReadTimeout,
            Error::ImageFormat,
            Error::ClipboardSize {
                limit: image_source::MAX_IMAGE_INPUT_BYTES,
            },
            Error::ClipboardChanged,
            Error::ClipboardTimeout,
            Error::ClipboardProcess(io::Error::other("secret clipboard diagnostic")),
        ]
    }

    #[test]
    fn file_availability_errors_alone_preserve_original_paste() {
        let text = "\x1b[200~'/private/original image.png'\x1b[201~\r\n";
        for error in [
            Error::ImageFile {
                operation: "open",
                source: io::ErrorKind::NotFound.into(),
            },
            Error::ImageFile {
                operation: "read",
                source: io::ErrorKind::PermissionDenied.into(),
            },
            Error::ImageFileType,
            Error::ImageSize,
        ] {
            assert!(matches!(
                Prepared::image(Err(error), Some(text.into())),
                Ok(Prepared::Input(ClientPaneInputEvent::Paste(actual))) if actual == text
            ));
        }
        assert!(matches!(
            Prepared::image(Err(Error::ImageSize), None),
            Err(Error::ImageSize)
        ));
        for error in processing_errors() {
            let kind = std::mem::discriminant(&error);
            assert!(matches!(
                Prepared::image(Err(error), Some(text.into())),
                Err(actual) if std::mem::discriminant(&actual) == kind
            ));
        }
    }

    #[test]
    fn prepared_image_preserves_owned_bytes_and_resize_flag() {
        for resized in [false, true] {
            let bytes = vec![1, 2, 3];
            let pointer = bytes.as_ptr();
            let image = PreparedImage {
                extension: "png",
                bytes,
                resized,
            };
            let prepared = Prepared::image(Ok(image), Some("unused fallback".into())).unwrap();
            let Prepared::Image(image) = prepared else {
                panic!("image replaced by fallback");
            };
            assert_eq!(image.bytes.as_ptr(), pointer);
            assert_eq!(image.bytes, [1, 2, 3]);
            assert_eq!(image.extension, "png");
            assert_eq!(image.resized, resized);
        }
    }

    #[gpui::test]
    fn all_processing_errors_show_redacted_local_feedback(cx: &mut gpui::TestAppContext) {
        let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
        let mut errors = processing_errors();
        errors.push(Error::ImageFile {
            operation: "read",
            source: io::Error::other("/private/image.png secret file diagnostic"),
        });
        errors.extend([Error::ImageSize, Error::ImageFileType]);
        for error in errors {
            view.update(cx, |view, cx| {
                view.config.notifications.enabled = false;
                view.config.notifications.delay_seconds = 3600;
                view.endpoints[0].toasts.entries.clear();
                view.report_image_error(&error, cx);
                let (_, notice) = view.endpoints[0].toasts.entries.back().unwrap();
                assert_eq!(notice.title, "Image discarded");
                assert!(notice.visible);
                assert_eq!(
                    notice.body.as_deref(),
                    Some(format!("{error} Nothing was uploaded or pasted.").as_str())
                );
                for text in [
                    notice.body.as_ref().unwrap(),
                    view.local_error.as_ref().unwrap(),
                ] {
                    assert!(!text.contains("/private"));
                    assert!(!text.contains("secret"));
                }
            });
        }
    }

    #[gpui::test]
    fn shared_transfer_notice_uses_selected_endpoint_and_sanitizes_text(
        cx: &mut gpui::TestAppContext,
    ) {
        let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
        view.update(cx, |view, cx| {
            view.endpoints.push(crate::endpoint::Endpoint::new(
                "other".into(),
                "Other".into(),
                ConnectTarget::Socket("/unused-transfer-test.sock".into()),
                false,
            ));
            view.selected_endpoint = 1;
            view.local_transfer_notice("Copy failed", "Cannot copy\x1b\ntext".into(), cx);
            assert!(view.endpoints[0].toasts.entries.is_empty());
            let (_, notice) = view.endpoints[1].toasts.entries.back().unwrap();
            assert_eq!(notice.title, "Copy failed");
            assert_eq!(notice.body.as_deref(), Some("Cannot copytext"));
            assert!(notice.visible);
            assert!(view.local_error.is_none());
        });
    }
}
