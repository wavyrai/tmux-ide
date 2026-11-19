//! The key table is the one the window answers: the menus, the hand-matched
//! key paths, the keyboard hints and Keyboard shortcuts… all agree with it.
#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::{menu_bar, pane_shortcuts::Shortcut};
use core::prelude::v1::test;

fn parse(key: &str) -> Keystroke {
    Keystroke::parse(key).unwrap()
}

#[test]
fn the_menus_take_their_key_equivalents_from_the_table() {
    use menu_bar::{
        Attention, ChooseTheme, ClosePane, CommandPalette, FocusPaneDown, FocusPaneLeft,
        FocusPaneRight, FocusPaneUp, NewTerminalWindow, NextWindow, PreviousWindow,
        SessionsAndPanes, ShowHome, ShowTerminals, SplitDown, SplitRight, ToggleSidebar, ZoomPane,
    };
    let actions: [(&dyn gpui::Action, Id); 17] = [
        (&CommandPalette, Id::Commands),
        (&SessionsAndPanes, Id::SessionsAndPanes),
        (&ShowHome, Id::Home),
        (&ShowTerminals, Id::Terminals),
        (&Attention, Id::Attention),
        (&ToggleSidebar, Id::Sidebar),
        (&SplitRight, Id::SplitRight),
        (&SplitDown, Id::SplitDown),
        (&ZoomPane, Id::Zoom),
        (&ClosePane, Id::ClosePane),
        (&FocusPaneLeft, Id::FocusLeft),
        (&FocusPaneRight, Id::FocusRight),
        (&FocusPaneUp, Id::FocusUp),
        (&FocusPaneDown, Id::FocusDown),
        (&NewTerminalWindow, Id::NewWindow),
        (&NextWindow, Id::NextWindow),
        (&PreviousWindow, Id::PreviousWindow),
    ];
    for (action, id) in actions {
        assert_eq!(menu_bar::keystroke(action), Some(keystroke(id)), "{id:?}");
    }
    // Every entry has a menu item but Search, which Commands opens.
    assert_eq!(KEYMAP.len(), actions.len() + 1);
    assert_eq!(menu_bar::keystroke(&ChooseTheme), None);
}

#[test]
fn the_window_answers_each_key_in_the_table() {
    use crate::tmux_snapshot::pane_shortcuts::shortcut;
    let pane = |id: Id| shortcut(&parse(keystroke(id)));
    assert_eq!(pane(Id::SplitRight), Some(Shortcut::SplitRight));
    assert_eq!(pane(Id::SplitDown), Some(Shortcut::SplitDown));
    assert_eq!(pane(Id::Zoom), Some(Shortcut::Zoom));
    assert_eq!(pane(Id::ClosePane), Some(Shortcut::Close));
    assert_eq!(pane(Id::NewWindow), Some(Shortcut::NewWindow));
    assert_eq!(pane(Id::NextWindow), Some(Shortcut::Window(true)));
    assert_eq!(pane(Id::PreviousWindow), Some(Shortcut::Window(false)));
    for (index, id) in [Id::FocusLeft, Id::FocusRight, Id::FocusUp, Id::FocusDown]
        .into_iter()
        .enumerate()
    {
        assert_eq!(pane(id), Some(Shortcut::Focus(index)), "{id:?}");
    }
    for id in [
        Id::Commands,
        Id::SessionsAndPanes,
        Id::Home,
        Id::Terminals,
        Id::Attention,
        Id::Sidebar,
    ] {
        assert!(
            crate::tmux_snapshot::picker::commands::shortcut(&parse(keystroke(id))),
            "{id:?}"
        );
    }
    let search = parse(keystroke(Id::Search));
    assert!(search.modifiers.platform && search.key == "k");
}

#[test]
fn the_keyboard_hints_read_the_table() {
    use crate::tmux_snapshot::kbd;
    assert_eq!(kbd::ZOOM, symbols(keystroke(Id::Zoom)));
    assert_eq!(kbd::SPLIT_RIGHT, symbols(keystroke(Id::SplitRight)));
    assert_eq!(kbd::SPLIT_DOWN, symbols(keystroke(Id::SplitDown)));
    for ((_, hint), id) in
        kbd::FOCUS
            .iter()
            .zip([Id::FocusLeft, Id::FocusRight, Id::FocusUp, Id::FocusDown])
    {
        assert_eq!(*hint, symbols(keystroke(id)));
    }
    assert_eq!(symbols("f5"), "F5");
    assert_eq!(symbols("cmd-k"), "⌘K");
}

/// Keyboard shortcuts… lists every key the guide teaches, spelled as it
/// spells the rest.
#[test]
fn keyboard_shortcuts_lists_every_key_the_guide_teaches() {
    let reference = crate::tmux_snapshot::picker::reference::SHORTCUTS.join("\n");
    for (label, ids) in GUIDE {
        for id in *ids {
            let spelled = spelled(keystroke(*id));
            let arrows = matches!(
                id,
                Id::FocusLeft | Id::FocusRight | Id::FocusUp | Id::FocusDown
            );
            let found = if arrows {
                reference.contains("Cmd+Alt+← / → / ↑ / ↓")
            } else {
                reference.contains(&spelled)
            };
            assert!(found, "{label}: {spelled}");
        }
    }
    assert_eq!(GUIDE.len(), 8, "eight keys, as the design lists");
}

#[test]
fn a_press_matches_only_its_own_keystroke() {
    assert!(matches("f5", &parse("f5")));
    assert!(!matches("f5", &parse("shift-f5")));
    assert!(matches("cmd-shift-d", &parse("cmd-shift-d")));
    assert!(!matches("cmd-d", &parse("cmd-shift-d")));
    assert!(!matches("cmd-shift-enter", &parse("cmd-enter")));
    assert!(matches("cmd-alt-left", &parse("cmd-alt-left")));
    assert!(!matches("cmd-alt-left", &parse("cmd-left")));
    assert!(matches("cmd-}", &parse("cmd-shift-]")));
}
