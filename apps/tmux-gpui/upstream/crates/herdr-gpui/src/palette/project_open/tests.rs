#![allow(clippy::unwrap_used)]

use super::*;
use crate::{
    palette::{Action, Filter, fixture_window},
    state::ConnectionStatus,
    window::MockPeer,
};
use gpui::TestAppContext;
use herdr_client::ConnectTarget;
use herdr_client::protocol::ClientMessage;

fn attach_local(view: &mut HerdrWindow, peer: &MockPeer) {
    view.endpoints[0].connection.handle = Some(peer.client.handle.clone());
    view.endpoints[0].live = view.live.clone();
    view.live.status = ConnectionStatus::Connected;
    view.endpoints[0].live.status = ConnectionStatus::Connected;
    *view.endpoints[0].connection.inbox.lock().unwrap() = view.live.clone();
}

fn select_remote_fixture(view: &mut HerdrWindow) {
    let mut remote = crate::endpoint::Endpoint::new(
        "ssh:box".into(),
        "Box".into(),
        ConnectTarget::Ssh {
            target: "unused".into(),
            session: "default".into(),
        },
        true,
    );
    remote.live = view.live.clone();
    view.endpoints.push(remote);
    view.selected_endpoint = 1;
    view.live = view.endpoints[1].live.clone();
}

#[test]
fn creation_response_is_typed_and_requires_a_workspace_id() {
    assert_eq!(
        created_workspace(
            &json!({"result": {"type": "workspace_created", "workspace": {"workspace_id": "w2"}}})
        )
        .unwrap(),
        "w2"
    );
    assert!(matches!(
        created_workspace(
            &json!({"result": {"type": "tab_created", "workspace": {"workspace_id": "w2"}}})
        ),
        Err(Error::PaletteProjectResponse)
    ));
    assert!(matches!(
        created_workspace(
            &json!({"result": {"type": "workspace_created", "workspace": {"workspace_id": ""}}})
        ),
        Err(Error::PaletteProjectResponse)
    ));
    assert!(matches!(
        created_workspace(&json!({"error": {"code": "refused", "message": "not trusted"}})),
        Err(Error::DaemonResponse(_))
    ));
}

#[gpui::test]
fn creating_a_project_while_viewing_ssh_targets_local_and_waits_for_its_response(
    cx: &mut TestAppContext,
) {
    let root = tempfile::tempdir().unwrap();
    let project = projects::Project {
        path: std::fs::canonicalize(root.path()).unwrap(),
        label: "project".into(),
    };
    let mut peer = MockPeer::advertising(&["workspace.create"]);
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            attach_local(view, &peer);
            select_remote_fixture(view);
            view.open_palette(Filter::All, window, cx);
            view.activate_palette(Action::Project(project.clone()), window, cx);
            view.activate_palette(Action::Project(project.clone()), window, cx);
            assert!(view.menu.palette.as_ref().unwrap().busy());
        })
    });
    cx.run_until_parked();
    // The connection reports the window's theme on its own; skip it.
    let (boot_id, request) = loop {
        match peer.receive() {
            ClientMessage::ClientShellHostTheme { .. } => {}
            ClientMessage::ClientShellEndpointRequest {
                boot_id, request, ..
            } => break (boot_id, request),
            message => panic!("expected workspace.create, got {message:?}"),
        }
    };
    let request: Value = serde_json::from_str(&request).unwrap();
    assert_eq!(boot_id, "boot-v1");
    assert_eq!(request["method"], "workspace.create");
    assert_eq!(
        request["params"],
        json!({"cwd": project.path, "label": "project", "focus": true, "trust_repository": false})
    );
    let pending = view.read_with(cx, |view, _| {
        assert_eq!(view.selected_endpoint, 1);
        assert!(view.pending_navigation.is_none());
        let ProjectOperation::Awaiting(id) = &view.menu.palette.as_ref().unwrap().project_operation
        else {
            panic!("expected pending creation");
        };
        id.clone()
    });
    cx.update(|window, cx| view.update(cx, |view, cx| {
        view.endpoints[0].live.dialog_response = Some(("unrelated".into(), Some(Ok(json!({"result": {"type": "workspace_created", "workspace": {"workspace_id": "w2"}}})))));
        view.update_palette_project(window, cx);
        assert!(view.menu.palette.is_some());
        view.endpoints[0].live.dialog_response = Some((pending, Some(Ok(json!({"result": {"type": "workspace_created", "workspace": {"workspace_id": "w2"}}})))));
        view.update_palette_project(window, cx);
        assert!(view.menu.palette.is_none());
        assert_eq!(view.selected_endpoint, 0);
        assert_eq!(view.pending_navigation, Some(NavigationTarget::Workspace("w2".into())));
    }));
}

#[gpui::test]
fn an_existing_local_project_is_focused_instead_of_created(cx: &mut TestAppContext) {
    let root = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(root.path()).unwrap();
    let peer = MockPeer::advertising(&["workspace.create"]);
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            Arc::make_mut(view.live.snapshot.as_mut().unwrap()).panes[0].cwd =
                Some(path.to_string_lossy().into_owned());
            attach_local(view, &peer);
            select_remote_fixture(view);
            view.open_palette(Filter::All, window, cx);
            view.activate_palette(
                Action::Project(projects::Project {
                    path,
                    label: "project".into(),
                }),
                window,
                cx,
            );
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(view.menu.palette.is_none());
        assert_eq!(view.selected_endpoint, 0);
        assert_eq!(
            view.pending_navigation,
            Some(NavigationTarget::Workspace("w1".into()))
        );
    });
}

#[gpui::test]
fn unavailable_or_replaced_local_connections_cannot_open_projects(cx: &mut TestAppContext) {
    let root = tempfile::tempdir().unwrap();
    let project = projects::Project {
        path: std::fs::canonicalize(root.path()).unwrap(),
        label: "project".into(),
    };
    let peer = MockPeer::new();
    let (view, cx) = cx.add_window_view(fixture_window);
    for change in 0..4 {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                attach_local(view, &peer);
                view.live.status = ConnectionStatus::Connected;
                view.endpoints[0].connection.target = ConnectTarget::Local;
                view.open_palette(Filter::All, window, cx);
                match change {
                    0 => view.endpoints[0].connection.handle = None,
                    1 => view.endpoints[0].generation += 1,
                    2 => Arc::make_mut(view.live.snapshot.as_mut().unwrap())
                        .boot_id
                        .push('x'),
                    _ => {
                        view.endpoints[0].connection.target = ConnectTarget::Ssh {
                            target: "unused".into(),
                            session: "default".into(),
                        }
                    }
                }
                view.activate_palette(Action::Project(project.clone()), window, cx);
                let palette = view.menu.palette.as_ref().unwrap();
                assert!(palette.error.is_some());
                assert!(!palette.busy());
                assert!(matches!(palette.project_operation, ProjectOperation::Idle));
            })
        });
    }
}

#[gpui::test]
fn dismissal_during_validation_does_not_queue_a_creation(cx: &mut TestAppContext) {
    let root = tempfile::tempdir().unwrap();
    let peer = MockPeer::new();
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            attach_local(view, &peer);
            view.open_palette(Filter::All, window, cx);
            view.activate_palette(
                Action::Project(projects::Project {
                    path: std::fs::canonicalize(root.path()).unwrap(),
                    label: "project".into(),
                }),
                window,
                cx,
            );
            view.dismiss_menu(window, cx);
            view.open_palette(Filter::Commands, window, cx);
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(
            view.endpoints[0]
                .connection
                .inbox
                .lock()
                .unwrap()
                .dialog_response
                .is_none()
        );
        let palette = view.menu.palette.as_ref().unwrap();
        assert!(palette.error.is_none());
        assert!(!palette.busy());
    });
}

#[gpui::test]
fn daemon_refusals_stay_in_the_palette_and_release_the_pending_operation(cx: &mut TestAppContext) {
    let peer = MockPeer::new();
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            attach_local(view, &peer);
            view.open_palette(Filter::All, window, cx);
            view.menu.palette.as_mut().unwrap().project_operation =
                ProjectOperation::Awaiting("create".into());
            view.live.dialog_response = Some((
                "create".into(),
                Some(Ok(
                    json!({"error": {"code": "refused", "message": "not trusted"}}),
                )),
            ));
            view.update_palette_project(window, cx);
            let palette = view.menu.palette.as_ref().unwrap();
            assert!(palette.error.as_ref().unwrap().contains("not trusted"));
            assert!(!palette.busy());
        })
    });
}

#[gpui::test]
fn dismissing_a_queued_local_creation_cannot_resume_input_against_an_old_surface(
    cx: &mut TestAppContext,
) {
    let root = tempfile::tempdir().unwrap();
    let peer = MockPeer::advertising(&["workspace.create", "client_shell.surface.set"]);
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            attach_local(view, &peer);
            view.open_palette(Filter::Projects, window, cx);
            view.activate_palette(
                Action::Project(projects::Project {
                    path: std::fs::canonicalize(root.path()).unwrap(),
                    label: "project".into(),
                }),
                window,
                cx,
            );
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert!(matches!(
                view.menu.palette.as_ref().unwrap().project_operation,
                ProjectOperation::Awaiting(_)
            ));
            assert!(view.live.activation.is_some());
            view.dismiss_menu(window, cx);
            assert!(!view.input_ready());
            assert!(view.activation_deadline.is_some());
        })
    });
}
