use super::{Edit, Target};
use crate::sidebar::layout_tests::{fixture_window, full_draw};
use crate::{
    endpoint::Endpoint,
    menu::{Page, sessions::Row},
    sessions::DeviceScan,
};
use gpui::{TestAppContext, point, px, size};
use herdr_client::{ConnectTarget, LocalSession, SessionState};

#[gpui::test]
fn create_form_owns_text_validates_and_returns_focus(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // No valid submission in this fixture: it must never start a daemon.
            view.endpoints[0].connection.target = ConnectTarget::Session {
                name: "default".into(),
                development: false,
            };
            view.open_sessions(point(px(10.), px(550.)), window, cx);
            view.open_session_create(Target::Local, window, cx);
        })
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert_eq!(panel.center(), point(px(400.), px(300.)));
    assert_eq!(panel.size.width, px(480.));
    assert!(cx.debug_bounds("session-modal").is_some());
    cx.simulate_keystrokes("b a d space n a m e enter");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let Some(Edit::Create { input, .. }) = &view.menu.session_edit else {
                panic!("form disappeared")
            };
            assert_eq!(input.read(cx).text(), "bad name");
            assert!(view.menu.error.is_some());
            assert!(view.sessions.mutation.is_none());
            input.update(cx, |input, cx| input.set_text_selected("default", cx));
            view.submit_session_edit(window, cx);
            assert!(view.menu.error.as_ref().unwrap().contains("already exists"));
        })
    });
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        let view = view.read(cx);
        assert!(view.menu.session_edit.is_none());
        assert!(view.menu.focus.is_focused(window));
        assert_eq!(view.menu.page, Some(Page::Sessions));
    });
}

#[gpui::test]
fn delete_confirmation_is_centered_and_cancel_returns_to_picker(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    let name = "a-long-stopped-session-name-that-must-stay-inside-the-modal";
    cx.simulate_resize(size(px(640.), px(480.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.endpoints[0].connection.target = ConnectTarget::Session {
                name: "default".into(),
                development: false,
            };
            view.sessions.entries = vec![LocalSession {
                name: name.into(),
                state: SessionState::Stopped,
                socket: ConnectTarget::Session {
                    name: name.into(),
                    development: false,
                }
                .socket_path()
                .unwrap(),
            }];
            view.open_sessions(point(px(10.), px(440.)), window, cx);
        })
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let picker = cx.debug_bounds("menu-panel").unwrap();
    let row = cx.debug_bounds("sessions-row-0").unwrap();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.confirm_session_delete(Row::Local(name.into()), Some(Target::Local), window, cx);
        })
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert_eq!(cx.debug_bounds("session-picker-underlay").unwrap(), picker);
    assert_eq!(
        cx.debug_bounds("sessions-row-0").unwrap(),
        row,
        "the modal must cover, not replace, the picker"
    );
    assert_eq!(panel.center(), point(px(320.), px(240.)));
    let cancel = cx.debug_bounds("session-edit-cancel").unwrap();
    let submit = cx.debug_bounds("session-edit-submit").unwrap();
    assert!(cancel.left() >= panel.left() && submit.right() <= panel.right());
    cx.simulate_click(cancel.center(), gpui::Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert_eq!(cx.debug_bounds("menu-panel").unwrap(), picker);
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert!(view.menu.session_edit.is_none());
        assert_eq!(view.menu.page, Some(Page::Sessions));
        assert!(view.sessions.mutation.is_none());
    });
}

#[gpui::test]
fn deletion_confirms_running_and_current_sessions_but_protects_default(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.endpoints[0].connection.target = ConnectTarget::Session {
                name: "current".into(),
                development: false,
            };
            view.sessions.entries = [
                ("default", SessionState::Stopped),
                ("current", SessionState::Stopped),
                ("busy", SessionState::Running),
                ("old", SessionState::Stopped),
            ]
            .into_iter()
            .map(|(name, state)| LocalSession {
                name: name.into(),
                state,
                socket: ConnectTarget::Session {
                    name: name.into(),
                    development: false,
                }
                .socket_path()
                .unwrap(),
            })
            .collect();
            for name in ["default", "missing"] {
                assert!(
                    view.session_delete_reason(&Row::Local(name.into()))
                        .is_some(),
                    "{name}"
                );
            }
            for name in ["current", "busy"] {
                assert!(
                    view.session_delete_reason(&Row::Local(name.into()))
                        .is_none()
                );
                view.confirm_session_delete(
                    Row::Local(name.into()),
                    Some(Target::Local),
                    window,
                    cx,
                );
                assert!(matches!(view.menu.session_edit, Some(Edit::Delete { .. })));
                assert!(view.sessions.mutation.is_none());
                view.cancel_session_edit(window, cx);
            }
            assert!(
                view.session_delete_reason(&Row::Local("old".into()))
                    .is_none()
            );
            view.confirm_session_delete(Row::Local("old".into()), Some(Target::Local), window, cx);
            assert!(matches!(view.menu.session_edit, Some(Edit::Delete { .. })));
            view.cancel_session_edit(window, cx);
            assert!(
                view.sessions.mutation.is_none(),
                "confirmation alone must not spawn"
            );
            view.endpoints[0].connection.target = ConnectTarget::Session {
                name: "default".into(),
                development: true,
            };
            assert!(
                view.session_delete_reason(&Row::Local("old".into()))
                    .is_some()
            );
            view.open_session_create(Target::Local, window, cx);
            assert!(view.menu.session_edit.is_none());
        })
    });
}

#[gpui::test]
fn a_replaced_device_cannot_receive_a_captured_deletion(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.endpoints.push(Endpoint::new(
                "ssh:test".into(),
                "Test".into(),
                ConnectTarget::Ssh {
                    target: "old.invalid".into(),
                    session: "default".into(),
                },
                true,
            ));
            view.sessions.devices.answers.insert(
                "ssh:test".into(),
                DeviceScan::Sessions(vec![herdr_client::RemoteSession {
                    name: "old".into(),
                    running: false,
                }]),
            );
            let row = Row::Device {
                id: "ssh:test".into(),
                session: "old".into(),
            };
            // Inject a captured confirmation on all platforms; Windows refuses
            // management_target even before considering the replacement.
            view.menu.session_edit = Some(Edit::Delete {
                row,
                target: Target::Device {
                    id: "ssh:test".into(),
                    host: herdr_client::RemoteHost::Ssh("old.invalid".into()),
                },
            });
            view.endpoints[1].connection.target = ConnectTarget::Ssh {
                target: "replacement.invalid".into(),
                session: "default".into(),
            };
            view.submit_session_edit(window, cx);
            assert!(view.menu.error.as_ref().unwrap().contains("changed"));
            assert!(view.sessions.mutation.is_none());
            let Some(Edit::Delete { row, target }) = view.menu.session_edit.take() else {
                panic!("the rejected confirmation must remain open");
            };
            // The same fence starts at paint, not only at confirmation.
            view.confirm_session_delete(row, Some(target), window, cx);
            assert!(view.menu.session_edit.is_none());
            assert!(
                view.sessions
                    .mutation_error
                    .as_ref()
                    .unwrap()
                    .contains("changed")
            );
        })
    });
}

#[gpui::test]
fn confirmed_current_session_handoff_retires_only_matching_targets(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let named = ConnectTarget::Session {
                name: "demo".into(),
                development: false,
            };
            view.endpoints[0].connection.target = named.clone();
            let old = view.endpoints[0].connection.inbox.clone();
            assert!(view.retarget_session_for_deletion(&named));
            assert_eq!(
                view.endpoints[0].connection.target,
                ConnectTarget::Session {
                    name: "default".into(),
                    development: false
                }
            );
            assert!(!std::sync::Arc::ptr_eq(
                &old,
                &view.endpoints[0].connection.inbox
            ));
            assert!(!view.retarget_session_for_deletion(&named));
            for (id, host, session) in [
                ("ssh:one", "host.invalid", "demo"),
                ("ssh:two", "host.invalid", "demo"),
                ("ssh:other", "other.invalid", "demo"),
            ] {
                view.endpoints.push(Endpoint::new(
                    id.into(),
                    id.into(),
                    ConnectTarget::Ssh {
                        target: host.into(),
                        session: session.into(),
                    },
                    true,
                ));
            }
            view.selected_endpoint = 1;
            let remote = ConnectTarget::Ssh {
                target: "host.invalid".into(),
                session: "demo".into(),
            };
            assert!(view.retarget_session_for_deletion(&remote));
            assert_eq!(view.selected_endpoint, 1);
            for endpoint in &view.endpoints[1..3] {
                assert_eq!(
                    endpoint.connection.target,
                    ConnectTarget::Ssh {
                        target: "host.invalid".into(),
                        session: "default".into()
                    }
                );
                assert!(endpoint.connection.handle.is_none());
            }
            assert_eq!(
                view.endpoints[3].connection.target,
                ConnectTarget::Ssh {
                    target: "other.invalid".into(),
                    session: "demo".into()
                }
            );
        })
    });
}
