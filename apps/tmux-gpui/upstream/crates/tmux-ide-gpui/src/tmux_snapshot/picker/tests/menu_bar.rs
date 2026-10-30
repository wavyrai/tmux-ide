//! Each menu item carries the action its title names and has the effect of
//! the key written next to it in `table`, and a held key still doesn't
//! repeat (the menu adds no key bindings).
use super::pane_shortcuts::ready;
use super::*;
use crate::tmux_snapshot::menu_bar::*;

/// One pane with a neighbour on each side, in the middle of three tmux
/// windows, so every Focus direction, Next and Previous Window goes somewhere
/// different.
fn layout(view: &mut SnapshotView, surface: browser::Surface) {
    ready(view);
    view.browser_state.surface = surface;
    view.browser_state.input_ready = true;
    view.browser_state.selected_pane = Some("pane-c".into());
    view.browser_state.pane_actions = Some(browser::PaneActions {
        id: "pane-c".into(),
        ..view.browser_state.pane_actions.clone().unwrap()
    });
    view.browser_state.regions = serde_json::from_str(
        r#"[{"id":"pane-c","left":6,"top":5,"width":5,"height":4},
            {"id":"pane-l","left":0,"top":5,"width":5,"height":4},
            {"id":"pane-r","left":12,"top":5,"width":5,"height":4},
            {"id":"pane-u","left":6,"top":0,"width":5,"height":4},
            {"id":"pane-d","left":6,"top":10,"width":5,"height":4}]"#,
    )
    .unwrap();
    let choice = |id: &str, window: &str| browser::Choice {
        id: id.into(),
        label: id.into(),
        pane_count: None,
        window_id: Some(window.into()),
        browser_icon: None,
        window_label: Some(window.into()),
    };
    view.browser_state.panes = vec![
        choice("pane-one", "window-1"),
        choice("pane-c", "window-2"),
        choice("pane-l", "window-2"),
        choice("pane-r", "window-2"),
        choice("pane-u", "window-2"),
        choice("pane-d", "window-2"),
        choice("pane-three", "window-3"),
    ];
}

/// What a step did: the commands it sent, and the visible state it left.
fn outcome(
    cx: &mut TestAppContext,
    surface: browser::Surface,
    step: impl Fn(&mut VisualTestContext),
) -> (Vec<String>, String) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| layout(view, surface));
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

/// The intended menu, written out by hand rather than read from the code:
/// title, the action that title must carry, the key it stands for, and where
/// the item is tried from (Terminals needs Home to have anywhere to go).
fn table() -> Vec<(
    &'static str,
    Box<dyn gpui::Action>,
    &'static str,
    browser::Surface,
)> {
    use browser::Surface::{Home, Workspace};
    vec![
        ("Command Palette", Box::new(CommandPalette), "f5", Workspace),
        (
            "Sessions and Panes",
            Box::new(SessionsAndPanes),
            "f6",
            Workspace,
        ),
        ("Needs Attention", Box::new(Attention), "f7", Workspace),
        ("Home", Box::new(ShowHome), "f1", Workspace),
        ("Terminals", Box::new(ShowTerminals), "f2", Home),
        (
            "Show or Hide Sidebar",
            Box::new(ToggleSidebar),
            "f10",
            Workspace,
        ),
        ("Split Right", Box::new(SplitRight), "cmd-d", Workspace),
        ("Split Down", Box::new(SplitDown), "cmd-shift-d", Workspace),
        ("Zoom", Box::new(ZoomPane), "cmd-shift-enter", Workspace),
        ("Close Pane…", Box::new(ClosePane), "cmd-w", Workspace),
        (
            "Focus Left",
            Box::new(FocusPaneLeft),
            "cmd-alt-left",
            Workspace,
        ),
        (
            "Focus Right",
            Box::new(FocusPaneRight),
            "cmd-alt-right",
            Workspace,
        ),
        ("Focus Up", Box::new(FocusPaneUp), "cmd-alt-up", Workspace),
        (
            "Focus Down",
            Box::new(FocusPaneDown),
            "cmd-alt-down",
            Workspace,
        ),
        (
            "New Window",
            Box::new(NewTerminalWindow),
            "cmd-t",
            Workspace,
        ),
        ("Next Window", Box::new(NextWindow), "cmd-}", Workspace),
        (
            "Previous Window",
            Box::new(PreviousWindow),
            "cmd-{",
            Workspace,
        ),
    ]
}

#[gpui::test]
fn every_menu_item_does_what_its_written_key_does(cx: &mut TestAppContext) {
    let menus = menus();
    let mut failures = Vec::new();
    for (title, action, key, surface) in table() {
        // The title carries the action it names.
        let carried = menus
            .iter()
            .flat_map(|menu| &menu.items)
            .find_map(|item| match item {
                MenuItem::Action { name, action, .. } if name.as_ref() == title => Some(action),
                _ => None,
            });
        match carried {
            Some(carried) if carried.partial_eq(action.as_ref()) => {}
            _ => failures.push(format!("{title}: wrong or missing action")),
        }
        let idle = outcome(cx, surface, |_| {});
        let by_key = outcome(cx, surface, |cx| cx.simulate_keystrokes(key));
        let by_menu = outcome(cx, surface, |cx| {
            cx.update(|window, cx| window.dispatch_action(action.boxed_clone(), cx));
            cx.run_until_parked();
        });
        if by_key == idle {
            failures.push(format!("{title}: {key} does nothing in the fixture"));
        }
        if by_menu != by_key {
            failures.push(format!("{title}: menu {by_menu:?} vs {key} {by_key:?}"));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// Choosing a menu item while the terminal composes ends the composition and
/// does the item, as pressing its key does there (#674 N1).
#[gpui::test]
fn a_menu_item_mid_composition_ends_it_and_acts(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            layout(view, browser::Surface::Workspace);
            view.marked = "かな".into();
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.dispatch_action(ShowHome);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |view, _| {
        assert!(view.marked.is_empty(), "composition ended")
    });
    let sent: Vec<String> = receiver
        .try_iter()
        .map(|c| serde_json::to_string(&c).unwrap_or_default())
        .collect();
    assert!(!sent.is_empty(), "Home was chosen: {sent:?}");
    assert!(
        !sent.iter().any(|c| c.contains("かな")),
        "nothing was typed: {sent:?}"
    );
}

#[gpui::test]
fn menu_items_act_and_are_not_no_ops(cx: &mut TestAppContext) {
    let (sent, _) = outcome(cx, browser::Surface::Workspace, |cx| {
        cx.dispatch_action(SplitRight)
    });
    assert!(sent.iter().any(|c| c.contains("\"split\"")), "{sent:?}");
    let (_, state) = outcome(cx, browser::Surface::Workspace, |cx| {
        cx.dispatch_action(CommandPalette)
    });
    assert!(state.contains("picker=Some(Commands)"), "{state}");
    let (_, state) = outcome(cx, browser::Surface::Workspace, |cx| {
        cx.dispatch_action(ToggleSidebar)
    });
    assert!(state.contains("sidebar_hidden=true"), "{state}");
}

#[gpui::test]
fn a_held_shortcut_still_does_not_repeat(cx: &mut TestAppContext) {
    // As the app starts: the menu bar installed.
    cx.update(install);
    let (sent, _) = outcome(cx, browser::Surface::Workspace, |cx| {
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

#[gpui::test]
fn choose_theme_opens_the_theme_picker(cx: &mut TestAppContext) {
    let (_, state) = outcome(cx, browser::Surface::Workspace, |cx| {
        cx.update(|window, cx| {
            let view = window.root::<SnapshotView>().flatten().unwrap();
            view.update(cx, |view, _| {
                view.browser_state.appearance = Some(
                    serde_json::from_value(serde_json::json!({
                        "selected":"dark", "system":"dark", "error":null,
                        "theme":{"canvas":1,"background":2,"foreground":3,"cursor":4,"surface":5,
                            "active":6,"muted":7,"accent":8,"palette":vec![9;256]},
                        "options":[{"id":"dark","name":"Dark"}]
                    }))
                    .unwrap(),
                );
            });
            window.draw(cx).clear(cx);
        });
        cx.dispatch_action(ChooseTheme);
    });
    assert!(state.contains("picker=Some(Theme)"), "{state}");
}

/// Full Screen and Minimize change the window itself, which a test window
/// can't show (#675 checks them live); here each item carries its action and
/// something on the focused path handles it.
#[gpui::test]
fn full_screen_and_minimize_reach_a_handler(cx: &mut TestAppContext) {
    let full_screen = crate::RunCommand {
        command: crate::controls::Command::ToggleFullScreen,
    };
    let expected: [(&str, &dyn gpui::Action); 2] =
        [("Enter Full Screen", &full_screen), ("Minimize", &Minimize)];
    let menus = menus();
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| layout(view, browser::Surface::Workspace));
        window.draw(cx).clear(cx);
    });
    for (title, action) in expected {
        let carried = menus
            .iter()
            .flat_map(|menu| &menu.items)
            .find_map(|item| match item {
                MenuItem::Action { name, action, .. } if name.as_ref() == title => Some(action),
                _ => None,
            });
        assert!(
            carried.is_some_and(|carried| carried.partial_eq(action)),
            "{title}"
        );
        cx.update(|window, cx| assert!(window.is_action_available(action, cx), "{title}"));
    }
}
