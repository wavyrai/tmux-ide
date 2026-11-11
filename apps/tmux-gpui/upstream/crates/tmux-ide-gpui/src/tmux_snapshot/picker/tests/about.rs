//! About opens from the app menu and the palette, holds the keyboard, closes
//! on Escape and gives the terminal its focus back.
use super::*;
use crate::tmux_snapshot::menu_bar::AboutApp;

fn open(cx: &mut VisualTestContext) {
    cx.dispatch_action(AboutApp);
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn the_app_menu_opens_about_and_escape_closes_it(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    open(cx);
    assert!(view.read_with(cx, |v, _| v.about.is_some()));
    assert!(cx.debug_bounds("about-card").is_some());
    assert!(cx.debug_bounds("about-copy-diagnostics").is_some());
    assert!(cx.debug_bounds("about-changelog").is_some());
    // Typing reaches neither the terminal nor the background service.
    cx.simulate_keystrokes("a b");
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(view.read_with(cx, |v, _| v.about.is_none()));
    assert!(cx.debug_bounds("about-card").is_none());
    let terminal = view.read_with(cx, |v, _| v.terminal_focus.clone());
    cx.update(|window, _| assert!(terminal.is_focused(window)));
}

#[gpui::test]
fn the_palette_row_opens_about(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_picker_mode(Mode::Commands, window, cx);
            assert!(
                v.picker
                    .as_ref()
                    .unwrap()
                    .rows
                    .iter()
                    .any(|row| row.target == Target::Command(Action::About)
                        && row.label == "About Tmux IDE")
            );
            v.choose_picker(Target::Command(Action::About), window, cx);
            assert!(v.picker.is_none());
            assert!(v.about.is_some());
        });
    });
}

#[gpui::test]
fn not_connected_never_shows_a_stale_version(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|_, cx| {
        view.update(cx, |v, _| {
            v.browser_state.diagnostics = Some(
                serde_json::from_value(serde_json::json!({"daemonVersion": "2.9.1"})).unwrap(),
            );
            // The connection that reported 2.9.1 is gone.
            v.browser_commands = None;
            assert_eq!(v.about_connection(), "Not connected");
        });
    });
}

#[gpui::test]
fn copy_diagnostics_closes_about_and_copies_the_allowlisted_report(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    open(cx);
    let button = cx.debug_bounds("about-copy-diagnostics").unwrap();
    cx.simulate_click(button.center(), Modifiers::none());
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |v, _| {
        assert!(v.about.is_none());
        assert!(v.picker.as_ref().unwrap().note.is_some());
    });
    let text = cx.update(|_, cx| cx.read_from_clipboard().unwrap().text().unwrap());
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["product"], "tmux-ide-gpui");
}

#[gpui::test]
fn whats_new_closes_about_and_opens_the_changes(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    open(cx);
    let link = cx.debug_bounds("about-changelog").unwrap();
    cx.simulate_click(link.center(), Modifiers::none());
    view.read_with(cx, |v, _| {
        assert!(v.about.is_none());
        assert_eq!(v.picker.as_ref().map(|p| p.mode), Some(Mode::WhatsNew));
    });
}

/// A pane card or a composition in progress keeps the keyboard: About waits.
#[gpui::test]
fn about_does_not_open_over_a_pane_card_or_a_composition(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| ready_pane(view, false));
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("close pane");
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |v, _| assert!(v.pane_close.is_some()));
    open(cx);
    view.read_with(cx, |v, _| assert!(v.about.is_none()));
    cx.simulate_keystrokes("escape");
    view.update(cx, |v, _| v.marked = "かな".into());
    open(cx);
    view.read_with(cx, |v, _| assert!(v.about.is_none()));
}

/// Over the Add machine dialog, About keeps the form and gives it the
/// keyboard back on close.
#[gpui::test]
fn about_over_a_dialog_returns_the_keyboard_to_it(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("connect to machine");
    cx.simulate_keystrokes("enter");
    cx.simulate_input("spark");
    open(cx);
    view.read_with(cx, |v, cx| {
        assert!(v.about.is_some());
        let picker = v.picker.as_ref().unwrap();
        assert_eq!(picker.mode, Mode::Machine);
        assert_eq!(picker.search.read(cx).text(), "spark");
    });
    cx.simulate_keystrokes("escape");
    cx.simulate_input("-1");
    view.read_with(cx, |v, cx| {
        assert!(v.about.is_none());
        assert_eq!(v.picker.as_ref().unwrap().search.read(cx).text(), "spark-1");
    });
    assert!(receiver.try_recv().is_err());
}

/// With the card open but the keyboard elsewhere, the window's key handler
/// still sends keys to About first.
#[gpui::test]
fn keys_reach_about_even_when_focus_has_moved(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    open(cx);
    cx.update(|window, cx| {
        let terminal = view.read(cx).terminal_focus.clone();
        terminal.focus(window, cx);
    });
    cx.simulate_keystrokes("a");
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |v, _| assert!(v.about.is_none()));
}

/// Tab reaches every control in order, Shift-Tab goes back, and Return acts.
#[gpui::test]
fn tab_reaches_the_links_and_return_acts(cx: &mut TestAppContext) {
    use crate::tmux_snapshot::about::Control;
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    open(cx);
    let focused = |cx: &mut VisualTestContext| {
        view.read_with(cx, |v, _| {
            v.about
                .as_ref()
                .and_then(|a| a.focused)
                .map(|i| Control::ALL[i])
        })
    };
    assert_eq!(focused(cx), None);
    cx.simulate_keystrokes("shift-tab");
    assert_eq!(focused(cx), Some(Control::CopyDiagnostics));
    cx.simulate_keystrokes("tab tab tab");
    assert_eq!(focused(cx), Some(Control::WhatsNew));
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |v, _| {
        assert!(v.about.is_none());
        assert_eq!(v.picker.as_ref().map(|p| p.mode), Some(Mode::WhatsNew));
    });
}
