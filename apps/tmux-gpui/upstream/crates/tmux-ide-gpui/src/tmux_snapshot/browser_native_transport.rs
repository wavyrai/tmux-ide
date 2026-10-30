//! Direct terminal route. The pipe carries catalog metadata and one-use capabilities only.
use super::super::{
    browser_direct::NativePresentation,
    browser_native_actions::{self, ActionOwner},
    browser_native_divider::{DividerOwner, SplitResponse},
    browser_native_editor::{Editor, ReadContext, Response as EditorResponse},
    browser_native_graphics::Graphics,
    browser_native_history::{Cache, History, Response},
    browser_native_input::{self, InputOwner},
    browser_native_owner::{self, Owner},
};
use super::*;
use herdr_client::{tmux_controller::Controller, tmux_handoff::Event};
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error)]
enum NativeError {
    #[cfg(target_os = "macos")]
    #[error("native surface publication failed")]
    Surface(#[from] crate::tmux_native_surface::driver::Error),
    #[error("direct terminal handoff failed")]
    Handoff(#[from] herdr_client::tmux_handoff::Error),
    #[error("direct terminal controller failed")]
    Controller(#[from] herdr_client::tmux_controller::Error),
    #[error("direct terminal input scheduler failed")]
    Input(#[from] browser_native_input::Error),
    #[error("direct terminal action failed")]
    Action(#[from] browser_native_actions::Error),
    #[error("direct owner action failed")]
    Owner(#[from] browser_native_owner::Error),
    #[error("direct terminal presentation failed")]
    Presentation(#[from] Error),
}
#[path = "browser_native_diagnostics.rs"]
mod diagnostics;
use super::super::browser_native_transition as transition;
enum Incoming {
    NativeOwner(Box<browser_native_owner::Response>),
    Catalog(Box<State>),
    Handoff(Event),
    History(Response),
    Editor(EditorResponse),
    Split(SplitResponse),
    Owner {
        id: String,
        request: u64,
        bytes: Vec<u8>,
    },
    Closed,
}
struct Active {
    id: String,
    request: u64,
    // A refused UI navigation does not change the terminal admission scope.
    input_epoch: u64,
    session: String,
    controller: Controller,
    presentation: NativePresentation,
    graphics: Graphics,
    #[cfg(target_os = "macos")]
    surfaces: super::super::browser_native_surfaces::Scene,
    input: InputOwner,
    selection_notice: Option<Command>,
    history: History,
    editor: Editor,
    editor_notice: Option<Command>,
    history_notice: Option<Command>,
    actions: ActionOwner,
    divider: DividerOwner,
    split_notice: Option<Command>,
    reissue: bool,
    preferred_pane: Option<String>,
    owner: Owner,
    stream_interrupted: bool,
    owner_notice: Option<Command>,
    action_status: Option<&'static str>,
    catalog_only: bool,
    daemon_version: Option<String>,
    generation: String,
    topology_notice: Option<Command>,
    topology_sent: catalog_notice::CatalogNotice,
    metadata_notice: Option<Command>,
    metadata_sent: Option<(u64, u64, String)>,
}
#[path = "browser_native_active.rs"]
mod active;
#[path = "browser_native_catalog.rs"]
mod catalog_notice;
fn revoke(active: &mut Option<Active>, state: &mut State) {
    if let Some(mut old) = active.take() {
        old.controller.retire();
    }
    state.frame = None;
    state.input_ready = false;
    state.input_targets.clear();
    state.native_focus_target = None;
    state.selection_identity = None;
    state.copy_region = None;
    state.regions.clear();
    state.graphics.clear();
    #[cfg(target_os = "macos")]
    {
        state.native_surfaces = None;
    }
    state.pane_actions = None;
    state.resize_token = None;
    state.split_layout = None;
}
fn revoke_connection(
    active: &mut Option<Active>,
    state: &mut State,
    output: &mut impl FnMut(Command) -> Result<(), Error>,
) {
    if let Some(value) = active.as_mut().and_then(|a| a.editor.cancel()) {
        let _ = output(Command::NativeEditorCancel { value });
    }
    revoke(active, state);
}
fn navigates(command: &Command) -> bool {
    matches!(
        command,
        Command::Home { .. }
            | Command::Pane { .. }
            | Command::Session { .. }
            | Command::Machine { .. }
            | Command::Refresh { .. }
            | Command::SessionTab { .. }
            | Command::SessionHistory { .. }
            | Command::FleetSession { .. }
            | Command::FleetServer { .. }
            | Command::MachineProfile { .. }
            | Command::OpenWorkspaceFleetAgent { .. }
            | Command::OpenWorkspaceAgent { .. }
            | Command::OpenPaletteAgent { .. }
            | Command::OpenAttentionAgent { .. }
            | Command::OpenAgent { .. }
    )
}
fn send_state(mailbox: &Mailbox, state: &State) {
    if let Ok(mut slot) = mailbox.lock() {
        *slot = Some(Some(state.clone()));
    }
}
fn accept_pipe(
    bytes: &[u8],
    reader: &mut Reader,
    tx: &mpsc::SyncSender<Incoming>,
) -> Result<(), Error> {
    #[derive(Deserialize)]
    struct Kind {
        #[serde(rename = "type")]
        kind: Option<String>,
    }
    let kind: Kind = serde_json::from_slice(bytes)?;
    let message = if matches!(
        kind.kind.as_deref(),
        Some("native-terminal-open" | "native-terminal-close")
    ) {
        Incoming::Handoff(
            Event::parse(bytes)
                .map_err(|_| Error::Invalid("invalid native capability envelope"))?,
        )
    } else if kind.kind.as_deref() == Some("native-editor-result") {
        Incoming::Editor(
            EditorResponse::parse(bytes).ok_or(Error::Invalid("invalid editor result"))?,
        )
    } else if kind.kind.as_deref() == Some("native-split-layout-result") {
        Incoming::Split(
            SplitResponse::parse(bytes).ok_or(Error::Invalid("invalid split metadata response"))?,
        )
    } else if kind.kind.as_deref() == Some("native-owner-action-result") {
        #[derive(Deserialize)]
        struct Header {
            id: String,
            request: u64,
        }
        if bytes.len() > 16384 {
            return Err(Error::Invalid("owner response too large"));
        }
        let header: Header = serde_json::from_slice(bytes)?;
        Incoming::Owner {
            id: header.id,
            request: header.request,
            bytes: bytes.to_vec(),
        }
    } else if kind.kind.as_deref() == Some("native-history-result") {
        Incoming::History(Response::parse(bytes)?)
    } else {
        let state = reader.accept(bytes)?;
        if state.frame.is_some() || state.input_ready || !state.graphics.is_empty() {
            return Err(Error::Invalid("broker sent terminal data on native route"));
        }
        Incoming::Catalog(Box::new(state))
    };
    tx.send(message)
        .map_err(|_| Error::Invalid("native route closed"))
}
fn read_broker(
    input: &mut impl BufRead,
    reader: &mut Reader,
    tx: &mpsc::SyncSender<Incoming>,
    binary: bool,
) -> Result<(), Error> {
    if binary {
        let mut parser = decode::binary::Parser::default();
        let mut bytes = [0; 65536];
        loop {
            let n = input.read(&mut bytes)?;
            if n == 0 {
                return parser.finish();
            }
            parser.push(&bytes[..n], |kind, payload| {
                if !matches!(kind, decode::binary::Kind::Json) {
                    return Err(Error::Invalid("terminal payload on broker pipe"));
                }
                accept_pipe(payload, reader, tx)?;
                Ok(true)
            })?;
        }
    } else {
        loop {
            let mut line = Vec::new();
            let n = input
                .by_ref()
                .take(8 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut line)?;
            if n == 0 {
                return Ok(());
            }
            if n > 8 * 1024 * 1024 || line.last() != Some(&b'\n') {
                return Err(Error::Invalid("invalid broker publication bound"));
            }
            accept_pipe(&line, reader, tx)?;
        }
    }
}
fn read_pipe(mut input: impl BufRead, binary: bool, tx: mpsc::SyncSender<Incoming>) {
    let mut reader = Reader::default();
    let result = read_broker(&mut input, &mut reader, &tx, binary);
    if result.is_err() {
        eprintln!("tmux-preview: native broker pipe rejected");
    }
    let _ = tx.send(Incoming::Closed);
}
fn write_pipe_command(output: &mut impl Write, command: &Command) -> Result<(), Error> {
    let mut bytes = serde_json::to_vec(command)?;
    bytes.push(b'\n');
    output.write_all(&bytes)?;
    output.flush()?;
    Ok(())
}
pub(super) fn start(kitty: super::super::kitty_graphics::Store) -> Bridge {
    let binary = std::env::var("TMUX_IDE_GUI_NATIVE_ENCODING").as_deref() == Ok("binary-rle-v1");
    start_io(
        kitty,
        || BufReader::new(std::io::stdin().lock()),
        || std::io::stdout().lock(),
        binary,
    )
}
// Construct handles inside their owning threads, preserving lock lifetimes and ordered I/O.
pub(in crate::tmux_snapshot) fn start_io<R: BufRead, W: Write>(
    kitty: super::super::kitty_graphics::Store,
    input: impl FnOnce() -> R + Send + 'static,
    output: impl FnOnce() -> W + Send + 'static,
    binary: bool,
) -> Bridge {
    let (tx, rx) = mpsc::sync_channel(8);
    std::thread::spawn(move || read_pipe(input(), binary, tx));
    start_events(kitty, rx, move || {
        let mut output = output();
        move |command| write_pipe_command(&mut output, &command)
    })
}

// The terminal loop consumes typed events and moves commands to its owner.
// Only the legacy pipe adapter above serializes catalog/control messages.
fn start_events<F: FnMut(Command) -> Result<(), Error>>(
    kitty: super::super::kitty_graphics::Store,
    rx: mpsc::Receiver<Incoming>,
    output: impl FnOnce() -> F + Send + 'static,
) -> Bridge {
    let mailbox = Arc::new(Mutex::new(None));
    let incoming = mailbox.clone();
    let (commands, receiver) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut active: Option<Active> = None;
        let history_cache: Cache = Default::default();
        let mut state = State::default();
        let mut stopped: Option<diagnostics::Stop> = None;
        let mut previews = super::super::browser_native_preview::Cache::default();
        let mut transition = transition::Transition::default();
        let mut browser_read_at = 0;
        let mut presence = (true, 0);
        let mut pending = std::collections::VecDeque::new();
        let start = Instant::now();
        let mut output = output();
        'worker: loop {
            let now = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
            let mut changed = false;
            loop {
                let event = match rx.try_recv() {
                    Ok(event) => event,
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => break 'worker,
                };
                match event {
                    Incoming::Closed => break 'worker,
                    Incoming::NativeOwner(response) => {
                        if let Some(current) = active
                            .as_mut()
                            .filter(|a| a.id == response.id && a.request == response.request)
                        {
                            match current.owner.response_native(*response) {
                                Ok(Some(done)) => current.owner_completed(done),
                                Ok(None) => {}
                                Err(_) => {
                                    revoke_connection(&mut active, &mut state, &mut output);
                                    changed = true;
                                }
                            }
                        }
                    }
                    Incoming::Owner { id, request, bytes } => {
                        if let Some(current) = active
                            .as_mut()
                            .filter(|a| a.id == id && a.request == request)
                        {
                            match current.owner.response(&bytes) {
                                Ok(Some(done)) => current.owner_completed(done),
                                Ok(None) => {}
                                Err(_) => {
                                    revoke_connection(&mut active, &mut state, &mut output);
                                    changed = true;
                                }
                            }
                        }
                    }
                    Incoming::Editor(response) => {
                        if let Some(current) = active
                            .as_mut()
                            .filter(|a| a.id == response.id && a.request == response.request)
                        {
                            changed |= current.editor.receive(response);
                        }
                    }
                    Incoming::Split(response) => {
                        if let Some(current) = active
                            .as_mut()
                            .filter(|a| a.id == response.id && a.request == response.request)
                        {
                            if let Some(resource) = response.resource {
                                if current
                                    .divider
                                    .accept_resource(
                                        &mut current.controller,
                                        response.sequence,
                                        resource,
                                    )
                                    .is_err()
                                {
                                    revoke_connection(&mut active, &mut state, &mut output);
                                }
                            } else {
                                current.divider.read_failed(response.sequence);
                            }
                            changed = true;
                        }
                    }
                    Incoming::History(response) => {
                        if let Some(current) = active
                            .as_mut()
                            .filter(|a| a.id == response.id && a.request == response.request)
                        {
                            match current
                                .history
                                .response(&mut current.presentation, response, now)
                            {
                                Ok(dirty) => changed |= dirty,
                                Err(_) => {
                                    revoke_connection(&mut active, &mut state, &mut output);
                                    changed = true;
                                }
                            }
                        }
                    }
                    Incoming::Catalog(next) => {
                        if next.request < state.request
                            || active.as_ref().is_some_and(|a| next.request < a.request)
                        {
                            continue;
                        }
                        if active.as_ref().is_some_and(|a| next.request > a.request) {
                            revoke_connection(&mut active, &mut state, &mut output);
                        }
                        if let Some(current) = active.as_mut() {
                            current.presentation.invalidate_overlay();
                        }
                        state = *next;
                        diagnostics::Stop::apply(&mut stopped, &mut state);
                        changed = true;
                    }
                    Incoming::Handoff(Event::Close { id, request, .. }) => {
                        if active
                            .as_ref()
                            .is_some_and(|a| a.id == id && a.request == request)
                        {
                            revoke_connection(&mut active, &mut state, &mut output);
                            changed = true;
                        }
                    }
                    Incoming::Handoff(Event::Open {
                        id,
                        request,
                        live_session_id,
                        capability,
                        ..
                    }) => {
                        if active.is_some() || request < state.request {
                            break 'worker;
                        }
                        let workspace = capability.workspace_name.clone();
                        let catalog_only = capability.catalog_only;
                        let daemon_version = capability.daemon_version.clone();
                        stopped = None;
                        let generation = capability.descriptor.daemon_instance_id.clone();
                        let history = History::new(
                            capability
                                .server_scope
                                .as_ref()
                                .map(|s| (s.server_id.clone(), s.generation.clone())),
                            workspace.clone(),
                            live_session_id.clone(),
                            capability.selected_pane.clone(),
                            history_cache.clone(),
                        );
                        #[cfg(target_os = "macos")]
                        let (controller_result, surface_inbox) = if capability.native_surfaces {
                            let Ok(generation_id) = uuid::Uuid::parse_str(&generation) else {
                                break 'worker;
                            };
                            let (driver, inbox) =
                                crate::tmux_native_surface::driver::Driver::new(generation_id);
                            (
                                Controller::spawn_with_surfaces(*capability, Box::new(driver)),
                                Some(inbox),
                            )
                        } else {
                            (Controller::spawn(*capability), None)
                        };
                        #[cfg(not(target_os = "macos"))]
                        let controller_result = Controller::spawn(*capability);
                        let Ok(mut controller) = controller_result else {
                            break 'worker;
                        };
                        if controller.presence(presence.0, presence.1, now).is_err() {
                            break 'worker;
                        }
                        let Ok(owner) = Owner::new(
                            id.clone(),
                            request,
                            workspace.clone(),
                            live_session_id.clone(),
                            generation.clone(),
                        ) else {
                            break 'worker;
                        };
                        active = Some(Active {
                            presentation: NativePresentation::new(&id, &workspace),
                            graphics: Graphics::new(kitty.clone()),
                            #[cfg(target_os = "macos")]
                            surfaces: super::super::browser_native_surfaces::Scene::new(
                                surface_inbox,
                            ),
                            id,
                            request,
                            input_epoch: request,
                            session: live_session_id,
                            controller,
                            input: InputOwner::default(),
                            selection_notice: None,
                            history,
                            editor: Editor::default(),
                            editor_notice: None,
                            history_notice: None,
                            actions: ActionOwner::default(),
                            divider: DividerOwner::default(),
                            split_notice: None,
                            reissue: false,
                            preferred_pane: None,
                            owner,
                            stream_interrupted: false,
                            owner_notice: None,
                            action_status: None,
                            catalog_only,
                            daemon_version,
                            generation,
                            topology_notice: None,
                            topology_sent: Default::default(),
                            metadata_notice: None,
                            metadata_sent: None,
                        });
                        changed = true;
                    }
                }
            }
            // Observe blur before consuming ACKs: queued text must never be dispatched
            // by an ACK while the foreground revocation is waiting in the command pipe.
            loop {
                match receiver.try_recv() {
                    Ok(Command::Presence {
                        active: foreground,
                        revision,
                    }) => {
                        presence = (foreground, revision);
                        if !foreground {
                            pending.retain(|command| !matches!(command, Command::Input { .. }));
                            if let Some(current) = active.as_mut() {
                                if let Some(value) = current.editor.cancel()
                                    && output(Command::NativeEditorCancel { value }).is_err()
                                {
                                    break 'worker;
                                }
                                current.input.focus_loss();
                                current.actions.focus_loss();
                                current.divider.focus_loss();
                                current.owner.cancel_waiting();
                            }
                        }
                        if let Some(current) = active.as_mut()
                            && !current.reissue
                            && !current.stream_interrupted
                            && current
                                .controller
                                .presence(foreground, revision, now)
                                .is_err()
                        {
                            break 'worker;
                        }
                        if output(Command::Presence {
                            active: foreground,
                            revision,
                        })
                        .is_err()
                        {
                            break 'worker;
                        }
                        changed = true;
                    }
                    Ok(command) => {
                        // Presence is drained ahead of dispatch. Refuse background
                        // input at admission so a later refocus in this same batch
                        // cannot revive stale text or geometry.
                        if !presence.0 && matches!(command, Command::Input { .. }) {
                            continue;
                        }
                        if pending.len() >= 64 {
                            break 'worker;
                        }
                        pending.push_back(command);
                    }
                    Err(mpsc::TryRecvError::Disconnected) => break 'worker,
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }
            if let Some(current) = active.as_mut().filter(|a| !a.reissue) {
                match current.poll(&mut state, presence.0, now) {
                    Ok(dirty) => changed |= dirty,
                    Err(error) => {
                        eprintln!(
                            "tmux-preview: terminal poll interrupted: {}",
                            diagnostics::code(&error)
                        );
                        // A submitted close/split can retire its stream before the receipt.
                        // Reconcile inventory once; never replay the mutation or queued input.
                        let structural = current.actions.interrupted().is_some_and(|c| c.reissue);
                        // Reconnecting cannot help a daemon that lacks a required capability.
                        let stop = diagnostics::Stop::new(
                            &error,
                            current.request,
                            current.daemon_version.as_deref(),
                        );
                        if stop.is_some() {
                            revoke_connection(&mut active, &mut state, &mut output);
                        } else if current.owner.waiting_receipt() && current.owner_notice.is_none()
                        {
                            // The authorized HTTP operation may retire the stream
                            // before replying. Preserve correlation, not terminal IO.
                            current.stream_interrupted = true;
                            current.controller.retire();
                            current.input.focus_loss();
                            pending.retain(|command| !matches!(command, Command::Input { .. }));
                            revoke(&mut None, &mut state);
                        } else if structural {
                            current.reissue = true;
                            current.input.focus_loss();
                            pending.retain(|command| !matches!(command, Command::Input { .. }));
                            revoke(&mut None, &mut state);
                        } else {
                            let notice = Command::NativeTerminalInterrupted {
                                version: 1,
                                id: current.id.clone(),
                                request: current.request,
                                pane: current.controller.selected().into(),
                                live_session_id: current.session.clone(),
                                generation: current.generation.clone(),
                                presence_revision: presence.1,
                            };
                            revoke_connection(&mut active, &mut state, &mut output);
                            if output(notice).is_err() {
                                break 'worker;
                            }
                        }
                        state.status = stop.as_ref().map_or_else(
                            || "Terminal connection interrupted — recovering".into(),
                            |stop| stop.status.clone(),
                        );
                        stopped = stop;
                        state.input_target_rejected = true;
                        changed = true;
                    }
                }
            }
            if let Some(command) = active.as_mut().and_then(|a| a.editor_notice.take())
                && output(command).is_err()
            {
                break 'worker;
            }
            if let Some(command) = active.as_mut().and_then(|a| a.selection_notice.take()) {
                if output(command).is_err() {
                    break 'worker;
                }
                changed = true;
            }
            if let Some(command) = active.as_mut().and_then(|a| a.split_notice.take())
                && output(command).is_err()
            {
                break 'worker;
            }
            if let Some(command) = active.as_mut().and_then(|a| a.owner_notice.take())
                && output(command).is_err()
            {
                break 'worker;
            }
            if let Some(command) = active.as_mut().and_then(|a| a.topology_notice.take())
                && output(command).is_err()
            {
                break 'worker;
            }
            if let Some(command) = active.as_mut().and_then(|a| a.metadata_notice.take())
                && output(command).is_err()
            {
                break 'worker;
            }
            if let Some(command) = active.as_mut().and_then(|a| a.history_notice.take())
                && output(command).is_err()
            {
                break 'worker;
            }
            // The broker admits refresh only in the foreground. Retain a completed
            // mutation until focus returns so its fresh inventory request is not lost.
            if presence.0 && active.as_ref().is_some_and(|a| a.reissue) {
                if let Some(current) = active.as_ref() {
                    transition.begin(&state, current.request, now);
                    let command = Command::NativeTerminalRefresh {
                        id: current.id.clone(),
                        request: current.request,
                        preferred_pane: current.preferred_pane.clone(),
                    };
                    if output(command).is_err() {
                        break 'worker;
                    }
                }
                revoke_connection(&mut active, &mut state, &mut output);
                state.status = "Opening terminal".into();
                changed = true;
            }
            // Leave queued commands bounded while one scheduler admission waits for an ACK.
            let action_waiting = pending.front().is_some_and(|c| {
                matches!(
                    c,
                    Command::OpenEditor { .. }
                        | Command::PaneAction { .. }
                        | Command::ResizePane { .. }
                        | Command::SplitGesture { .. }
                )
            });
            let navigation_waiting = pending.front().is_some_and(navigates);
            let draining_history = active
                .as_mut()
                .is_some_and(|a| a.history.drain(&mut a.presentation, now));
            // A drag release/cancel closes the barrier even if newer input or a fit
            // is queued behind its Begin. Those terminal commands keep their FIFO order.
            let continuing_split = active.as_ref().is_some_and(|a| a.divider.busy());
            let split_command = continuing_split
                .then(|| {
                    pending.iter().position(|c| match c {
                        Command::SplitGesture {
                            request,
                            gesture,
                            update,
                        } => active.as_ref().is_some_and(|a| {
                            a.request == *request && a.divider.continuation(gesture, update)
                        }),
                        _ => false,
                    })
                })
                .flatten();
            let can_admit = !(navigation_waiting && draining_history)
                && active.as_ref().is_none_or(|a| {
                    !a.reissue
                        && !a.owner.busy()
                        && (!a.divider.busy() || split_command.is_some())
                        && !a.actions.busy()
                        && !(presence.0
                            && matches!(pending.front(), Some(Command::Input { .. }))
                            && !a.controller.input_ready())
                        && !a.input.waiting()
                        && (!action_waiting || !a.input.busy())
                });
            let mut admitted = false;
            if can_admit
                && let Some(command) = split_command
                    .and_then(|index| pending.remove(index))
                    .or_else(|| pending.pop_front())
            {
                admitted = true;
                if matches!(
                    &command,
                    Command::PaneAction {
                        action: super::super::pane_actions::Action::NewWindow,
                        ..
                    }
                ) {
                    transition.begin(&state, state.request, now);
                }
                if navigates(&command)
                    && let Some(value) = active.as_mut().and_then(|a| a.editor.cancel())
                    && output(Command::NativeEditorCancel { value }).is_err()
                {
                    break 'worker;
                }
                let result = match command {
                    Command::OpenEditor { request, id, token } => {
                        if let Some(current) = active
                            .as_mut()
                            .filter(|a| a.request == request && !a.catalog_only)
                            && let Some(value) = current.editor.submit(
                                &current.controller,
                                &current.presentation,
                                ReadContext {
                                    id: &current.id,
                                    request,
                                    pane: &id,
                                    token: &token,
                                    presence: presence.1,
                                },
                                now,
                            )
                        {
                            if output(Command::NativeEditorOpen { value }).is_err() {
                                break 'worker;
                            }
                            current.action_status = Some("Opening selected pane folder in VS Code");
                        }
                        Ok(())
                    }
                    Command::Input {
                        request,
                        id,
                        input_target,
                        input,
                    } => active
                        .as_mut()
                        .filter(|a| a.request == request)
                        .map_or(Ok(()), |a| {
                            a.input(&id, input_target.as_deref(), input, now)
                        }),
                    Command::Pane { request, id }
                        if active.as_ref().is_some_and(|a| {
                            !a.catalog_only && a.controller.selectable(&id).is_some()
                        }) =>
                    {
                        if let Some(current) = active.as_mut() {
                            current.select(&id, request, now)
                        } else {
                            Ok(())
                        }
                    }
                    Command::PaneAction {
                        request,
                        id,
                        token,
                        action,
                    } => active
                        .as_mut()
                        .filter(|a| a.request == request)
                        .map_or(Ok(()), |a| a.action(&id, &token, action, now)),
                    Command::SplitGesture {
                        request,
                        gesture,
                        update,
                    } => active
                        .as_mut()
                        .filter(|a| a.request == request)
                        .map_or(Ok(()), |a| {
                            a.divider
                                .command(&mut a.controller, &gesture, update, now)
                                .map(|_| ())
                                .map_err(NativeError::from)
                        }),
                    Command::ResizePane {
                        request,
                        id,
                        token,
                        axis,
                        cells,
                    } => active
                        .as_mut()
                        .filter(|a| a.request == request)
                        .map_or(Ok(()), |a| {
                            a.actions
                                .resize(
                                    &mut a.controller,
                                    &a.presentation,
                                    browser_native_actions::ActionTarget {
                                        pane: &id,
                                        token: &token,
                                        operation: &uuid::Uuid::new_v4().to_string(),
                                    },
                                    axis,
                                    cells,
                                    now,
                                )
                                .map_err(NativeError::from)
                        }),
                    Command::KittyMissing { digests } => active.as_mut().map_or(Ok(()), |a| {
                        a.controller
                            .graphics_missing(digests)
                            .map_err(NativeError::from)
                    }),
                    Command::Presence {
                        active: foreground,
                        revision,
                    } => {
                        presence = (foreground, revision);
                        let result = active.as_mut().map_or(Ok(()), |a| {
                            if a.stream_interrupted {
                                return Ok(());
                            }
                            a.controller
                                .presence(foreground, revision, now)
                                .map_err(NativeError::from)
                        });
                        if output(Command::Presence {
                            active: foreground,
                            revision,
                        })
                        .is_err()
                        {
                            break 'worker;
                        }
                        result
                    }
                    other => {
                        if navigates(&other) {
                            if let Command::Pane { request, .. } = &other {
                                transition.begin(&state, *request, now);
                            } else {
                                transition.clear();
                            }
                            revoke_connection(&mut active, &mut state, &mut output);
                            changed = true;
                        }
                        if output(other).is_err() {
                            break 'worker;
                        }
                        Ok(())
                    }
                };
                let fatal = match &result {
                    Ok(()) => false,
                    Err(NativeError::Input(
                        browser_native_input::Error::Scope
                        | browser_native_input::Error::Unsupported
                        | browser_native_input::Error::Scheduler(
                            herdr_client::tmux_input::Error::Busy,
                        ),
                    )) => active.as_ref().is_some_and(|a| a.input.retired()),
                    Err(NativeError::Owner(browser_native_owner::Error::Rejected)) => false,
                    Err(NativeError::Action(
                        browser_native_actions::Error::Stale
                        | browser_native_actions::Error::BrokerRequired,
                    )) => false,
                    Err(NativeError::Action(browser_native_actions::Error::Controller(
                        herdr_client::tmux_controller::Error::Control(
                            herdr_client::tmux_control::Error::Busy
                            | herdr_client::tmux_control::Error::Lifetime,
                        ),
                    ))) => false,
                    Err(_) => true,
                };
                if fatal {
                    revoke_connection(&mut active, &mut state, &mut output);
                    state.status = "Terminal input interrupted — reopen the pane".into();
                    state.input_target_rejected = true;
                    changed = true;
                }
            }
            if presence.0 && state.input_ready && now >= browser_read_at {
                for pane in state
                    .panes
                    .iter()
                    .filter(|p| p.browser_icon.is_some() && state.browser_pane_visible(&p.id))
                    .take(24)
                {
                    if output(Command::BrowserControls {
                        request: state.request,
                        id: pane.id.clone(),
                        command: None,
                    })
                    .is_err()
                    {
                        break 'worker;
                    }
                }
                browser_read_at = now.saturating_add(750);
            }
            if let Some(route) = state.native_frame_scope.as_ref() {
                previews.remember(route, &state);
            }
            let preview_before = state.retained_preview;
            let frame_before = state.frame.clone();
            if let Some(route) = state.native_retained_preview.clone() {
                previews.show(&route, &mut state, presence.0, now);
            } else {
                previews.clear_preview(&mut state);
            }
            changed |= preview_before != state.retained_preview
                || match (frame_before.as_ref(), state.frame.as_ref()) {
                    (Some(a), Some(b)) => !a.same(b),
                    (None, None) => false,
                    _ => true,
                };
            let expired = transition.expire(now);
            if changed || expired {
                let publication = transition.publication(&state, presence.0, now);
                send_state(&incoming, &publication);
            }
            if !changed && !admitted {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        revoke_connection(&mut active, &mut state, &mut output);
        previews.clear(&mut state);
        if let Ok(mut slot) = incoming.lock() {
            *slot = Some(None);
        }
    });
    Bridge { mailbox, commands }
}

#[cfg(test)]
#[path = "browser_native_transport_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "browser_native_selection_tests.rs"]
mod selection_tests;

#[cfg(test)]
#[path = "browser_native_backend_tests.rs"]
mod backend_tests;

#[path = "browser_native_local.rs"]
mod local;
pub(in crate::tmux_snapshot) use local::{NativeOwner, start as start_local};

#[cfg(unix)]
pub(in crate::tmux_snapshot) use local::start_remote;
