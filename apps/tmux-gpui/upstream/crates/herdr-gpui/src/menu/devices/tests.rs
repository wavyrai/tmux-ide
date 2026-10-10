use super::{
    Page,
    add_device::{LocalSpace, Offer, Setup, Step, enter},
    setup,
};
use crate::{
    HerdrWindow, NavigationTarget, search_input::SearchInput,
    sidebar::layout_tests::fixture_window, state::ConnectionStatus,
};
use gpui::{AppContext, Context};
use herdr_client::protocol::{ClientMessage, ClientShellSnapshot};
use herdr_client::{HostProbe, protocol::ClientPaneInputEvent};
use std::sync::Arc;

#[test]
fn only_a_present_herdr_is_saved_without_a_terminal() {
    assert_eq!(Offer::for_probe(HostProbe::Running), None);
    assert_eq!(Offer::for_probe(HostProbe::Stopped), None);
    assert_eq!(Offer::for_probe(HostProbe::Missing), Some(Offer::Install));
    assert_eq!(Offer::for_probe(HostProbe::Outdated), Some(Offer::Update));
    assert_eq!(
        Offer::for_probe(HostProbe::SshFailed),
        Some(Offer::Terminal)
    );
    assert_eq!(
        Offer::Install.question("dev@box"),
        "Herdr was not detected on dev@box. Should we install it?"
    );
}

fn open_form(view: &mut HerdrWindow, step: Step, cx: &mut Context<HerdrWindow>) {
    view.menu.device_setup = Some(Setup {
        fields: std::array::from_fn(|_| cx.new(SearchInput::new)),
        step,
        claim: None,
        task: None,
        discovery: None,
        suggested_label: None,
        _label_edits: None,
    });
    view.menu.page = Some(Page::AddDevice);
}

fn step(view: &HerdrWindow) -> &Step {
    &view.menu.device_setup.as_ref().unwrap().step
}

#[gpui::test]
fn a_saved_device_closes_the_dialog_by_itself(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            open_form(view, Step::Saved, cx);
            view.poll_device_setup(window, cx);
            assert!(view.menu.page.is_none());
            assert!(view.menu.device_setup.is_none());
            assert!(view.focus.is_focused(window));
        });
    });
}

#[gpui::test]
fn install_needs_a_connected_local_daemon(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let request = setup::Request::new("dev@box", "Box", "").unwrap();
            view.endpoints[0].live.status = ConnectionStatus::Disconnected;
            open_form(view, Step::Verifying(request), cx);
            view.setup_space_verified(Ok(setup::Claim::fixture("disconnected.test")), cx);
            assert!(matches!(step(view), Step::Confirm(_, Offer::Terminal)));
            // The claim stays with the dialog for a retry.
            assert!(view.menu.device_setup.as_ref().unwrap().claim.is_some());
            assert!(
                view.menu
                    .error
                    .as_deref()
                    .unwrap()
                    .starts_with("Open a local workspace:")
            );
        });
    });
}

/// The sessions list can attach a saved device to another of its sessions.
/// The catalog still holds the entry it was saved with, so adding that entry
/// again is refused, and the session it now shows was never saved.
#[gpui::test]
fn a_device_on_another_session_is_still_matched_by_its_saved_entry(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.reconcile_catalog(
                vec![herdr_client::SavedHost {
                    id: "0123456789abcdef0123456789abcdef".into(),
                    label: "m5max-ms".into(),
                    target: "penso@box".into(),
                    session: "default".into(),
                    enabled: true,
                }],
                Vec::new(),
                cx,
            );
            // What choosing another session from the list does to the target.
            view.endpoints[1].connection.target = herdr_client::ConnectTarget::Ssh {
                target: "penso@box".into(),
                session: "work".into(),
            };
            let saved = setup::Request::new("penso@box", "Again", "").unwrap();
            assert!(matches!(
                view.ensure_new_device(&saved),
                Err(crate::Error::DeviceExists(label)) if label == "m5max-ms"
            ));
            let work = setup::Request::new("penso@box", "Work", "work").unwrap();
            assert!(view.ensure_new_device(&work).is_ok());
        });
    });
}

#[gpui::test]
fn a_host_already_saved_or_being_added_returns_to_the_form(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.endpoints.push(crate::endpoint::Endpoint::new(
                "0123456789abcdef0123456789abcdef".into(),
                "m5max-ms".into(),
                herdr_client::ConnectTarget::Ssh {
                    target: "penso@box".into(),
                    session: "default".into(),
                },
                true,
            ));
            // The window's own list refuses the exact spelling at once.
            let again = setup::Request::new("penso@box", "Again", "").unwrap();
            assert!(matches!(
                view.ensure_new_device(&again),
                Err(crate::Error::DeviceExists(label)) if label == "m5max-ms"
            ));
            let other = setup::Request::new("penso@box", "Work", "work").unwrap();
            assert!(view.ensure_new_device(&other).is_ok());

            // Background checks catch other spellings and concurrent adds.
            // Neither may fall through to offering a terminal.
            for (error, message) in [
                (
                    crate::Error::DeviceExists("m5max-ms".into()),
                    "This host and session are already saved as \u{201c}m5max-ms\u{201d}.",
                ),
                (
                    crate::Error::DeviceAdding,
                    "This host is already being added.",
                ),
            ] {
                open_form(view, Step::Checking(again.clone()), cx);
                view.device_probed(Err(error), cx);
                assert!(matches!(step(view), Step::Form));
                assert_eq!(view.menu.error.as_deref(), Some(message));
            }
            open_form(view, Step::Verifying(again.clone()), cx);
            view.setup_space_verified(Err(crate::Error::DeviceExists("m5max-ms".into())), cx);
            assert!(matches!(step(view), Step::Form));
        });
    });
}

#[gpui::test]
fn created_space_runs_setup_in_its_root_pane(cx: &mut gpui::TestAppContext) {
    let mut peer = crate::window::MockPeer::new();
    let (view, cx) = cx.add_window_view(fixture_window);
    let snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap();
    let boot = snapshot.boot_id.clone();
    let space = |request: &str| {
        let request = request.to_owned();
        let boot = boot.clone();
        move || LocalSpace {
            request,
            boot,
            command: "'herdr' 'machine' 'add'".into(),
        }
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let local = &mut view.endpoints[0];
            local.connection.handle = Some(peer.client.handle.clone());
            local.live.snapshot = Some(Arc::new(snapshot));
            local.live.status = ConnectionStatus::Connected;
            let request = setup::Request::new("dev@box", "Box", "").unwrap();

            // A refusal returns to the question with the daemon's reason.
            open_form(view, Step::Opening(request.clone(), space("create")()), cx);
            view.endpoints[0].live.dialog_response = Some((
                "create".into(),
                Some(Ok(serde_json::json!({"error":{"code":"denied","message":"no"}}))),
            ));
            view.poll_device_setup(window, cx);
            assert!(matches!(step(view), Step::Confirm(_, Offer::Terminal)));
            assert!(view.menu.error.as_deref().unwrap().ends_with("denied: no"));

            // Another dialog's response is not this workspace.
            let created = serde_json::json!({"result":{"type":"workspace_created","workspace":{"workspace_id":"w9"},"tab":{"tab_id":"t9"},"root_pane":{"pane_id":"w9:p1"}}});
            open_form(view, Step::Opening(request, space("create")()), cx);
            view.endpoints[0].live.dialog_response =
                Some(("other".into(), Some(Ok(created.clone()))));
            view.poll_device_setup(window, cx);
            assert!(matches!(step(view), Step::Opening(..)));

            view.endpoints[0].live.dialog_response =
                Some(("create".into(), Some(Ok(created))));
            view.poll_device_setup(window, cx);
            assert!(view.menu.page.is_none());
            assert_eq!(
                view.pending_navigation,
                Some(NavigationTarget::Workspace("w9".into()))
            );
        });
    });
    assert_eq!(
        peer.receive(),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w9:p1".into(),
            events: vec![
                ClientPaneInputEvent::TextCommit("'herdr' 'machine' 'add'".into()),
                enter(),
            ],
        }
    );
}
