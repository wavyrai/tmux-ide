//! The window's periodic endpoint work: draining each connection, activating
//! the selected surface, and probing sessions.
use super::{ACTIVATION_TIMEOUT, LOCAL, Redraw};
use crate::HerdrWindow;
use gpui::{ClipboardItem, Context};
use herdr_client::RemoteHost;
use std::time::Instant;

impl HerdrWindow {
    /// Writes daemon-forwarded OSC 52 payloads to the pasteboard and reports
    /// the copy the way a local selection does. Returns whether anything was
    /// written, so the window repaints for the flash.
    pub(super) fn apply_clipboard_writes(
        &mut self,
        writes: impl IntoIterator<Item = String>,
        cx: &mut Context<Self>,
    ) -> bool {
        let mut writes = writes.into_iter().peekable();
        if writes.peek().is_none() {
            return false;
        }
        for text in writes {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
        if self.config.clipboard_toast.enabled {
            self.show_flash(crate::window::Flash::success("copied to clipboard"), cx);
        }
        true
    }

    pub(crate) fn poll_endpoints(&mut self, cx: &mut Context<Self>) {
        self.recover_after_sleep(Instant::now(), std::time::SystemTime::now());
        // Record the focused target the user last saw before a newer snapshot
        // can replace it; input held across a gap may only go there.
        self.flush_pending_input(cx);
        if let Some(error) = self.catalog.poll_write() {
            crate::storage_warning::warn_storage_failure("Save host selection", &error);
            self.local_error = Some(format!("Save host selection: {error}"));
            cx.notify();
        }
        if let Some(result) = self.catalog.poll() {
            match result {
                Ok(update) => {
                    self.catalog.accept(&update);
                    #[cfg(feature = "cloud")]
                    self.reconcile_devices(update.hosts, update.wsl, update.cloud, cx);
                    #[cfg(not(feature = "cloud"))]
                    self.reconcile_devices(update.hosts, update.wsl, cx);
                }
                Err(error) => {
                    self.local_error = Some(format!("Host catalog: {error}"));
                    cx.notify();
                }
            }
        }
        let mut changed = Redraw::None;
        // Whether the selected endpoint itself moved on. Only then does the
        // window take its state: another endpoint changing, or this one's
        // inbox being busy for a poll, must not replace what the window has
        // stamped since, such as the split drag request it is waiting on.
        let mut selected_changed = false;
        // OSC 52 writes are drained per endpoint so they are written once and
        // never linger in a live state that a later poll would re-read.
        let mut clipboard_writes = std::collections::VecDeque::new();
        for (index, endpoint) in self.endpoints.iter_mut().enumerate() {
            let updated = endpoint.poll(Instant::now());
            clipboard_writes.append(&mut endpoint.live.clipboard_writes);
            // Bells are a presentation effect: only the selected endpoint's
            // ring, as the TUI drops them from inactive endpoints.
            let bells = std::mem::take(&mut endpoint.live.bells);
            if index == self.selected_endpoint {
                self.bell.queue(bells);
            }
            selected_changed |= index == self.selected_endpoint && updated != Redraw::None;
            self.sound.poll(
                &mut endpoint.sounds,
                &mut endpoint.live,
                index == self.selected_endpoint && self.active,
                Instant::now(),
            );
            changed = changed.max(updated);
            // Remote cwd strings must never be resolved against this machine's Git repos.
            if updated == Redraw::Window
                && index == 0
                && let (Some(avatars), Some(snapshot)) =
                    (&mut self.avatars, &endpoint.live.snapshot)
            {
                for workspace in &snapshot.workspaces {
                    avatars.request(&workspace.new_workspace_cwd);
                }
            }
            if endpoint.enabled
                && !endpoint.detached
                && endpoint.connection.handle.is_none()
                && Instant::now() >= endpoint.retry_at
            {
                endpoint.connect(self.options, index == 0 && self.selected_endpoint == 0);
                selected_changed |= index == self.selected_endpoint;
                changed = Redraw::Window;
            }
        }
        if self.apply_clipboard_writes(clipboard_writes, cx) {
            changed = Redraw::Window;
        }
        self.restore_selection(cx);
        if self.tick_toasts(
            self.menu.page.is_some() || self.toasts_hidden,
            Instant::now(),
        ) {
            changed = Redraw::Window;
        }
        let endpoint = &mut self.endpoints[self.selected_endpoint];
        if self.selected_generation != endpoint.generation {
            self.reset_selected(cx);
        }
        let endpoint = &mut self.endpoints[self.selected_endpoint];
        if selected_changed {
            self.live = endpoint.live.clone();
            if !self.live.status.is_connected() {
                self.local_error = None;
            }
        }
        if endpoint.outage().is_some() {
            self.presentation.hold();
        } else {
            self.presentation.resume();
        }
        // Activation is timed from the snapshot it needs. An endpoint that is
        // down or still handshaking is retried in place, never given up for Local.
        // The handle stops before the disconnect state reaches the inbox, so
        // `live` can still hold the lost connection's snapshot for a poll; the
        // outage is recorded as soon as the stop is seen.
        if (self.live.snapshot.is_none() || endpoint.outage().is_some())
            && let Some(deadline) = &mut self.activation_deadline
        {
            *deadline = Instant::now() + ACTIVATION_TIMEOUT;
        }
        self.pending_releases
            .retain_mut(|release| !release.resolved());
        if !endpoint.initial_surface
            && self.pending_releases.is_empty()
            && let (Some(handle), Some(snapshot)) =
                (&endpoint.connection.handle, &endpoint.live.snapshot)
            && let Ok(mut state) = endpoint.connection.inbox.try_lock()
        {
            let result = handle
                .resize(&snapshot.boot_id, self.options)
                .and_then(|()| handle.set_surface_active(&snapshot.boot_id, true));
            match result {
                Ok(request) => {
                    state.surface = None;
                    state.activation = Some(crate::state::SurfaceActivation {
                        request,
                        boot: snapshot.boot_id.clone(),
                        revision: None,
                        failed: false,
                        focus: None,
                        active: true,
                    });
                    state.dirty = true;
                    endpoint.initial_surface = true;
                    self.live = state.clone();
                    // take_update already moved this response out of the inbox.
                    // Installing an activation fence must not discard that delivery.
                    self.live.dialog_response = endpoint.live.dialog_response.clone();
                    self.activation_deadline = Some(Instant::now() + ACTIVATION_TIMEOUT);
                    self.last_queued_options = Some(self.options);
                    self.sent_focus = None;
                }
                Err(error) => {
                    self.local_error = Some(format!("Activate: {error}"));
                    self.activation_deadline = Some(Instant::now());
                }
            }
            changed = Redraw::Window;
        }
        // Held input precedes any deferred navigation.
        self.flush_pending_input(cx);
        if self.navigation_ready() {
            self.activation_deadline = None;
            if let Some(id) = self.pending_toast {
                self.navigate_toast(id, cx);
            } else if let Some(target) = self.pending_navigation.take() {
                self.dispatch_navigation(target.as_deref(), cx);
            }
        } else if self
            .activation_deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
            || self.live.activation.as_ref().is_some_and(|a| a.failed)
        {
            let mut error = format!(
                "{}: surface activation failed or timed out",
                self.endpoints[self.selected_endpoint].label
            );
            if let Some(reason) = &self.live.error {
                error.push_str(&format!(": {reason}"));
            }
            if self.selected_endpoint != 0 {
                self.switch_endpoint(LOCAL, cx);
            } else {
                // Recover Local with a fresh active handshake, even if the
                // previous surface lane or its acknowledgement was unavailable.
                self.reconnect(cx);
            }
            self.local_error = Some(error);
            changed = Redraw::Window;
        }
        self.sync_server_keymap(cx);
        match changed {
            Redraw::None => {}
            Redraw::Terminal => self.redraw_terminal(cx),
            Redraw::Window => cx.notify(),
        }
    }

    /// Scan local sessions while the popup asks for them, and ask the saved
    /// devices for their own sessions on their own slower interval. Probing is
    /// I/O to the disk and to each host, so both run on workers and only this
    /// page starts one; results are cached between opens.
    pub(crate) fn poll_sessions(&mut self, cx: &mut Context<Self>) {
        let development = self.local_development();
        let open = self.menu.page == Some(crate::menu::Page::Sessions);
        let now = Instant::now();
        let targets = self.probe_targets();
        self.sessions.devices.forget_replaced(&targets);
        // Hold the catalog steady through the mutation and its successful exit
        // animation. Workers stay bounded; finished answers wait in their inbox.
        if self.sessions.mutation.is_some() {
            if open && self.sessions.departure.is_some() {
                cx.notify();
            }
            return;
        }
        let mut changed = self.sessions.poll(development, open, now);
        if self.sessions.devices.poll(&targets, open, now) {
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    /// The devices this window may ask for their sessions: every enabled saved
    /// device on an SSH host or in a WSL distribution. One the user disabled is
    /// never dialled, and the local endpoint has no host to ask.
    pub(crate) fn probe_targets(&self) -> Vec<(String, RemoteHost)> {
        self.endpoints
            .iter()
            .skip(1)
            .filter(|endpoint| endpoint.enabled)
            .filter_map(|endpoint| {
                Some((
                    endpoint.id.clone(),
                    endpoint.connection.target.remote_host()?,
                ))
            })
            .collect()
    }
}
