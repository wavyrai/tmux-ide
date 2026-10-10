use super::*;

const PICK: &str = r##"{"kind":"pick","target":{"kind":"element","selector":"#save","tag":"button","text":"Save","html":"<button id=\"save\">Save</button>"}}"##;

/// A snapshot where pane `w0:p1` runs an agent with `status`.
fn with_agent(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, status: &str) {
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let mut shown: serde_json::Value =
                serde_json::to_value(view.live.snapshot.as_deref().unwrap()).unwrap();
            shown["panes"] = serde_json::json!([{
                "pane_id": "w0:p1", "workspace_id": "w0", "tab_id": "t0", "label": null,
                "cwd": null, "foreground_cwd": null, "focused": true,
                "right_click_passthrough": false
            }]);
            shown["agents"] = serde_json::json!([{
                "pane_id": "w0:p1", "workspace_id": "w0", "tab_id": "t0", "name": "claude",
                "display_agent": "Claude Code", "agent": "claude", "title": null,
                "terminal_title": null, "terminal_title_stripped": null,
                "agent_status": status, "state_change_seq": 0, "state_labels": [],
                "tokens": [], "focused": true
            }]);
            view.live.snapshot = Some(Arc::new(serde_json::from_value(shown).unwrap()));
        });
    });
}

/// Opens a page the way an agent in pane `w0:p1` would, and writes a note on
/// its Save button.
fn noted_tab(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) -> crate::browser::Tab {
    let tab_scope = view.read_with(cx, |view, _| scope(&view.endpoints[0]));
    let tab = cx.update(|_, cx| {
        let id = Store::update(cx, |store| {
            store.open(
                tab_scope,
                "w0",
                Some(url("http://localhost:3000/")),
                Some("w0:p1".into()),
            )
        })
        .unwrap();
        cx.global::<Store>().get(id).cloned().unwrap()
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // A page's posts are ignored until the user starts annotating.
            view.page_posted(tab.id, PICK, window, cx);
            assert!(!view.browser.annotations.open(tab.id));
            view.toggle_annotating(tab.id, window, cx);
            view.page_posted(tab.id, "not json", window, cx);
            view.page_posted(tab.id, PICK, window, cx);
            let input = view.browser.annotations.input.clone();
            input.update(cx, |input, cx| input.set_text_selected("Make it blue", cx));
            view.add_note(tab.id, window, cx);
            assert_eq!(view.browser.annotations.queued(tab.id), 1);
        });
    });
    tab
}

fn kept(cx: &mut VisualTestContext) -> Option<String> {
    cx.update(|_, cx| {
        cx.default_global::<crate::browser::Feedback>()
            .take("w0:p1")
    })
}

#[gpui::test]
fn notes_reach_the_agent_that_opened_the_page(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx);

    // The agent's pane is not in this window: the notes wait for it.
    let tab = noted_tab(&view, cx);
    cx.update(|_, cx| view.update(cx, |view, cx| view.send_notes(&tab, cx)));
    let text = kept(cx).unwrap();
    assert!(text.contains("On <button> at `#save`"), "{text}");
    assert!(text.contains("Note: Make it blue"), "{text}");
    assert!(kept(cx).is_none(), "taken once");

    // An agent waiting in `browser feedback --wait` gets them directly.
    let tab = noted_tab(&view, cx);
    cx.update(|_, cx| {
        cx.default_global::<crate::browser::Feedback>()
            .set_waiting(vec!["w0:p1".into()]);
        view.update(cx, |view, cx| view.send_notes(&tab, cx));
        cx.default_global::<crate::browser::Feedback>()
            .set_waiting(Vec::new());
    });
    assert!(kept(cx).is_some());

    // A working agent's pane is typed into once it is idle; this fixture has
    // no connection, so the paste fails and the notes are kept instead.
    with_agent(&view, cx, "working");
    let tab = noted_tab(&view, cx);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.send_notes(&tab, cx);
            assert_eq!(view.deliveries.len(), 1);
            view.poll_deliveries(cx);
            assert_eq!(view.deliveries.len(), 1, "held while busy");
        });
    });
    assert!(kept(cx).is_none());
    with_agent(&view, cx, "idle");
    cx.update(|_, cx| view.update(cx, |view, cx| view.poll_deliveries(cx)));
    view.read_with(cx, |view, _| {
        assert_eq!(view.deliveries.len(), 0);
        assert_eq!(view.browser.annotations.queued(tab.id), 0);
    });
    assert!(kept(cx).is_some_and(|text| text.contains("Make it blue")));
}

#[gpui::test]
fn a_pane_without_an_agent_is_never_typed_into(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx);
    with_agent(&view, cx, "idle");
    // The agent exited: its pane is back at a shell, where Enter would
    // run the pasted notes.
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let mut shown = (*view.live.snapshot.clone().unwrap()).clone();
            shown.agents.clear();
            view.live.snapshot = Some(Arc::new(shown));
        });
    });
    let tab = noted_tab(&view, cx);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.send_notes(&tab, cx);
            view.poll_deliveries(cx);
            assert_eq!(view.deliveries.len(), 0);
        });
    });
    assert!(kept(cx).is_some_and(|text| text.contains("Make it blue")));
}

#[gpui::test]
fn an_agent_asking_a_question_is_not_typed_into(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx);
    with_agent(&view, cx, "blocked");
    let tab = noted_tab(&view, cx);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.send_notes(&tab, cx);
            // Deadline not reached: still held.
            view.poll_deliveries(cx);
            assert_eq!(view.deliveries.len(), 1);
        });
    });
    // The pane closing sends them to `browser feedback` rather than nowhere.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let mut shown = (*view.live.snapshot.clone().unwrap()).clone();
            shown.panes.clear();
            shown.agents.clear();
            view.live.snapshot = Some(Arc::new(shown));
            view.poll_deliveries(cx);
            assert_eq!(view.deliveries.len(), 0);
        });
    });
    assert!(kept(cx).is_some());
}
