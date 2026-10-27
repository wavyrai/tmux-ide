use super::*;

#[test]
#[cfg(feature = "qa-menu")]
fn badge_preview_is_available_only_in_the_macos_qa_menu() {
    let menus = menus(Layout::default());
    let qa = menus
        .iter()
        .find(|menu| menu.name.as_ref() == "QA")
        .unwrap();
    for (label, enabled) in [("Enable badge", true), ("Disable badge preview", false)] {
        let action = qa.items.iter().find_map(|item| match item {
            MenuItem::Action { name, action, .. } if name.as_ref() == label => Some(action),
            _ => None,
        });
        if cfg!(target_os = "macos") {
            assert!(
                action
                    .unwrap()
                    .partial_eq(&crate::actions::SetBadgePreview { enabled })
            );
        } else {
            assert!(action.is_none());
        }
    }
}

#[test]
#[cfg(feature = "qa-menu")]
fn qa_menu_sends_a_delayed_system_notification() {
    let menus = menus(Layout::default());
    let qa = menus
        .iter()
        .find(|menu| menu.name.as_ref() == "QA")
        .unwrap();
    assert!(qa.items.iter().any(|item| matches!(item,
        MenuItem::Action { name, action, .. }
            if name.as_ref() == "Send notification in 3 seconds"
                && action.partial_eq(&crate::actions::ShowSystemNotificationPreview)
    )));
}

#[test]
#[cfg(feature = "qa-menu")]
fn qa_menu_carries_update_progress_previews() {
    let menus = menus(Layout::default());
    let qa = menus
        .iter()
        .find(|menu| menu.name.as_ref() == "QA")
        .unwrap();
    for (label, expected) in [
        (
            "Show update download progress (50%)",
            Box::new(ShowUpdateDownloadPreview) as Box<dyn gpui::Action>,
        ),
        (
            "Show Homebrew update progress",
            Box::new(ShowUpdateHomebrewPreview),
        ),
    ] {
        assert!(
            qa.items.iter().any(|item| matches!(item,
                MenuItem::Action { name, action, .. }
                    if name.as_ref() == label && action.partial_eq(expected.as_ref())
            )),
            "{label}"
        );
    }
}

#[test]
fn view_menu_lists_every_layout_in_groups_and_checks_the_current_one() {
    for current in LayoutMode::ALL {
        let menus = menus(Layout {
            mode: current,
            ..Layout::default()
        });
        let view = menus
            .iter()
            .find(|menu| menu.name.as_ref() == "View")
            .unwrap();
        assert!(
            !view.items.iter().any(
                |item| matches!(item, MenuItem::Submenu(menu) if menu.name.as_ref() == "Rows")
            ),
            "one layout setting, one menu"
        );
        let layout = view
            .items
            .iter()
            .find_map(|item| match item {
                MenuItem::Submenu(menu) if menu.name.as_ref() == "Layout" => Some(menu),
                _ => None,
            })
            .unwrap();
        // Densities, their rounded versions, then the other designs.
        let separators: Vec<usize> = layout
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| matches!(item, MenuItem::Separator))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(separators, vec![3, 7]);
        let actions: Vec<_> = layout
            .items
            .iter()
            .filter_map(|item| match item {
                MenuItem::Action {
                    name,
                    action,
                    checked,
                    ..
                } => Some((name, action, *checked)),
                _ => None,
            })
            .collect();
        assert_eq!(actions.len(), LayoutMode::ALL.len());
        for ((name, action, checked), mode) in actions.into_iter().zip(LayoutMode::ALL) {
            assert_eq!(name.as_ref(), mode.label());
            assert!(action.partial_eq(&SetLayout { mode }));
            assert_eq!(checked, mode == current, "{current}");
        }
    }
}

#[test]
fn qa_menu_requires_explicit_feature() {
    let menus = menus(Layout::default());
    let names: Vec<_> = menus.iter().map(|menu| menu.name.as_ref()).collect();
    let mut expected = vec!["Herdr", "File", "Edit", "View", "Terminal", "Window"];
    if cfg!(feature = "qa-menu") {
        expected.push("QA");
    }
    assert_eq!(names, expected);
}

fn edit_action(label: &str) -> Box<dyn gpui::Action> {
    menus(Layout::default())
        .into_iter()
        .find(|menu| menu.name.as_ref() == "Edit")
        .unwrap()
        .items
        .into_iter()
        .find_map(|item| match item {
            MenuItem::Action { name, action, .. } if name.as_ref() == label => Some(action),
            _ => None,
        })
        .unwrap()
}

/// Standard Edit items: native selectors for OS text fields, the shortcuts
/// every macOS app shows, and labels that do not claim the keystrokes.
#[gpui::test]
fn edit_menu_carries_standard_items_and_shortcut_labels(cx: &mut gpui::TestAppContext) {
    let items = &menus(Layout::default())
        .into_iter()
        .find(|menu| menu.name.as_ref() == "Edit")
        .unwrap()
        .items;
    let expected = [
        ("Cut", OsAction::Cut, "cmd-x"),
        ("Copy", OsAction::Copy, "cmd-c"),
        ("Paste", OsAction::Paste, "cmd-v"),
        ("Select All", OsAction::SelectAll, "cmd-a"),
    ];
    let actions: Vec<_> = items
        .iter()
        .filter_map(|item| match item {
            MenuItem::Action {
                name, os_action, ..
            } => Some((name.as_ref(), *os_action)),
            _ => None,
        })
        .collect();
    assert!(
        actions
            .iter()
            .map(|(name, os)| (*name, *os))
            .eq(expected.iter().map(|(name, os, _)| (*name, Some(*os)))),
        "Edit menu items or their native selectors changed"
    );
    cx.update(|cx| {
        crate::bind_keys(cx);
        for (name, _, keystroke) in expected {
            let action = edit_action(name);
            let keymap = cx.key_bindings();
            let keymap = keymap.borrow();
            let bindings: Vec<_> = keymap.bindings_for_action(action.as_ref()).collect();
            assert_eq!(bindings.len(), 1, "{name}");
            assert_eq!(
                bindings[0].keystrokes()[0].inner(),
                &gpui::Keystroke::parse(keystroke).unwrap()
            );
            // No element sets the context, so the keystroke never dispatches
            // the action ahead of the focused element's own key handler.
            assert!(bindings[0].predicate().is_some());
        }
    });
}

/// Each item is enabled only where it acts, and choosing it does what its
/// shortcut does in the focused element.
#[gpui::test]
fn edit_menu_items_follow_focus(cx: &mut gpui::TestAppContext) {
    use crate::{
        dialog_input::DialogInput,
        menu::{Page, WorkspaceAction},
        sidebar::layout_tests::{fixture_window, full_draw},
    };
    use gpui::ClipboardItem;

    const LABELS: [&str; 4] = ["Cut", "Copy", "Paste", "Select All"];
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        fixture_window(window, cx)
    });
    let available = |cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| {
            full_draw(window, cx).clear(cx);
            LABELS
                .into_iter()
                .filter(|label| window.is_action_available(edit_action(label).as_ref(), cx))
                .collect::<Vec<_>>()
        })
    };
    let choose = |label: &str, cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| window.dispatch_action(edit_action(label), cx));
        cx.run_until_parked();
    };

    // Without a highlighted selection, the terminal only pastes.
    cx.update(|window, cx| view.read(cx).focus.clone().focus(window, cx));
    assert_eq!(available(cx), ["Paste"]);

    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.menu.page = Some(Page::Dialog(WorkspaceAction::Rename));
            view.menu.input = Some(DialogInput::new("draft".into()));
        });
        cx.write_to_clipboard(ClipboardItem::new_string("renamed".into()));
    });
    assert_eq!(available(cx), LABELS);
    choose("Select All", cx);
    choose("Paste", cx);
    let draft = |cx: &mut gpui::VisualTestContext| {
        view.read_with(cx, |view, _| view.menu.input.as_ref().unwrap().text.clone())
    };
    assert_eq!(draft(cx), "renamed");
    cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("other".into())));
    choose("Select All", cx);
    choose("Copy", cx);
    assert_eq!(draft(cx), "renamed");
    let clipboard = |cx: &mut gpui::VisualTestContext| {
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()))
    };
    assert_eq!(clipboard(cx).as_deref(), Some("renamed"));
    cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("other".into())));
    choose("Cut", cx);
    assert_eq!(draft(cx), "");
    assert_eq!(clipboard(cx).as_deref(), Some("renamed"));

    // A search field takes the action before the overlay around it.
    let search = cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.dismiss_menu(window, cx);
            view.open_theme_picker(window, cx);
        });
        cx.write_to_clipboard(ClipboardItem::new_string("nord".into()));
        view.read(cx).menu.themes.as_ref().unwrap().search.clone()
    });
    assert_eq!(available(cx), LABELS);
    choose("Paste", cx);
    assert_eq!(
        search.read_with(cx, |search, _| search.text().to_owned()),
        "nord"
    );
    view.read_with(cx, |view, _| {
        assert!(view.menu.input.is_none());
        assert_eq!(view.menu.page, Some(Page::Themes));
    });
}

/// The font size items are the only way to reach these commands from the
/// macOS menu bar, and each must dispatch the catalog command rather than
/// an action of its own; full screen follows them, as in other Mac apps.
#[test]
fn view_menu_carries_the_font_size_and_full_screen_commands() {
    let menus = menus(Layout::default());
    let view = menus
        .iter()
        .find(|menu| menu.name.as_ref() == "View")
        .unwrap();
    let actions: Vec<_> = view
        .items
        .iter()
        .filter_map(|item| match item {
            MenuItem::Action { name, action, .. } => Some((name.as_ref(), action)),
            _ => None,
        })
        .collect();
    let expected = [
        ("Increase Font Size", Command::IncreaseFontSize),
        ("Decrease Font Size", Command::DecreaseFontSize),
        ("Reset Font Size", Command::ResetFontSize),
        ("Toggle Full Screen", Command::ToggleFullScreen),
    ];
    assert_eq!(actions.len(), expected.len());
    for ((name, action), (label, command)) in actions.iter().zip(expected) {
        assert_eq!(*name, label);
        assert!(action.partial_eq(&RunCommand { command }), "{label}");
    }
    // Reset is a different kind of act from stepping, so it sits apart.
    assert!(matches!(view.items[2], MenuItem::Separator));
}

fn action_names(menu: &Menu) -> Vec<&str> {
    menu.items
        .iter()
        .filter_map(|item| match item {
            MenuItem::Action { name, .. } => Some(name.as_ref()),
            _ => None,
        })
        .collect()
}

/// macOS reserves Hide and Minimize for every app: without these items
/// Cmd-H and Cmd-M have no key equivalent and do nothing.
#[cfg(target_os = "macos")]
#[gpui::test]
fn macos_menus_carry_hide_and_minimize(cx: &mut gpui::TestAppContext) {
    let menus = menus(Layout::default());
    let herdr = menus
        .iter()
        .find(|menu| menu.name.as_ref() == "Herdr")
        .unwrap();
    assert_eq!(
        action_names(herdr),
        [
            "About Herdr",
            "Command Palette",
            "Settings",
            "Keyboard Shortcuts",
            "Check for Updates...",
            "Hide Herdr",
            "Hide Others",
            "Show All",
            "Quit Herdr",
        ]
    );
    // Hiding sits apart from quitting.
    assert!(matches!(
        herdr.items[herdr.items.len() - 2],
        MenuItem::Separator
    ));
    let window = menus
        .iter()
        .find(|menu| menu.name.as_ref() == "Window")
        .unwrap();
    assert_eq!(action_names(window)[0], "Minimize");
    assert!(matches!(window.items[1], MenuItem::Separator));

    cx.update(|cx| {
        crate::bind_keys(cx);
        let bound = |action: &dyn gpui::Action| {
            let keymap = cx.key_bindings();
            let keymap = keymap.borrow();
            keymap
                .bindings_for_action(action)
                .map(|binding| binding.keystrokes()[0].inner().clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(bound(&Hide), [gpui::Keystroke::parse("cmd-h").unwrap()]);
        assert_eq!(
            bound(&HideOthers),
            [gpui::Keystroke::parse("cmd-alt-h").unwrap()]
        );
        assert_eq!(bound(&Minimize), [gpui::Keystroke::parse("cmd-m").unwrap()]);
        // Show All carries the standard no-shortcut.
        assert!(bound(&ShowAll).is_empty());
    });
}

/// Hide and Minimize are macOS conventions, not cross-platform menus.
#[cfg(not(target_os = "macos"))]
#[test]
fn hide_and_minimize_are_macos_only() {
    let menus = menus(Layout::default());
    let herdr = menus
        .iter()
        .find(|menu| menu.name.as_ref() == "Herdr")
        .unwrap();
    assert_eq!(
        action_names(herdr),
        [
            "About Herdr",
            "Command Palette",
            "Settings",
            "Keyboard Shortcuts",
            "Check for Updates...",
            "Quit Herdr",
        ]
    );
    let window = menus
        .iter()
        .find(|menu| menu.name.as_ref() == "Window")
        .unwrap();
    assert_eq!(
        action_names(window),
        ["New Window", "Cycle Through Windows", "Logs"]
    );
}
