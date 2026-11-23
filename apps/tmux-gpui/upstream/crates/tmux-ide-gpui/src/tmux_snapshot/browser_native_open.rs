//! An issued stream becomes the terminal loop's route. A stream that cannot be
//! opened is reported lost, so the catalog re-issues it: it never ends the
//! loop (card #871).
use super::*;
use herdr_client::tmux_handoff::Handoff;

/// What the catalog issued (`native-terminal-open`).
pub(super) struct Issued {
    pub(super) id: String,
    pub(super) request: u64,
    pub(super) session: String,
    pub(super) capability: Handoff,
}

/// Opens the stream. `Err` is the notice that asks the catalog for another:
/// the capability expired on the way (the Mac slept), a thread or a pipe
/// could not be had, or the capability does not fit this build.
pub(super) fn open(
    issued: Issued,
    kitty: &crate::tmux_snapshot::kitty_graphics::Store,
    history: &Cache,
    presence: (bool, u64),
    now: u64,
) -> Result<Active, Box<Command>> {
    let lost = Command::NativeTerminalInterrupted {
        version: 1,
        id: issued.id.clone(),
        request: issued.request,
        pane: issued.capability.selected_pane.clone(),
        live_session_id: issued.session.clone(),
        generation: issued.capability.descriptor.daemon_instance_id.clone(),
        presence_revision: presence.1,
        cause: Cause::Lost,
    };
    route(issued, kitty, history, presence, now).map_err(|error| {
        eprintln!(
            "tmux-preview: terminal stream not opened: {}",
            diagnostics::detail(&error)
        );
        Box::new(lost)
    })
}

fn route(
    issued: Issued,
    kitty: &crate::tmux_snapshot::kitty_graphics::Store,
    history: &Cache,
    presence: (bool, u64),
    now: u64,
) -> Result<Active, NativeError> {
    let Issued {
        id,
        request,
        session,
        capability,
    } = issued;
    let workspace = capability.workspace_name.clone();
    let catalog_only = capability.catalog_only;
    let daemon_version = capability.daemon_version.clone();
    let generation = capability.descriptor.daemon_instance_id.clone();
    let history = History::new(
        capability
            .server_scope
            .as_ref()
            .map(|s| (s.server_id.clone(), s.generation.clone())),
        workspace.clone(),
        session.clone(),
        capability.selected_pane.clone(),
        history.clone(),
    );
    #[cfg(target_os = "macos")]
    let (mut controller, surface_inbox) = if capability.native_surfaces {
        let generation_id = uuid::Uuid::parse_str(&generation)
            .map_err(|_| herdr_client::tmux_controller::Error::Invalid)?;
        let (driver, inbox) = crate::tmux_native_surface::driver::Driver::new(generation_id);
        (
            Controller::spawn_with_surfaces(capability, Box::new(driver))?,
            Some(inbox),
        )
    } else {
        (Controller::spawn(capability)?, None)
    };
    #[cfg(not(target_os = "macos"))]
    let mut controller = Controller::spawn(capability)?;
    controller.presence(presence.0, presence.1, now)?;
    let owner = Owner::new(
        id.clone(),
        request,
        workspace.clone(),
        session.clone(),
        generation.clone(),
    )?;
    Ok(Active {
        presentation: NativePresentation::new(&id, &workspace),
        graphics: Graphics::new(kitty.clone()),
        #[cfg(target_os = "macos")]
        surfaces: crate::tmux_snapshot::browser_native_surfaces::Scene::new(surface_inbox),
        id,
        request,
        input_epoch: request,
        session,
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
        action_status: Default::default(),
        catalog_only,
        daemon_version,
        generation,
        topology_notice: None,
        topology_sent: Default::default(),
        metadata_notice: None,
        metadata_sent: None,
    })
}
