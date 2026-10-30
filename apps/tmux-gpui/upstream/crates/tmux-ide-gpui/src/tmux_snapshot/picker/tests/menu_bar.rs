//! Each menu item has the same effect as pressing its shortcut, and a held
//! key still doesn't repeat (the menu adds no key bindings).
use super::pane_shortcuts::ready;
use super::*;
use crate::tmux_snapshot::menu_bar::*;

/// What a step did: the commands it sent, and the visible state it left.
fn outcome(
    cx: &mut TestAppContext,
    step: impl Fn(&mut VisualTestContext),
) -> (Vec<String>, String) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| ready(view));
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    step(cx);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let sent = receiver
        .try_iter()
        .map(|c| serde_json::to_string(&c).unwrap_or_default())
        .collect();
    let state = view.read_with(cx, |view, _| {
        format!(
            "picker={:?} pane_scope={} closing={} surface={:?} sidebar_hidden={} pane_actions={}",
            view.picker.as_ref().map(|p| p.mode),
            view.picker.as_ref().is_some_and(|p| p.pane_scope.is_some()),
            view.picker.as_ref().is_some_and(|p| p.closing.is_some()),
            view.browser_state.surface,
            view.sidebar_hidden,
            view.pane_actions.is_some(),
        )
    });
    (sent, state)
}

fn same_as_its_shortcut<A: gpui::Action + Clone>(action: A, cx: &mut TestAppContext) {
    let key = keystroke(&action).unwrap();
    let by_key = outcome(cx, |cx| cx.simulate_keystrokes(key));
    let by_menu = outcome(cx, |cx| cx.dispatch_action(action.clone()));
    assert_eq!(by_menu, by_key, "{key}");
}

#[gpui::test]
fn every_menu_item_does_what_its_shortcut_does(cx: &mut TestAppContext) {
    same_as_its_shortcut(CommandPalette, cx);
    same_as_its_shortcut(SessionsAndPanes, cx);
    same_as_its_shortcut(Attention, cx);
    same_as_its_shortcut(ShowHome, cx);
    same_as_its_shortcut(ShowTerminals, cx);
    same_as_its_shortcut(ToggleSidebar, cx);
    same_as_its_shortcut(SplitRight, cx);
    same_as_its_shortcut(SplitDown, cx);
    same_as_its_shortcut(ZoomPane, cx);
    same_as_its_shortcut(ClosePane, cx);
    same_as_its_shortcut(FocusPaneLeft, cx);
    same_as_its_shortcut(FocusPaneRight, cx);
    same_as_its_shortcut(FocusPaneUp, cx);
    same_as_its_shortcut(FocusPaneDown, cx);
    same_as_its_shortcut(NewTerminalWindow, cx);
    same_as_its_shortcut(NextWindow, cx);
    same_as_its_shortcut(PreviousWindow, cx);
}

#[gpui::test]
fn menu_items_act_and_are_not_no_ops(cx: &mut TestAppContext) {
    // The comparison above would pass if both paths did nothing.
    let (sent, _) = outcome(cx, |cx| cx.dispatch_action(SplitRight));
    assert!(sent.iter().any(|c| c.contains("\"split\"")), "{sent:?}");
    let (_, state) = outcome(cx, |cx| cx.dispatch_action(CommandPalette));
    assert!(state.contains("picker=Some(Commands)"), "{state}");
    let (_, state) = outcome(cx, |cx| cx.dispatch_action(ToggleSidebar));
    assert!(state.contains("sidebar_hidden=true"), "{state}");
}

#[gpui::test]
fn a_held_shortcut_still_does_not_repeat(cx: &mut TestAppContext) {
    // As the app starts: the menu bar installed.
    cx.update(install);
    let (sent, _) = outcome(cx, |cx| {
        cx.simulate_event(KeyDownEvent {
            keystroke: Keystroke::parse("cmd-d").unwrap(),
            is_held: true,
            prefer_character_input: false,
            layout: None,
        })
    });
    assert!(sent.is_empty(), "a held ⌘D must not split: {sent:?}");
}

#[test]
fn the_menu_bar_has_the_mac_menus_and_no_shortcut_text() {
    let menus = menus();
    let names: Vec<_> = menus.iter().map(|m| m.name.to_string()).collect();
    assert_eq!(names, ["tmux-ide", "Edit", "View", "Pane", "Window"]);
    for menu in &menus {
        for item in &menu.items {
            if let MenuItem::Action { name, .. } = item {
                assert!(!name.contains('⌘') && !name.contains('⇧'), "{name}");
            }
        }
    }
}
