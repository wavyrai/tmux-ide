use super::*;
use crate::tmux_snapshot::home::filters::Filter;

fn roster() -> browser::home_agents::Roster {
    serde_json::from_value(serde_json::json!({"revision":4,"phase":"live","rows":[],
        "observedSessions":0,"totalSessions":0,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap()
}
#[gpui::test]
fn home_filter_keys_search_and_escape_never_send_terminal_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.home_agents = Some(roster());
        view
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    for (key, expected) in [
        ("w", Filter::Working),
        ("a", Filter::Attention),
        ("a", Filter::All),
        ("w", Filter::Working),
        ("0", Filter::All),
    ] {
        cx.simulate_keystrokes(key);
        view.read_with(cx, |view, _| {
            assert!(view.home_filter.as_ref().unwrap().filter == expected)
        });
    }
    cx.simulate_keystrokes("/");
    cx.simulate_input("a/w0");
    view.read_with(cx, |view, cx| {
        let controls = view.home_filter.as_ref().unwrap();
        assert_eq!(controls.search.read(cx).text(), "a/w0");
        assert!(controls.filter == Filter::All);
    });
    cx.simulate_keystrokes("escape");
    cx.simulate_keystrokes("w");
    view.read_with(cx, |view, cx| {
        let controls = view.home_filter.as_ref().unwrap();
        assert_eq!(controls.search.read(cx).text(), "");
        assert!(controls.filter == Filter::Working);
        assert_eq!(view.browser_request, 7);
        assert_eq!(view.browser_state.home_agents.as_ref().unwrap().revision, 4);
    });
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn home_filter_keys_preserve_modifiers_modal_input_and_workspace_ownership(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.home_agents = Some(roster());
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            for key in ["cmd-w", "ctrl-a", "alt-w", "shift-a"] {
                let event = KeyDownEvent {
                    keystroke: Keystroke::parse(key).unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                    layout: None,
                };
                assert!(!v.home_filter_key(&event, window, cx));
            }
            let event = KeyDownEvent {
                keystroke: Keystroke::parse("w").unwrap(),
                is_held: false,
                prefer_character_input: false,
                layout: None,
            };
            v.open_commands(window, cx);
            assert!(!v.home_filter_key(&event, window, cx));
            v.picker = None;
            v.browser_state.surface = browser::Surface::Workspace;
            assert!(!v.home_filter_key(&event, window, cx));
            v.browser_state.surface = browser::Surface::Home;
            v.browser_state.home_agents = None;
            assert!(!v.home_filter_key(&event, window, cx));
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn home_filter_keys_preserve_marked_search_and_do_not_retoggle_held_attention(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.home_agents = Some(roster());
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            let mut event = KeyDownEvent {
                keystroke: Keystroke::parse("a").unwrap(),
                is_held: false,
                prefer_character_input: false,
                layout: None,
            };
            assert!(v.home_filter_key(&event, window, cx));
            event.is_held = true;
            assert!(v.home_filter_key(&event, window, cx));
            assert!(v.home_filter.as_ref().unwrap().filter == Filter::Attention);
            let search = v.home_filter.as_ref().unwrap().search.clone();
            search.read(cx).focus.clone().focus(window, cx);
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "に", Some(0..1), window, cx)
            });
            event.keystroke = Keystroke::parse("escape").unwrap();
            event.is_held = false;
            assert!(!v.home_filter_key(&event, window, cx));
            assert!(search.read(cx).is_composing());
            assert!(search.read(cx).focus.is_focused(window));
            assert!(v.home_filter.as_ref().unwrap().filter == Filter::Attention);
        });
    });
    assert!(receiver.try_recv().is_err());
}
